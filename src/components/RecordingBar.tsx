import { useRef, useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { resetDiarize, createDraft, downloadTextFile, getSettings, getLocalModelStatus } from '../lib/api';
import { fetchSidecar, waitForSidecarReady } from '../lib/sidecar';
import { t } from '../i18n';
import { CustomSelect } from './CustomSelect';
import { useToast } from './Toast';
import {
    isTauri, safeInvoke,
    SYSTEM_SPEAKER_ID_OFFSET,
} from './recording/recording-constants';
import { useWaveform } from './recording/use-waveform';
import { useDraftArchive } from './recording/use-draft-archive';
import { useChunkRecording } from './recording/use-chunk-recording';
import { useSummarize } from './recording/use-summarize';
import {
    useStreamingStt, openStreamingWebSocket, attachSocketHandlers,
} from './recording/use-streaming-stt';
import { MinutesOptionsModal } from './recording/minutes-options-modal';
import { applySttMessage, type SttStreamContext } from './recording/stt-message-reducer';
import type { SttWsMessage } from '../types/stt';
import { IconDownload, IconMic, IconMinutes, IconPause, IconPlay, IconRecord, IconSpinner, IconStop, IconTranslate } from './icons/scribble-icons';

/** Upper bound on waiting for trailing finals after Stop. A local final may
 *  wait ~2.5s on its speaker verdict, so this covers a short backlog. */
const STOP_DRAIN_TIMEOUT_MS = 6000;

/** How often the live transcript is written to the draft while recording, so
 *  a crash or force-quit mid-meeting loses at most this much text. */
const AUTOSAVE_INTERVAL_MS = 30_000;

type SavedPart = ReturnType<typeof useAppStore.getState>['transcriptParts'][number];

/** Transcript JSON exactly as Stop persists it (autosave uses the same shape). */
function serializeTranscriptParts(parts: SavedPart[]): string {
    return JSON.stringify(
        parts.map(p => ({
            text: p.text, speaker: p.speaker, speakerId: p.speakerId,
            startTime: p.startTime, endTime: p.endTime,
            chunkId: p.chunkId, chunkIds: p.chunkIds, translation: p.translation || '',
        }))
    );
}


export function RecordingBar() {
    const {
        recording, paused, seconds, transcriptParts, currentMeetingId, meetings,
        translationEnabled, translationLang,
        setRecording, setPaused, setSeconds, clearTranscript,
        setTranslationEnabled, setTranslationLang, lang,
        setIsTranscribing, setInterimText, setInterimSpeaker,
        summaryLoading, liveStatus, setLiveStatus,
    } = useAppStore();
    const stopping = liveStatus === 'stopping';

    const [audioSource, setAudioSource] = useState<'mic' | 'system' | 'both'>('mic');
    const [barHeights, setBarHeights] = useState(['4px', '4px', '4px']);
    const sttProviderRef = useRef('local');
    // Reactive copy of the saved STT provider for UI gating. Cabin translation
    // is a cloud-only feature — there is no offline translate model — so when
    // the user picks Local (offline) we disable the toggle entirely.
    const [sttProvider, setSttProvider] = useState('local');
    const cabinDisabled = sttProvider === 'local';
    const { showToast } = useToast();

    // AI is OPTIONAL — `aiConfigured` (resolved in App.tsx, shared via store)
    // gates the minutes actions. When false, the "Create Minutes" CTA routes
    // the user to Settings instead of summarizing.
    const aiConfigured = useAppStore((s) => s.aiConfigured);
    // Minutes options popup — language + template now live here (out of the
    // bar) so the bar stays compact; opened by the CTA when AI is configured.
    const [minutesPopupOpen, setMinutesPopupOpen] = useState(false);

    // Hooks from recording modules
    const { analyserRef, startDrawing, stopDrawing, setBarHeightsFn } = useWaveform();
    const { archiveRecorderRef, startDraftAudioArchive, stopDraftAudioArchive } = useDraftArchive();
    const { mediaRecorderRef, inflightChunksRef, startChunkRecording } = useChunkRecording();
    const { wsRef, connectPcmStream, disconnectPcmStream, closeWebSocket, drainWebSocket } = useStreamingStt();
    const { summarize } = useSummarize();

    const streamRef = useRef<MediaStream | null>(null);
    const timerRef = useRef<number | null>(null);

    // Indirect ref to stopRecording — needed because the terminal-error
    // handler must be passed into startRecording / attachSocketHandlers
    // BEFORE stopRecording is defined below (function-component ordering).
    const stopRecordingRef = useRef<() => Promise<void> | void>(() => {});
    // Guard so a flood of error events (Soniox can fire the same 402 repeatedly
    // on each reconnect attempt) collapses into a SINGLE toast + stop call.
    const terminalErrorFiredRef = useRef(false);
    const handleSttTerminalError = useCallback((rawMsg: string) => {
        if (terminalErrorFiredRef.current) return;
        terminalErrorFiredRef.current = true;
        // Translate well-known Soniox billing/auth codes into actionable text.
        let userMsg = rawMsg;
        const lower = rawMsg.toLowerCase();
        if (lower.includes('402') || lower.includes('budget exhausted')) {
            userMsg = lang === 'vi'
                ? 'Soniox đã hết quota tháng. Vui lòng nạp thêm hoặc đổi sang Local (offline) trong Cài đặt.'
                : 'Soniox monthly budget exhausted. Top up or switch to Local (offline) in Settings.';
        } else if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
            userMsg = lang === 'vi'
                ? 'Soniox API Key không hợp lệ. Vui lòng kiểm tra lại trong Cài đặt.'
                : 'Invalid Soniox API key. Please check Settings.';
        }
        showToast(userMsg, 'error');
        console.error('[stt-terminal]', rawMsg);
        try { void stopRecordingRef.current(); } catch (e) { console.warn('[stt-terminal] stop failed:', e); }
    }, [lang, showToast]);

    // Sync barHeights from waveform hook to local state
    useEffect(() => {
        setBarHeightsFn.current = setBarHeights;
    }, [setBarHeightsFn]);

    // Keep the reactive STT provider in sync with saved settings: fetch on
    // mount and whenever Settings is saved (SettingsPanel dispatches the event).
    useEffect(() => {
        let alive = true;
        const refresh = () => {
            getSettings()
                .then((s) => { if (alive) setSttProvider((s.stt_provider || 'local').toLowerCase()); })
                .catch(() => {});
        };
        refresh();
        window.addEventListener('scribble:settings-saved', refresh);
        return () => { alive = false; window.removeEventListener('scribble:settings-saved', refresh); };
    }, []);

    // Local (offline) has no translation model — force cabin translation off so
    // no stale TRANSLATE command/lang is sent on the local WS.
    useEffect(() => {
        if (cabinDisabled && translationEnabled) setTranslationEnabled(false);
    }, [cabinDisabled, translationEnabled, setTranslationEnabled]);

    // ── Mid-session translation toggle ──
    const translationToggleRef = useRef({ enabled: translationEnabled, lang: translationLang });
    useEffect(() => {
        const prev = translationToggleRef.current;
        const changed = prev.enabled !== translationEnabled || (translationEnabled && prev.lang !== translationLang);
        translationToggleRef.current = { enabled: translationEnabled, lang: translationLang };
        if (!changed || !recording) return;

        if (sttProviderRef.current === 'local') {
            // local WS accepts live TRANSLATE: commands too (no reconnect needed)
            const cmd = translationEnabled ? `TRANSLATE:${translationLang}` : 'TRANSLATE:off';
            if (isTauri && audioSource === 'both') {
                // Tauri event payload must be JSON-encoded string for serde
                const payload = JSON.stringify(cmd);
                import('@tauri-apps/api/event').then(({ emit }) => {
                    emit('system-audio-cmd', payload).catch(console.warn);
                });
            } else {
                // Send raw text command to WS (backend expects "TRANSLATE:xx" not JSON)
                const ws = wsRef.current;
                if (ws && ws.readyState === WebSocket.OPEN) ws.send(cmd);
            }
        } else {
            // Soniox: must reconnect (translate_lang set at connection time)
            // Guard against rapid toggles — skip if not actually recording
            if (!useAppStore.getState().recording) return;
            const ws = wsRef.current;
            if (ws) ws.close();
            if (isTauri && (audioSource === 'both' || audioSource === 'system')) {
                (async () => {
                    try {
                        const { invoke } = await import('@tauri-apps/api/core');
                        await invoke('stop_system_audio');
                        await new Promise(r => setTimeout(r, 300));
                        // Re-check recording state after await — user may have stopped
                        if (!useAppStore.getState().recording) return;
                        const state = useAppStore.getState();
                        const sysArgs: Record<string, unknown> = {};
                        if (state.draftId) sysArgs.draftId = state.draftId;
                        sysArgs.sttProvider = sttProviderRef.current;
                        if (translationEnabled) sysArgs.translateLang = translationLang;
                        await invoke('start_system_audio', sysArgs);
                    } catch (e) {
                        console.warn('[translation] Soniox Tauri restart failed:', e);
                    }
                })();
            }
        }
    }, [translationEnabled, translationLang, recording, audioSource, wsRef]);

    // ── Cleanup on unmount ──
    useEffect(() => {
        return () => {
            const tid = window.__systemUnlistenTimeout;
            if (tid) clearTimeout(tid);
            const unlisten = window.__systemAudioUnlisten;
            if (unlisten) { unlisten(); window.__systemAudioUnlisten = null; }
            clearInterval(window.__vadInterval);
            clearInterval(window.__systemBarInterval);
        };
    }, []);

    // ── Timer ── (frozen while stopping: the drain is not recording time)
    useEffect(() => {
        if (recording && !paused && !stopping) {
            timerRef.current = window.setInterval(() => {
                useAppStore.setState((s) => ({ seconds: s.seconds + 1 }));
            }, 1000);
        }
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [recording, paused, stopping]);

    // ── Autosave ── every AUTOSAVE_INTERVAL_MS while recording, only when the
    // transcript changed. Stop still does the final, authoritative save.
    useEffect(() => {
        if (!recording) return;
        let lastSaved = '';
        const id = window.setInterval(() => {
            const s = useAppStore.getState();
            if (!s.draftId || s.transcriptParts.length === 0) return;
            const json = serializeTranscriptParts(s.transcriptParts);
            if (json === lastSaved) return;
            lastSaved = json;
            fetchSidecar(`/meetings/${s.draftId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transcript: json, audioDuration: s.seconds }),
            }).catch(e => console.warn('[autosave] failed:', e));
        }, AUTOSAVE_INTERVAL_MS);
        return () => clearInterval(id);
    }, [recording]);

    // ── Permissions ──
    const ensureSystemCapturePermission = useCallback(async (): Promise<boolean> => {
        if (!isTauri || (audioSource !== 'system' && audioSource !== 'both')) return true;
        try {
            const has = Boolean(await safeInvoke('check_screen_access'));
            if (has) return true;
            return Boolean(await safeInvoke('request_screen_access'));
        } catch { return false; } // permission check may throw on non-Tauri
    }, [audioSource]);

    // ── System audio transcript handler (Tauri events) ──
    const setupSystemAudioListener = useCallback(async (_sttProvider: string) => {
        const { listen } = await import('@tauri-apps/api/event');
        // System audio restarts its stream on pause/translation toggles without
        // this listener knowing, so its ms offsets are not trusted.
        const ctx: SttStreamContext = {
            speakerIdOffset: SYSTEM_SPEAKER_ID_OFFSET,
            useStreamClock: false,
            streamOffsetSec: 0,
            setIsTranscribing,
        };
        const unlisten = await listen<string>('system-audio-transcript', (event) => {
            let data: SttWsMessage;
            try { data = JSON.parse(event.payload); } catch { return; }
            const outcome = applySttMessage(data, ctx);
            if (outcome.kind !== 'error') return;
            // Terminal STT error (Soniox 402, auth fail, model load) — stop the
            // recording + toast instead of leaking the text as a transcript part.
            if (outcome.terminal) handleSttTerminalError(outcome.message);
            else console.error('[system-audio]', outcome.message);
        });
        return unlisten;
    }, [setIsTranscribing, handleSttTerminalError]);

    // ── Start recording ──
    const startRecording = useCallback(async () => {
        try {
            // Reset the terminal-error latch so a fresh recording session can
            // surface a new fatal error (e.g. budget exhausted -> user tops up
            // -> tries again -> fails again -> we want the toast to fire).
            terminalErrorFiredRef.current = false;
            setInterimText('');
            setInterimSpeaker('Speaker 1', 0);
            setIsTranscribing(false);

            // ── Validate STT configuration before recording ──
            // Soniox is the only provider needing a credential. Local (offline)
            // needs no key but DOES need the bundled model on disk — refuse to
            // start rather than open a stream that would fail silently.
            let resolvedProvider = 'local';
            try {
                const settings = await getSettings();
                const provider = (settings.stt_provider || 'local').toLowerCase();
                // Anything that isn't Soniox is treated as Local.
                resolvedProvider = provider === 'soniox' ? 'soniox' : 'local';

                if (resolvedProvider === 'soniox') {
                    const hasSonioxKey = !!(settings.soniox_api_key && settings.soniox_api_key !== '' && !settings.soniox_api_key.startsWith('***'));
                    // Masked keys show as "xxxx***xxxx" — masked = a real key is saved.
                    const sonioxConfigured = hasSonioxKey || (settings.soniox_api_key || '').includes('***');
                    if (!sonioxConfigured) {
                        showToast(
                            lang === 'vi'
                                ? 'Vui lòng cấu hình Soniox API Key trong Cài đặt trước khi ghi âm'
                                : 'Please configure Soniox API Key in Settings before recording',
                            'error'
                        );
                        useAppStore.getState().setSettingsOpen(true);
                        return;
                    }
                } else {
                    const status = await getLocalModelStatus();
                    if (!status.cached && status.status !== 'done') {
                        showToast(
                            lang === 'vi'
                                ? 'Model nhận diện offline chưa sẵn sàng. Vào Cài đặt → Giọng nói để tải model, hoặc chuyển sang Soniox.'
                                : 'The offline speech model is not ready. Open Settings → Speech to download it, or switch to Soniox.',
                            'error'
                        );
                        useAppStore.getState().setSettingsOpen(true);
                        return;
                    }
                }
            } catch (e) {
                // Backend not ready — overlay should be showing, but guard anyway
                showToast(
                    lang === 'vi'
                        ? 'Hệ thống chưa sẵn sàng. Vui lòng đợi...'
                        : 'System not ready. Please wait...',
                    'error'
                );
                return;
            }

            if (!(await ensureSystemCapturePermission())) return;

            const state = useAppStore.getState();
            const currentMeeting = state.currentMeetingId
                ? state.meetings.find((m) => m.id === state.currentMeetingId)
                : null;
            const resumeDraftId = currentMeeting?.status === 'draft'
                ? currentMeeting.id
                : (!state.currentMeetingId && state.draftId ? state.draftId : null);

            try { await resetDiarize(); } catch {} // best-effort, non-critical

            setLiveStatus('connecting');
            if (resumeDraftId) {
                useAppStore.getState().setDraftId(resumeDraftId);
                setRecording(true);
                const resumeSeconds = currentMeeting ? Number(currentMeeting.audio_duration || 0) : state.seconds;
                setSeconds(Math.max(0, Math.floor(resumeSeconds)));
            } else {
                clearTranscript();
                setRecording(true);
                setSeconds(0);
                useAppStore.getState().setRecordingStartedAt(
                    new Date().toLocaleString('sv-SE') + ' ' + Intl.DateTimeFormat().resolvedOptions().timeZone
                );
                fetchSidecar('/diarize-reset', { method: 'POST' }).catch(() => {});
                try {
                    const title = new Date().toLocaleDateString('vi-VN', {
                        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
                    });
                    const { id } = await createDraft(title);
                    useAppStore.getState().setDraftId(id);
                } catch (e) { console.warn('[draft] Failed:', e); }
            }

            // Detect STT provider
            let sttProvider = 'local';
            try {
                const settingsData = await getSettings();
                sttProvider = (settingsData.stt_provider || 'local').toLowerCase() === 'soniox' ? 'soniox' : 'local';
                sttProviderRef.current = sttProvider;
            } catch {}

            let stream: MediaStream;

            if (audioSource === 'system') {
                if (isTauri) {
                    const activeDraftId = useAppStore.getState().draftId;
                    const { translationEnabled: tlEnabled, translationLang: tlLang } = useAppStore.getState();
                    const sysArgs: Record<string, unknown> = {};
                    if (activeDraftId) sysArgs.draftId = activeDraftId;
                    sysArgs.sttProvider = sttProvider;
                    if (tlEnabled) sysArgs.translateLang = tlLang;
                    await safeInvoke('start_system_audio', sysArgs);
                    const barInterval = setInterval(() => {
                        setBarHeights([
                            `${Math.random() * 16 + 6}px`,
                            `${Math.random() * 20 + 8}px`,
                            `${Math.random() * 14 + 6}px`,
                        ]);
                    }, 300);
                    window.__systemBarInterval = barInterval;
                    const unlisten = await setupSystemAudioListener(sttProvider);
                    window.__systemAudioUnlisten = unlisten;
                    setLiveStatus('live');
                    return;
                }
                // Browser system audio
                const displayStream = await navigator.mediaDevices.getDisplayMedia({
                    audio: true, video: { width: 1, height: 1, frameRate: 1 }
                });
                displayStream.getVideoTracks().forEach(t => t.stop());
                stream = new MediaStream(displayStream.getAudioTracks());
            } else if (audioSource === 'both') {
                console.info('[rec] requesting microphone');
            const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.info('[rec] microphone granted:', micStream.getAudioTracks()[0]?.label || '(unlabelled)');
                if (isTauri) {
                    stream = micStream;
                    try {
                        const activeDraftId = useAppStore.getState().draftId;
                        const { translationEnabled: tlEnabled, translationLang: tlLang } = useAppStore.getState();
                        const sysArgs: Record<string, unknown> = {};
                        if (activeDraftId) sysArgs.draftId = activeDraftId;
                        sysArgs.sttProvider = sttProvider;
                        if (tlEnabled) sysArgs.translateLang = tlLang;
                        await safeInvoke('start_system_audio', sysArgs);
                        const unlisten = await setupSystemAudioListener(sttProvider);
                        window.__systemAudioUnlisten = unlisten;
                    } catch (e) {
                        console.warn('[both] system audio failed:', e);
                    }
                } else {
                    const displayStream = await navigator.mediaDevices.getDisplayMedia({
                        audio: true, video: { width: 1, height: 1, frameRate: 1 }
                    });
                    displayStream.getVideoTracks().forEach(t => t.stop());
                    const audioCtx = new AudioContext();
                    if (audioCtx.state === 'suspended') {
                        try { await audioCtx.resume(); } catch { /* non-fatal */ }
                    }
                    const micSource = audioCtx.createMediaStreamSource(micStream);
                    const displaySource = audioCtx.createMediaStreamSource(displayStream);
                    const merger = audioCtx.createChannelMerger(2);
                    micSource.connect(merger, 0, 0);
                    displaySource.connect(merger, 0, 1);
                    const dest = audioCtx.createMediaStreamDestination();
                    merger.connect(dest);
                    stream = dest.stream;
                    (stream as MediaStream & { _sources?: MediaStream[] })._sources = [micStream, displayStream];
                }
            } else {
                console.info('[rec] requesting microphone (mic only)');
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.info('[rec] microphone granted');
            }

            streamRef.current = stream;

            // AudioContext construction costs ~370ms (measured) and is
            // independent of the backend. Sequence the two in PARALLEL: the
            // readiness probe was previously awaited only AFTER the audio graph
            // was built, so the two delays added up and the user stared at an
            // empty transcript for ~1.5s after pressing record.
            const readyBasePromise = waitForSidecarReady();

            const audioCtx = new AudioContext();
            // A NEW AudioContext can start in the `suspended` state under
            // WebKit's autoplay policy, in which case `onaudioprocess` never
            // fires and NO audio reaches the recognizer — the transcript stays
            // empty even though the UI says it is recording. This is why the
            // first recording after launching the app produced nothing while a
            // later one worked: by then the context had been resumed by some
            // other gesture. Resume explicitly and wait for it to actually run.
            if (audioCtx.state === 'suspended') {
                console.info('[rec] AudioContext suspended — resuming');
                try { await audioCtx.resume(); } catch (e) { console.warn('[rec] resume failed:', e); }
            }
            console.info('[rec] AudioContext state:', audioCtx.state, '@', audioCtx.sampleRate, 'Hz');

            const source = audioCtx.createMediaStreamSource(stream);
            analyserRef.current = audioCtx.createAnalyser();
            analyserRef.current.fftSize = 2048;
            source.connect(analyserRef.current);
            startDrawing();
            startDraftAudioArchive(stream);

            // Try WebSocket streaming, fallback to chunk mode
            const readyBase = await readyBasePromise;
            let chunkFallbackStarted = false;
            const fallbackToChunkMode = () => {
                if (chunkFallbackStarted) return;
                chunkFallbackStarted = true;
                closeWebSocket();
                disconnectPcmStream();
                startChunkRecording(stream, analyserRef);
                setLiveStatus('live');
            };

            const { translationEnabled: tlEnabled, translationLang: tlLang } = useAppStore.getState();
            const tWs = performance.now();
            const ws = await openStreamingWebSocket(sttProvider, readyBase, tlEnabled ? tlLang : undefined);
            console.info(
                '[rec] ws', ws ? 'OPEN' : 'FAILED',
                `${Math.round(performance.now() - tWs)}ms`,
                'base=', readyBase, 'provider=', sttProvider,
            );
            if (!ws) {
                // ALL WS bases rejected — usually sidecar offline or WS handshake
                // refused (firewall, port collision). Tell the user why instead
                // of silently downgrading to file-chunk mode and looking broken.
                const providerName = sttProvider === 'soniox' ? 'Soniox' : 'Local (offline)';
                showToast(
                    lang === 'vi'
                        ? `Không kết nối được tới ${providerName}. Đang chuyển sang chế độ chunk (chậm hơn). Kiểm tra mạng / API Key trong Cài đặt.`
                        : `Could not connect to ${providerName}. Falling back to chunk mode (slower). Check network / API key in Settings.`,
                    'warning',
                );
                fallbackToChunkMode();
            } else {
                wsRef.current = ws;
                console.info('[rec] streaming attached; PCM capture starting');
                attachSocketHandlers(ws, {
                    wsRef, sttProvider, readyBase, fallbackToChunkMode, setIsTranscribing,
                    onTerminalError: handleSttTerminalError,
                });
                connectPcmStream(audioCtx, source);
                setLiveStatus('live');
            }
        } catch (err) {
            console.error('Audio access error:', err);
            setRecording(false);
            setLiveStatus('idle');
        }
    }, [
        audioSource, clearTranscript, setRecording, setSeconds, startDrawing, startChunkRecording,
        startDraftAudioArchive, lang, setInterimText, setInterimSpeaker,
        setIsTranscribing, ensureSystemCapturePermission, setupSystemAudioListener,
        wsRef, connectPcmStream, disconnectPcmStream, closeWebSocket, analyserRef,
        showToast, handleSttTerminalError, setLiveStatus,
    ]);

    // ── Stop recording ──
    // Stop system audio and wait for its trailing finals: Rust drains its STT
    // socket after `stop_system_audio` and then emits `system-audio-done`.
    const drainSystemAudio = useCallback(async () => {
        const unlisten = window.__systemAudioUnlisten;
        window.__systemAudioUnlisten = null;
        // Paused system audio was already stopped — nothing is in flight.
        if (!isTauri || !unlisten || useAppStore.getState().paused) {
            await safeInvoke('stop_system_audio').catch(() => {});
            unlisten?.();
            return;
        }
        const { listen } = await import('@tauri-apps/api/event');
        let resolveDone: () => void = () => {};
        const done = new Promise<void>((r) => { resolveDone = r; });
        const unlistenDone = await listen('system-audio-done', () => resolveDone()).catch(() => null);
        const timer = window.setTimeout(() => resolveDone(), STOP_DRAIN_TIMEOUT_MS);
        await safeInvoke('stop_system_audio').catch(() => {});
        await done;
        window.clearTimeout(timer);
        unlistenDone?.();
        unlisten();
    }, []);

    const stopRecording = useCallback(async () => {
        const pre = useAppStore.getState();
        // Double-click / terminal-error re-entry guard.
        if (!pre.recording || pre.liveStatus === 'stopping') return;
        setLiveStatus('stopping');

        // 1. Stop capturing, then let every pipeline finish what it already
        //    has. Finals that land during the drain are still committed
        //    (recording stays true until the drain is done).
        disconnectPcmStream();
        mediaRecorderRef.current?.stop();
        const inflight = Array.from(inflightChunksRef.current);
        await Promise.all([
            inflight.length > 0 ? Promise.allSettled(inflight) : Promise.resolve(),
            drainWebSocket(STOP_DRAIN_TIMEOUT_MS),
            drainSystemAudio(),
        ]);

        // Flush interim text
        const state = useAppStore.getState();
        const dId = state.draftId;
        const interimText = state.interimText?.trim();
        // Status banners (reconnecting / warnings) share the interim slot —
        // never persist them as speech.
        if (interimText && !/^(🔄|⚠)/u.test(interimText)) {
            const ts = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
            state.addTranscriptPart({
                text: interimText,
                speaker: state.interimSpeaker || 'Speaker 1',
                speakerId: state.interimSpeakerId ?? 0,
                startTime: String(Math.max(0, state.seconds - 5)),
                endTime: String(state.seconds),
                timestamp: ts, translation: '',
            });
        }

        // Commit pending translation
        const pendingTranslation = useAppStore.getState().interimTranslation;
        const currentParts = useAppStore.getState().transcriptParts;
        if (pendingTranslation && currentParts.length > 0) {
            const lastIdx = currentParts.length - 1;
            const existingTrans = currentParts[lastIdx].translation || '';
            if (!existingTrans || pendingTranslation.length > existingTrans.length) {
                useAppStore.getState().updateTranscriptTranslation(lastIdx, pendingTranslation);
            }
        }
        useAppStore.getState().setInterimTranslation('');

        // Persist transcript
        if (dId) {
            const allParts = useAppStore.getState().transcriptParts;
            if (allParts.length > 0) {
                const transcriptJson = serializeTranscriptParts(allParts);
                await fetchSidecar(`/meetings/${dId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transcript: transcriptJson, audioDuration: useAppStore.getState().seconds }),
                }).catch(e => console.warn('[stop] sync failed:', e));
            }
        }

        setRecording(false); setPaused(false); setLiveStatus('idle');
        setIsTranscribing(false); setInterimText(''); setInterimSpeaker('Speaker 1', 0);
        mediaRecorderRef.current?.stop();
        stopDraftAudioArchive();
        closeWebSocket();
        disconnectPcmStream();

        const stream = streamRef.current;
        if (stream) {
            const extra = (stream as MediaStream & { _sources?: MediaStream[] })._sources as MediaStream[] | undefined;
            if (extra) extra.forEach(s => s.getTracks().forEach(t => t.stop()));
            stream.getTracks().forEach(t => t.stop());
        }
        stopDrawing();
        clearInterval(window.__vadInterval);
        clearInterval(window.__systemBarInterval);
        setBarHeights(['4px', '4px', '4px']);
    }, [setRecording, setPaused, setIsTranscribing, setInterimText, setInterimSpeaker, setLiveStatus,
        stopDraftAudioArchive, closeWebSocket, drainWebSocket, drainSystemAudio, disconnectPcmStream,
        stopDrawing, mediaRecorderRef, inflightChunksRef]);

    // Keep stopRecording reachable from callbacks defined ABOVE this point
    // (handleSttTerminalError needs to invoke it without creating a render-loop
    // dep cycle on the callback identity).
    useEffect(() => {
        stopRecordingRef.current = stopRecording;
    }, [stopRecording]);

    // ── Pause / Resume ──
    const togglePause = useCallback(() => {
        const nextPaused = !paused;
        setPaused(nextPaused);
        if (nextPaused) {
            setIsTranscribing(false); setInterimText(''); setInterimSpeaker('Speaker 1', 0);
            mediaRecorderRef.current?.pause();
            try { if (archiveRecorderRef.current?.state === 'recording') archiveRecorderRef.current.pause(); } catch {}
            if (isTauri && (audioSource === 'system' || audioSource === 'both')) {
                safeInvoke('stop_system_audio').catch(() => {});
            }
            return;
        }
        if (isTauri && recording && (audioSource === 'system' || audioSource === 'both')) {
            const { draftId, translationEnabled: tlE, translationLang: tlL } = useAppStore.getState();
            const sysArgs: Record<string, unknown> = {};
            if (draftId) sysArgs.draftId = draftId;
            sysArgs.sttProvider = sttProviderRef.current || 'local';
            if (tlE) sysArgs.translateLang = tlL;
            safeInvoke('start_system_audio', sysArgs).catch(() => {});
        }
        mediaRecorderRef.current?.resume();
        try { if (archiveRecorderRef.current?.state === 'paused') archiveRecorderRef.current.resume(); } catch {}
    }, [paused, recording, audioSource, setPaused, setIsTranscribing, setInterimText, setInterimSpeaker,
        mediaRecorderRef, archiveRecorderRef]);

    // ── Translation download ──
    const downloadTranslation = async () => {
        const state = useAppStore.getState();
        if (!state.transcriptParts.some(p => (p.translation || '').trim())) return;
        const mid = state.currentMeetingId || state.draftId;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = mid ? `meeting-${mid}-translation.txt` : `meeting-translation-${stamp}.txt`;
        const lines = state.transcriptParts
            .map(p => {
                const tr = String(p.translation || '').trim();
                return tr ? `[${p.startTime} - ${p.endTime}] ${p.speaker}\n${tr}` : '';
            })
            .filter(Boolean);
        if (lines.length) await downloadTextFile(filename, lines.join('\n\n'));
    };

    // ── Minutes CTA ──
    // Not configured → guide the user to Settings (with a toast explaining why)
    // instead of a dead button. Configured → open the options popup.
    const handleCreateMinutes = () => {
        if (!aiConfigured) {
            showToast(
                lang === 'vi'
                    ? 'Chưa cấu hình Trợ lý AI. Đang mở Cài đặt để bạn bật tính năng tạo biên bản.'
                    : 'AI Assistant not set up. Opening Settings so you can enable minutes.',
                'info',
            );
            useAppStore.getState().setSettingsOpen(true);
            return;
        }
        setMinutesPopupOpen(true);
    };
    const confirmCreateMinutes = () => {
        setMinutesPopupOpen(false);
        summarize();
    };

    // ── Render ──
    const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
    const hasTranslatedParts = transcriptParts.some(p => String(p.translation || '').trim().length > 0);
    const viewedMeeting = currentMeetingId ? meetings.find(m => m.id === currentMeetingId) : null;
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
                    disabled={stopping}
                    title={recording ? (lang === 'vi' ? 'Dừng ghi âm' : 'Stop recording') : recordBtnLabel}
                    aria-label={recording ? (lang === 'vi' ? 'Dừng ghi âm' : 'Stop recording') : recordBtnLabel}
                >
                    <span className="rec-main-icon t-icon-swap" data-state={recording ? 'b' : 'a'}>
                        <span className="t-icon" data-icon="a"><IconRecord size={20} /></span>
                        <span className="t-icon" data-icon="b"><IconStop size={20} /></span>
                    </span>
                </button>

                {recording && (
                    <>
                        <button className="rec-pause-btn" onClick={togglePause} disabled={stopping} aria-label={paused ? 'Resume' : 'Pause'}>
                            <span className="t-icon-swap" data-state={paused ? 'b' : 'a'}>
                                <span className="t-icon" data-icon="a"><IconPause size={14} /></span>
                                <span className="t-icon" data-icon="b"><IconPlay size={14} /></span>
                            </span>
                        </button>
                        <div className="audio-bars">
                            <div className="bar" style={{ height: barHeights[0] }} />
                            <div className="bar" style={{ height: barHeights[1] }} />
                            <div className="bar" style={{ height: barHeights[2] }} />
                        </div>
                        <div className="rec-status" role="status" aria-live="polite">
                            <div className="rec-dot" aria-hidden="true" />
                            <span>
                                {stopping
                                    ? (lang === 'vi' ? 'Đang hoàn tất câu cuối...' : 'Finishing last sentence...')
                                    : paused ? (lang === 'vi' ? 'Tạm dừng' : 'Paused') : (lang === 'vi' ? 'Đang ghi' : 'Recording')}
                                {' • '}{formatTime(seconds)}
                            </span>
                        </div>
                    </>
                )}

                {!recording && translationEnabled && transcriptParts.length > 0 && (
                    <button className="rec-download-btn" onClick={downloadTranslation} disabled={!hasTranslatedParts}>
                        <IconDownload size={13} />
                        <span>{lang === 'vi' ? 'Tải bản dịch' : 'Download translation'}</span>
                    </button>
                )}

                {!recording && transcriptParts.length > 0 && (
                    <button
                        className={`rec-summarize-btn ${summaryLoading ? 'loading' : ''} ${!aiConfigured ? 'needs-setup' : ''}`}
                        onClick={handleCreateMinutes}
                        disabled={summaryLoading}
                        aria-busy={summaryLoading}
                        title={!aiConfigured
                            ? (lang === 'vi'
                                ? 'Chưa cấu hình Trợ lý AI — bấm để mở Cài đặt và bật tính năng tạo biên bản'
                                : 'AI Assistant not set up — click to open Settings and enable minutes')
                            : (lang === 'vi' ? 'Chọn tuỳ chọn rồi tạo biên bản' : 'Pick options, then create minutes')}>
                        {summaryLoading ? (
                            <>
                                <IconSpinner size={14} className="rec-btn-spinner" />
                                <span>{lang === 'vi' ? 'Đang tạo biên bản...' : 'Creating minutes...'}</span>
                            </>
                        ) : (
                            <>
                                <IconMinutes size={14} />
                                <span>{lang === 'vi' ? 'Tạo biên bản' : 'Create Minutes'}</span>
                            </>
                        )}
                    </button>
                )}
            </div>

            {/* Minutes options popup — language + template moved out of the bar */}
            <MinutesOptionsModal
                open={minutesPopupOpen}
                lang={lang}
                onClose={() => setMinutesPopupOpen(false)}
                onConfirm={confirmCreateMinutes}
            />

            {/* Translation Bar */}
            <div className="translation-bar">
                <div className="audio-source-wrap">
                    <IconMic size={14} />
                    <CustomSelect className="audio-source-select" value={audioSource}
                        onChange={(v) => setAudioSource(v as 'mic' | 'system' | 'both')}
                        options={[
                            { value: 'mic', label: t('mic_only', lang) },
                            { value: 'system', label: t('system_only', lang) },
                            { value: 'both', label: t('both', lang) },
                        ]}
                    />
                </div>
                <div className="bar-divider" />
                <div
                    className="translation-toggle-wrap"
                    title={cabinDisabled
                        ? (lang === 'vi'
                            ? 'Dịch cabin cần Soniox (chưa hỗ trợ dịch offline) — không khả dụng ở chế độ Local'
                            : 'Cabin translation needs Soniox (no offline translate model) — unavailable in Local mode')
                        : undefined}
                    style={cabinDisabled ? { opacity: 0.45 } : undefined}
                >
                    <IconTranslate size={16} />
                    <span>{lang === 'vi' ? 'Dịch cabin' : 'Translate'}</span>
                    <label className="toggle toggle-sm">
                        <input type="checkbox" checked={translationEnabled && !cabinDisabled} disabled={cabinDisabled}
                            onChange={(e) => setTranslationEnabled(e.target.checked)} />
                        <span className="toggle-slider" />
                    </label>
                </div>
                <CustomSelect className="translation-lang-select" value={translationLang}
                    onChange={setTranslationLang} disabled={!translationEnabled || cabinDisabled}
                    options={[
                        { value: 'vi', label: 'Vietnamese' }, { value: 'en', label: 'English' },
                        { value: 'ja', label: 'Japanese' }, { value: 'ko', label: 'Korean' },
                        { value: 'zh', label: 'Chinese' }, { value: 'fr', label: 'French' },
                        { value: 'de', label: 'German' }, { value: 'es', label: 'Spanish' },
                        { value: 'th', label: 'Thai' }, { value: 'id', label: 'Indonesian' },
                        { value: 'ru', label: 'Russian' },
                    ]}
                />
            </div>
        </>
    );
}
