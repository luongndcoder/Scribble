require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve ffmpeg binary path (cross-platform: macOS + Windows)
const { execSync } = require('child_process');
const STDERR_SUPPRESS = process.platform === 'win32' ? '2>NUL' : '2>/dev/null';
let FFMPEG_BIN = process.env.FFMPEG_PATH || '';
let ffmpegAvailable = false;

function testFfmpeg(bin) {
    try { execSync(`"${bin}" -version`, { stdio: 'ignore' }); return true; } catch { return false; }
}

if (FFMPEG_BIN && testFfmpeg(FFMPEG_BIN)) {
    ffmpegAvailable = true;
} else {
    // 1. Check system PATH
    const sysCmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    try {
        const sysPath = execSync(sysCmd, { encoding: 'utf8' }).trim().split('\n')[0];
        if (sysPath && testFfmpeg(sysPath)) { FFMPEG_BIN = sysPath; ffmpegAvailable = true; }
    } catch { }

    // 2. Try ffmpeg-static
    if (!ffmpegAvailable) {
        try {
            let staticPath = require('ffmpeg-static');
            if (staticPath && staticPath.includes('app.asar')) {
                staticPath = staticPath.replace('app.asar', 'app.asar.unpacked');
            }
            if (staticPath && testFfmpeg(staticPath)) { FFMPEG_BIN = staticPath; ffmpegAvailable = true; }
        } catch { }
    }

    // 3. Fallback
    if (!ffmpegAvailable) {
        FFMPEG_BIN = 'ffmpeg';
        console.warn('⚠️ ffmpeg not found. WAV conversion and Nvidia STT will not work.');
        console.warn('   Install ffmpeg: https://ffmpeg.org/download.html');
    }
}
console.log(`ffmpeg: ${ffmpegAvailable ? '✅ ' + FFMPEG_BIN : '❌ not available'}`);

function getAudioMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = { '.webm': 'audio/webm', '.mp4': 'audio/mp4', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac' };
    return mimeMap[ext] || 'audio/webm';
}

// ─── Config ───
const STT_MODE = process.env.STT_MODE || 'api'; // 'local' | 'api'
const STT_SERVICE_URL = process.env.STT_SERVICE_URL || 'http://localhost:5555';
const STT_API_URL = process.env.STT_API_URL || '';
const STT_API_KEY = process.env.STT_API_KEY || '';
const STT_API_MODEL = process.env.STT_API_MODEL || 'whisper-large-v3-turbo';
const LLM_BASE_URL_DEFAULT = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
const LLM_API_KEY_DEFAULT = process.env.LLM_API_KEY || '';
const LLM_MODEL_DEFAULT = process.env.LLM_MODEL || 'gpt-5.2';

// Ensure uploads directory exists (use userData in Electron)
const uploadsDir = process.env.ELECTRON_MODE
    ? path.join(process.env.AUDIO_DIR || path.join(__dirname, 'uploads'), '..', 'uploads')
    : path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer config for audio uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// LLM client — reads from DB first, falls back to .env
function getLLM() {
    const apiKey = db.getSetting('llm_api_key') || LLM_API_KEY_DEFAULT;
    const baseURL = db.getSetting('llm_base_url') || LLM_BASE_URL_DEFAULT;
    if (!apiKey) {
        throw new Error('LLM API Key chưa được cấu hình. Vui lòng vào Settings để thêm.');
    }
    return new OpenAI({ apiKey, baseURL });
}

function getLLMModel() {
    return db.getSetting('llm_model') || LLM_MODEL_DEFAULT;
}

// Forward audio file to local Python STT service (Parakeet)
async function transcribeViaLocal(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const blob = new Blob([fileBuffer], { type: getAudioMimeType(filePath) });

    const form = new FormData();
    form.append('audio', blob, fileName);

    const res = await fetch(`${STT_SERVICE_URL}/transcribe`, {
        method: 'POST',
        body: form,
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'STT service error' }));
        throw new Error(err.error || `STT service returned ${res.status}`);
    }

    return await res.json();
}

// Forward audio file to external STT API (OpenAI Whisper-compatible)
async function transcribeViaAPI(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const blob = new Blob([fileBuffer], { type: getAudioMimeType(filePath) });

    const form = new FormData();
    form.append('file', blob, fileName);
    form.append('model', STT_API_MODEL);
    form.append('language', 'vi');

    const res = await fetch(`${STT_API_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${STT_API_KEY}` },
        body: form,
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'External STT error' }));
        throw new Error(err.error?.message || err.error || `API returned ${res.status}`);
    }

    const data = await res.json();
    return { text: data.text || '', segments: [] };
}

// Direct Nvidia Cloud STT via gRPC (no Python needed)
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// Load Riva ASR proto
const PROTO_PATH = path.join(__dirname, 'proto', 'riva_asr.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
});
const rivaProto = grpc.loadPackageDefinition(packageDefinition).nvidia.riva.asr;

let nvidiaGrpcClient = null;

function getNvidiaClient() {
    const apiKey = db.getSetting('nvidia_api_key') || process.env.NVIDIA_API_KEY;
    const functionId = db.getSetting('nvidia_function_id') || process.env.NVIDIA_FUNCTION_ID || 'f3dff2bb-99f9-403d-a5f1-f574a757deb0';
    const rivaUrl = process.env.NVIDIA_RIVA_URL || 'grpc.nvcf.nvidia.com:443';

    if (!apiKey) throw new Error('Nvidia API key chưa được cấu hình');

    // Create SSL credentials with metadata for auth
    const sslCreds = grpc.credentials.createSsl();
    const metaCreds = grpc.credentials.createFromMetadataGenerator((params, callback) => {
        const meta = new grpc.Metadata();
        meta.add('function-id', functionId);
        meta.add('authorization', `Bearer ${apiKey}`);
        callback(null, meta);
    });
    const combinedCreds = grpc.credentials.combineChannelCredentials(sslCreds, metaCreds);

    nvidiaGrpcClient = new rivaProto.RivaSpeechRecognition(rivaUrl, combinedCreds);
    return nvidiaGrpcClient;
}

async function transcribeViaNvidia(filePath) {
    const client = getNvidiaClient();
    const { execSync } = require('child_process');

    // Convert audio to WAV PCM 16kHz mono (Riva expects this format)
    if (!ffmpegAvailable) throw new Error('ffmpeg is required for Nvidia STT but not installed. Install from https://ffmpeg.org or use Groq/API backend instead.');
    const wavPath = filePath.replace(/\.[^.]+$/, '_riva.wav');
    try {
        execSync(`"${FFMPEG_BIN}" -y -i "${filePath}" -ar 16000 -ac 1 -f wav "${wavPath}" ${STDERR_SUPPRESS}`);
    } catch (e) {
        throw new Error('ffmpeg conversion failed — is ffmpeg installed correctly?');
    }

    const audioData = fs.readFileSync(wavPath);
    fs.unlink(wavPath, () => { }); // cleanup

    const request = {
        config: {
            encoding: 'LINEAR_PCM',
            sample_rate_hertz: 16000,
            language_code: 'vi-VN',
            max_alternatives: 1,
            enable_automatic_punctuation: true,
            audio_channel_count: 1,
        },
        audio: audioData,
    };

    return new Promise((resolve, reject) => {
        client.Recognize(request, { deadline: new Date(Date.now() + 30000) }, (err, response) => {
            if (err) {
                reject(new Error(`Nvidia gRPC: ${err.message}`));
                return;
            }

            let text = '';
            if (response.results) {
                for (const r of response.results) {
                    if (r.alternatives && r.alternatives[0]) {
                        text += r.alternatives[0].transcript + ' ';
                    }
                }
            }
            resolve({ text: text.trim(), segments: [] });
        });
    });
}

// ─── Groq STT (OpenAI-compatible API) ───
async function transcribeViaGroq(filePath) {
    const apiKey = db.getSetting('groq_api_key') || process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('Groq API key not configured');

    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: getAudioMimeType(filePath) });

    const form = new FormData();
    form.append('file', blob, path.basename(filePath));
    form.append('model', 'whisper-large-v3-turbo');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: form,
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    let text = (data.text || '').trim();

    // Reject results that are likely hallucinations from silent/noisy chunks
    if (data.segments && data.segments.length > 0) {
        const avgNoSpeechProb = data.segments.reduce((sum, s) => sum + (s.no_speech_prob || 0), 0) / data.segments.length;
        if (avgNoSpeechProb > 0.5) {
            console.log(`Groq: Rejected chunk (avg no_speech_prob=${avgNoSpeechProb.toFixed(2)})`);
            return { text: '', segments: [] };
        }
    }

    // Reject suspiciously short or repetitive results
    if (text.length < 3) {
        return { text: '', segments: [] };
    }

    return { text, segments: data.segments || [] };
}

// Smart routing — reads backend from DB settings
async function transcribe(filePath) {
    const backend = db.getSetting('stt_backend') || process.env.STT_BACKEND || 'local';

    if (backend === 'nvidia') {
        try {
            return await transcribeViaNvidia(filePath);
        } catch (err) {
            console.error('Nvidia direct API error:', err.message);
            try {
                return await transcribeViaLocal(filePath);
            } catch {
                throw err;
            }
        }
    }

    if (backend === 'groq') {
        try {
            return await transcribeViaGroq(filePath);
        } catch (err) {
            console.error('Groq STT error:', err.message);
            throw err;
        }
    }

    if (backend === 'api' && STT_API_URL) {
        return transcribeViaAPI(filePath);
    }

    // Default: local Python service
    return transcribeViaLocal(filePath);
}

// ─── Whisper Hallucination Filter ───
const HALLUCINATION_PATTERNS = [
    // Vietnamese YouTube/social media hallucinations
    /h[aã]y subscribe cho k[eê]nh/gi,
    /ghiền mì gõ/gi,
    /để không bỏ lỡ nh[uư]ng video hấp dẫn/gi,
    /đừng quên like và subscribe/gi,
    /nhấn nút đăng ký/gi,
    /cảm ơn (các )?bạn đã (theo dõi|xem)/gi,
    /[đd][eể] kh[oô]ng b[oỏ] l[oỡ] nh[uữ]ng video h[aấ]p d[aẫ]n/gi,
    /v[aà] h[eẹ]n g[aặ]p l[aạ]i/gi,
    /đ[aă]ng k[yý] k[eê]nh.*[uủ]ng h[oộ]/gi,
    /xin chào.*kênh/gi,
    /bấm nút (chuông|like|đăng ký)/gi,

    // English YouTube/social media hallucinations
    /thank you for watching/gi,
    /please subscribe/gi,
    /like and subscribe/gi,
    /don'?t forget to subscribe/gi,
    /thanks for (watching|listening)/gi,
    /hit the (bell|like|subscribe)/gi,
    /see you in the next (video|episode)/gi,
    /leave a comment below/gi,

    // Common Whisper noise hallucinations
    /♪+/g,
    /🎵+/g,
    /\[music\]/gi,
    /\[applause\]/gi,
    /\[laughter\]/gi,
    /\(music\)/gi,
    /\(applause\)/gi,
    /\.{4,}/g,                           // repeated dots "....."
    /^[\s.…,!?]+$/,                      // only punctuation
    /(.{2,}?)\1{3,}/g,                   // same phrase repeated 4+ times
    /©.*all rights reserved/gi,
    /subtitles? by/gi,
    /www\.\w+\.\w+/gi,                   // random URLs

    // Whisper silence-fill hallucinations (single phrases repeated)
    /^meeting\.?$/gi,
    /^meeting discussion\.?$/gi,
    /^cuộc họp công việc\.?$/gi,
    /^\.+$/g,                             // only dots
    /^,+$/g,                              // only commas
];

function filterHallucinations(text) {
    if (!text) return text;
    let cleaned = text;
    for (const pattern of HALLUCINATION_PATTERNS) {
        cleaned = cleaned.replace(pattern, '');
    }
    return cleaned.replace(/\s{2,}/g, ' ').trim();
}

// ─── Settings API ───

// GET /api/settings — Return current config (from DB + env)
app.get('/api/settings', (req, res) => {
    const saved = db.getAllSettings();
    res.json({
        sttMode: STT_MODE,
        sttServiceUrl: STT_SERVICE_URL,
        sttApiUrl: STT_API_URL,
        sttApiModel: STT_API_MODEL,
        llmModel: db.getSetting('llm_model') || LLM_MODEL_DEFAULT,
        llmBaseUrl: db.getSetting('llm_base_url') || LLM_BASE_URL_DEFAULT,
        llmApiKeySet: !!(db.getSetting('llm_api_key') || LLM_API_KEY_DEFAULT),
        groqApiKeySet: !!(db.getSetting('groq_api_key') || process.env.GROQ_API_KEY),
        nvidiaApiKeySet: !!(db.getSetting('nvidia_api_key') || process.env.NVIDIA_API_KEY),
        backend: saved.stt_backend || 'local',
        preprocessing: saved.stt_preprocessing !== 'false',
        chunkDuration: parseInt(saved.stt_chunk_duration) || 5,
        ffmpegAvailable,
        platform: process.platform,
    });
});

// GET /api/stt-health — Check Python STT service, fallback to saved settings
app.get('/api/stt-health', async (req, res) => {
    const saved = db.getAllSettings();
    try {
        const r = await fetch(`${STT_SERVICE_URL}/health`);
        const data = await r.json();
        res.json(data);
    } catch (err) {
        res.json({
            status: 'offline',
            backend: saved.stt_backend || 'local',
            preprocessing: saved.stt_preprocessing !== 'false',
            error: 'STT service không chạy',
        });
    }
});

// GET /api/diagnose — Comprehensive health check for all configured services
app.get('/api/diagnose', async (req, res) => {
    const saved = db.getAllSettings();
    const backend = saved.stt_backend || 'local';
    const results = {
        backend,
        stt: { status: 'unknown', message: '' },
        llm: { status: 'unknown', message: '' },
    };

    // 1. Check STT backend
    if (backend === 'groq') {
        const key = saved.groq_api_key || process.env.GROQ_API_KEY;
        if (!key) {
            results.stt = { status: 'error', message: 'Groq API Key chưa được cấu hình' };
        } else {
            try {
                const r = await fetch('https://api.groq.com/openai/v1/models', {
                    headers: { 'Authorization': `Bearer ${key}` },
                    signal: AbortSignal.timeout(5000),
                });
                if (r.ok) {
                    results.stt = { status: 'ok', message: 'Groq API kết nối thành công' };
                } else {
                    const err = await r.json().catch(() => ({}));
                    results.stt = { status: 'error', message: `Groq API lỗi: ${err.error?.message || r.status}` };
                }
            } catch (err) {
                results.stt = { status: 'error', message: `Không kết nối được Groq: ${err.message}` };
            }
        }
    } else if (backend === 'nvidia') {
        const key = saved.nvidia_api_key || process.env.NVIDIA_API_KEY;
        const funcId = saved.nvidia_function_id || process.env.NVIDIA_FUNCTION_ID || 'f3dff2bb-99f9-403d-a5f1-f574a757deb0';
        if (!key) {
            results.stt = { status: 'error', message: 'Nvidia API Key chưa được cấu hình' };
        } else if (!funcId) {
            results.stt = { status: 'error', message: 'Nvidia Function ID chưa được cấu hình' };
        } else {
            try {
                // Test gRPC connection (same method used for actual transcription)
                const client = getNvidiaClient();
                const deadline = new Date(Date.now() + 5000);
                await new Promise((resolve, reject) => {
                    client.waitForReady(deadline, (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                results.stt = { status: 'ok', message: 'Nvidia Cloud gRPC kết nối thành công' };
            } catch (err) {
                results.stt = { status: 'error', message: `Không kết nối được Nvidia gRPC: ${err.message}` };
            }
        }
    } else if (backend === 'local') {
        try {
            const r = await fetch(`${STT_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
            if (r.ok) {
                results.stt = { status: 'ok', message: 'Local STT service đang chạy' };
            } else {
                results.stt = { status: 'error', message: `Local STT trả về lỗi: ${r.status}` };
            }
        } catch {
            results.stt = { status: 'error', message: 'Local STT service không chạy (port 5555)' };
        }
    }

    // 2. Check LLM
    const llmKey = saved.llm_api_key || LLM_API_KEY_DEFAULT;
    const llmBase = saved.llm_base_url || LLM_BASE_URL_DEFAULT;
    if (!llmKey) {
        results.llm = { status: 'warning', message: 'LLM API Key chưa được cấu hình (tuỳ chọn)' };
    } else {
        try {
            const r = await fetch(`${llmBase}/models`, {
                headers: { 'Authorization': `Bearer ${llmKey}` },
                signal: AbortSignal.timeout(5000),
            });
            if (r.ok) {
                results.llm = { status: 'ok', message: 'LLM API kết nối thành công' };
            } else {
                results.llm = { status: 'error', message: `LLM API lỗi: ${r.status}` };
            }
        } catch (err) {
            results.llm = { status: 'error', message: `Không kết nối được LLM: ${err.message}` };
        }
    }

    res.json(results);
});

// POST /api/stt-config — Save to DB first, then optionally sync to Python
app.post('/api/stt-config', async (req, res) => {
    const { backend, preprocessing, nvidia_api_key, nvidia_function_id, groq_api_key, chunk_duration, llm_api_key, llm_base_url, llm_model } = req.body;

    // 1. Always save to local DB (never fails)
    if (backend) db.setSetting('stt_backend', backend);
    if (preprocessing !== undefined) db.setSetting('stt_preprocessing', String(preprocessing));
    if (nvidia_api_key) db.setSetting('nvidia_api_key', nvidia_api_key);
    if (nvidia_function_id) db.setSetting('nvidia_function_id', nvidia_function_id);
    if (groq_api_key) db.setSetting('groq_api_key', groq_api_key);
    if (chunk_duration) db.setSetting('stt_chunk_duration', String(chunk_duration));
    if (llm_api_key) db.setSetting('llm_api_key', llm_api_key);
    if (llm_base_url) db.setSetting('llm_base_url', llm_base_url);
    if (llm_model) db.setSetting('llm_model', llm_model);

    // 2. Try to sync to Python STT service (optional)
    let sttSynced = false;
    try {
        const r = await fetch(`${STT_SERVICE_URL}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
        });
        const data = await r.json();
        sttSynced = true;
    } catch (err) {
        // Python offline — settings are saved locally, will sync on next start
    }

    res.json({ ok: true, saved: true, sttSynced });
});

// ─── API Routes ───

// POST /api/transcribe — Upload audio → Python STT service (Parakeet) → transcript
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Không có file audio' });

    try {
        const result = await transcribe(req.file.path);

        // Clean up uploaded file
        fs.unlink(req.file.path, () => { });

        res.json({
            text: filterHallucinations(result.text),
            segments: result.segments || [],
        });
    } catch (err) {
        if (req.file?.path) fs.unlink(req.file.path, () => { });
        console.error('Transcription error:', err.message);
        res.status(500).json({ error: `Lỗi phiên dịch: ${err.message}` });
    }
});

// POST /api/transcribe-chunk — Real-time chunked transcription via Python STT service
app.post('/api/transcribe-chunk', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Không có audio chunk' });

    try {
        console.log(`[transcribe-chunk] file: ${req.file.originalname} (${req.file.size} bytes) backend: ${db.getSetting('stt_backend') || 'local'}`);
        const result = await transcribe(req.file.path);

        fs.unlink(req.file.path, () => { });
        const text = filterHallucinations((result.text || '').trim());
        console.log(`[transcribe-chunk] result: "${text.substring(0, 80)}${text.length > 80 ? '...' : ''}"`);
        res.json({ text });
    } catch (err) {
        if (req.file?.path) fs.unlink(req.file.path, () => { });
        console.error('Chunk transcription error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Draft Auto-Save (transcript recovery) ───

// POST /api/drafts — Create a draft when recording starts
app.post('/api/drafts', (req, res) => {
    try {
        const id = db.createMeeting({
            title: 'Đang ghi âm...',
            transcript: '',
            summary: '',
            audioDuration: 0,
            language: req.body.language || 'vi',
        });
        // Mark as draft
        db.updateMeeting(id, { status: 'draft' });
        res.json({ id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PATCH /api/drafts/:id — Append transcript text during recording
app.patch('/api/drafts/:id', (req, res) => {
    const { id } = req.params;
    const { appendText, audioDuration } = req.body;
    try {
        const meeting = db.getMeeting(id);
        if (!meeting) return res.status(404).json({ error: 'Draft not found' });

        const newTranscript = meeting.transcript
            ? meeting.transcript + '\n' + appendText
            : appendText;

        const updates = { transcript: newTranscript };
        if (audioDuration) updates.audioDuration = audioDuration;
        db.updateMeeting(id, updates);

        res.json({ ok: true, length: newTranscript.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/drafts/active — Check for unfinished drafts
app.get('/api/drafts/active', (req, res) => {
    try {
        const draft = db.getActiveDraft();
        if (draft && draft.transcript) {
            res.json({
                hasDraft: true,
                id: draft.id,
                transcript: draft.transcript,
                duration: draft.audio_duration,
                createdAt: draft.created_at,
            });
        } else {
            res.json({ hasDraft: false });
        }
    } catch (err) {
        res.json({ hasDraft: false });
    }
});

// ─── Audio File Persistence ───
const AUDIO_DIR = process.env.AUDIO_DIR || path.join(__dirname, 'audio_files');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// POST /api/meetings/:id/audio — Upload and save meeting audio
app.post('/api/meetings/:id/audio', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });

    const { id } = req.params;
    const meeting = db.getMeeting(id);
    if (!meeting) {
        fs.unlink(req.file.path, () => { });
        return res.status(404).json({ error: 'Meeting not found' });
    }

    const { execSync } = require('child_process');
    const wavFilename = `${id}.wav`;
    const wavPath = path.join(AUDIO_DIR, wavFilename);

    try {
        if (!ffmpegAvailable) throw new Error('ffmpeg not available');
        execSync(`"${FFMPEG_BIN}" -y -i "${req.file.path}" -ar 44100 -ac 1 -f wav "${wavPath}" ${STDERR_SUPPRESS}`);
        fs.unlink(req.file.path, () => { });
        db.updateMeeting(id, { audioPath: wavFilename });
        res.json({ ok: true, audioPath: wavFilename });
    } catch (err) {
        fs.unlink(req.file.path, () => { });
        res.status(500).json({ error: 'Audio conversion failed' });
    }
});

// GET /api/meetings/:id/audio — Download saved audio
app.get('/api/meetings/:id/audio', (req, res) => {
    const meeting = db.getMeeting(req.params.id);
    if (!meeting || !meeting.audio_path) {
        return res.status(404).json({ error: 'Audio not found' });
    }
    const filePath = path.join(AUDIO_DIR, meeting.audio_path);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Audio file missing' });
    }
    res.download(filePath, `${meeting.title || 'meeting'}.wav`);
});

// POST /api/convert-wav — WebM audio → ffmpeg → WAV download
app.post('/api/convert-wav', upload.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });

    const { execSync } = require('child_process');
    const wavPath = req.file.path.replace(/\.[^.]+$/, '.wav');

    try {
        if (!ffmpegAvailable) throw new Error('ffmpeg is not installed. Download from https://ffmpeg.org');
        execSync(`"${FFMPEG_BIN}" -y -i "${req.file.path}" -ar 44100 -ac 1 -f wav "${wavPath}" ${STDERR_SUPPRESS}`);
        res.download(wavPath, 'meeting.wav', () => {
            fs.unlink(req.file.path, () => { });
            fs.unlink(wavPath, () => { });
        });
    } catch (err) {
        fs.unlink(req.file.path, () => { });
        res.status(500).json({ error: 'ffmpeg conversion failed' });
    }
});

// ─── Summarization Engine ───

const CHUNK_CHARS = 8000;     // ~2000 tokens per chunk
const OVERLAP_CHARS = 500;    // overlap between chunks to preserve context
const SINGLE_PASS_LIMIT = 120000; // ~30K tokens — single-pass for GPT-5.2 (128K context)

function splitTranscript(transcript) {
    const lines = transcript.split('\n');
    const segments = [];
    let current = [];
    let currentLen = 0;

    for (const line of lines) {
        current.push(line);
        currentLen += line.length;

        if (currentLen >= CHUNK_CHARS) {
            segments.push(current.join('\n'));
            // Keep last few lines as overlap for next segment
            const overlapLines = [];
            let overlapLen = 0;
            for (let i = current.length - 1; i >= 0; i--) {
                overlapLen += current[i].length;
                if (overlapLen >= OVERLAP_CHARS) break;
                overlapLines.unshift(current[i]);
            }
            current = overlapLines;
            currentLen = overlapLen;
        }
    }
    if (current.length > 0) segments.push(current.join('\n'));
    return segments;
}

async function summarizeSegment(llm, segment, index, total, isVietnamese) {
    const systemPrompt = `You are a meticulous meeting-notes assistant processing chunk ${index + 1} of ${total}.
For this chunk, extract:
A) Key points discussed (bullet list)
B) Decisions made (only if explicitly stated, otherwise skip)
C) Action items: Owner | Task | Due date (use "TBD" if missing)
D) Risks / blockers / open questions
E) Participants mentioned

Rules:
- Use ONLY information in this chunk. Do not invent details.
- If something is ambiguous, write "Unclear:" and what you can/cannot determine.
- Preserve important numbers, dates, names, and commitments exactly.
- Transcription may have spelling mistakes — correct if obvious from context.
- Keep it concise and structured.`;

    const userPrompt = isVietnamese
        ? `Đây là phần ${index + 1}/${total} của bản ghi cuộc họp. Hãy trích xuất theo format trên. Viết bằng tiếng Việt.\n\n<transcript_chunk>\n${segment}\n</transcript_chunk>`
        : `This is chunk ${index + 1}/${total} of the meeting transcript. Extract per the format above.\n\n<transcript_chunk>\n${segment}\n</transcript_chunk>`;

    const completion = await llm.chat.completions.create({
        model: getLLMModel(),
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 1500,
    });
    return completion.choices[0].message.content.trim();
}

function getSummaryJsonPrompt(isVietnamese) {
    return isVietnamese
        ? `Bạn là trợ lý biên bản cuộc họp chuyên nghiệp. Phân tích transcript và trả về JSON:
{
  "title": "Tên cuộc họp (ngắn gọn, tạo từ nội dung)",
  "summary": "Tóm tắt tổng quan (3-6 điểm chính, nêu bật mục tiêu và kết quả)",
  "participants": ["Người tham gia (nếu xác định được từ transcript)"],
  "keyPoints": ["Các nội dung chính đã thảo luận, theo thứ tự"],
  "decisions": ["Quyết định ĐÃ ĐƯỢC THỐNG NHẤT RÕ RÀNG. Nếu chưa quyết định, ghi 'Chưa quyết định: ...'"],
  "actionItems": [{"task": "Nhiệm vụ cụ thể", "assignee": "Người phụ trách (TBD nếu chưa rõ)", "deadline": "Hạn chót (TBD nếu chưa rõ)", "priority": "high/medium/low"}],
  "risks": ["Rủi ro, blocker, hoặc câu hỏi chưa được giải đáp"],
  "nextSteps": ["Bước tiếp theo / follow-up"],
  "parkingLot": ["Ý tưởng được đề cập nhưng chưa quyết định"]
}

QUY TẮC:
- CHỈ sử dụng thông tin CÓ trong transcript. KHÔNG thêm hay suy luận.
- Nếu thông tin không rõ ràng, ghi "Chưa rõ:" kèm mô tả.
- Giữ nguyên các con số, ngày tháng, tên người, cam kết quan trọng.
- Nếu mục không có thông tin, trả về mảng rỗng [].
- Sửa lỗi chính tả nếu rõ ràng từ ngữ cảnh.
- Viết hoàn toàn bằng tiếng Việt.
- CHỈ trả về JSON, không có text khác.`
        : `You are a meticulous meeting-notes assistant. Analyze the transcript and return JSON:
{
  "title": "Meeting title (concise, generated from content)",
  "summary": "TL;DR overview (3-6 key bullets as a paragraph)",
  "participants": ["Attendees identified from transcript"],
  "keyPoints": ["Topics discussed, in order"],
  "decisions": ["Decisions EXPLICITLY made. If not decided, write 'Not decided: ...'"],
  "actionItems": [{"task": "Specific task", "assignee": "Owner (TBD if unknown)", "deadline": "Due date (TBD if unknown)", "priority": "high/medium/low"}],
  "risks": ["Risks, blockers, or open questions raised"],
  "nextSteps": ["Follow-ups and next steps"],
  "parkingLot": ["Ideas raised but not decided"]
}

RULES:
- Use ONLY information present in the transcript. Do NOT invent details.
- If something is ambiguous, write "Unclear:" and describe what you can/cannot determine.
- Preserve important numbers, dates, names, and commitments exactly.
- If a section has no info, return empty array [].
- Fix obvious spelling mistakes from context.
- Return ONLY JSON, no other text.`;
}

async function reduceSummaries(llm, summaries, isVietnamese) {
    const systemPrompt = getSummaryJsonPrompt(isVietnamese);
    const intro = isVietnamese
        ? `Dưới đây là các bản tóm tắt từng phần của cuộc họp dài. Hãy tổng hợp thành biên bản hoàn chỉnh:
- Loại bỏ trùng lặp giữa các phần
- Gộp action items trùng lặp (cùng owner + task)
- Giữ nguyên tất cả decisions, risks, và open questions
- Sắp xếp keyPoints theo thứ tự thảo luận`
        : `Below are partial summaries of a long meeting. Synthesize into complete minutes:
- Remove duplicates across parts
- Merge duplicate action items (same owner + task)
- Preserve all decisions, risks, and open questions
- Order keyPoints by discussion sequence`;
    const combined = summaries.map((s, i) => `--- Part ${i + 1} ---\n${s}`).join('\n\n');

    const completion = await llm.chat.completions.create({
        model: getLLMModel(),
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${intro}\n\n<summaries>\n${combined}\n</summaries>` },
        ],
        temperature: 0.2,
        max_tokens: 4000,
    });
    return completion.choices[0].message.content.trim();
}

// POST /api/summarize — SSE stream, reads transcript from DB by meetingId
app.post('/api/summarize', async (req, res) => {
    const { meetingId, language } = req.body;
    if (!meetingId) return res.status(400).json({ error: 'meetingId is required' });

    // Read transcript from DB
    const meeting = db.getMeeting(meetingId);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    const transcript = meeting.transcript || '';
    if (!transcript.trim()) return res.status(400).json({ error: 'Meeting has no transcript' });

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    try {
        const llm = getLLM();
        const lang = language || 'vi';
        const isVietnamese = lang === 'vi';

        let raw;

        if (transcript.length <= SINGLE_PASS_LIMIT) {
            // Single-pass — GPT-5.2 has 128K context, send everything at once
            sendEvent('progress', { message: isVietnamese ? 'Đang tạo biên bản...' : 'Generating summary...', step: 1, total: 1 });
            console.log(`Single-pass summary for ${transcript.length} chars`);

            const systemPrompt = getSummaryJsonPrompt(isVietnamese);
            const userContent = isVietnamese
                ? `Transcript cuộc họp:\n\n<transcript>\n${transcript}\n</transcript>`
                : `Meeting transcript:\n\n<transcript>\n${transcript}\n</transcript>`;

            const completion = await llm.chat.completions.create({
                model: getLLMModel(),
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent },
                ],
                temperature: 0.3,
                max_tokens: 3000,
            });
            raw = completion.choices[0].message.content.trim();
        } else {
            // Long meeting — MapReduce with overlap-based chunking
            const segments = splitTranscript(transcript);
            const total = segments.length;
            console.log(`MapReduce: ${total} segments for ${transcript.length} chars (overlap: ${OVERLAP_CHARS})`);

            sendEvent('progress', {
                message: isVietnamese
                    ? `Cuộc họp dài — chia thành ${total} phần để xử lý`
                    : `Long meeting — split into ${total} segments`,
                step: 0, total: total + 1,
            });

            // Phase 1: Map — summarize each segment
            const partialSummaries = [];
            for (let i = 0; i < segments.length; i++) {
                sendEvent('progress', {
                    message: isVietnamese
                        ? `Đang phân tích phần ${i + 1}/${total}...`
                        : `Analyzing part ${i + 1}/${total}...`,
                    step: i + 1, total: total + 1,
                });
                console.log(`  Map ${i + 1}/${total}...`);
                const s = await summarizeSegment(llm, segments[i], i, total, isVietnamese);
                partialSummaries.push(s);
            }

            // Phase 2: Reduce — combine into final summary JSON
            sendEvent('progress', {
                message: isVietnamese
                    ? 'Đang tổng hợp biên bản cuối cùng...'
                    : 'Generating final summary...',
                step: total + 1, total: total + 1,
            });
            console.log('  Reduce...');
            raw = await reduceSummaries(llm, partialSummaries, isVietnamese);
        }

        // Strip markdown code fences
        const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (fenceMatch) raw = fenceMatch[1].trim();

        const summary = JSON.parse(raw);

        // Save summary to DB directly
        const title = summary.title || (isVietnamese ? 'Cuộc họp' : 'Meeting') + ' ' + new Date().toLocaleDateString('vi-VN');
        db.updateMeeting(meetingId, {
            title,
            summary: JSON.stringify(summary),
            status: 'complete',
        });
        console.log(`Summary saved to DB for meeting ${meetingId}`);

        sendEvent('done', { summary, meetingId });
        res.end();
    } catch (err) {
        console.error('Summary error:', err.message);
        sendEvent('error', { error: `Lỗi tóm tắt: ${err.message}` });
        res.end();
    }
});

// POST /api/translate — SSE streaming translation via LLM
app.post('/api/translate', async (req, res) => {
    const { text, targetLang } = req.body;
    if (!text) return res.status(400).json({ error: 'No text to translate' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    });

    const sendEvent = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const llm = getLLM();
        const stream = await llm.chat.completions.create({
            model: getLLMModel(),
            messages: [
                {
                    role: 'system',
                    content: `You are a professional real-time interpreter. Translate the following speech transcript to ${targetLang}. Maintain the natural speaking tone, preserve meaning accurately. Output ONLY the translated text, nothing else.`,
                },
                { role: 'user', content: text },
            ],
            temperature: 0.3,
            max_tokens: 2000,
            stream: true,
        });

        for await (const chunk of stream) {
            const token = chunk.choices?.[0]?.delta?.content;
            if (token) {
                sendEvent('token', { token });
            }
        }
        sendEvent('done', {});
        res.end();
    } catch (err) {
        console.error('Translation error:', err.message);
        sendEvent('error', { error: err.message });
        res.end();
    }
});

// POST /api/meetings — Save a meeting
app.post('/api/meetings', (req, res) => {
    try {
        const { title, transcript, summary, audioDuration, language } = req.body;
        const id = db.createMeeting({
            title: title || 'Cuộc họp không tên',
            transcript: typeof transcript === 'string' ? transcript : JSON.stringify(transcript),
            summary: typeof summary === 'string' ? summary : JSON.stringify(summary),
            audioDuration,
            language,
        });
        res.json({ id, message: 'Đã lưu cuộc họp' });
    } catch (err) {
        console.error('Save meeting error:', err.message);
        res.status(500).json({ error: `Lỗi lưu cuộc họp: ${err.message}` });
    }
});

// GET /api/meetings — List all meetings
app.get('/api/meetings', (req, res) => {
    try {
        const meetings = db.getAllMeetings();
        res.json(meetings);
    } catch (err) {
        console.error('Get meetings error:', err.message);
        res.status(500).json({ error: `Lỗi tải danh sách: ${err.message}` });
    }
});

// GET /api/meetings/:id — Get single meeting
app.get('/api/meetings/:id', (req, res) => {
    try {
        const meeting = db.getMeeting(req.params.id);
        if (!meeting) return res.status(404).json({ error: 'Không tìm thấy cuộc họp' });

        // Parse JSON fields
        try { meeting.summary = JSON.parse(meeting.summary); } catch { }
        res.json(meeting);
    } catch (err) {
        console.error('Get meeting error:', err.message);
        res.status(500).json({ error: `Lỗi tải cuộc họp: ${err.message}` });
    }
});

// PUT /api/meetings/:id — Update a meeting (used to promote drafts)
app.put('/api/meetings/:id', (req, res) => {
    try {
        const meeting = db.getMeeting(req.params.id);
        if (!meeting) return res.status(404).json({ error: 'Không tìm thấy cuộc họp' });
        db.updateMeeting(req.params.id, req.body);
        res.json({ ok: true, id: req.params.id });
    } catch (err) {
        console.error('Update meeting error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/meetings/:id — Delete a meeting
app.delete('/api/meetings/:id', (req, res) => {
    try {
        const deleted = db.deleteMeeting(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Không tìm thấy cuộc họp' });
        res.json({ message: 'Đã xóa cuộc họp' });
    } catch (err) {
        console.error('Delete meeting error:', err.message);
        res.status(500).json({ error: `Lỗi xóa: ${err.message}` });
    }
});

// POST /api/meetings/:id/export — Export meeting as markdown
app.post('/api/meetings/:id/export', (req, res) => {
    try {
        const meeting = db.getMeeting(req.params.id);
        if (!meeting) return res.status(404).json({ error: 'Không tìm thấy cuộc họp' });

        let summary;
        try { summary = JSON.parse(meeting.summary); } catch { summary = {}; }

        let md = `# ${summary.title || meeting.title}\n\n`;
        md += `📅 ${new Date(meeting.created_at).toLocaleString('vi-VN')}\n\n`;

        if (summary.summary) {
            md += `## Tóm tắt\n${summary.summary}\n\n`;
        }
        if (summary.participants?.length) {
            md += `## Người tham gia\n${summary.participants.map(p => `- ${p}`).join('\n')}\n\n`;
        }
        if (summary.keyPoints?.length) {
            md += `## Điểm chính\n${summary.keyPoints.map(p => `- ${p}`).join('\n')}\n\n`;
        }
        if (summary.actionItems?.length) {
            md += `## Nhiệm vụ\n${summary.actionItems.map(a => `- [ ] ${a.task}${a.assignee ? ` → ${a.assignee}` : ''}${a.deadline ? ` (${a.deadline})` : ''}`).join('\n')}\n\n`;
        }
        if (summary.decisions?.length) {
            md += `## Quyết định\n${summary.decisions.map(d => `- ${d}`).join('\n')}\n\n`;
        }
        if (summary.nextSteps?.length) {
            md += `## Bước tiếp theo\n${summary.nextSteps.map(s => `- ${s}`).join('\n')}\n\n`;
        }
        if (meeting.transcript) {
            md += `## Transcript\n${meeting.transcript}\n`;
        }

        res.json({ markdown: md, title: summary.title || meeting.title });
    } catch (err) {
        console.error('Export error:', err.message);
        res.status(500).json({ error: `Lỗi xuất file: ${err.message}` });
    }
});

// POST /api/meetings/:id/export-docx — Export meeting as DOCX
app.post('/api/meetings/:id/export-docx', async (req, res) => {
    try {
        const meeting = db.getMeeting(req.params.id);
        if (!meeting) return res.status(404).json({ error: 'Không tìm thấy cuộc họp' });

        let summary;
        try { summary = JSON.parse(meeting.summary); } catch { summary = {}; }

        const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');

        const children = [];

        // Title
        children.push(new Paragraph({
            children: [new TextRun({ text: summary.title || meeting.title, bold: true, size: 36, font: 'Inter' })],
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
        }));

        // Date
        children.push(new Paragraph({
            children: [new TextRun({ text: `📅 ${new Date(meeting.created_at).toLocaleString('vi-VN')}`, size: 20, color: '666666', font: 'Inter' })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
        }));

        const addSection = (title, items, isBullet = true) => {
            if (!items?.length) return;
            children.push(new Paragraph({
                children: [new TextRun({ text: title, bold: true, size: 28, font: 'Inter' })],
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 300, after: 100 },
            }));
            items.forEach(item => {
                const text = typeof item === 'string' ? item : `${item.task}${item.assignee ? ` → ${item.assignee}` : ''}${item.deadline ? ` (${item.deadline})` : ''}`;
                children.push(new Paragraph({
                    children: [new TextRun({ text, size: 22, font: 'Inter' })],
                    bullet: isBullet ? { level: 0 } : undefined,
                    spacing: { after: 60 },
                }));
            });
        };

        // Summary
        if (summary.summary) {
            children.push(new Paragraph({
                children: [new TextRun({ text: 'Tóm tắt', bold: true, size: 28, font: 'Inter' })],
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 300, after: 100 },
            }));
            children.push(new Paragraph({
                children: [new TextRun({ text: summary.summary, size: 22, font: 'Inter' })],
                spacing: { after: 200 },
            }));
        }

        addSection('Người tham gia', summary.participants);
        addSection('Điểm chính', summary.keyPoints || summary.key_points);
        addSection('Nhiệm vụ', summary.actionItems || summary.action_items);
        addSection('Quyết định', summary.decisions);
        addSection('Bước tiếp theo', summary.nextSteps || summary.next_steps);

        // Transcript
        if (meeting.transcript) {
            children.push(new Paragraph({
                children: [new TextRun({ text: 'Transcript', bold: true, size: 28, font: 'Inter' })],
                heading: HeadingLevel.HEADING_2,
                spacing: { before: 300, after: 100 },
            }));
            meeting.transcript.split('\n').filter(l => l.trim()).forEach(line => {
                children.push(new Paragraph({
                    children: [new TextRun({ text: line, size: 20, italics: true, color: '555555', font: 'Inter' })],
                    spacing: { after: 40 },
                }));
            });
        }

        const doc = new Document({ sections: [{ children }] });
        const buffer = await Packer.toBuffer(doc);

        const filename = `${(summary.title || meeting.title || 'meeting').replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF ]/g, '_')}.docx`;
        res.set({
            'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
        });
        res.send(buffer);
    } catch (err) {
        console.error('DOCX export error:', err.message);
        res.status(500).json({ error: `Lỗi xuất DOCX: ${err.message}` });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🎤 Meeting Minutes server đang chạy tại http://localhost:${PORT}\n`);
});
