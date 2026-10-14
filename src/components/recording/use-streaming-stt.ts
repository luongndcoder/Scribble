import { useRef, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { SIDECAR_WS_BASES } from "../../lib/sidecar";
import type { SttWsMessage } from "../../types/stt";
import { applySttMessage, type SttStreamContext } from "./stt-message-reducer";
import {
    WS_CONNECT_TIMEOUT_MS,
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
    // Only Soniox and Local remain; anything else (stale stored value) is
    // treated as Local — the free, key-less offline default.
    const wsPath = provider === "soniox" ? WS_PATH_SONIOX : WS_PATH_LOCAL;
    const translateQuery = translateLang ? `&translate_lang=${encodeURIComponent(translateLang)}` : "";
    const preferredWs = preferredHttpBase ? preferredHttpBase.replace(/^http/, "ws") : null;
    const urlSep = wsPath.includes("?") ? "&" : "?";

    const dialOne = (base: string): Promise<WebSocket | null> =>
        new Promise<WebSocket | null>((resolve) => {
            const url = `${base}${wsPath}${urlSep}t=1${translateQuery}`;
            let settled = false;
            let ws: WebSocket;
            try {
                ws = new WebSocket(url);
            } catch {
                resolve(null);
                return;
            }
            const finish = (ok: boolean) => {
                if (settled) return;
                settled = true;
                window.clearTimeout(timer);
                if (ok) {
                    resolve(ws);
                } else {
                    resolve(null);
                    try { ws.close(); } catch { /* already dead */ }
                }
            };
            const timer = window.setTimeout(() => finish(false), WS_CONNECT_TIMEOUT_MS);
            ws.onopen = () => finish(true);
            ws.onerror = () => finish(false);
            ws.onclose = () => finish(false);
        });

    // If waitForSidecarReady() already verified a healthy HTTP base (typically
    // 127.0.0.1:8765), dial ONLY that base first so we don't spawn a second
    // concurrent Soniox/local STT session on `localhost:8765` and wait on
    // Promise.all for the slower mDNS dial.
    if (preferredWs) {
        const direct = await dialOne(preferredWs);
        if (direct) return direct;
    }

    const fallbackBases = preferredWs
        ? SIDECAR_WS_BASES.filter((b) => b !== preferredWs)
        : [...SIDECAR_WS_BASES];
    if (fallbackBases.length === 0) return null;
    if (fallbackBases.length === 1) return dialOne(fallbackBases[0]);

    // True first-success race across remaining candidates: resolve as soon as
    // the first socket opens and immediately close any other in-flight sockets.
    return new Promise<WebSocket | null>((resolve) => {
        let winner: WebSocket | null = null;
        let remaining = fallbackBases.length;
        for (const base of fallbackBases) {
            void dialOne(base).then((ws) => {
                remaining -= 1;
                if (ws && !winner) {
                    winner = ws;
                    resolve(ws);
                } else if (ws) {
                    try { ws.close(); } catch { /* already dead */ }
                } else if (remaining === 0 && !winner) {
                    resolve(null);
                }
            });
        }
    });
}

/**
 * Attach transcript message handlers to an open WebSocket.
 * Message semantics live in `applySttMessage` (shared with system audio).
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
    // Backend start_ms/end_ms count from THIS socket's first sample, so pin
    // them to the timer value at connect (resumed drafts, reconnects).
    const ctx: SttStreamContext = {
        speakerIdOffset: 0,
        useStreamClock: true,
        streamOffsetSec: useAppStore.getState().seconds,
        setIsTranscribing,
    };

    ws.onmessage = (event) => {
        let data: SttWsMessage;
        try {
            data = JSON.parse(event.data);
        } catch (e) {
            console.warn("[stt-ws] message parse error:", e);
            return;
        }
        const outcome = applySttMessage(data, ctx);
        if (outcome.kind !== "error") return;
        console.error("[stt-ws]", outcome.message);
        // Terminal errors (402 budget, auth fail, model load failure) — the
        // stream is dead. Null wsRef BEFORE close so onclose skips reconnect.
        if (outcome.terminal || onTerminalError) {
            wsRef.current = null;
            try { ws.close(); } catch { /* may already be closed */ }
            onTerminalError?.(outcome.message);
        } else {
            useAppStore.getState().setInterimText(`⚠ ${outcome.message}`);
        }
    };

    ws.onerror = (e) => console.warn("[stt-ws] WebSocket error:", e);
    ws.onclose = () => {
        // Guard: skip reconnect if WS was already replaced (stop nullifies wsRef)
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

/** Control frame the Rust STT routes understand (`{"type":"stop"}`). The old
 *  plain-text "STOP" was ignored, so the server never got to flush. */
const STOP_FRAME = JSON.stringify({ type: "stop" });

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
            try { ws.send(STOP_FRAME); } catch {} // may already be closed
            try { ws.close(); } catch {} // may already be closed
        }
    }, []);

    /**
     * Graceful stop: ask the server to finalize, keep receiving until it
     * closes the socket (every trailing final delivered) or `timeoutMs`
     * passes. Message handlers stay attached, so late finals still land in
     * the transcript. Closing immediately used to drop the last utterance.
     */
    const drainWebSocket = useCallback(async (timeoutMs: number) => {
        const ws = wsRef.current;
        if (!ws) return;
        // Detach first: stops PCM sends and makes onclose skip its reconnect.
        wsRef.current = null;
        if (ws.readyState === WebSocket.OPEN) {
            await new Promise<void>((resolve) => {
                const timer = window.setTimeout(resolve, timeoutMs);
                ws.addEventListener("close", () => { window.clearTimeout(timer); resolve(); }, { once: true });
                try { ws.send(STOP_FRAME); } catch { window.clearTimeout(timer); resolve(); }
            });
        }
        try { ws.close(); } catch {} // may already be closed
    }, []);

    return { wsRef, scriptNodeRef, connectPcmStream, disconnectPcmStream, closeWebSocket, drainWebSocket };
}
