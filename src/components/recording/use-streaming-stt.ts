import { useRef, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { SIDECAR_WS_BASES } from "../../lib/sidecar";
import type { SttWsMessage } from "../../types/stt";
import {
    WS_CONNECT_TIMEOUT_MS,
    WS_PATH_NVIDIA,
    WS_PATH_SONIOX,
    WS_PATH_LOCAL,
    TARGET_SAMPLE_RATE,
    SCRIPT_PROCESSOR_BUFFER,
} from "./recording-constants";

/**
 * Open a WebSocket to the sidecar STT endpoint, trying multiple bases.
 */
export async function openStreamingWebSocket(
    provider: string,
    preferredHttpBase: string | null,
    translateLang?: string,
): Promise<WebSocket | null> {
    const wsPath = provider === "soniox" ? WS_PATH_SONIOX
        : provider === "local" ? WS_PATH_LOCAL
        : WS_PATH_NVIDIA;
    const translateQuery = translateLang ? `&translate_lang=${encodeURIComponent(translateLang)}` : "";
    const preferredWs = preferredHttpBase ? preferredHttpBase.replace(/^http/, "ws") : null;
    const wsBases = preferredWs ? [preferredWs, ...SIDECAR_WS_BASES.filter((b) => b !== preferredWs)] : [...SIDECAR_WS_BASES];

    for (const base of wsBases) {
        const urlSep = wsPath.includes("?") ? "&" : "?";
        const url = `${base}${wsPath}${urlSep}t=1${translateQuery}`;
        try {
            const ws = new WebSocket(url);
            const opened = await new Promise<boolean>((resolve) => {
                const timer = window.setTimeout(() => resolve(false), WS_CONNECT_TIMEOUT_MS);
                ws.onopen = () => { window.clearTimeout(timer); resolve(true); };
                ws.onerror = () => { window.clearTimeout(timer); resolve(false); };
                ws.onclose = () => { window.clearTimeout(timer); resolve(false); };
            });
            if (opened) return ws;
            try { ws.close(); } catch {}
        } catch {}
    }
    return null;
}

/**
 * Attach transcript message handlers to an open WebSocket.
 * Handles: speaker_correction, speaker_split, translation, interim/final text.
 */
export function attachSocketHandlers(
    ws: WebSocket,
    opts: {
        wsRef: React.MutableRefObject<WebSocket | null>;
        sttProvider: string;
        readyBase: string | null;
        fallbackToChunkMode: () => void;
        setIsTranscribing: (v: boolean) => void;
        /** Terminal STT error (e.g. Soniox 402 budget exhausted). When set, the
         * caller should stop recording + show a toast. Distinct from transient
         * connection errors which trigger fallbackToChunkMode. */
        onTerminalError?: (msg: string) => void;
    },
) {
    const { wsRef, sttProvider, readyBase, fallbackToChunkMode, setIsTranscribing, onTerminalError } = opts;

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.error) {
                // Surface the actual message (Soniox sends error: true + text: "..."),
                // not the boolean flag, so the user sees what went wrong.
                const fallbackErr = useAppStore.getState().lang === "vi" ? "Lỗi nhận dạng giọng nói" : "STT error";
                const msg = (typeof data.error === "string" ? data.error : "") || data.text || fallbackErr;
                console.error("[stt-ws]", msg);
                setIsTranscribing(false);
                useAppStore.getState().setInterimText("");
                // Terminal errors (402 budget, auth fail) — the stream is dead.
                // Null wsRef BEFORE close so the onclose handler skips reconnect.
                if (data.terminal || onTerminalError) {
                    wsRef.current = null;
                    try { ws.close(); } catch { /* may already be closed */ }
                    onTerminalError?.(msg);
                } else {
                    // Backwards-compat: legacy non-terminal error keeps old UX.
                    useAppStore.getState().setInterimText(`⚠ ${msg}`);
                }
                return;
            }
            // Backend reconnect heartbeat (Soniox auto-reconnect after server
            // closed the WS due to its ~1h session-duration cap). Show as
            // interim status; do NOT add to transcriptParts. We OWN the display
            // string (localized) instead of echoing the backend's English text,
            // so the message always matches the UI language.
            if (data.info || data.type === "info") {
                const reconnecting = useAppStore.getState().lang === "vi"
                    ? "Đang kết nối lại..."
                    : "Reconnecting...";
                useAppStore.getState().setInterimText(`🔄 ${reconnecting}`);
                return;
            }
            if (data.type === "speaker_correction" && data.chunk_id) {
                const correctedId = data.speaker_id ?? 0;
                const correctedSpeaker = data.speaker || `Speaker ${correctedId + 1}`;
                useAppStore.getState().updateTranscriptSpeakerByChunk(data.chunk_id, correctedId, correctedSpeaker);
                return;
            }
            if (data.type === "speaker_split") {
                const preState = useAppStore.getState();
                if (preState.interimTranslation && preState.transcriptParts.length > 0) {
                    const lastIdx = preState.transcriptParts.length - 1;
                    useAppStore.getState().updateTranscriptTranslation(lastIdx, preState.interimTranslation);
                    useAppStore.getState().setInterimTranslation("");
                }
                const newSpeakerId = data.speaker_id ?? 0;
                const newSpeaker = data.speaker || `Speaker ${newSpeakerId + 1}`;
                useAppStore.getState().setInterimText("");
                useAppStore.getState().setInterimSpeaker(newSpeaker, newSpeakerId);
                return;
            }
            // Translation event
            if (data.type === "translation" && data.translation) {
                handleTranslationEvent(data);
                return;
            }

            const text = (data.text || "").trim();
            if (!text) return;

            const state = useAppStore.getState();
            if (!state.recording || state.paused) {
                useAppStore.getState().setInterimText("");
                setIsTranscribing(false);
                return;
            }
            const ts = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

            if (data.is_final) {
                handleFinalTranscript(data, text, ts, state);
                setIsTranscribing(false);
            } else {
                useAppStore.getState().setInterimText(text);
                useAppStore.getState().setInterimSpeaker(data.speaker || "Speaker 1", data.speaker_id ?? 0);
                setIsTranscribing(true);
            }
        } catch (e) {
            console.warn("[stt-ws] message parse error:", e);
        }
    };

    ws.onerror = (e) => console.warn("[stt-ws] WebSocket error:", e);
    ws.onclose = () => {
        // Guard: skip reconnect if WS was already replaced (stopRecording nullifies wsRef)
        if (wsRef.current !== ws) return;
        const state = useAppStore.getState();
        // Don't reconnect if paused or not recording (user stopped)
        if (state.paused || !state.recording) return;
        void (async () => {
            try {
                const reopened = await openStreamingWebSocket(
                    sttProvider,
                    readyBase,
                    useAppStore.getState().translationEnabled ? useAppStore.getState().translationLang : undefined,
                );
                // Re-check: user may have stopped during reconnect attempt
                if (!useAppStore.getState().recording || wsRef.current !== ws) {
                    if (reopened) try { reopened.close(); } catch {}
                    return;
                }
                if (!reopened) {
                    fallbackToChunkMode();
                    return;
                }
                wsRef.current = reopened;
                attachSocketHandlers(reopened, opts);
            } catch (e) {
                console.warn("[stt-ws] Reconnect failed:", e);
                fallbackToChunkMode();
            }
        })();
    };
}

/** Handle a translation WS event (chunk-targeted or interim). */
function handleTranslationEvent(data: SttWsMessage) {
    const translation = data.translation || "";
    if (data.chunk_id) {
        const currentParts = useAppStore.getState().transcriptParts;
        const cid = data.chunk_id;
        const targetIdx = currentParts.findIndex(
            (p) => p.chunkId === cid || (p.chunkIds && p.chunkIds.includes(cid)),
        );
        if (targetIdx >= 0) {
            if (data.append) {
                const existingTrans = currentParts[targetIdx].translation || "";
                const combined = existingTrans ? `${existingTrans} ${translation}` : translation;
                useAppStore.getState().updateTranscriptTranslation(targetIdx, combined);
            } else {
                // Replace mode: accumulated translation from Nvidia NMT
                useAppStore.getState().updateTranscriptTranslation(targetIdx, translation);
            }
            // Clear interim if this is the live (last) part
            if (targetIdx === currentParts.length - 1) {
                useAppStore.getState().setInterimTranslation("");
            }
            return;
        }
    }
    // No chunk_id: accumulated block translation (Nvidia NMT).
    // Backend sends growing accumulated result — always accept and persist.
    const parts = useAppStore.getState().transcriptParts;
    if (parts.length > 0) {
        const lastIdx = parts.length - 1;
        useAppStore.getState().updateTranscriptTranslation(lastIdx, translation);
        useAppStore.getState().setInterimTranslation("");
    } else {
        useAppStore.getState().setInterimTranslation(translation);
    }
}

/** Handle a final transcript result — determine same-chunk, same-speaker, or new speaker. */
function handleFinalTranscript(data: SttWsMessage, text: string, ts: string, state: ReturnType<typeof useAppStore.getState>) {
    const speakerId = data.speaker_id ?? 0;
    const speaker = data.speaker || "Speaker 1";
    const chunkId = data.chunk_id || "";

    useAppStore.getState().setInterimText("");
    useAppStore.getState().setInterimSpeaker(speaker, speakerId);

    // Prefer the backend's token-level offsets (Soniox sends start_ms / end_ms
    // per segment, which is the truth). Fall back to the recording timer for
    // STT sources that don't provide ms offsets, with a 3-second look-back on
    // segment start to roughly match the spoken phrase boundary.
    const startSec = data.start_ms != null
        ? Math.floor(data.start_ms / 1000)
        : Math.max(0, state.seconds - 3);
    const endSec = data.end_ms != null
        ? Math.floor(data.end_ms / 1000)
        : state.seconds;

    const lastPart = state.transcriptParts[state.transcriptParts.length - 1];
    const lastChunkIds = new Set<string>();
    if (lastPart?.chunkId) lastChunkIds.add(lastPart.chunkId);
    if (Array.isArray(lastPart?.chunkIds)) {
        lastPart.chunkIds.forEach((id) => { if (id) lastChunkIds.add(id); });
    }
    const sameChunk = Boolean(chunkId) && lastChunkIds.has(chunkId);
    const sameSpeaker = Boolean(lastPart) && Number(lastPart.speakerId) === Number(speakerId);

    if (sameChunk) {
        useAppStore.getState().replaceLastPartText(text, String(endSec), chunkId || undefined);
    } else if (sameSpeaker) {
        // Don't clear interimTranslation here — accumulated translation will update via handleTranslationEvent
        useAppStore.getState().appendToLastPart(text, String(endSec), chunkId || undefined);
    } else {
        // New speaker — commit pending translation
        const prevTranslation = useAppStore.getState().interimTranslation;
        if (prevTranslation && state.transcriptParts.length > 0) {
            useAppStore.getState().updateTranscriptTranslation(state.transcriptParts.length - 1, prevTranslation);
            useAppStore.getState().setInterimTranslation("");
        }
        useAppStore.getState().addTranscriptPart({
            text,
            speaker,
            speakerId,
            chunkId: chunkId || undefined,
            chunkIds: chunkId ? [chunkId] : undefined,
            startTime: String(startSec),
            endTime: String(endSec),
            timestamp: ts,
            translation: "",
        });
    }

    // Inline translation on final event
    if (data.translation) {
        const updatedParts = useAppStore.getState().transcriptParts;
        if (updatedParts.length > 0) {
            const li = updatedParts.length - 1;
            useAppStore.getState().updateTranscriptTranslation(li, data.translation);
            useAppStore.getState().setInterimTranslation("");
        }
    }
}

/**
 * Hook providing WebSocket ref and PCM streaming node setup.
 */
export function useStreamingStt() {
    const wsRef = useRef<WebSocket | null>(null);
    const scriptNodeRef = useRef<ScriptProcessorNode | null>(null);
    const audioCtxRef = useRef<AudioContext | null>(null);

    /** Connect ScriptProcessor to WebSocket for PCM streaming. Stores audioCtx ref for cleanup. */
    const connectPcmStream = useCallback(
        (audioCtx: AudioContext, sourceNode: AudioNode) => {
            audioCtxRef.current = audioCtx;
            const scriptNode = audioCtx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);
            scriptNodeRef.current = scriptNode;
            sourceNode.connect(scriptNode);
            scriptNode.connect(audioCtx.destination);

            scriptNode.onaudioprocess = (e) => {
                const socket = wsRef.current;
                if (!socket || socket.readyState !== WebSocket.OPEN) return;
                const state = useAppStore.getState();
                if (state.paused) return;
                const inputData = e.inputBuffer.getChannelData(0);
                const ratio = audioCtx.sampleRate / TARGET_SAMPLE_RATE;
                const outputLen = Math.floor(inputData.length / ratio);
                const pcm16 = new Int16Array(outputLen);
                for (let i = 0; i < outputLen; i++) {
                    const sample = inputData[Math.floor(i * ratio)];
                    pcm16[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
                }
                socket.send(pcm16.buffer);
            };
        },
        [],
    );

    const disconnectPcmStream = useCallback(() => {
        if (scriptNodeRef.current) {
            scriptNodeRef.current.disconnect();
            scriptNodeRef.current = null;
        }
        if (audioCtxRef.current) {
            audioCtxRef.current.close().catch(() => {});
            audioCtxRef.current = null;
        }
    }, []);

    const closeWebSocket = useCallback(() => {
        const ws = wsRef.current;
        if (ws) {
            wsRef.current = null;
            try { ws.send("STOP"); } catch {} // may already be closed
            try { ws.close(); } catch {} // may already be closed
        }
    }, []);

    return { wsRef, scriptNodeRef, connectPcmStream, disconnectPcmStream, closeWebSocket };
}
