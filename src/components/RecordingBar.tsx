import { useRef, useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { resetDiarize, createDraft, appendDraft, appendDraftAudio, downloadTextFile } from '../lib/api';
import { consumeSseResponse } from '../lib/sse';
import { fetchSidecar, SIDECAR_WS_BASES, waitForSidecarReady } from '../lib/sidecar';
import { t } from '../i18n';

const isTauri = !!(window as any).__TAURI_INTERNALS__;
const isMac = navigator.platform?.toLowerCase().includes('mac') ?? false;

async function safeInvoke(cmd: string, args?: any) {
    if (!isTauri) {
        console.warn(`[Tauri] Not in Tauri env, skipping invoke('${cmd}')`);
        return null;
    }
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke(cmd, args);
}

function extractMinutesTitle(summary: string): string | null {
    const raw = String(summary || '').trim();
    if (!raw) return null;

    const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const jsonCandidate = (fenced?.[1] || raw).trim();
    if (jsonCandidate.startsWith('{') && jsonCandidate.endsWith('}')) {
        try {
            const parsed = JSON.parse(jsonCandidate);
            const jsonTitle = String(parsed?.title || '').trim();
            if (jsonTitle) return jsonTitle.slice(0, 160);
        } catch { }
    }

    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const h1 = lines.find((line) => /^#\s+/.test(line));
    if (h1) return h1.replace(/^#\s+/, '').trim().slice(0, 160);

    const explicitTitle = lines.find((line) => /^(tiêu đề|tieu de|title)\s*[:\-]/i.test(line));
    if (explicitTitle) {
        return explicitTitle
            .replace(/^(tiêu đề|tieu de|title)\s*[:\-]\s*/i, '')
            .trim()
            .slice(0, 160);
    }

    const firstContent = lines.find((line) =>
        !/^##\s+/.test(line) && !/^[-*]\s+/.test(line) && !/^\d+\.\s+/.test(line)
    );
    return firstContent ? firstContent.slice(0, 160) : null;
}

async function openNvidiaWebSocket(preferredHttpBase: string | null): Promise<WebSocket | null> {
    const preferredWs = preferredHttpBase
        ? preferredHttpBase.replace(/^http/, 'ws')
        : null;
    const wsBases = preferredWs
        ? [preferredWs, ...SIDECAR_WS_BASES.filter((b) => b !== preferredWs)]
        : [...SIDECAR_WS_BASES];

    for (const base of wsBases) {
        const url = `${base}/ws/nvidia-stream`;
        try {
            const ws = new WebSocket(url);
            const opened = await new Promise<boolean>((resolve) => {
                const timer = window.setTimeout(() => resolve(false), 1800);
                ws.onopen = () => {
                    window.clearTimeout(timer);
                    resolve(true);
                };
                ws.onerror = () => {
                    window.clearTimeout(timer);
                    resolve(false);
                };
                ws.onclose = () => {
                    window.clearTimeout(timer);
                    resolve(false);
                };
            });
            if (opened) return ws;
            try { ws.close(); } catch { }
        } catch { }
    }
    return null;
}



export function RecordingBar() {
    const {
        recording, paused, seconds, transcriptParts, currentMeetingId, meetings,
        translationEnabled, translationLang,
        setRecording, setPaused, setSeconds, clearTranscript,
        addTranscriptPart, appendToLastPart, replaceLastPartText, updateTranscriptSpeakerByChunk, setTranslationEnabled,
        setTranslationLang, lang, setIsTranscribing, setInterimText, setInterimSpeaker, setTransientSummary,
        summaryLoading, setSummaryLoading,
    } = useAppStore();

    const [audioSource, setAudioSource] = useState<'mic' | 'system' | 'both'>('mic');

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const timerRef = useRef<number | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const animFrameRef = useRef<number>(0);
    const [barHeights, setBarHeights] = useState(['4px', '4px', '4px']);
    const wsRef = useRef<WebSocket | null>(null);
    const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
    const archiveRecorderRef = useRef<MediaRecorder | null>(null);
    const audioUploadChainRef = useRef<Promise<void>>(Promise.resolve());
    const summarizeLockRef = useRef(false);

    useEffect(() => {
        if (recording && !paused) {
            timerRef.current = window.setInterval(() => {
                useAppStore.setState((s) => ({ seconds: s.seconds + 1 }));
            }, 1000);
        }
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [recording, paused]);

    const drawWaveform = useCallback(() => {
        const analyser = analyserRef.current;
        if (!analyser) return;
        const bufLen = analyser.fftSize;
        const data = new Float32Array(bufLen);
        const draw = () => {
            animFrameRef.current = requestAnimationFrame(draw);
            analyser.getFloatTimeDomainData(data);
            // Calculate RMS for bar heights
            let sum = 0;
            for (let i = 0; i < bufLen; i++) sum += data[i] * data[i];
            const rms = Math.sqrt(sum / bufLen);
            const level = Math.min(rms * 8, 1); // normalize 0-1
            setBarHeights([
                `${Math.max(4, level * 20 + Math.random() * 6)}px`,
                `${Math.max(4, level * 24 + Math.random() * 4)}px`,
                `${Math.max(4, level * 18 + Math.random() * 8)}px`,
            ]);
        };
        draw();
    }, []);

    const ensureSystemCapturePermission = useCallback(async (): Promise<boolean> => {
        if (!isTauri || (audioSource !== 'system' && audioSource !== 'both')) {
            return true;
        }
        try {
            const hasPermission = Boolean(await safeInvoke('check_screen_access'));
            if (hasPermission) return true;
            const granted = Boolean(await safeInvoke('request_screen_access'));
            return granted;
        } catch (e) {
            console.warn('[permissions] screen capture check/request failed:', e);
            return false;
        }
    }, [audioSource]);

    const sendChunk = async (blob: Blob, startSec: number, endSec: number) => {
        const form = new FormData();
        form.append('audio', blob, 'chunk.webm');
        setInterimText('');
        setInterimSpeaker('Speaker 1', 0);
        setIsTranscribing(true);
        try {
            const res = await fetchSidecar('/transcribe-diarize', { method: 'POST', body: form });
            const data = await res.json();
            const ts = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

            const rawSegments = Array.isArray(data.segments) ? data.segments : [];
            const normalizedSegments = rawSegments
                .map((seg: any) => ({
                    text: String(seg?.text || '').trim(),
                    speakerId: seg?.speaker_id ?? 0,
                    speaker: seg?.speaker || 'Speaker 1',
                    chunkId: seg?.chunk_id || '',
                }))
                .filter((seg: any) => seg.text.length > 0);

            if (normalizedSegments.length === 0) {
                const fallbackText = String(data.text || '').trim();
                if (!fallbackText) return;
                normalizedSegments.push({
                    text: fallbackText,
                    speakerId: 0,
                    speaker: 'Speaker 1',
                    chunkId: data.chunk_id || '',
                });
            }

            const safeStart = Math.max(0, startSec);
            const safeEnd = Math.max(safeStart, endSec);
            const perSegment = (safeEnd - safeStart) / Math.max(1, normalizedSegments.length);

            normalizedSegments.forEach((seg: any, idx: number) => {
                const segStart = safeStart + perSegment * idx;
                const segEnd = idx === normalizedSegments.length - 1
                    ? safeEnd
                    : safeStart + perSegment * (idx + 1);

                const state = useAppStore.getState();
                const lastPart = state.transcriptParts[state.transcriptParts.length - 1];
                if (lastPart && lastPart.speakerId === seg.speakerId) {
                    appendToLastPart(seg.text, segEnd.toFixed(1), seg.chunkId || undefined);
                    return;
                }

                addTranscriptPart({
                    text: seg.text,
                    speaker: seg.speaker,
                    speakerId: seg.speakerId,
                    chunkId: seg.chunkId || undefined,
                    chunkIds: seg.chunkId ? [seg.chunkId] : undefined,
                    startTime: segStart.toFixed(1),
                    endTime: segEnd.toFixed(1),
                    timestamp: ts,
                    translation: '',
                });
            });
        } catch (err) { console.error('Transcription error:', err); }
        setInterimText('');
        setInterimSpeaker('Speaker 1', 0);
        setIsTranscribing(false);
        // Auto-save to draft
        const dId = useAppStore.getState().draftId;
        const lastPart = useAppStore.getState().transcriptParts[useAppStore.getState().transcriptParts.length - 1];
        if (dId && lastPart) appendDraft(
            dId,
            {
                text: lastPart.text,
                speaker: lastPart.speaker,
                speakerId: lastPart.speakerId,
                chunkId: lastPart.chunkId,
                chunkIds: lastPart.chunkIds,
                startTime: lastPart.startTime,
                endTime: lastPart.endTime,
                translation: lastPart.translation || '',
            },
            useAppStore.getState().seconds
        ).catch(() => { });
    };

    const enqueueDraftAudioUpload = useCallback((blob: Blob) => {
        if (!blob || blob.size === 0) return;
        audioUploadChainRef.current = audioUploadChainRef.current.then(async () => {
            const dId = useAppStore.getState().draftId;
            if (!dId) return;
            try {
                await appendDraftAudio(dId, blob, `meeting-${dId}.webm`);
            } catch (e) {
                console.warn('[draft-audio] upload failed:', e);
            }
        }).catch(() => { });
    }, []);

    const startDraftAudioArchive = useCallback((stream: MediaStream) => {
        if (!stream) return;
        if (archiveRecorderRef.current) {
            try {
                if (archiveRecorderRef.current.state !== 'inactive') archiveRecorderRef.current.stop();
            } catch { }
            archiveRecorderRef.current = null;
        }

        let recorder: MediaRecorder;
        try {
            const mime = 'audio/webm;codecs=opus';
            recorder = MediaRecorder.isTypeSupported(mime)
                ? new MediaRecorder(stream, { mimeType: mime })
                : new MediaRecorder(stream);
        } catch (e) {
            console.warn('[draft-audio] archive recorder unavailable:', e);
            return;
        }

        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) enqueueDraftAudioUpload(e.data);
        };
        recorder.onerror = (e) => console.warn('[draft-audio] recorder error:', e);
        try {
            recorder.start(4000);
            archiveRecorderRef.current = recorder;
        } catch (e) {
            console.warn('[draft-audio] recorder start failed:', e);
        }
    }, [enqueueDraftAudioUpload]);

    const startChunkRecording = useCallback((stream: MediaStream) => {
        const SILENCE_DURATION = 400, MIN_CHUNK_SEC = 2, MAX_CHUNK_SEC = 4;
        let chunkStart = Date.now();
        let isSilent = false, silenceStart = 0;
        let recorder: MediaRecorder | null = null;
        let chunks: Blob[] = [];

        const startRec = () => {
            recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            chunks = [];
            recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: 'audio/webm' });
                const { seconds } = useAppStore.getState();
                const endSec = seconds;
                const startSec = endSec - (Date.now() - chunkStart) / 1000;
                sendChunk(blob, Math.max(0, startSec), endSec);
                chunkStart = Date.now();
                if (useAppStore.getState().recording && !useAppStore.getState().paused) startRec();
            };
            recorder.start();
            mediaRecorderRef.current = recorder;
        };
        startRec();

        const vadInterval = setInterval(() => {
            const s = useAppStore.getState();
            if (!s.recording || s.paused || !analyserRef.current) return;
            const bufLen = analyserRef.current.fftSize;
            const data = new Float32Array(bufLen);
            analyserRef.current.getFloatTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < bufLen; i++) sum += data[i] * data[i];
            const rms = Math.sqrt(sum / bufLen);
            const now = Date.now(), age = (now - chunkStart) / 1000, silent = rms < 0.015;
            if (silent) {
                if (!isSilent) { isSilent = true; silenceStart = now; }
                if (now - silenceStart >= SILENCE_DURATION && age >= MIN_CHUNK_SEC) { isSilent = false; recorder?.stop(); }
            } else { isSilent = false; silenceStart = 0; }
            if (age >= MAX_CHUNK_SEC) { isSilent = false; recorder?.stop(); }
        }, 80);
        (window as any).__vadInterval = vadInterval;
    }, []);

    const startRecording = useCallback(async () => {
        try {
            setInterimText('');
            setInterimSpeaker('Speaker 1', 0);
            setIsTranscribing(false);

            const hasSystemPermission = await ensureSystemCapturePermission();
            if (!hasSystemPermission) {
                console.warn('[recording] screen capture permission not granted');
                return;
            }

            const state = useAppStore.getState();
            const currentMeeting = state.currentMeetingId
                ? state.meetings.find((m) => m.id === state.currentMeetingId)
                : null;
            const resumeDraftId = currentMeeting?.status === 'draft'
                ? currentMeeting.id
                : (!state.currentMeetingId && state.draftId ? state.draftId : null);

            // Ensure backend diarizer state is reset before opening a new capture session.
            try {
                await resetDiarize();
            } catch (e) {
                console.warn('[recording] diarize reset failed before start:', e);
            }

            if (resumeDraftId) {
                // Continue an existing draft meeting from detail view.
                useAppStore.getState().setDraftId(resumeDraftId);
                setRecording(true);
                const resumeSeconds = currentMeeting
                    ? Number(currentMeeting.audio_duration || 0)
                    : state.seconds;
                setSeconds(Math.max(0, Math.floor(resumeSeconds)));
            } else {
                // New recording — fresh start
                clearTranscript();
                setRecording(true);
                setSeconds(0);

                // Create a draft in DB
                try {
                    const title = new Date().toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                    const { id } = await createDraft(title);
                    useAppStore.getState().setDraftId(id);
                } catch (e) { console.warn('[draft] Failed to create draft:', e); }
            }

            let stream: MediaStream;

            if (audioSource === 'system') {
                if (isTauri && isMac) {
                    // macOS: Tauri native system audio (CoreAudio)
                    const activeDraftId = useAppStore.getState().draftId;
                    await safeInvoke(
                        'start_system_audio',
                        activeDraftId ? { draftId: activeDraftId } : undefined
                    );
                    const barInterval = setInterval(() => {
                        setBarHeights([
                            `${Math.random() * 16 + 6}px`,
                            `${Math.random() * 20 + 8}px`,
                            `${Math.random() * 14 + 6}px`,
                        ]);
                    }, 300);
                    (window as any).__systemBarInterval = barInterval;
                    const { listen } = await import('@tauri-apps/api/event');
                    const unlisten = await listen<string>('system-audio-transcript', (event) => {
                        try {
                            const state = useAppStore.getState();
                            if (!state.recording || state.paused) {
                                useAppStore.getState().setInterimText('');
                                setIsTranscribing(false);
                                return;
                            }
                            const data = JSON.parse(event.payload);
                            if (data.error) {
                                console.error('[system-audio]', data.error);
                                setIsTranscribing(false);
                                useAppStore.getState().setInterimText('');
                                return;
                            }

                            // Handle both WebSocket streaming (interim/final) and HTTP chunk responses
                            const isFinal = data.is_final === true || data.segments !== undefined;
                            const seg = data.segments?.[0] || {};
                            const text = (seg.text || data.text || '').trim();
                            if (!text) return;

                            const speakerId = seg.speaker_id ?? data.speaker_id ?? 0;
                            const speaker = seg.speaker || data.speaker || 'Speaker 1';
                            const chunkId = seg.chunk_id || data.chunk_id || '';
                            const ts = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

                            if (isFinal) {
                                useAppStore.getState().setInterimText('');
                                useAppStore.getState().setInterimSpeaker(speaker, speakerId);
                                const lastPart = state.transcriptParts[state.transcriptParts.length - 1];
                                const lastChunkIds = new Set<string>();
                                if (lastPart?.chunkId) lastChunkIds.add(lastPart.chunkId);
                                if (Array.isArray(lastPart?.chunkIds)) {
                                    lastPart.chunkIds.forEach((id) => { if (id) lastChunkIds.add(id); });
                                }
                                const sameChunk = Boolean(chunkId) && lastChunkIds.has(chunkId);
                                const sameSpeaker = Boolean(lastPart) && Number(lastPart.speakerId) === Number(speakerId);

                                if (sameChunk) {
                                    replaceLastPartText(text, String(state.seconds), chunkId || undefined);
                                } else if (sameSpeaker) {
                                    appendToLastPart(text, String(state.seconds), chunkId || undefined);
                                } else {
                                    addTranscriptPart({
                                        text,
                                        speaker,
                                        speakerId,
                                        chunkId: chunkId || undefined,
                                        chunkIds: chunkId ? [chunkId] : undefined,
                                        startTime: String(Math.max(0, state.seconds - 5)),
                                        endTime: String(state.seconds),
                                        timestamp: ts,
                                        translation: '',
                                    });
                                }
                                setIsTranscribing(false);
                                // Auto-save to draft
                                const dId = useAppStore.getState().draftId;
                                const savePart = useAppStore.getState().transcriptParts[useAppStore.getState().transcriptParts.length - 1];
                                if (dId && savePart) appendDraft(
                                    dId,
                                    {
                                        text: savePart.text,
                                        speaker,
                                        speakerId,
                                        chunkId: savePart.chunkId,
                                        chunkIds: savePart.chunkIds,
                                        startTime: savePart.startTime,
                                        endTime: savePart.endTime,
                                        translation: savePart.translation || '',
                                    },
                                    state.seconds
                                ).catch(() => { });
                            } else {
                                // Interim (streaming) — show live text
                                useAppStore.getState().setInterimText(text);
                                useAppStore.getState().setInterimSpeaker(speaker, speakerId);
                                setIsTranscribing(true);
                            }
                        } catch { }
                    });
                    (window as any).__systemAudioUnlisten = unlisten;
                    return;
                }
                // Browser: use getDisplayMedia for system audio
                const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1, frameRate: 1 } });
                displayStream.getVideoTracks().forEach(t => t.stop());
                if (displayStream.getAudioTracks().length === 0) {
                    throw new Error('No system audio available');
                }
                stream = new MediaStream(displayStream.getAudioTracks());

            } else if (audioSource === 'both') {
                // Merge mic + system audio
                const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

                if (isTauri && isMac) {
                    // macOS: mic from browser + system from native
                    stream = micStream;
                    try {
                        const activeDraftId = useAppStore.getState().draftId;
                        await safeInvoke(
                            'start_system_audio',
                            activeDraftId ? { draftId: activeDraftId } : undefined
                        );
                        const { listen } = await import('@tauri-apps/api/event');
                        const unlisten = await listen<string>('system-audio-transcript', (event) => {
                            try {
                                const state = useAppStore.getState();
                                if (!state.recording || state.paused) return;
                                const data = JSON.parse(event.payload);
                                const seg = data.segments?.[0] || {};
                                const text = (seg.text || data.text || '').trim();
                                if (!text) return;
                                const speakerId = (seg.speaker_id ?? 0) + 100;
                                const speaker = seg.speaker || 'System';
                                const chunkId = seg.chunk_id || data.chunk_id || '';
                                const ts = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                                addTranscriptPart({
                                    text,
                                    speaker,
                                    speakerId,
                                    chunkId: chunkId || undefined,
                                    chunkIds: chunkId ? [chunkId] : undefined,
                                    startTime: String(Math.max(0, state.seconds - 5)),
                                    endTime: String(state.seconds),
                                    timestamp: ts,
                                    translation: '',
                                });
                            } catch { }
                        });
                        (window as any).__systemAudioUnlisten = unlisten;
                    } catch (e) {
                        console.warn('[both] system audio failed, continuing with mic only:', e);
                    }
                } else {
                    // Browser: merge mic + display audio via Web Audio API
                    const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1, frameRate: 1 } });
                    displayStream.getVideoTracks().forEach(t => t.stop());
                    const ctx = new AudioContext();
                    const dest = ctx.createMediaStreamDestination();
                    ctx.createMediaStreamSource(micStream).connect(dest);
                    if (displayStream.getAudioTracks().length > 0) {
                        ctx.createMediaStreamSource(new MediaStream(displayStream.getAudioTracks())).connect(dest);
                    }
                    stream = dest.stream;
                    // Store refs for cleanup
                    (stream as any)._sources = [micStream, displayStream];
                    (stream as any)._audioCtx = ctx;
                }
            } else {
                // Mic only
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            streamRef.current = stream;
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);
            analyserRef.current = analyser;
            drawWaveform();
            startDraftAudioArchive(stream);

            // Wait for sidecar
            const readyBase = await waitForSidecarReady(7000);
            if (!readyBase) {
                console.warn('[sidecar] not ready within timeout, continuing with fallback endpoints');
            }

            // Nvidia streaming: WebSocket + raw PCM (with retry/fallback)
            let chunkFallbackStarted = false;
            const fallbackToChunkMode = () => {
                if (chunkFallbackStarted) return;
                chunkFallbackStarted = true;
                console.warn('[nvidia-stream] fallback to chunk mode');
                if (wsRef.current) {
                    try { wsRef.current.close(); } catch { }
                    wsRef.current = null;
                }
                if (scriptNodeRef.current) {
                    scriptNodeRef.current.disconnect();
                    scriptNodeRef.current = null;
                }
                startChunkRecording(stream);
            };

            const attachSocketHandlers = (ws: WebSocket) => {
                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        if (data.error) {
                            console.error('[nvidia-stream]', data.error);
                            setIsTranscribing(false);
                            useAppStore.getState().setInterimText('');
                            return;
                        }
                        if (data.type === 'speaker_correction' && data.chunk_id) {
                            const correctedId = data.speaker_id ?? 0;
                            const correctedSpeaker = data.speaker || `Speaker ${correctedId + 1}`;
                            updateTranscriptSpeakerByChunk(data.chunk_id, correctedId, correctedSpeaker);
                            return;
                        }
                        // Speaker split: diarizer detected speaker change mid-stream
                        // Finalize current interim text as old speaker, start new speaker
                        if (data.type === 'speaker_split') {
                            const newSpeakerId = data.speaker_id ?? 0;
                            const newSpeaker = data.speaker || `Speaker ${newSpeakerId + 1}`;
                            const st = useAppStore.getState();
                            const pendingInterim = st.interimText?.trim();
                            if (pendingInterim) {
                                // Save current interim text under the OLD speaker
                                const oldSpeaker = st.interimSpeaker || 'Speaker 1';
                                const oldSpeakerId = st.interimSpeakerId ?? 0;
                                const parts = st.transcriptParts;
                                const lastPart = parts[parts.length - 1];
                                if (lastPart && lastPart.speakerId === oldSpeakerId && lastPart.text) {
                                    useAppStore.getState().setTranscriptParts(
                                        parts.map((p, i) =>
                                            i === parts.length - 1
                                                ? { ...p, text: p.text + ' ' + pendingInterim }
                                                : p
                                        )
                                    );
                                } else {
                                    useAppStore.getState().addTranscriptPart({
                                        text: pendingInterim,
                                        speaker: oldSpeaker,
                                        speakerId: oldSpeakerId,
                                        startTime: String(st.seconds),
                                        endTime: String(st.seconds),
                                        timestamp: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                                        translation: '',
                                    });
                                }
                            }
                            // Clear interim and set new speaker
                            useAppStore.getState().setInterimText('');
                            useAppStore.getState().setInterimSpeaker(newSpeaker, newSpeakerId);
                            return;
                        }
                        const text = (data.text || '').trim();
                        if (!text) return;

                        const state = useAppStore.getState();
                        if (!state.recording || state.paused) {
                            useAppStore.getState().setInterimText('');
                            setIsTranscribing(false);
                            return;
                        }
                        const ts = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });

                        if (data.is_final) {
                            useAppStore.getState().setInterimText('');
                            useAppStore.getState().setInterimSpeaker(data.speaker || 'Speaker 1', data.speaker_id ?? 0);
                            const speakerId = data.speaker_id ?? 0;
                            const speaker = data.speaker || 'Speaker 1';
                            const chunkId = data.chunk_id || '';
                            const lastPart = state.transcriptParts[state.transcriptParts.length - 1];
                            const lastChunkIds = new Set<string>();
                            if (lastPart?.chunkId) lastChunkIds.add(lastPart.chunkId);
                            if (Array.isArray(lastPart?.chunkIds)) {
                                lastPart.chunkIds.forEach((id) => { if (id) lastChunkIds.add(id); });
                            }
                            const sameChunk = Boolean(chunkId) && lastChunkIds.has(chunkId);
                            const sameSpeaker = Boolean(lastPart) && Number(lastPart.speakerId) === Number(speakerId);

                            if (sameChunk) {
                                replaceLastPartText(text, String(state.seconds), chunkId || undefined);
                            } else if (sameSpeaker) {
                                appendToLastPart(text, String(state.seconds), chunkId || undefined);
                            } else {
                                addTranscriptPart({
                                    text,
                                    speaker,
                                    speakerId,
                                    chunkId: chunkId || undefined,
                                    chunkIds: chunkId ? [chunkId] : undefined,
                                    startTime: String(Math.max(0, state.seconds - 3)),
                                    endTime: String(state.seconds),
                                    timestamp: ts,
                                    translation: '',
                                });
                            }
                            setIsTranscribing(false);
                            const dId = useAppStore.getState().draftId;
                            const savePart = useAppStore.getState().transcriptParts[useAppStore.getState().transcriptParts.length - 1];
                            if (dId && savePart) appendDraft(
                                dId,
                                {
                                    text: savePart.text,
                                    speaker,
                                    speakerId,
                                    chunkId: savePart.chunkId,
                                    chunkIds: savePart.chunkIds,
                                    startTime: savePart.startTime,
                                    endTime: savePart.endTime,
                                },
                                state.seconds
                            ).catch(() => { });
                        } else {
                            useAppStore.getState().setInterimText(text);
                            useAppStore.getState().setInterimSpeaker(data.speaker || 'Speaker 1', data.speaker_id ?? 0);
                            setIsTranscribing(true);
                        }
                    } catch { }
                };
                ws.onerror = (e) => console.error('[nvidia-stream] WebSocket error:', e);
                ws.onclose = () => {
                    if (wsRef.current !== ws) return;
                    const state = useAppStore.getState();
                    if (!state.recording || state.paused) return;
                    void (async () => {
                        console.warn('[nvidia-stream] socket closed, retrying...');
                        const reopened = await openNvidiaWebSocket(readyBase);
                        if (!reopened) {
                            fallbackToChunkMode();
                            return;
                        }
                        wsRef.current = reopened;
                        attachSocketHandlers(reopened);
                    })();
                };
            };

            const ws = await openNvidiaWebSocket(readyBase);
            if (!ws) {
                fallbackToChunkMode();
            } else {
                wsRef.current = ws;
                attachSocketHandlers(ws);

                const scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
                scriptNodeRef.current = scriptNode;
                source.connect(scriptNode);
                scriptNode.connect(audioCtx.destination);

                scriptNode.onaudioprocess = (e) => {
                    const socket = wsRef.current;
                    if (!socket || socket.readyState !== WebSocket.OPEN) return;
                    const state = useAppStore.getState();
                    if (!state.recording || state.paused) return;
                    const inputData = e.inputBuffer.getChannelData(0);
                    const ratio = audioCtx.sampleRate / 16000;
                    const outputLen = Math.floor(inputData.length / ratio);
                    const pcm16 = new Int16Array(outputLen);
                    for (let i = 0; i < outputLen; i++) {
                        const sample = inputData[Math.floor(i * ratio)];
                        pcm16[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
                    }
                    socket.send(pcm16.buffer);
                };
            }
        } catch (err: any) {
            console.error('Audio access error:', err);
            setRecording(false);
        }
    }, [audioSource, clearTranscript, setRecording, setSeconds, drawWaveform, startChunkRecording, startDraftAudioArchive, addTranscriptPart, appendToLastPart, replaceLastPartText, updateTranscriptSpeakerByChunk, lang, setInterimText, setInterimSpeaker, setIsTranscribing, ensureSystemCapturePermission]);

    const stopRecording = useCallback(() => {
        // Promote any pending interim text to final before clearing
        const state = useAppStore.getState();
        const pendingText = state.interimText?.trim();
        if (pendingText) {
            const speaker = state.interimSpeaker || 'Speaker 1';
            const speakerId = state.interimSpeakerId ?? 0;
            const parts = state.transcriptParts;
            const lastPart = parts[parts.length - 1];
            if (lastPart && lastPart.speakerId === speakerId && lastPart.text) {
                useAppStore.getState().setTranscriptParts(
                    parts.map((p, i) =>
                        i === parts.length - 1
                            ? { ...p, text: p.text + ' ' + pendingText }
                            : p
                    )
                );
            } else {
                useAppStore.getState().addTranscriptPart({
                    text: pendingText,
                    speaker,
                    speakerId,
                    startTime: '0',
                    endTime: '0',
                    timestamp: new Date().toISOString(),
                    translation: '',
                });
            }
        }
        setRecording(false); setPaused(false);
        setIsTranscribing(false);
        setInterimText('');
        setInterimSpeaker('Speaker 1', 0);
        mediaRecorderRef.current?.stop();
        if (archiveRecorderRef.current) {
            try {
                if (archiveRecorderRef.current.state !== 'inactive') archiveRecorderRef.current.stop();
            } catch { }
            archiveRecorderRef.current = null;
        }

        // Close Nvidia streaming WebSocket
        if (wsRef.current) {
            try { wsRef.current.send('STOP'); } catch { }
            try { wsRef.current.close(); } catch { }
            wsRef.current = null;
        }
        if (scriptNodeRef.current) {
            scriptNodeRef.current.disconnect();
            scriptNodeRef.current = null;
        }

        const stream = streamRef.current;
        if (stream) {
            // Clean up merged stream sub-sources (both mode)
            if ((stream as any)._sources) {
                (stream as any)._sources.forEach((s: MediaStream) => s.getTracks().forEach(t => t.stop()));
            }
            if ((stream as any)._audioCtx) {
                (stream as any)._audioCtx.close().catch(() => { });
            }
            stream.getTracks().forEach(t => t.stop());
        }
        cancelAnimationFrame(animFrameRef.current);
        clearInterval((window as any).__vadInterval);
        clearInterval((window as any).__systemBarInterval);
        setBarHeights(['4px', '4px', '4px']);
        safeInvoke('stop_system_audio').catch(() => { });
        if ((window as any).__systemAudioUnlisten) {
            (window as any).__systemAudioUnlisten();
            (window as any).__systemAudioUnlisten = null;
        }
    }, [setRecording, setPaused, setIsTranscribing, setInterimText, setInterimSpeaker]);

    const togglePause = useCallback(() => {
        const nextPaused = !paused;
        setPaused(nextPaused);
        if (nextPaused) {
            // Promote any pending interim text to a final transcript part before clearing
            const state = useAppStore.getState();
            const pendingText = state.interimText?.trim();
            if (pendingText) {
                const speaker = state.interimSpeaker || 'Speaker 1';
                const speakerId = state.interimSpeakerId ?? 0;
                const parts = state.transcriptParts;
                const lastPart = parts[parts.length - 1];
                // Append to last part if same speaker, else create new part
                if (lastPart && lastPart.speakerId === speakerId && lastPart.text) {
                    useAppStore.getState().setTranscriptParts(
                        parts.map((p, i) =>
                            i === parts.length - 1
                                ? { ...p, text: p.text + ' ' + pendingText }
                                : p
                        )
                    );
                } else {
                    useAppStore.getState().addTranscriptPart({
                        text: pendingText,
                        speaker,
                        speakerId,
                        startTime: '0',
                        endTime: '0',
                        timestamp: new Date().toISOString(),
                        translation: '',
                    });
                }
                // Auto-save the promoted part to draft
                const dId = useAppStore.getState().draftId;
                if (dId) {
                    const savedPart = useAppStore.getState().transcriptParts[useAppStore.getState().transcriptParts.length - 1];
                    if (savedPart) appendDraft(dId, {
                        text: savedPart.text,
                        speaker: savedPart.speaker,
                        speakerId: savedPart.speakerId,
                        startTime: savedPart.startTime,
                        endTime: savedPart.endTime,
                        translation: savedPart.translation || '',
                    }, useAppStore.getState().seconds).catch(() => { });
                }
            }
            setIsTranscribing(false);
            setInterimText('');
            setInterimSpeaker('Speaker 1', 0);
            mediaRecorderRef.current?.pause();
            try {
                if (archiveRecorderRef.current?.state === 'recording') archiveRecorderRef.current.pause();
            } catch { }
            if (isTauri && (audioSource === 'system' || audioSource === 'both')) {
                safeInvoke('stop_system_audio').catch(() => { });
            }
            return;
        }
        if (isTauri && recording && (audioSource === 'system' || audioSource === 'both')) {
            const activeDraftId = useAppStore.getState().draftId;
            safeInvoke(
                'start_system_audio',
                activeDraftId ? { draftId: activeDraftId } : undefined
            ).catch(() => { });
        }
        mediaRecorderRef.current?.resume();
        try {
            if (archiveRecorderRef.current?.state === 'paused') archiveRecorderRef.current.resume();
        } catch { }
    }, [paused, recording, audioSource, setPaused, setIsTranscribing, setInterimText, setInterimSpeaker]);

    const downloadTranslation = async () => {
        const state = useAppStore.getState();
        const hasAnyTranslation = state.transcriptParts.some((p) => (p.translation || '').trim().length > 0);
        if (!hasAnyTranslation) return;

        const meetingId = state.currentMeetingId || state.draftId;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = meetingId
            ? `meeting-${meetingId}-translation.txt`
            : `meeting-translation-${stamp}.txt`;

        const lines = state.transcriptParts
            .map((part) => {
                const translated = String(part.translation || '').trim();
                if (!translated) return '';
                const timeRange = `${part.startTime} - ${part.endTime}`;
                return `[${timeRange}] ${part.speaker}\n${translated}`;
            })
            .filter(Boolean);

        if (!lines.length) return;
        await downloadTextFile(filename, lines.join('\n\n'));
    };

    const summarize = async () => {
        if (summarizeLockRef.current) return;
        summarizeLockRef.current = true;
        setSummaryLoading(true);
        setTransientSummary('');
        useAppStore.setState({ activeTab: 'summary' });
        try {
            const state = useAppStore.getState();
            const mid = state.currentMeetingId || state.draftId;
            const payload: any = { language: lang };
            if (mid) {
                payload.meetingId = mid;
            } else {
                // Build transcript from current parts for unsaved meeting
                payload.transcript = JSON.stringify(
                    state.transcriptParts.map(p => ({
                        speaker: p.speaker,
                        text: p.text,
                        timestamp: p.timestamp,
                        translation: p.translation || '',
                    }))
                );
            }
            const res = await fetchSidecar('/summarize', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            let accumulated = '';
            let hasSseError = false;
            await consumeSseResponse(res, {
                onToken: (token) => {
                    accumulated += token;
                    setTransientSummary(accumulated);
                    if (!mid) return;
                    useAppStore.setState((s) => {
                        const idx = s.meetings.findIndex((m) => m.id === mid);
                        if (idx >= 0) {
                            const next = [...s.meetings];
                            next[idx] = { ...next[idx], summary: accumulated };
                            return { meetings: next };
                        }

                        // Ensure draft summaries are visible immediately even before list refresh.
                        return {
                            meetings: [{
                                id: mid,
                                title: `Meeting ${mid}`,
                                transcript: '',
                                summary: accumulated,
                                audio_duration: s.seconds,
                                created_at: new Date().toISOString(),
                                status: state.currentMeetingId ? 'saved' : 'draft',
                            }, ...s.meetings],
                        };
                    });
                },
                onErrorEvent: (message) => {
                    hasSseError = true;
                    console.warn('[RecordingBar] Summarize SSE error:', message);
                    setTransientSummary(lang === 'vi'
                        ? `Không thể tạo biên bản: ${message}`
                        : `Cannot create minutes: ${message}`);
                },
            });

            // Save final summary to DB
            if (mid && accumulated && !hasSseError) {
                try {
                    const extractedTitle = extractMinutesTitle(accumulated);
                    await fetchSidecar(`/meetings/${mid}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            summary: accumulated,
                            status: 'saved',
                            ...(extractedTitle ? { title: extractedTitle } : {}),
                        }),
                    });

                    const refreshed = await fetchSidecar(`/meetings/${mid}`);
                    if (refreshed.ok) {
                        const meeting = await refreshed.json();
                        useAppStore.setState((s) => {
                            const idx = s.meetings.findIndex((m) => m.id === mid);
                            if (idx >= 0) {
                                const next = [...s.meetings];
                                next[idx] = meeting;
                                return { meetings: next };
                            }
                            return { meetings: [meeting, ...s.meetings] };
                        });
                    } else if (extractedTitle) {
                        useAppStore.setState((s) => {
                            const idx = s.meetings.findIndex((m) => m.id === mid);
                            if (idx < 0) return s;
                            const next = [...s.meetings];
                            next[idx] = { ...next[idx], title: extractedTitle };
                            return { meetings: next };
                        });
                    }
                } catch { }
            }
        } catch (e) {
            console.warn('[RecordingBar] Summarize failed:', e);
            const message = e instanceof Error ? e.message : String(e || '');
            setTransientSummary(lang === 'vi'
                ? `Không thể tạo biên bản: ${message || 'Lỗi không xác định'}`
                : `Cannot create minutes: ${message || 'Unknown error'}`);
        } finally {
            summarizeLockRef.current = false;
            setSummaryLoading(false);
        }
    };

    const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
    const hasTranslatedParts = transcriptParts.some((part) => String(part.translation || '').trim().length > 0);
    const viewedMeeting = currentMeetingId ? meetings.find((m) => m.id === currentMeetingId) : null;
    const canResumeDraft = !recording && viewedMeeting?.status === 'draft';
    const recordBtnLabel = canResumeDraft
        ? (lang === 'vi' ? 'Tiếp tục ghi âm bản nháp' : 'Continue draft recording')
        : (lang === 'vi' ? 'Bắt đầu ghi âm' : 'Start recording');

    return (
        <>
            {/* Floating Recording Bar */}
            <div className={`rec-bar ${recording ? 'recording' : ''} ${paused ? 'paused' : ''}`}>
                <button
                    className={`rec-main-btn ${recording ? 'active' : ''}`}
                    onClick={recording ? stopRecording : startRecording}
                    title={recording ? (lang === 'vi' ? 'Dừng ghi âm' : 'Stop recording') : recordBtnLabel}
                    aria-label={recording ? (lang === 'vi' ? 'Dừng ghi âm' : 'Stop recording') : recordBtnLabel}
                >
                    <span className="rec-main-icon">
                        {recording ? (
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                        ) : (
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="8" /></svg>
                        )}
                    </span>
                </button>

                {recording && (
                    <>
                        <button className="rec-pause-btn" onClick={togglePause}>
                            {paused ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21" /></svg>
                            ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                            )}
                        </button>
                        <div className="audio-bars">
                            <div className="bar" style={{ height: barHeights[0] }} />
                            <div className="bar" style={{ height: barHeights[1] }} />
                            <div className="bar" style={{ height: barHeights[2] }} />
                        </div>
                        <div className="rec-status">
                            <div className="rec-dot" />
                            <span>{paused ? (lang === 'vi' ? 'Tạm dừng' : 'Paused') : (lang === 'vi' ? 'Đang ghi' : 'Recording')} • {formatTime(seconds)}</span>
                        </div>
                    </>
                )}

                {!recording && transcriptParts.length > 0 && (
                    <button className="rec-download-btn" onClick={downloadTranslation} disabled={!hasTranslatedParts}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" x2="12" y1="15" y2="3" />
                        </svg>
                        <span>{lang === 'vi' ? 'Tải bản dịch' : 'Download translation'}</span>
                    </button>
                )}

                {!recording && transcriptParts.length > 0 && (
                    <button
                        className={`rec-summarize-btn ${summaryLoading ? 'loading' : ''}`}
                        onClick={summarize}
                        disabled={summaryLoading}
                        aria-busy={summaryLoading}
                    >
                        {summaryLoading ? (
                            <>
                                <svg className="rec-btn-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                                <span>{lang === 'vi' ? 'Đang tạo biên bản...' : 'Creating minutes...'}</span>
                            </>
                        ) : (
                            <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z" />
                                </svg>
                                <span>{lang === 'vi' ? 'Tạo biên bản' : 'Create Minutes'}</span>
                            </>
                        )}
                    </button>
                )}
            </div>

            {/* Translation Bar */}
            <div className="translation-bar">
                <div className="audio-source-wrap">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 10v3a7 7 0 0 0 14 0v-3" /><path d="M9 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    </svg>
                    <select
                        className="audio-source-select"
                        value={audioSource}
                        onChange={(e) => setAudioSource(e.target.value as 'mic' | 'system' | 'both')}
                    >
                        <option value="mic">{t('mic_only', lang)}</option>
                        <option value="system">{t('system_only', lang)}</option>
                        <option value="both">{t('both', lang)}</option>
                    </select>
                </div>
                <div className="bar-divider" />
                <div className="translation-toggle-wrap">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" />
                    </svg>
                    <span>{lang === 'vi' ? 'Dịch cabin' : 'Translate'}</span>
                    <label className="toggle toggle-sm">
                        <input type="checkbox" checked={translationEnabled} onChange={(e) => setTranslationEnabled(e.target.checked)} />
                        <span className="toggle-slider" />
                    </label>
                </div>
                <select className="translation-lang-select" value={translationLang} onChange={(e) => setTranslationLang(e.target.value)} disabled={!translationEnabled}>
                    <option value="vi">Tiếng Việt</option>
                    <option value="en">English</option>
                    <option value="ja">日本語</option>
                    <option value="ko">한국어</option>
                    <option value="zh">中文</option>
                    <option value="fr">Français</option>
                    <option value="de">Deutsch</option>
                    <option value="es">Español</option>
                    <option value="th">ภาษาไทย</option>
                    <option value="id">Bahasa Indonesia</option>
                    <option value="ru">Русский</option>
                    <option value="ar">العربية</option>
                    <option value="hi">हिन्दी</option>
                </select>
            </div>
        </>
    );
}
