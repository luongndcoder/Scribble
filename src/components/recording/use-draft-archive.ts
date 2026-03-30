import { useRef, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { appendDraftAudio } from "../../lib/api";
import { ARCHIVE_CHUNK_INTERVAL_MS } from "./recording-constants";

/**
 * Hook managing draft audio archive recording and upload chain.
 */
export function useDraftArchive() {
    const archiveRecorderRef = useRef<MediaRecorder | null>(null);
    const audioUploadChainRef = useRef<Promise<void>>(Promise.resolve());

    const enqueueDraftAudioUpload = useCallback((blob: Blob) => {
        if (!blob || blob.size === 0) return;
        audioUploadChainRef.current = audioUploadChainRef.current
            .then(async () => {
                const dId = useAppStore.getState().draftId;
                if (!dId) return;
                try {
                    await appendDraftAudio(dId, blob, `meeting-${dId}.webm`);
                } catch (e) {
                    console.warn("[draft-audio] upload failed:", e);
                }
            })
            .catch((e) => {
                // Log but don't break the chain — next upload can still succeed
                console.warn("[draft-audio] upload chain error:", e);
            });
    }, []);

    const startDraftAudioArchive = useCallback(
        (stream: MediaStream) => {
            if (!stream) return;
            if (archiveRecorderRef.current) {
                try {
                    if (archiveRecorderRef.current.state !== "inactive") archiveRecorderRef.current.stop();
                } catch {}
                archiveRecorderRef.current = null;
            }

            let recorder: MediaRecorder;
            try {
                const mime = "audio/webm;codecs=opus";
                recorder = MediaRecorder.isTypeSupported(mime)
                    ? new MediaRecorder(stream, { mimeType: mime })
                    : new MediaRecorder(stream);
            } catch (e) {
                console.warn("[draft-audio] archive recorder unavailable:", e);
                return;
            }

            recorder.ondataavailable = (e) => {
                if (e.data && e.data.size > 0) enqueueDraftAudioUpload(e.data);
            };
            recorder.onerror = (e) => console.warn("[draft-audio] recorder error:", e);
            try {
                recorder.start(ARCHIVE_CHUNK_INTERVAL_MS);
                archiveRecorderRef.current = recorder;
            } catch (e) {
                console.warn("[draft-audio] recorder start failed:", e);
            }
        },
        [enqueueDraftAudioUpload],
    );

    const stopDraftAudioArchive = useCallback(() => {
        if (archiveRecorderRef.current) {
            try {
                if (archiveRecorderRef.current.state !== "inactive") archiveRecorderRef.current.stop();
            } catch {}
            archiveRecorderRef.current = null;
        }
    }, []);

    return { archiveRecorderRef, startDraftAudioArchive, stopDraftAudioArchive };
}
