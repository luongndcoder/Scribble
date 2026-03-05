// ─── State ───
const state = {
    recording: false,
    paused: false,
    draftId: null,
    mediaRecorder: null,
    audioChunks: [],
    allAudioChunks: [],
    timer: null,
    seconds: 0,
    analyser: null,
    animFrame: null,
    currentMeetingId: null,
    audioStream: null,
    transcriptParts: [],
    chunkQueue: [],
    isTranscribing: false,
    recordStartTime: null,
    // VAD (Voice Activity Detection)
    vadInterval: null,
    chunkStartTime: 0,
    silenceStart: 0,
    isSilent: false,
    currentView: 'list',
    activeDetailTab: 'recording',
    translationEnabled: false,
    translationStartIdx: Infinity,
    audioSource: 'mic',  // 'mic' | 'system' | 'both'
};

// ─── DOM ───
const $ = (sel) => document.querySelector(sel);
const $id = (id) => document.getElementById(id);

const el = {
    btnRecord: $id('btnRecord'),
    recMainIcon: $id('recMainIcon'),
    btnStop: $id('btnStop'),
    btnPause: $id('btnPause'),
    btnDownloadAudio: $id('btnDownloadAudio'),
    btnSummarize: $id('btnSummarize'),
    btnExport: $id('btnExport'),

    btnNewMeeting2: $id('btnNewMeeting2'),
    btnCopyTranscript: $id('btnCopyTranscript'),
    btnClearTranscript: $id('btnClearTranscript'),
    recordTimer: $id('recordTimer'),
    waveformCanvas: $id('waveformCanvas'),
    emptyState: $id('emptyState'),
    processingState: $id('processingState'),
    processingText: $id('processingText'),
    transcriptContent: $id('transcriptContent'),
    minutesContent: $id('minutesContent'),
    meetingsGrid: $id('meetingsGrid'),
    summaryEmpty: $id('summaryEmpty'),
    recBar: $id('recBar'),
    recWaveWrap: $id('recWaveWrap'),
    recIndicator: $id('recIndicator'),
    // Views
    viewMeetings: $id('viewMeetings'),
    viewDetail: $id('viewDetail'),
    // Sub-tabs
    subTabRecording: $id('subTabRecording'),
    subTabSummary: $id('subTabSummary'),
    paneRecording: $id('paneRecording'),
    paneSummary: $id('paneSummary'),
    btnBack: $id('btnBack'),
    // Settings
    btnSettings: $id('btnSettings'),
    settingsModal: $id('settingsModal'),
    closeSettings: $id('closeSettings'),
    cancelSettings: $id('cancelSettings'),
    btnDiagnose: $id('btnDiagnose'),
    diagnoseResults: $id('diagnoseResults'),
    saveSettings: $id('saveSettings'),
    sttStatus: $id('sttStatus'),
    nvidiaSettings: $id('nvidiaSettings'),
    localSettings: $id('localSettings'),
    nvidiaApiKey: $id('nvidiaApiKey'),

    groqSettings: $id('groqSettings'),
    groqApiKey: $id('groqApiKey'),
    preprocessToggle: $id('preprocessToggle'),
    translationToggle: $id('translationToggle'),
    translationLang: $id('translationLang'),
    llmApiKey: $id('llmApiKey'),
    llmBaseUrl: $id('llmBaseUrl'),
    llmModel: $id('llmModel'),
};

// ─── Language Toggle ───
function updateLangToggle() {
    const btn = $id('btnLangToggle');
    if (btn) btn.textContent = currentLang === 'vi' ? '🇻🇳' : '🇬🇧';
}

// ─── Toast (replaces alert/confirm) ───
function showToast(msg, type = 'info', duration = 3000) {
    let container = $id('toastContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastContainer';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function showConfirm(msg) {
    return new Promise((resolve) => {
        let overlay = document.createElement('div');
        overlay.className = 'confirm-overlay';
        overlay.innerHTML = `
            <div class="confirm-box">
                <p class="confirm-msg">${msg}</p>
                <div class="confirm-actions">
                    <button class="action-btn confirm-cancel">${t('confirm_no')}</button>
                    <button class="action-btn danger confirm-ok">${t('confirm_yes')}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));
        overlay.querySelector('.confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
        overlay.querySelector('.confirm-ok').onclick = () => { overlay.remove(); resolve(true); };
    });
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    initCanvas();
    showView('list');
    loadMeetings();
    applyTranslations();
    updateLangToggle();

    // Electron mode: hide local STT backend
    if (window.electronAPI?.isElectron) {
        const localCard = document.querySelector('[data-stt-backend="local"]');
        if (localCard) {
            localCard.style.display = 'none';
            const localRadio = localCard.querySelector('input[type="radio"]');
            if (localRadio?.checked) {
                const groqRadio = document.querySelector('input[name="sttBackend"][value="groq"]');
                if (groqRadio) {
                    groqRadio.checked = true;
                    groqRadio.dispatchEvent(new Event('change'));
                }
            }
        }
        // Hide STT status section — server is embedded in Electron
        const statusGroup = $id('sttStatusGroup');
        if (statusGroup) statusGroup.style.display = 'none';
        document.body.classList.add('electron-app');
    }
});

function bindEvents() {
    el.btnRecord.addEventListener('click', toggleRecording);
    el.btnStop.addEventListener('click', stopRecording);
    el.btnPause.addEventListener('click', togglePause);
    el.btnDownloadAudio.addEventListener('click', downloadAudio);
    el.btnSummarize.addEventListener('click', summarizeTranscript);
    el.btnExport.addEventListener('click', exportMeeting);

    el.btnNewMeeting2.addEventListener('click', newMeeting);
    el.btnCopyTranscript.addEventListener('click', copyTranscript);
    el.btnClearTranscript.addEventListener('click', clearAllTranscript);

    // Translation toggle
    el.translationToggle.addEventListener('change', () => {
        state.translationEnabled = el.translationToggle.checked;
        el.translationLang.disabled = !state.translationEnabled;
        if (state.translationEnabled) {
            // Only translate chunks from this point forward
            state.translationStartIdx = state.transcriptParts.length;
            showToast(`${t('toast_cabin_on')} ${el.translationLang.value}`, 'success');
        }
    });

    // Audio source pills
    document.querySelectorAll('.source-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            if (state.recording) {
                showToast(t('toast_no_source_change'), 'error');
                return;
            }
            document.querySelectorAll('.source-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            state.audioSource = pill.dataset.source;
        });
    });

    // Language toggle
    $id('btnLangToggle').addEventListener('click', () => {
        setLanguage(currentLang === 'vi' ? 'en' : 'vi');
        updateLangToggle();
    });

    // Back button
    el.btnBack.addEventListener('click', () => showView('list'));

    // Sub-tabs
    document.querySelectorAll('.sub-tab').forEach(tab => {
        tab.addEventListener('click', () => switchDetailTab(tab.dataset.detailTab));
    });

    // Settings
    el.btnSettings.addEventListener('click', openSettings);
    el.closeSettings.addEventListener('click', closeSettings);
    el.cancelSettings.addEventListener('click', closeSettings);
    el.saveSettings.addEventListener('click', saveSettingsAction);
    el.btnDiagnose.addEventListener('click', runDiagnose);
    // Settings modal: only close via X button, not by clicking overlay
    // Also close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !el.settingsModal.classList.contains('hidden')) closeSettings();
    });

    document.querySelectorAll('.radio-card input').forEach(radio => {
        radio.addEventListener('change', () => {
            document.querySelectorAll('.radio-card').forEach(c => c.classList.remove('active'));
            radio.closest('.radio-card').classList.add('active');
            el.nvidiaSettings.classList.toggle('hidden', radio.value !== 'nvidia');
            el.groqSettings.classList.toggle('hidden', radio.value !== 'groq');
            el.localSettings.classList.toggle('hidden', radio.value !== 'local');
        });
    });
}

// ─── View Navigation ───
function showView(view) {
    state.currentView = view;
    el.viewMeetings.classList.toggle('active', view === 'list');
    el.viewDetail.classList.toggle('active', view === 'detail');
    if (view === 'list') loadMeetings();
}

function switchDetailTab(tabId) {
    state.activeDetailTab = tabId;
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.toggle('active', t.dataset.detailTab === tabId));
    document.querySelectorAll('.detail-pane').forEach(p => p.classList.remove('active'));
    $id(tabId === 'recording' ? 'paneRecording' : 'paneSummary').classList.add('active');
}

// Compatibility wrapper — old code calls switchTab
function switchTab(tabId) {
    if (tabId === 'meetings') {
        showView('list');
    } else if (tabId === 'recording') {
        showView('detail');
        switchDetailTab('recording');
    } else if (tabId === 'summary') {
        showView('detail');
        switchDetailTab('summary');
    }
}

// ─── Recording ───

// Get system audio stream (desktop loopback via Electron, or display media on web)
async function getSystemAudioStream() {
    try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: { width: 320, height: 240, frameRate: 30 }
        });
        // Stop video track immediately — we only need audio
        displayStream.getVideoTracks().forEach(t => t.stop());
        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length === 0) {
            throw new Error(t('toast_no_system_audio'));
        }
        return new MediaStream(audioTracks);
    } catch (err) {
        console.error('System audio error:', err);
        throw err;
    }
}

// Get merged mic + system audio stream
async function getMixedAudioStream() {
    const [micStream, sysStream] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: true }),
        getSystemAudioStream(),
    ]);
    // Merge using Web Audio API
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(micStream).connect(dest);
    ctx.createMediaStreamSource(sysStream).connect(dest);
    // Keep references for cleanup
    const merged = dest.stream;
    merged._sources = [micStream, sysStream];
    merged._audioCtx = ctx;
    return merged;
}

async function toggleRecording() {
    if (state.recording) { stopRecording(); return; }

    try {
        // Request mic access on Electron/macOS before recording
        if (window.electronAPI?.requestMicAccess) {
            const granted = await window.electronAPI.requestMicAccess();
            if (!granted) {
                showToast(t('toast_mic_denied_mac'), 'error', 6000);
                return;
            }
        }

        let stream;
        if (state.audioSource === 'mic') {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else if (state.audioSource === 'system') {
            stream = await getSystemAudioStream();
        } else {
            // 'both': merge mic + system audio
            stream = await getMixedAudioStream();
        }
        state.audioStream = stream;
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/ogg;codecs=opus',
        ];
        state.mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || '';
        // Determine file extension from MIME type
        const extMap = { 'audio/webm;codecs=opus': 'webm', 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg;codecs=opus': 'ogg' };
        state.audioExt = extMap[state.mimeType] || 'webm';
        console.log('MediaRecorder mimeType:', state.mimeType || '(browser default)', '→ ext:', state.audioExt);

        const isResumingDraft = !!state.draftId;
        if (!isResumingDraft) {
            // Fresh recording — reset transcript
            state.transcriptParts = [];
            state.seconds = 0;
        }
        // else: keep existing transcriptParts and seconds from restored draft

        state.recording = true;
        state.recordStartTime = Date.now() - (state.seconds * 1000); // offset for resumed time

        // Create a draft in DB for recovery (only if not resuming)
        if (!isResumingDraft) {
            try {
                const dr = await fetch('/api/drafts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ language: 'vi' }),
                });
                const drData = await dr.json();
                state.draftId = drData.id;
            } catch (e) {
                console.warn('Draft create failed:', e);
            }
        }

        // UI updates
        el.btnRecord.querySelector('.rec-main-icon').innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            </svg>`;
        el.btnRecord.classList.add('active');
        el.recBar.classList.add('recording');
        el.btnStop.classList.remove('hidden');
        el.btnPause.classList.remove('hidden');
        el.recWaveWrap.classList.remove('hidden');
        el.recordTimer.classList.remove('hidden');
        el.recIndicator.classList.remove('hidden');
        el.emptyState.classList.add('hidden');
        el.btnSummarize.classList.add('hidden');
        el.btnDownloadAudio.classList.add('hidden');

        switchTab('recording');

        // Timer
        updateTimerDisplay();
        state.timer = setInterval(() => {
            state.seconds++;
            updateTimerDisplay();
        }, 1000);

        // Waveform
        const audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        state.analyser = audioCtx.createAnalyser();
        state.analyser.fftSize = 256;
        source.connect(state.analyser);
        drawWaveform();

        // Start recording
        console.log('[DEBUG] Starting recorder session, mimeType:', state.mimeType, 'ext:', state.audioExt);
        startRecorderSession();

        // VAD-based chunk splitting with auto-calibrating noise floor
        const VAD_CHECK_MS = 80;          // check every 80ms for responsiveness
        const SILENCE_DURATION = 800;     // 800ms silence to trigger cut (natural pause)
        const MIN_CHUNK_SEC = 5;          // min chunk 5s for better Whisper context
        const MAX_CHUNK_SEC = 30;         // force cut at 30s (hard cap)
        const SMOOTHING = 0.3;            // exponential smoothing factor (0-1, lower = smoother)
        const CALIBRATION_MS = 500;       // calibrate noise floor from first 500ms

        state.chunkStartTime = Date.now();
        state.silenceStart = 0;
        state.isSilent = false;

        let smoothedRms = 0;
        let noiseFloor = 0.01;            // default, will be calibrated
        let calibrationSamples = [];
        let calibrated = false;

        state.vadInterval = setInterval(() => {
            if (!state.recording || state.paused || !state.analyser) return;
            if (!state.mediaRecorder || state.mediaRecorder.state !== 'recording') return;

            // Calculate RMS audio level
            const bufferLength = state.analyser.fftSize;
            const dataArray = new Float32Array(bufferLength);
            state.analyser.getFloatTimeDomainData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) sum += dataArray[i] * dataArray[i];
            const rms = Math.sqrt(sum / bufferLength);

            // Exponential smoothing to avoid spikes
            smoothedRms = SMOOTHING * rms + (1 - SMOOTHING) * smoothedRms;

            // Auto-calibrate noise floor from first 500ms
            if (!calibrated) {
                calibrationSamples.push(rms);
                const elapsed = Date.now() - state.chunkStartTime;
                if (elapsed >= CALIBRATION_MS && calibrationSamples.length > 0) {
                    // Noise floor = median of calibration samples × 2
                    const sorted = calibrationSamples.slice().sort((a, b) => a - b);
                    noiseFloor = Math.max(0.005, sorted[Math.floor(sorted.length / 2)] * 2);
                    calibrated = true;
                    console.log(`VAD calibrated: noise floor = ${noiseFloor.toFixed(4)}`);
                }
                return; // don't cut during calibration
            }

            const now = Date.now();
            const chunkAge = (now - state.chunkStartTime) / 1000;
            const isSilent = smoothedRms < noiseFloor;

            if (isSilent) {
                if (!state.isSilent) {
                    state.isSilent = true;
                    state.silenceStart = now;
                }
                const silenceDuration = now - state.silenceStart;

                // Cut on natural pause: silence + minimum chunk reached
                if (silenceDuration >= SILENCE_DURATION && chunkAge >= MIN_CHUNK_SEC) {
                    console.log(`[DEBUG] VAD cut: chunkAge=${chunkAge.toFixed(1)}s silence=${silenceDuration}ms`);
                    state.chunkStartTime = now;
                    state.isSilent = false;
                    state.mediaRecorder.stop();
                }
            } else {
                state.isSilent = false;
                state.silenceStart = 0;
            }

            // Safety cap: force cut
            if (chunkAge >= MAX_CHUNK_SEC) {
                console.log(`[DEBUG] Force cut at ${MAX_CHUNK_SEC}s`);
                state.chunkStartTime = now;
                state.isSilent = false;
                state.mediaRecorder.stop();
            }
        }, VAD_CHECK_MS);

    } catch (err) {
        console.error('Recording error:', err);
        if (err.name === 'ScreenCaptureError') {
            showToast(err.message, 'error', 8000);
        } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
            if (window.electronAPI?.isElectron && window.electronAPI?.platform === 'darwin') {
                showToast(t('toast_mic_denied_mac'), 'error', 6000);
            } else {
                showToast(t('toast_mic_denied'), 'error');
            }
        } else if (err.name === 'NotFoundError') {
            showToast(t('toast_mic_not_found'), 'error');
        } else {
            showToast(t('toast_mic_error') + err.message, 'error');
        }
    }
}

function startRecorderSession() {
    if (!state.recording || !state.audioStream) return;

    const recorderOpts = state.mimeType ? { mimeType: state.mimeType } : undefined;
    const recorder = new MediaRecorder(state.audioStream, recorderOpts);
    let chunks = [];
    // Capture the actual start time of this recording segment
    const segmentStartMs = Date.now();

    recorder.onerror = (e) => console.error('MediaRecorder error:', e.error || e);

    recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
            chunks.push(e.data);
            state.allAudioChunks.push(e.data);
        }
    };

    recorder.onstop = () => {
        console.log(`[DEBUG] Recorder stopped, chunks: ${chunks.length}, totalSize: ${chunks.reduce((s, c) => s + c.size, 0)} bytes`);
        if (chunks.length > 0) {
            const blob = new Blob(chunks, { type: state.mimeType });
            // Calculate actual times relative to recording start
            const startSec = state.recordStartTime ? (segmentStartMs - state.recordStartTime) / 1000 : 0;
            const endSec = state.recordStartTime ? (Date.now() - state.recordStartTime) / 1000 : 0;
            sendChunkBlob(blob, startSec, endSec);
        }
        if (state.recording) startRecorderSession();
    };

    recorder.start(500);
    state.mediaRecorder = recorder;
}

function stopRecording() {
    state.recording = false;
    state.paused = false;

    if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop();
    }
    if (state.vadInterval) clearInterval(state.vadInterval);
    if (state.timer) clearInterval(state.timer);
    if (state.animFrame) cancelAnimationFrame(state.animFrame);
    if (state.audioStream) {
        // Clean up merged stream sub-sources if present (both mode)
        if (state.audioStream._sources) {
            state.audioStream._sources.forEach(s => s.getTracks().forEach(t => t.stop()));
        }
        if (state.audioStream._audioCtx) {
            state.audioStream._audioCtx.close().catch(() => { });
        }
        state.audioStream.getTracks().forEach(t => t.stop());
        state.audioStream = null;
    }

    // UI reset
    el.btnRecord.querySelector('.rec-main-icon').innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="8"/>
        </svg>`;
    el.btnRecord.classList.remove('active');
    el.recBar.classList.remove('recording', 'paused');
    el.btnStop.classList.add('hidden');
    el.btnPause.classList.add('hidden');
    el.recWaveWrap.classList.add('hidden');
    el.recordTimer.classList.add('hidden');
    el.recIndicator.classList.add('hidden');

    if (state.transcriptParts.length > 0) {
        el.btnSummarize.classList.remove('hidden');
    }
    if (state.allAudioChunks.length > 0) {
        el.btnDownloadAudio.classList.remove('hidden');
        // Auto-upload audio to server for persistence
        uploadAudioToServer();
    }
}

async function uploadAudioToServer() {
    const meetingId = state.draftId || state.currentMeetingId;
    if (!meetingId || state.allAudioChunks.length === 0) return;

    try {
        const blob = new Blob(state.allAudioChunks, { type: state.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('audio', blob, 'meeting.webm');
        await fetch(`/api/meetings/${meetingId}/audio`, { method: 'POST', body: form });
        console.log('Audio saved to server');
    } catch (err) {
        console.warn('Audio upload failed:', err);
    }
}

// ─── Pause / Resume ───
function togglePause() {
    if (!state.recording || !state.mediaRecorder) return;

    if (state.paused) {
        // Resume
        state.mediaRecorder.resume();
        state.paused = false;
        state.timer = setInterval(() => { state.seconds++; updateTimerDisplay(); }, 1000);
        el.recBar.classList.remove('paused');
        el.recIndicator.querySelector('.rec-dot-live')?.classList.remove('paused');
        el.btnPause.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
        drawWaveform();
        showToast(t('toast_resumed'), 'success');
    } else {
        // Pause
        state.mediaRecorder.pause();
        state.paused = true;
        if (state.timer) clearInterval(state.timer);
        if (state.animFrame) cancelAnimationFrame(state.animFrame);
        el.recBar.classList.add('paused');
        el.recIndicator.querySelector('.rec-dot-live')?.classList.add('paused');
        el.btnPause.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>`;
        showToast(t('toast_paused'), 'info');
    }
}

// ─── Download Audio ───
async function downloadAudio() {
    if (state.allAudioChunks.length === 0) {
        showToast(t('toast_no_audio'), 'error');
        return;
    }

    showToast(t('toast_converting_wav'), 'info');
    const blob = new Blob(state.allAudioChunks, { type: state.mimeType || 'audio/webm' });
    const formData = new FormData();
    formData.append('audio', blob, 'meeting.webm');

    try {
        const r = await fetch('/api/convert-wav', { method: 'POST', body: formData });
        if (!r.ok) throw new Error('Convert failed');

        const wavBlob = await r.blob();
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `meeting_${new Date().toISOString().slice(0, 10)}.wav`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(t('toast_wav_done'), 'success');
    } catch (err) {
        console.error('Download error:', err);
        showToast(t('toast_wav_error'), 'error');
    }
}

function updateTimerDisplay() {
    const m = Math.floor(state.seconds / 60);
    const s = state.seconds % 60;
    el.recordTimer.textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Waveform ───
function initCanvas() {
    const canvas = el.waveformCanvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 200 * dpr;
    canvas.height = 32 * dpr;
    ctx.scale(dpr, dpr);
}

function drawWaveform() {
    const canvas = el.waveformCanvas;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;

    function draw() {
        if (!state.recording) return;
        state.animFrame = requestAnimationFrame(draw);

        const data = new Uint8Array(state.analyser.frequencyBinCount);
        state.analyser.getByteFrequencyData(data);

        ctx.clearRect(0, 0, W, H);

        const barW = 2.5;
        const gap = 1.5;
        const bars = Math.floor(W / (barW + gap));
        const step = Math.floor(data.length / bars);

        for (let i = 0; i < bars; i++) {
            const val = data[i * step] / 255;
            const h = Math.max(2, val * H * 0.85);
            const x = i * (barW + gap);
            const y = (H - h) / 2;

            ctx.fillStyle = val > 0.4 ? '#ef4444' : '#d1d5db';
            ctx.beginPath();
            ctx.roundRect(x, y, barW, h, 1);
            ctx.fill();
        }
    }
    draw();
}

// ─── Transcription ───
async function sendChunkBlob(blob, startSec, endSec) {
    const ext = state.audioExt || 'webm';
    const filename = `${Date.now()}-chunk.${ext}`;
    const form = new FormData();
    form.append('audio', blob, filename);

    // Attach timing captured at recording moment
    state.chunkQueue.push({ form, startSec, endSec });
    if (!state.isTranscribing) processQueue();
}

async function processQueue() {
    if (state.chunkQueue.length === 0) { state.isTranscribing = false; return; }
    state.isTranscribing = true;

    const { form, startSec, endSec } = state.chunkQueue.shift();
    try {
        const res = await fetch('/api/transcribe', { method: 'POST', body: form });
        console.log(`[DEBUG] Transcription response status: ${res.status}`);
        const data = await res.json();

        if (data.text && data.text.trim()) {
            const text = data.text.trim();

            // Filter Whisper hallucinations
            const HALLUCINATIONS = [
                'các bạn hãy kênh của chúng mình nhé',
                'cảm ơn các bạn đã theo dõi',
                'hãy đăng ký kênh',
                'hãy subscribe kênh',
                'hãy like và subscribe',
                'xin chào các bạn',
                'cảm ơn đã xem',
                'hẹn gặp lại các bạn',
                'thank you for watching',
                'please subscribe',
                'like and subscribe',
            ];
            const lower = text.toLowerCase();
            const isHallucination = HALLUCINATIONS.some(h => lower.includes(h))
                || text.length <= 3
                || /^(.)\1+$/.test(text.replace(/\s/g, ''));

            if (isHallucination) {
                console.log('Filtered hallucination:', text);
                processQueue();
                return;
            }
            state.transcriptParts.push({
                text: data.text.trim(),
                startTime: Math.max(0, startSec).toFixed(1),
                endTime: Math.max(0, endSec).toFixed(1),
                timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                translation: '',
            });

            renderTranscript();

            // Auto-translate if cabin translation is enabled
            if (state.translationEnabled) {
                translateChunk(state.transcriptParts.length - 1);
            }

            // Auto-save to server draft
            if (state.draftId) {
                const line = `[${Math.max(0, startSec).toFixed(1)}s-${Math.max(0, endSec).toFixed(1)}s] ${data.text.trim()}`;
                fetch(`/api/drafts/${state.draftId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ appendText: line, audioDuration: state.seconds }),
                }).catch(() => { });
            }
        }
    } catch (err) {
        console.error('Transcribe error:', err);
        showToast(`Transcription error: ${err.message}`, 'error');
    }

    processQueue();
}

function renderTranscript() {
    el.emptyState.classList.add('hidden');

    const fmtSec = (v) => {
        const sec = typeof v === 'string' ? parseFloat(v) || 0 : v;
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    el.transcriptContent.innerHTML = state.transcriptParts.map((p, i) => {
        const isLast = i === state.transcriptParts.length - 1;
        const timeLabel = p.endTime ? `${fmtSec(p.startTime)} - ${fmtSec(p.endTime)}` : fmtSec(p.startTime);
        const shouldTranslate = state.translationEnabled && i >= state.translationStartIdx;
        const translationHtml = p.translation
            ? `<div class="transcript-translation" id="ttrans-${i}">${escapeHtml(p.translation)}</div>`
            : (shouldTranslate ? `<div class="transcript-translation streaming" id="ttrans-${i}"></div>` : '');
        return `
            <div class="transcript-item ${isLast && state.recording ? 'live' : ''}" data-index="${i}">
                <div class="transcript-time">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    ${timeLabel}
                </div>
                <div class="transcript-text" id="ttext-${i}">${escapeHtml(p.text)}</div>
                ${translationHtml}
                <div class="transcript-actions">
                    <button class="transcript-action-btn t-edit-btn" data-idx="${i}" title="Sửa">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
                        </svg>
                    </button>
                    ${p.translation ? `<button class="transcript-action-btn t-edit-translation-btn" data-idx="${i}" title="Sửa bản dịch" style="color:var(--primary,#6366f1)">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M5 8l6 6"/><path d="M4 14l6 6"/><path d="M2 5h12"/><path d="M7 2v6"/><path d="M15 11h7"/><path d="M18 8v6"/>                        </svg>
                    </button>` : ''}
                    <button class="transcript-action-btn t-delete-btn" data-idx="${i}" title="Xóa">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
                        </svg>
                    </button>
                </div>
            </div>`;
    }).join('');

    // Bind edit buttons
    el.transcriptContent.querySelectorAll('.t-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editTranscriptItem(parseInt(btn.dataset.idx));
        });
    });

    // Bind delete buttons
    el.transcriptContent.querySelectorAll('.t-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteTranscriptItem(parseInt(btn.dataset.idx));
        });
    });

    // Bind edit translation buttons
    el.transcriptContent.querySelectorAll('.t-edit-translation-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editTranslationItem(parseInt(btn.dataset.idx));
        });
    });

    const content = document.querySelector('.tab-content');
    if (content) content.scrollTop = content.scrollHeight;
}

// ─── Cabin Translation ───
async function translateChunk(idx) {
    const part = state.transcriptParts[idx];
    if (!part || !part.text) return;

    const targetLang = el.translationLang.value;
    let transEl = document.getElementById(`ttrans-${idx}`);

    // Create the translation element if it doesn't exist
    if (!transEl) {
        const itemEl = el.transcriptContent.querySelector(`[data-index="${idx}"]`);
        if (!itemEl) return;
        transEl = document.createElement('div');
        transEl.className = 'transcript-translation streaming';
        transEl.id = `ttrans-${idx}`;
        const textEl = itemEl.querySelector('.transcript-text');
        textEl.after(transEl);
    }

    transEl.classList.add('streaming');
    transEl.textContent = '';

    try {
        const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: part.text, targetLang }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let translated = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        if (data.token) {
                            translated += data.token;
                            transEl.textContent = translated;
                            // Auto scroll
                            const content = document.querySelector('.tab-content');
                            if (content) content.scrollTop = content.scrollHeight;
                        }
                    } catch { }
                }
            }
        }

        state.transcriptParts[idx].translation = translated;
        transEl.classList.remove('streaming');
    } catch (err) {
        console.error('Translation error:', err);
        transEl.textContent = '⚠️ ' + t('translation_error');
        transEl.classList.remove('streaming');
    }
}

function editTranscriptItem(idx) {
    const textEl = document.getElementById(`ttext-${idx}`);
    if (!textEl) return;
    const original = state.transcriptParts[idx].text;

    textEl.contentEditable = 'true';
    textEl.classList.add('editing');
    textEl.focus();

    // Select all text
    const range = document.createRange();
    range.selectNodeContents(textEl);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    const save = () => {
        const newText = textEl.textContent.trim();
        textEl.contentEditable = 'false';
        textEl.classList.remove('editing');
        if (newText && newText !== original) {
            state.transcriptParts[idx].text = newText;
            showToast(t('toast_transcript_updated'), 'success');
            autoSaveDraft();
        } else if (!newText) {
            textEl.textContent = original;
        }
    };

    textEl.addEventListener('blur', save, { once: true });
    textEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); textEl.blur(); }
        if (e.key === 'Escape') { textEl.textContent = original; textEl.blur(); }
    });
}

function deleteTranscriptItem(idx) {
    state.transcriptParts.splice(idx, 1);
    renderTranscript();
    showToast(t('toast_transcript_deleted'), 'success');
    autoSaveDraft();
}

function clearAllTranscript() {
    if (state.transcriptParts.length === 0) return;
    if (!confirm(t('confirm_clear_all') || 'Xóa tất cả transcript?')) return;
    state.transcriptParts = [];
    el.transcriptContent.innerHTML = '';
    el.emptyState.classList.remove('hidden');
    showToast(t('toast_transcript_cleared') || 'Đã xóa tất cả transcript', 'success');
    autoSaveDraft();
}

function editTranslationItem(idx) {
    const transEl = document.getElementById(`ttrans-${idx}`);
    if (!transEl) return;
    const original = state.transcriptParts[idx].translation || '';

    transEl.contentEditable = 'true';
    transEl.classList.add('editing');
    transEl.focus();

    const range = document.createRange();
    range.selectNodeContents(transEl);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    const save = () => {
        const newText = transEl.textContent.trim();
        transEl.contentEditable = 'false';
        transEl.classList.remove('editing');
        if (newText !== original) {
            state.transcriptParts[idx].translation = newText;
            showToast(t('toast_translation_updated') || 'Đã cập nhật bản dịch', 'success');
            autoSaveDraft();
        }
    };

    transEl.addEventListener('blur', save, { once: true });
    transEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); transEl.blur(); }
        if (e.key === 'Escape') { transEl.textContent = original; transEl.blur(); }
    });
}

function autoSaveDraft() {
    const id = state.draftId || state.currentMeetingId;
    if (!id) return;
    const fullText = state.transcriptParts.map(p => `[${p.startTime}s-${p.endTime || p.startTime}s] ${p.text}`).join('\n');
    fetch(`/api/meetings/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: fullText }),
    }).catch(() => { });
}

// ─── Copy Transcript ───
function copyTranscript() {
    if (state.transcriptParts.length === 0) {
        showToast(t('toast_no_transcript_copy'), 'info');
        return;
    }

    const toVttTime = (val) => {
        const secs = typeof val === 'string' ? parseFloat(val) || 0 : val;
        const h = Math.floor(secs / 3600).toString().padStart(2, '0');
        const m = Math.floor((secs % 3600) / 60).toString().padStart(2, '0');
        const s = Math.floor(secs % 60).toString().padStart(2, '0');
        const ms = Math.round((secs % 1) * 1000).toString().padStart(3, '0');
        return `${h}:${m}:${s}.${ms}`;
    };

    let vtt = 'WEBVTT\n\n';
    state.transcriptParts.forEach((p, i) => {
        const start = toVttTime(p.startTime);
        const end = p.endTime ? toVttTime(p.endTime) : toVttTime(parseFloat(p.startTime || 0) + 5);
        vtt += `${i + 1}\n${start} --> ${end}\n${p.text}\n\n`;
    });

    navigator.clipboard.writeText(vtt.trim()).then(() => {
        showToast(t('toast_copied_vtt'), 'success');
    });
}

// ─── Summarize ───
async function summarizeTranscript() {
    const meetingId = state.draftId || state.currentMeetingId;
    if (!meetingId) {
        showToast('Không tìm thấy cuộc họp để tạo biên bản', 'error');
        return;
    }

    el.processingState.classList.remove('hidden');
    el.processingText.textContent = 'AI đang tạo biên bản...';
    el.processingState.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.btnSummarize.classList.add('hidden');

    try {
        const res = await fetch('/api/summarize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ meetingId }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `HTTP ${res.status}`);
        }

        // Read SSE stream
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let summaryData = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop(); // keep incomplete chunk

            for (const chunk of lines) {
                if (!chunk.startsWith('data: ')) continue;
                try {
                    const event = JSON.parse(chunk.slice(6));

                    if (event.type === 'progress') {
                        el.processingText.textContent = event.message;
                    } else if (event.type === 'done') {
                        summaryData = event.summary;
                    } else if (event.type === 'error') {
                        throw new Error(event.error);
                    }
                } catch (parseErr) {
                    if (parseErr.message.startsWith('Lỗi')) throw parseErr;
                }
            }
        }

        el.processingState.classList.add('hidden');

        if (summaryData) {
            switchTab('summary');
            el.summaryEmpty.classList.add('hidden');
            el.minutesContent.innerHTML = formatMinutes(summaryData);
            el.btnExport.classList.remove('hidden');
            // Server already saved summary to DB — just reload meetings list
            state.currentMeetingId = meetingId;
            state.draftId = null;
            loadMeetings();
            showToast(t('toast_minutes_done'), 'success');
        } else {
            el.btnSummarize.classList.remove('hidden');
            showToast(t('toast_minutes_empty'), 'error');
        }
    } catch (err) {
        console.error('Summarize error:', err);
        el.processingState.classList.add('hidden');
        el.btnSummarize.classList.remove('hidden');
        showToast(t('toast_minutes_error') + err.message, 'error');
    }
}

function formatMinutes(text) {
    try {
        const obj = typeof text === 'string' ? JSON.parse(text) : text;
        let html = '';
        if (obj.title) html += `<h1>${escapeHtml(obj.title)}</h1>`;
        if (obj.summary) html += `<div class="summary-block"><p>${escapeHtml(obj.summary)}</p></div>`;
        if (obj.participants?.length) html += `<p><strong>Thành viên:</strong> ${escapeHtml(obj.participants.join(', '))}</p>`;

        const keyPoints = obj.keyPoints || obj.key_points;
        if (keyPoints?.length) {
            html += `<h2>📌 Nội dung chính</h2><ul>`;
            keyPoints.forEach(p => html += `<li>${escapeHtml(p)}</li>`);
            html += `</ul>`;
        }

        const actionItems = obj.actionItems || obj.action_items;
        if (actionItems?.length) {
            html += `<h2>✅ Hành động</h2><ul>`;
            actionItems.forEach(a => {
                if (typeof a === 'string') {
                    html += `<li>${escapeHtml(a)}</li>`;
                } else {
                    let item = escapeHtml(a.task || '');
                    if (a.assignee) item += ` — <em>${escapeHtml(a.assignee)}</em>`;
                    if (a.deadline) item += ` (${escapeHtml(a.deadline)})`;
                    if (a.priority && a.priority !== 'medium') item += ` <span class="priority-${a.priority}">[${a.priority}]</span>`;
                    html += `<li>${item}</li>`;
                }
            });
            html += `</ul>`;
        }

        if (obj.decisions?.length) {
            html += `<h2>🔨 Quyết định</h2><ul>`;
            obj.decisions.forEach(d => html += `<li>${escapeHtml(d)}</li>`);
            html += `</ul>`;
        }

        const risks = obj.risks;
        if (risks?.length) {
            html += `<h2>⚠️ Rủi ro / Vấn đề mở</h2><ul>`;
            risks.forEach(r => html += `<li>${escapeHtml(r)}</li>`);
            html += `</ul>`;
        }

        const nextSteps = obj.nextSteps || obj.next_steps;
        if (nextSteps?.length) {
            html += `<h2>➡️ Bước tiếp theo</h2><ul>`;
            nextSteps.forEach(s => html += `<li>${escapeHtml(s)}</li>`);
            html += `</ul>`;
        }

        const parkingLot = obj.parkingLot || obj.parking_lot;
        if (parkingLot?.length) {
            html += `<h2>💡 Ý tưởng chưa quyết định</h2><ul>`;
            parkingLot.forEach(p => html += `<li>${escapeHtml(p)}</li>`);
            html += `</ul>`;
        }

        return html || '<p>Không có dữ liệu biên bản.</p>';
    } catch {
        const s = String(text);
        return `<div>${s.replace(/\n/g, '<br>')}</div>`;
    }
}

// ─── Meetings (CRUD) ───
async function saveMeeting(transcript, summary) {
    try {
        const title = extractTitle(summary);
        let id;

        if (state.draftId) {
            // Promote draft → complete
            await fetch(`/api/meetings/${state.draftId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, transcript, summary: JSON.stringify(summary), status: 'complete' }),
            });
            id = state.draftId;
            state.draftId = null;
        } else {
            const res = await fetch('/api/meetings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, transcript, summary: JSON.stringify(summary) }),
            });
            const data = await res.json();
            id = data.id;
        }

        state.currentMeetingId = id;
        loadMeetings();
    } catch (err) {
        console.error('Save error:', err);
    }
}

// ─── Draft Recovery ───

function extractTitle(summary) {
    try {
        const obj = typeof summary === 'string' ? JSON.parse(summary) : summary;
        return obj.title || 'Cuộc họp ' + new Date().toLocaleDateString('vi-VN');
    } catch {
        return 'Cuộc họp ' + new Date().toLocaleDateString('vi-VN');
    }
}

async function loadMeetings() {
    try {
        const res = await fetch('/api/meetings');
        let meetings = await res.json();

        // Guard: API might return error object instead of array
        if (!Array.isArray(meetings)) {
            console.warn('loadMeetings: unexpected response', meetings);
            meetings = [];
        }

        // Filter out empty drafts (no transcript)
        meetings = meetings.filter(m => m.status !== 'draft' || m.title !== 'Đang ghi âm...' || true);

        // Meetings grid tab
        if (meetings.length === 0) {
            el.meetingsGrid.innerHTML = `<div class="list-empty">${t('no_meetings')}</div>`;
        } else {
            el.meetingsGrid.innerHTML = meetings.map(m => {
                const isDraft = m.status === 'draft';
                const badge = isDraft ? `<span class="draft-badge">${t('draft')}</span> ` : '';
                return `
                <div class="meeting-card" data-meeting-id="${m.id}">
                    <div class="meeting-card-info">
                        <div class="meeting-card-title">${badge}${escapeHtml(m.title)}</div>
                        <div class="meeting-card-date">${new Date(m.created_at).toLocaleDateString(currentLang === 'vi' ? 'vi-VN' : 'en-US')} · ${new Date(m.created_at).toLocaleTimeString(currentLang === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                    <div class="meeting-card-actions">
                        <button class="card-action-btn card-download-btn" data-id="${m.id}" title="${t('download_transcript')}" aria-label="${t('download_transcript')}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/>
                            </svg>
                        </button>
                        ${m.audio_path ? `<button class="card-action-btn card-audio-btn" data-id="${m.id}" title="${t('download_audio')}" aria-label="${t('download_audio')}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                            </svg>
                        </button>` : ''}
                        <button class="card-action-btn card-delete-btn" data-id="${m.id}" title="${t('delete_item')}" aria-label="${t('delete_item')}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                            </svg>
                        </button>
                    </div>
                </div>`;
            }).join('');

            // Bind card click (on info area, not action buttons)
            el.meetingsGrid.querySelectorAll('.meeting-card-info').forEach(info => {
                const card = info.closest('.meeting-card');
                info.addEventListener('click', () => loadMeeting(card.dataset.meetingId));
            });

            // Bind delete buttons
            el.meetingsGrid.querySelectorAll('.card-delete-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    deleteMeetingById(btn.dataset.id);
                });
            });

            // Bind download transcript buttons
            el.meetingsGrid.querySelectorAll('.card-download-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    downloadTranscriptById(btn.dataset.id);
                });
            });

            // Bind download audio buttons
            el.meetingsGrid.querySelectorAll('.card-audio-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    downloadAudioById(btn.dataset.id);
                });
            });
        }
    } catch (err) {
        console.error('Load meetings error:', err);
    }
}

async function deleteMeetingById(id) {
    try {
        await fetch(`/api/meetings/${id}`, { method: 'DELETE' });
        if (state.currentMeetingId === id) {
            state.currentMeetingId = null;
            state.transcriptParts = [];
            el.transcriptContent.innerHTML = '';
        }
        showToast(t('toast_meeting_deleted'), 'success');
        loadMeetings();
    } catch (err) {
        showToast(t('toast_meeting_delete_error'), 'error');
    }
}

async function downloadTranscriptById(id) {
    try {
        const res = await fetch(`/api/meetings/${id}`);
        if (!res.ok) throw new Error('Not found');
        const meeting = await res.json();
        const text = meeting.transcript || '';
        if (!text.trim()) { showToast(t('toast_no_transcript_export'), 'info'); return; }

        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${meeting.title || 'meeting'}_transcript.txt`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(t('toast_transcript_downloaded'), 'success');
    } catch (err) {
        showToast(t('toast_transcript_download_error'), 'error');
    }
}

function downloadAudioById(id) {
    const a = document.createElement('a');
    a.href = `/api/meetings/${id}/audio`;
    a.download = 'meeting.wav';
    a.click();
    showToast(t('toast_loading_audio'), 'info');
}

async function loadMeeting(id) {
    try {
        const res = await fetch(`/api/meetings/${id}`);
        if (!res.ok) {
            showToast(t('toast_meeting_load_error'), 'error');
            return;
        }
        const meeting = await res.json();
        state.currentMeetingId = id;

        // If this is a draft, set draftId so Record continues from it
        if (meeting.status === 'draft') {
            state.draftId = id;
            state.seconds = Math.floor(meeting.audio_duration || 0);
        } else {
            state.draftId = null;
        }

        // Parse transcript into parts
        const rawTranscript = meeting.transcript || '';
        if (rawTranscript) {
            const lines = rawTranscript.split('\n').filter(l => l.trim());
            state.transcriptParts = lines.map((line, i) => {
                const tsMatch = line.match(/^\[(\d+(?:\.\d+)?)s(?:-(\d+(?:\.\d+)?)s)?\]\s*/);
                const secs = tsMatch ? parseFloat(tsMatch[1]) : 0;
                const endSecs = tsMatch && tsMatch[2] ? parseFloat(tsMatch[2]) : secs;
                const m = Math.floor(secs / 60);
                const s = Math.floor(secs % 60);
                const timeStr = `${m}:${s.toString().padStart(2, '0')}`;
                return {
                    text: tsMatch ? line.slice(tsMatch[0].length) : line,
                    startTime: tsMatch ? tsMatch[1] : '0',
                    endTime: tsMatch && tsMatch[2] ? tsMatch[2] : '',
                    timestamp: tsMatch ? tsMatch[1] : '',
                };
            });
        } else {
            state.transcriptParts = [];
        }
        renderTranscript();

        // Show summary
        if (meeting.summary) {
            const summaryData = typeof meeting.summary === 'string' ? meeting.summary : JSON.stringify(meeting.summary);
            try {
                const summaryObj = typeof meeting.summary === 'object' ? meeting.summary : JSON.parse(meeting.summary);
                el.minutesContent.innerHTML = formatMinutes(summaryObj);
            } catch {
                el.minutesContent.innerHTML = `<div>${summaryData}</div>`;
            }
            el.summaryEmpty.classList.add('hidden');
            el.btnExport.classList.remove('hidden');

        } else {
            el.minutesContent.innerHTML = '';
            el.summaryEmpty.classList.remove('hidden');
            el.btnExport.classList.add('hidden');

        }

        el.emptyState.classList.add('hidden');
        switchTab('recording');

        // Show summarize button for drafts with transcript
        if (meeting.status === 'draft' && state.transcriptParts.length > 0) {
            el.btnSummarize.classList.remove('hidden');
        }

        loadMeetings();
    } catch (err) {
        console.error('Load meeting error:', err);
        showToast(t('toast_meetings_load_error'), 'error');
    }
}

function newMeeting() {
    state.currentMeetingId = null;
    state.draftId = null;
    state.transcriptParts = [];
    state.seconds = 0;
    state.recordStartTime = null;
    el.transcriptContent.innerHTML = '';
    el.minutesContent.innerHTML = '';
    el.emptyState.classList.remove('hidden');
    el.summaryEmpty.classList.remove('hidden');
    el.btnSummarize.classList.add('hidden');
    el.btnExport.classList.add('hidden');

    updateTimerDisplay();
    switchTab('recording');
    loadMeetings();
}

async function exportMeeting() {
    // Show export options
    const choice = await showExportPicker();
    if (!choice) return;

    const id = state.currentMeetingId || state.draftId;
    if (!id) { showToast(t('toast_no_meeting_export'), 'info'); return; }

    if (choice === 'md') {
        try {
            const res = await fetch(`/api/meetings/${id}/export`, { method: 'POST' });
            const data = await res.json();
            if (!data.markdown) throw new Error('Empty');
            const blob = new Blob([data.markdown], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${data.title || 'meeting'}.md`;
            a.click();
            URL.revokeObjectURL(url);
            showToast(t('toast_md_exported'), 'success');
        } catch (err) {
            showToast(t('toast_md_error'), 'error');
        }
    } else if (choice === 'docx') {
        try {
            const res = await fetch(`/api/meetings/${id}/export-docx`, { method: 'POST' });
            if (!res.ok) throw new Error('Failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `meeting.docx`;
            a.click();
            URL.revokeObjectURL(url);
            showToast(t('toast_docx_exported'), 'success');
        } catch (err) {
            showToast(t('toast_docx_error'), 'error');
        }
    }
}

function showExportPicker() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'export-overlay';
        overlay.innerHTML = `
            <div class="export-picker">
                <div class="export-picker-title">Chọn định dạng xuất</div>
                <button class="export-option" data-type="md">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>
                    </svg>
                    <div>
                        <div class="export-option-name">Markdown (.md)</div>
                        <div class="export-option-desc">Dễ chỉnh sửa, tương thích Notion/Obsidian</div>
                    </div>
                </button>
                <button class="export-option" data-type="docx">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 15v-2"/><path d="M12 15v-4"/><path d="M15 15v-6"/>
                    </svg>
                    <div>
                        <div class="export-option-name">Word (.docx)</div>
                        <div class="export-option-desc">Mở được trên Word, Google Docs</div>
                    </div>
                </button>
            </div>
        `;
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));

        overlay.querySelectorAll('.export-option').forEach(btn => {
            btn.addEventListener('click', () => {
                overlay.remove();
                resolve(btn.dataset.type);
            });
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { overlay.remove(); resolve(null); }
        });
    });
}

async function deleteMeeting() {
    if (!state.currentMeetingId) return;
    const yes = await showConfirm(t('confirm_delete'));
    if (!yes) return;

    try {
        await fetch(`/api/meetings/${state.currentMeetingId}`, { method: 'DELETE' });
        showToast(t('toast_meeting_deleted'), 'success');
        newMeeting();
    } catch (err) {
        console.error('Delete error:', err);
        showToast(t('toast_meeting_delete_error'), 'error');
    }
}

// ─── Utilities ───
function escapeHtml(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}

// ─── Settings ───

async function openSettings() {
    el.settingsModal.classList.remove('hidden');
    checkSTTHealth();
    await loadSTTConfig();
}

function closeSettings() {
    el.settingsModal.classList.add('hidden');
}

async function checkSTTHealth() {
    const dot = el.sttStatus.querySelector('.status-dot');
    const text = el.sttStatus.querySelector('.status-text');
    dot.className = 'status-dot loading';
    text.textContent = t('stt_checking');

    try {
        const r = await fetch('/api/stt-health');
        const data = await r.json();
        if (data.status === 'ok') {
            dot.className = 'status-dot online';
            text.textContent = `${t('stt_online')} — ${data.backend === 'nvidia' ? 'Nvidia Cloud' : 'Local Parakeet'}`;
        } else {
            dot.className = 'status-dot offline';
            text.textContent = t('stt_offline');
        }
    } catch {
        dot.className = 'status-dot offline';
        text.textContent = t('stt_offline_short');
    }
}

async function loadSTTConfig() {
    try {
        const r = await fetch('/api/stt-health');
        const data = await r.json();
        if (!data) return;

        const radio = document.querySelector(`input[name="sttBackend"][value="${data.backend || 'local'}"]`);
        if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change'));
        }

        el.preprocessToggle.checked = data.preprocessing !== false;
    } catch {
        // STT may be offline
    }

    // Load config + show provider status badges
    try {
        const r = await fetch('/api/settings');
        const cfg = await r.json();
        if (cfg.llmBaseUrl) el.llmBaseUrl.value = cfg.llmBaseUrl;
        if (cfg.llmModel) el.llmModel.value = cfg.llmModel;
        el.llmApiKey.placeholder = cfg.llmApiKeySet ? t('key_configured') : 'sk-xxx';

        // Show configured badges on STT radio cards
        const badgeMap = { groq: cfg.groqApiKeySet, nvidia: cfg.nvidiaApiKeySet };
        document.querySelectorAll('.radio-card[data-stt-backend]').forEach(card => {
            const backend = card.dataset.sttBackend;
            card.querySelectorAll('.config-badge').forEach(b => b.remove());
            if (backend === 'local') return;
            const badge = document.createElement('span');
            badge.className = badgeMap[backend] ? 'config-badge configured' : 'config-badge not-configured';
            badge.textContent = badgeMap[backend] ? t('configured') : t('not_configured');
            card.querySelector('.radio-card-inner').appendChild(badge);
        });

        // Update API key placeholders
        if (el.groqApiKey) el.groqApiKey.placeholder = cfg.groqApiKeySet ? t('key_configured') : 'gsk_xxx';
        if (el.nvidiaApiKey) el.nvidiaApiKey.placeholder = cfg.nvidiaApiKeySet ? t('key_configured') : 'nvapi-xxx';
    } catch { }
}

// ─── Diagnose ───
async function runDiagnose() {
    const box = el.diagnoseResults;
    box.classList.remove('hidden');
    box.innerHTML = `
        <div class="diagnose-item"><span class="diagnose-dot checking"></span> ${t('diagnose_checking')}</div>
    `;

    try {
        const res = await fetch('/api/diagnose');
        const data = await res.json();

        const statusIcon = (s) => `<span class="diagnose-dot ${s}"></span>`;
        box.innerHTML = `
            <div class="diagnose-item">${statusIcon(data.stt.status)} <strong>STT (${data.backend}):</strong>&nbsp;${data.stt.message}</div>
            <div class="diagnose-item">${statusIcon(data.llm.status)} <strong>LLM:</strong>&nbsp;${data.llm.message}</div>
        `;
    } catch (err) {
        box.innerHTML = `
            <div class="diagnose-item"><span class="diagnose-dot error"></span> ${t('diagnose_fail')}: ${err.message}</div>
        `;
    }
}

async function saveSettingsAction() {
    const backend = document.querySelector('input[name="sttBackend"]:checked')?.value || 'local';
    const preprocessing = el.preprocessToggle.checked;
    const apiKey = el.nvidiaApiKey.value.trim();

    try {
        const body = { backend, preprocessing };
        if (backend === 'nvidia' && apiKey) body.nvidia_api_key = apiKey;

        const groqKey = el.groqApiKey.value.trim();
        if (backend === 'groq' && groqKey) body.groq_api_key = groqKey;
        const llmKey = el.llmApiKey.value.trim();
        if (llmKey) body.llm_api_key = llmKey;
        const llmUrl = el.llmBaseUrl.value.trim();
        if (llmUrl) body.llm_base_url = llmUrl;
        const llmMod = el.llmModel.value.trim();
        if (llmMod) body.llm_model = llmMod;

        const r = await fetch('/api/stt-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!r.ok) {
            showToast(t('toast_save_failed'), 'error');
            return;
        }

        const data = await r.json();
        if (data.ok) {
            closeSettings();
            showToast(t('toast_saved'), 'success');
        } else {
            showToast(t('toast_save_error') + (data.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        showToast(t('toast_server_error'), 'error');
    }
}
