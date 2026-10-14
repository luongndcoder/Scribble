/**
 * Single reducer for live STT stream messages.
 *
 * Shared by the browser WebSocket path (mic, `use-streaming-stt.ts`) and the
 * Tauri `system-audio-transcript` event path (`RecordingBar.tsx`). Those two
 * used to carry hand-copied handlers that had already drifted apart (system
 * audio ignored `append` translations, used a different timing guess and
 * different speaker fallbacks), so a fix in one never reached the other.
 */
import { useAppStore } from "../../stores/appStore";
import type { SttWsMessage } from "../../types/stt";

/** Same-speaker finals merge into one paragraph only while it stays readable.
 *  Local STT is unpunctuated, so without a cap one speaker became a wall of
 *  text that later re-split (and jumped) when the paragraph closed. */
const MAX_PARAGRAPH_CHARS = 360;
/** A pause longer than this starts a new paragraph even for the same speaker. */
const PARAGRAPH_GAP_SEC = 4;

export interface SttStreamContext {
    /** Added to backend speaker ids (system audio is offset so its speakers
     *  never collide with mic speakers). */
    speakerIdOffset: number;
    /** Trust backend `start_ms`/`end_ms`. Only valid when the stream clock
     *  starts at `streamOffsetSec` — the system-audio stream restarts on
     *  pause/translation toggles without the listener knowing, so it opts out. */
    useStreamClock: boolean;
    /** Recording timer value when this stream connected. */
    streamOffsetSec: number;
    setIsTranscribing: (v: boolean) => void;
}

export type SttMessageOutcome =
    | { kind: "ok" }
    | { kind: "error"; message: string; terminal: boolean };

const OK: SttMessageOutcome = { kind: "ok" };
const store = () => useAppStore.getState();

export function applySttMessage(data: SttWsMessage, ctx: SttStreamContext): SttMessageOutcome {
    // Soniox sends `error: true` + `text`; local-stream sends
    // `type: "error"` + `error`/`message`. Accept every shape.
    if (data.error || data.type === "error") {
        const fallback = store().lang === "vi" ? "Lỗi nhận dạng giọng nói" : "STT error";
        const message =
            (typeof data.error === "string" ? data.error : "") || data.message || data.text || fallback;
        ctx.setIsTranscribing(false);
        store().setInterimText("");
        return {
            kind: "error",
            message,
            terminal: Boolean(data.terminal || data.error === true || data.type === "error"),
        };
    }
    // Backend reconnect heartbeat. We own the (localized) display string
    // instead of echoing the backend's English text.
    if (data.info || data.type === "info") {
        store().setInterimText(`🔄 ${store().lang === "vi" ? "Đang kết nối lại..." : "Reconnecting..."}`);
        return OK;
    }
    if (data.type === "speaker_correction" && data.chunk_id) {
        const rawId = data.speaker_id ?? 0;
        store().updateTranscriptSpeakerByChunk(
            data.chunk_id,
            rawId + ctx.speakerIdOffset,
            data.speaker || `Speaker ${rawId + 1}`,
        );
        return OK;
    }
    if (data.type === "speaker_split") {
        commitPendingTranslation();
        const rawId = data.speaker_id ?? 0;
        store().setInterimText("");
        store().setInterimSpeaker(data.speaker || `Speaker ${rawId + 1}`, rawId + ctx.speakerIdOffset);
        return OK;
    }
    if (data.type === "translation" && data.translation) {
        applyTranslation(data);
        return OK;
    }

    // Streaming mode: speaker at top level. Chunked mode (/transcribe-diarize
    // relayed by system audio): speaker inside segments[0].
    const seg = data.segments?.[0];
    const text = (seg?.text || data.text || "").trim();
    if (!text) return OK;

    const state = store();
    if (!state.recording) {
        state.setInterimText("");
        ctx.setIsTranscribing(false);
        return OK;
    }
    const rawSpeakerId = seg?.speaker_id ?? data.speaker_id ?? 0;
    const speakerId = rawSpeakerId + ctx.speakerIdOffset;
    const speaker = seg?.speaker || data.speaker || `Speaker ${rawSpeakerId + 1}`;

    if (data.is_final) {
        // Finals are kept even while paused: the words were spoken before the
        // pause and only finished decoding after it — dropping them lost the
        // end of the sentence.
        applyFinal(data, text, speaker, speakerId, seg?.chunk_id || data.chunk_id || "", ctx);
        ctx.setIsTranscribing(false);
    } else if (!state.paused) {
        state.setInterimText(text);
        state.setInterimSpeaker(speaker, speakerId);
        ctx.setIsTranscribing(true);
    }
    return OK;
}

/** Move a pending interim translation onto the last committed part. */
function commitPendingTranslation() {
    const s = store();
    if (s.interimTranslation && s.transcriptParts.length > 0) {
        s.updateTranscriptTranslation(s.transcriptParts.length - 1, s.interimTranslation);
        s.setInterimTranslation("");
    }
}

/** Translation event: chunk-targeted (replace or append) or accumulated. */
function applyTranslation(data: SttWsMessage) {
    const translation = data.translation || "";
    const s = store();
    const parts = s.transcriptParts;
    if (data.chunk_id) {
        const cid = data.chunk_id;
        const idx = parts.findIndex((p) => p.chunkId === cid || (p.chunkIds && p.chunkIds.includes(cid)));
        if (idx >= 0) {
            const existing = parts[idx].translation || "";
            const next = data.append && existing ? `${existing} ${translation}` : translation;
            s.updateTranscriptTranslation(idx, next);
            if (idx === parts.length - 1) s.setInterimTranslation("");
            return;
        }
    }
    // No (known) chunk: accumulated block translation for the live part.
    if (parts.length > 0) {
        s.updateTranscriptTranslation(parts.length - 1, translation);
        s.setInterimTranslation("");
    } else {
        s.setInterimTranslation(translation);
    }
}

/** Commit a final: replace the in-progress chunk, extend the paragraph, or
 *  start a new one. */
function applyFinal(
    data: SttWsMessage,
    text: string,
    speaker: string,
    speakerId: number,
    chunkId: string,
    ctx: SttStreamContext,
) {
    const s = store();
    s.setInterimText("");
    s.setInterimSpeaker(speaker, speakerId);

    // Backend offsets are the truth; the timer fallback looks back 3s to
    // roughly match where the phrase started.
    const startSec = ctx.useStreamClock && data.start_ms != null
        ? ctx.streamOffsetSec + data.start_ms / 1000
        : Math.max(0, s.seconds - 3);
    const endSec = ctx.useStreamClock && data.end_ms != null
        ? ctx.streamOffsetSec + data.end_ms / 1000
        : s.seconds;
    const endStr = String(Math.floor(endSec));
    const tentativeLen = data.tentative ? data.tentative.length : 0;

    const last = s.transcriptParts[s.transcriptParts.length - 1];
    const lastChunkIds = new Set<string>();
    if (last?.chunkId) lastChunkIds.add(last.chunkId);
    last?.chunkIds?.forEach((id) => { if (id) lastChunkIds.add(id); });
    const sameChunk = Boolean(chunkId) && lastChunkIds.has(chunkId);
    const sameSpeaker = Boolean(last) && Number(last.speakerId) === Number(speakerId);
    // Translations are stored per part and replaced wholesale by each final,
    // so a translated chunk must own its part — merging would overwrite the
    // previous chunk's translation.
    const canMerge = sameSpeaker
        && !data.translation && !last.translation
        && last.text.length < MAX_PARAGRAPH_CHARS
        && startSec - (parseFloat(last.endTime) || 0) < PARAGRAPH_GAP_SEC;

    // Punctuating models (Nemotron) decide a comma/question mark only after
    // hearing the next words, so it can arrive at the START of the next final
    // (", nhưng tuy nhiên…"). It belongs to the end of the previous part.
    const leadPunct = /^[,.?!;:…]+/.exec(text)?.[0] ?? '';
    if (!sameChunk && !canMerge && leadPunct && last) {
        s.appendTextToPart(s.transcriptParts.length - 1, leadPunct);
        text = text.slice(leadPunct.length).trim();
        if (!text) return;
    }

    if (sameChunk) {
        const effectiveEnd =
            last.text === text && !last._tentativeLen && tentativeLen === 0 && last.endTime
                ? last.endTime
                : endStr;
        s.replaceLastPartText(text, effectiveEnd, chunkId || undefined, tentativeLen);
        if (chunkId && Number(last.speakerId) !== Number(speakerId)) {
            s.updateTranscriptSpeakerByChunk(chunkId, speakerId, speaker);
        }
    } else if (canMerge) {
        s.appendToLastPart(text, endStr, chunkId || undefined, tentativeLen);
    } else {
        commitPendingTranslation();
        s.addTranscriptPart({
            text,
            speaker,
            speakerId,
            chunkId: chunkId || undefined,
            chunkIds: chunkId ? [chunkId] : undefined,
            startTime: String(Math.floor(startSec)),
            endTime: endStr,
            timestamp: new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }),
            translation: "",
            _tentativeLen: tentativeLen,
        });
    }

    // Inline translation (Soniox sends it with each final).
    if (data.translation) {
        const parts = store().transcriptParts;
        if (parts.length > 0) {
            store().updateTranscriptTranslation(parts.length - 1, data.translation);
            store().setInterimTranslation("");
        }
    }
}
