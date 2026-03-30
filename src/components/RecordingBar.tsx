import { useRef, useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { resetDiarize, createDraft, downloadTextFile, getSettings } from '../lib/api';
import { fetchSidecar, waitForSidecarReady } from '../lib/sidecar';
import { t } from '../i18n';
import { CustomSelect } from './CustomSelect';
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


export function RecordingBar() {
    const {
        recording, paused, seconds, transcriptParts, currentMeetingId, meetings,
        translationEnabled, translationLang, summaryLang, setSummaryLang,
        summaryTemplate, setSummaryTemplate, customPrompt, setCustomPrompt,
        setRecording, setPaused, setSeconds, clearTranscript,
        addTranscriptPart,
        setTranslationEnabled, setTranslationLang, lang,
        setIsTranscribing, setInterimText, setInterimSpeaker,
        summaryLoading,
    } = useAppStore();

    const [audioSource, setAudioSource] = useState<'mic' | 'system' | 'both'>('mic');
    const [barHeights, setBarHeights] = useState(['4px', '4px', '4px']);
    const sttProviderRef = useRef('nvidia');

    // Hooks from recording modules
    const { analyserRef, startDrawing, stopDrawing, setBarHeightsFn } = useWaveform();
    const { archiveRecorderRef, startDraftAudioArchive, stopDraftAudioArchive } = useDraftArchive();
    const { mediaRecorderRef, inflightChunksRef, startChunkRecording } = useChunkRecording();
    const { wsRef, connectPcmStream, disconnectPcmStream, closeWebSocket } = useStreamingStt();
    const { summarize } = useSummarize();

    const streamRef = useRef<MediaStream | null>(null);
    const timerRef = useRef<number | null>(null);

    // Sync barHeights from waveform hook to local state
    useEffect(() => {
        setBarHeightsFn.current = setBarHeights;
    }, [setBarHeightsFn]);

    // ── Mid-session translation toggle ──
    const translationToggleRef = useRef({ enabled: translationEnabled, lang: translationLang });
    useEffect(() => {
        const prev = translationToggleRef.current;
        const changed = prev.enabled !== translationEnabled || (translationEnabled && prev.lang !== translationLang);
        translationToggleRef.current = { enabled: translationEnabled, lang: translationLang };
        if (!changed || !recording) return;

        if (sttProviderRef.current === 'nvidia') {
            const cmd = translationEnabled ? `TRANSLATE:${translationLang}` : 'TRANSLATE:off';
            const payload = JSON.stringify({ text: cmd });
            if (isTauri && audioSource === 'both') {
                import('@tauri-apps/api/event').then(({ emit }) => {
                    emit('system-audio-cmd', payload).catch(console.warn);
                });
            } else {
                const ws = wsRef.current;
                if (ws && ws.readyState === WebSocket.OPEN) ws.send(payload);
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
            const tid = (window as any).__systemUnlistenTimeout;
            if (tid) clearTimeout(tid);
            const unlisten = (window as any).__systemAudioUnlisten;
            if (unlisten) { unlisten(); (window as any).__systemAudioUnlisten = null; }
            clearInterval((window as any).__vadInterval);
            clearInterval((window as any).__systemBarInterval);
        };
    }, []);

    // ── Timer ──
    useEffect(() => {
        if (recording && !paused) {
            timerRef.current = window.setInterval(() => {
                useAppStore.setState((s) => ({ seconds: s.seconds + 1 }));
            }, 1000);
        }
        return () => { if (timerRef.current) clearInterval(timerRef.current); };
    }, [recording, paused]);

    // ── Permissions ──
    const ensureSystemCapturePermission = useCallback(async (): Promise<boolean> => {
        if (!isTauri || (audioSource !== 'system' && audioSource !== 'both')) return true;
        try {
            const has = Boolean(await safeInvoke('check_screen_access'));
            if (has) return true;
            return Boolean(await safeInvoke('request_screen_access'));
        } catch { return false; }
    }, [audioSource]);

    // ── System audio transcript handler (Tauri events) ──
    const setupSystemAudioListener = useCallback(async (_sttProvider: string) => {
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

                // Translation event
                if (data.type === 'translation' && data.translation) {
                    if (data.chunk_id) {
                        const currentParts = useAppStore.getState().transcriptParts;
                        const targetIdx = currentParts.findIndex(
                            (p) => p.chunkId === data.chunk_id || (p.chunkIds && p.chunkIds.includes(data.chunk_id))
                        );
                        if (targetIdx >= 0) {
                            useAppStore.getState().updateTranscriptTranslation(targetIdx, data.translation);
                            return;
                        }
                    }
                    useAppStore.getState().setInterimTranslation(data.translation);
                    return;
                }

                const seg = data.segments?.[0] || {};
                const text = (seg.text || data.text || '').trim();
                if (!text) return;

                const speakerId = (seg.speaker_id ?? 0) + SYSTEM_SPEAKER_ID_OFFSET;
                const speaker = seg.speaker || 'System';
                const chunkId = seg.chunk_id || data.chunk_id || '';
                const ts = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
                addTranscriptPart({
                    text, speaker, speakerId,
                    chunkId: chunkId || undefined,
                    chunkIds: chunkId ? [chunkId] : undefined,
                    startTime: String(Math.max(0, state.seconds - 5)),
                    endTime: String(state.seconds),
                    timestamp: ts,
                    translation: data.translation || '',
                });
            } catch {}
        });
        return unlisten;
    }, [addTranscriptPart, setIsTranscribing]);

    // ── Start recording ──
    const startRecording = useCallback(async () => {
        try {
            setInterimText('');
            setInterimSpeaker('Speaker 1', 0);
            setIsTranscribing(false);

            if (!(await ensureSystemCapturePermission())) return;

            const state = useAppStore.getState();
            const currentMeeting = state.currentMeetingId
                ? state.meetings.find((m) => m.id === state.currentMeetingId)
                : null;
            const resumeDraftId = currentMeeting?.status === 'draft'
                ? currentMeeting.id
                : (!state.currentMeetingId && state.draftId ? state.draftId : null);

            try { await resetDiarize(); } catch {}

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
            let sttProvider = 'nvidia';
            try {
                const settingsData = await getSettings();
                sttProvider = settingsData.stt_provider || 'nvidia';
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
                    (window as any).__systemBarInterval = barInterval;
                    const unlisten = await setupSystemAudioListener(sttProvider);
                    (window as any).__systemAudioUnlisten = unlisten;
                    return;
                }
                // Browser system audio
                const displayStream = await navigator.mediaDevices.getDisplayMedia({
                    audio: true, video: { width: 1, height: 1, frameRate: 1 }
                });
                displayStream.getVideoTracks().forEach(t => t.stop());
                stream = new MediaStream(displayStream.getAudioTracks());
            } else if (audioSource === 'both') {
                const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
                        (window as any).__systemAudioUnlisten = unlisten;
                    } catch (e) {
                        console.warn('[both] system audio failed:', e);
                    }
                } else {
                    const displayStream = await navigator.mediaDevices.getDisplayMedia({
                        audio: true, video: { width: 1, height: 1, frameRate: 1 }
                    });
                    displayStream.getVideoTracks().forEach(t => t.stop());
                    const audioCtx = new AudioContext();
                    const micSource = audioCtx.createMediaStreamSource(micStream);
                    const displaySource = audioCtx.createMediaStreamSource(displayStream);
                    const merger = audioCtx.createChannelMerger(2);
                    micSource.connect(merger, 0, 0);
                    displaySource.connect(merger, 0, 1);
                    const dest = audioCtx.createMediaStreamDestination();
                    merger.connect(dest);
                    stream = dest.stream;
                    (stream as any)._sources = [micStream, displayStream];
                }
            } else {
                stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }

            streamRef.current = stream;
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(stream);
            analyserRef.current = audioCtx.createAnalyser();
            analyserRef.current.fftSize = 2048;
            source.connect(analyserRef.current);
            startDrawing();
            startDraftAudioArchive(stream);

            // Try WebSocket streaming, fallback to chunk mode
            const readyBase = await waitForSidecarReady();
            let chunkFallbackStarted = false;
            const fallbackToChunkMode = () => {
                if (chunkFallbackStarted) return;
                chunkFallbackStarted = true;
                closeWebSocket();
                disconnectPcmStream();
                startChunkRecording(stream, analyserRef);
            };

            const { translationEnabled: tlEnabled, translationLang: tlLang } = useAppStore.getState();
            const ws = await openStreamingWebSocket(sttProvider, readyBase, tlEnabled ? tlLang : undefined);
            if (!ws) {
                fallbackToChunkMode();
            } else {
                wsRef.current = ws;
                attachSocketHandlers(ws, {
                    wsRef, sttProvider, readyBase, fallbackToChunkMode, setIsTranscribing,
                });
                connectPcmStream(audioCtx, source);
            }
        } catch (err) {
            console.error('Audio access error:', err);
            setRecording(false);
        }
    }, [
        audioSource, clearTranscript, setRecording, setSeconds, startDrawing, startChunkRecording,
        startDraftAudioArchive, addTranscriptPart, lang, setInterimText, setInterimSpeaker,
        setIsTranscribing, ensureSystemCapturePermission, setupSystemAudioListener,
        wsRef, connectPcmStream, disconnectPcmStream, closeWebSocket, analyserRef,
    ]);

    // ── Stop recording ──
    const stopRecording = useCallback(async () => {
        mediaRecorderRef.current?.stop();
        const inflight = Array.from(inflightChunksRef.current);
        if (inflight.length > 0) await Promise.allSettled(inflight);

        // Flush interim text
        const state = useAppStore.getState();
        const dId = state.draftId;
        const interimText = state.interimText?.trim();
        if (interimText) {
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
                const transcriptJson = JSON.stringify(
                    allParts.map(p => ({
                        text: p.text, speaker: p.speaker, speakerId: p.speakerId,
                        startTime: p.startTime, endTime: p.endTime,
                        chunkId: p.chunkId, chunkIds: p.chunkIds, translation: p.translation || '',
                    }))
                );
                await fetchSidecar(`/meetings/${dId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transcript: transcriptJson, audioDuration: useAppStore.getState().seconds }),
                }).catch(e => console.warn('[stop] sync failed:', e));
            }
        }

        setRecording(false); setPaused(false);
        setIsTranscribing(false); setInterimText(''); setInterimSpeaker('Speaker 1', 0);
        mediaRecorderRef.current?.stop();
        stopDraftAudioArchive();
        closeWebSocket();
        disconnectPcmStream();

        const stream = streamRef.current;
        if (stream) {
            const extra = (stream as any)._sources as MediaStream[] | undefined;
            if (extra) extra.forEach(s => s.getTracks().forEach(t => t.stop()));
            stream.getTracks().forEach(t => t.stop());
        }
        stopDrawing();
        clearInterval((window as any).__vadInterval);
        clearInterval((window as any).__systemBarInterval);
        setBarHeights(['4px', '4px', '4px']);
        safeInvoke('stop_system_audio').catch(() => {});

        const systemUnlisten = (window as any).__systemAudioUnlisten;
        if (systemUnlisten) {
            (window as any).__systemAudioUnlisten = null;
            const tid = setTimeout(() => systemUnlisten(), 3000);
            (window as any).__systemUnlistenTimeout = tid;
        }
    }, [setRecording, setPaused, setIsTranscribing, setInterimText, setInterimSpeaker,
        stopDraftAudioArchive, closeWebSocket, disconnectPcmStream, stopDrawing,
        mediaRecorderRef, inflightChunksRef]);

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
            sysArgs.sttProvider = sttProviderRef.current || 'nvidia';
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
                        <button className="rec-pause-btn" onClick={togglePause} aria-label={paused ? 'Resume' : 'Pause'}>
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
                    <div className="summarize-group">
                        <CustomSelect className="summary-lang-select" value={summaryLang} onChange={setSummaryLang}
                            options={[{ value: 'vi', label: 'Vietnamese' }, { value: 'en', label: 'English' }]}
                        />
                        <CustomSelect className="summary-template-select" value={summaryTemplate} onChange={setSummaryTemplate}
                            options={[
                                { value: 'mom', label: lang === 'vi' ? 'Biên bản (MoM)' : 'Minutes (MoM)' },
                                { value: 'summary', label: lang === 'vi' ? 'Tóm tắt chi tiết' : 'Detailed Summary' },
                                { value: 'bullets', label: 'Bullet Points' },
                                { value: 'custom', label: lang === 'vi' ? 'Tùy chỉnh' : 'Custom Prompt' },
                            ]}
                        />
                        {summaryTemplate === 'custom' && (
                            <textarea className="custom-prompt-input" value={customPrompt}
                                onChange={(e) => setCustomPrompt(e.target.value)}
                                placeholder={lang === 'vi' ? 'Nhập prompt tùy chỉnh...' : 'Enter your custom prompt...'} rows={3}
                            />
                        )}
                        <button className={`rec-summarize-btn ${summaryLoading ? 'loading' : ''}`}
                            onClick={summarize} disabled={summaryLoading} aria-busy={summaryLoading}>
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
                    </div>
                )}
            </div>

            {/* Translation Bar */}
            <div className="translation-bar">
                <div className="audio-source-wrap">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M2 10v3a7 7 0 0 0 14 0v-3" /><path d="M9 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    </svg>
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
                <CustomSelect className="translation-lang-select" value={translationLang}
                    onChange={setTranslationLang} disabled={!translationEnabled}
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
