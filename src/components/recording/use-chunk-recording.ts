import { useRef, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { fetchSidecar } from "../../lib/sidecar";
import type { SttSegment, SttTranscribeResponse } from "../../types/stt";
import {
    SILENCE_DURATION_MS,
    MIN_CHUNK_SEC,
    MAX_CHUNK_SEC,
    VAD_INTERVAL_MS,
    SILENCE_RMS_THRESHOLD,
} from "./recording-constants";

/**
 * Hook for VAD-based chunk recording (fallback when WebSocket streaming is unavailable).
 */
export function useChunkRecording() {
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const inflightChunksRef = useRef<Set<Promise<void>>>(new Set());

    const sendChunk = async (blob: Blob, startSec: number, endSec: number) => {
        const { setInterimText, setInterimSpeaker, setIsTranscribing, addTranscriptPart, appendToLastPart } =
            useAppStore.getState();
        const form = new FormData();
        form.append("audio", blob, "chunk.webm");
        setInterimText("");
        setInterimSpeaker("Speaker 1", 0);
        setIsTranscribing(true);
        try {
            const res = await fetchSidecar("/transcribe-diarize", { method: "POST", body: form });
            const data: SttTranscribeResponse = await res.json();
            const ts = new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });

            const rawSegments: SttSegment[] = Array.isArray(data.segments) ? data.segments : [];
            const normalizedSegments = rawSegments
                .map((seg) => ({
                    text: String(seg?.text || "").trim(),
                    speakerId: seg?.speaker_id ?? 0,
                    speaker: seg?.speaker || "Speaker 1",
                    chunkId: seg?.chunk_id || "",
                }))
                .filter((seg) => seg.text.length > 0);

            if (normalizedSegments.length === 0) {
                const fallbackText = String(data.text || "").trim();
                if (!fallbackText) return;
                normalizedSegments.push({
                    text: fallbackText,
                    speakerId: 0,
                    speaker: "Speaker 1",
                    chunkId: data.chunk_id || "",
                });
            }

            const safeStart = Math.max(0, startSec);
            const safeEnd = Math.max(safeStart, endSec);
            const perSegment = (safeEnd - safeStart) / Math.max(1, normalizedSegments.length);

            normalizedSegments.forEach((seg, idx) => {
                const segStart = safeStart + perSegment * idx;
                const segEnd = idx === normalizedSegments.length - 1 ? safeEnd : safeStart + perSegment * (idx + 1);

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
                    translation: "",
                });
            });
        } catch (err) {
            console.error("Transcription error:", err);
        }
        setInterimText("");
        setInterimSpeaker("Speaker 1", 0);
        setIsTranscribing(false);
    };

    const sendChunkTracked = (blob: Blob, startSec: number, endSec: number) => {
        const p = sendChunk(blob, startSec, endSec).finally(() => {
            inflightChunksRef.current.delete(p as Promise<void>);
        }) as Promise<void>;
        inflightChunksRef.current.add(p);
    };

    const startChunkRecording = useCallback(
        (stream: MediaStream, analyserRef: React.RefObject<AnalyserNode | null>) => {
            let chunkStart = Date.now();
            let isSilent = false,
                silenceStart = 0;
            let recorder: MediaRecorder | null = null;
            let chunks: Blob[] = [];

            const startRec = () => {
                recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
                chunks = [];
                recorder.ondataavailable = (e) => {
                    if (e.data.size > 0) chunks.push(e.data);
                };
                recorder.onstop = () => {
                    const blob = new Blob(chunks, { type: "audio/webm" });
                    const { seconds } = useAppStore.getState();
                    const endSec = seconds;
                    const startSec = endSec - (Date.now() - chunkStart) / 1000;
                    sendChunkTracked(blob, Math.max(0, startSec), endSec);
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
                const now = Date.now(),
                    age = (now - chunkStart) / 1000,
                    silent = rms < SILENCE_RMS_THRESHOLD;
                if (silent) {
                    if (!isSilent) {
                        isSilent = true;
                        silenceStart = now;
                    }
                    if (now - silenceStart >= SILENCE_DURATION_MS && age >= MIN_CHUNK_SEC) {
                        isSilent = false;
                        recorder?.stop();
                    }
                } else {
                    isSilent = false;
                    silenceStart = 0;
                }
                if (age >= MAX_CHUNK_SEC) {
                    isSilent = false;
                    recorder?.stop();
                }
            }, VAD_INTERVAL_MS);
            window.__vadInterval = vadInterval;
        },
        [],
    );

    return { mediaRecorderRef, inflightChunksRef, startChunkRecording };
}
