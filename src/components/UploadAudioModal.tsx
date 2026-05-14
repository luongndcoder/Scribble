/**
 * Upload Audio Modal — pick a local audio/video file, stream it to the sidecar
 * via the Rust bridge, then watch the pipeline progress over SSE until a
 * transcript + minutes are ready.
 *
 * Why one component:
 *   The upload + pipeline + outcome are a single user-perceived flow. Splitting
 *   into three modals would lose context (which file, which job) and make
 *   cancel ambiguous. Internal step machine (idle/picked/uploading/pipeline/
 *   done/error) keeps the surface area testable.
 *
 * Cross-platform: file picking goes through Tauri's native dialog (windows,
 * mac, linux). HTML5 <input type="file"> is intentionally NOT used — it would
 * load the whole file into the webview's JS heap, which OOMs WebKitGTK on
 * Linux past ~500MB.
 */
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { NVIDIA_STT_LANGUAGES } from '../lib/language-options';
import {
    cancelAudioUpload,
    cancelJob,
    isDuplicateError,
    isTerminal,
    pickAudioFile,
    subscribeJobEvents,
    uploadAudio,
    type JobChunkPayload,
    type JobState,
    type UploadProgressPayload,
    type UploadResult,
} from '../lib/upload-audio';
import { CustomSelect } from './CustomSelect';
import { useToast } from './Toast';

type Step = 'pick' | 'uploading' | 'pipeline' | 'done' | 'error' | 'duplicate';

interface ChunkLine {
    idx: number;
    text: string;
}

interface Props {
    open: boolean;
    onClose: () => void;
    /** Fired when a meeting becomes ready (done or duplicate). Caller navigates. */
    onMeetingReady: (meetingId: number) => void;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function basenameFromPath(p: string): string {
    const cleaned = p.replace(/[\\/]+$/, '');
    const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
    return slash >= 0 ? cleaned.slice(slash + 1) : cleaned;
}

function stemFromBasename(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
}

export function UploadAudioModal({ open, onClose, onMeetingReady }: Props) {
    const { lang } = useAppStore();
    const { showToast } = useToast();

    const [step, setStep] = useState<Step>('pick');
    const [filePath, setFilePath] = useState<string | null>(null);
    const [title, setTitle] = useState<string>('');
    const [language, setLanguage] = useState<string>('vi');

    // Upload phase (Rust streaming)
    const [bytesSent, setBytesSent] = useState<number>(0);
    const [totalBytes, setTotalBytes] = useState<number>(0);

    // Pipeline phase (sidecar SSE)
    const [jobState, setJobState] = useState<JobState | null>(null);
    const [chunks, setChunks] = useState<ChunkLine[]>([]);

    // Outcome
    const [readyMeetingId, setReadyMeetingId] = useState<number | null>(null);
    const [duplicateMeetingId, setDuplicateMeetingId] = useState<number | null>(null);
    const [errorMessage, setErrorMessage] = useState<string>('');

    const uploadIdRef = useRef<string | null>(null);
    const jobIdRef = useRef<string | null>(null);
    const sseAbortRef = useRef<AbortController | null>(null);
    const cancelledRef = useRef<boolean>(false);
    const chunksEndRef = useRef<HTMLDivElement | null>(null);

    const resetAll = () => {
        setStep('pick');
        setFilePath(null);
        setTitle('');
        setBytesSent(0);
        setTotalBytes(0);
        setJobState(null);
        setChunks([]);
        setReadyMeetingId(null);
        setDuplicateMeetingId(null);
        setErrorMessage('');
        uploadIdRef.current = null;
        jobIdRef.current = null;
        sseAbortRef.current = null;
        cancelledRef.current = false;
    };

    // Reset whenever the modal is opened fresh.
    useEffect(() => {
        if (open) resetAll();
        // Cleanup on unmount or close: abort SSE so we don't leak the stream.
        return () => {
            if (sseAbortRef.current) {
                sseAbortRef.current.abort();
                sseAbortRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    // Auto-scroll chunk preview as new lines arrive.
    useEffect(() => {
        chunksEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, [chunks.length]);

    if (!open) return null;

    const tr = lang === 'vi'
        ? {
              title: 'Upload file ghi âm',
              subtitle: 'Chọn file audio/video — Scribble sẽ tự phiên âm và tạo biên bản.',
              pickFile: 'Chọn file…',
              pickedFile: 'File đã chọn',
              titleLabel: 'Tiêu đề cuộc họp',
              titlePlaceholder: 'Tên cuộc họp (tuỳ chọn)',
              languageLabel: 'Ngôn ngữ chính',
              start: 'Bắt đầu xử lý',
              cancel: 'Hủy',
              close: 'Đóng',
              uploading: 'Đang tải file lên',
              processing: 'Đang xử lý',
              transcript: 'Bản phiên âm trực tiếp',
              done: 'Hoàn thành',
              doneDesc: 'Biên bản đã sẵn sàng.',
              openMeeting: 'Mở cuộc họp',
              error: 'Có lỗi xảy ra',
              tryAgain: 'Thử lại',
              duplicate: 'File đã được upload trước đó',
              duplicateDesc: (id: number) => `File này đã tồn tại trong cuộc họp #${id}. Mở cuộc họp đó?`,
              openExisting: 'Mở cuộc họp cũ',
              chunkStats: (done: number, total: number) =>
                  total > 0 ? `Đã phiên âm ${done}/${total} đoạn` : '',
              chunkStatsDone: (total: number) =>
                  total > 0 ? `✓ Đã phiên âm xong ${total}/${total} đoạn` : '',
              summarizingHint: 'Đang tổng hợp biên bản tự động (vài phút)…',
              hint: 'Tip: file lớn có thể mất vài phút.',
              cancelling: 'Đang hủy…',
          }
        : {
              title: 'Upload audio file',
              subtitle: 'Pick a local audio or video — Scribble transcribes it and generates minutes.',
              pickFile: 'Choose file…',
              pickedFile: 'Selected file',
              titleLabel: 'Meeting title',
              titlePlaceholder: 'Meeting name (optional)',
              languageLabel: 'Primary language',
              start: 'Start processing',
              cancel: 'Cancel',
              close: 'Close',
              uploading: 'Uploading file',
              processing: 'Processing',
              transcript: 'Live transcript',
              done: 'All done',
              doneDesc: 'Minutes are ready.',
              openMeeting: 'Open meeting',
              error: 'Something went wrong',
              tryAgain: 'Try again',
              duplicate: 'File already uploaded',
              duplicateDesc: (id: number) => `This file already exists as meeting #${id}. Open it?`,
              openExisting: 'Open existing meeting',
              chunkStats: (done: number, total: number) =>
                  total > 0 ? `Transcribed ${done}/${total} chunks` : '',
              chunkStatsDone: (total: number) =>
                  total > 0 ? `✓ Transcribed ${total}/${total} chunks` : '',
              summarizingHint: 'Generating meeting minutes (a few minutes)…',
              hint: 'Tip: large files may take several minutes.',
              cancelling: 'Cancelling…',
          };

    const handlePick = async () => {
        try {
            const picked = await pickAudioFile();
            if (!picked) return;
            const base = basenameFromPath(picked);
            setFilePath(picked);
            if (!title) setTitle(stemFromBasename(base));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showToast(msg || tr.error, 'error');
        }
    };

    const handleStart = async () => {
        if (!filePath) return;
        cancelledRef.current = false;
        setStep('uploading');
        setBytesSent(0);
        setTotalBytes(0);

        let result: UploadResult;
        try {
            result = await uploadAudio(
                {
                    filePath,
                    title: title.trim() || undefined,
                    language,
                },
                (p: UploadProgressPayload) => {
                    uploadIdRef.current = p.upload_id;
                    setBytesSent(p.bytes_sent);
                    setTotalBytes(p.total_bytes);
                },
            );
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (cancelledRef.current) {
                onClose();
                return;
            }
            setErrorMessage(msg);
            setStep('error');
            return;
        }

        jobIdRef.current = result.job_id;
        setStep('pipeline');

        // Subscribe to job SSE — runs until terminal state.
        const abort = new AbortController();
        sseAbortRef.current = abort;
        try {
            await subscribeJobEvents(result.job_id, {
                signal: abort.signal,
                onStatus: (state) => {
                    setJobState(state);
                    if (state.status === 'failed') {
                        const dupId = isDuplicateError(state.error);
                        if (dupId !== null) {
                            setDuplicateMeetingId(dupId);
                            setStep('duplicate');
                            return;
                        }
                        setErrorMessage(state.error || tr.error);
                        setStep('error');
                        return;
                    }
                    if (state.status === 'cancelled') {
                        onClose();
                        return;
                    }
                    if (state.status === 'done') {
                        setReadyMeetingId(state.meeting_id);
                        setStep('done');
                    }
                },
                onChunk: (c: JobChunkPayload) => {
                    const idx = c.idx;
                    const text = c.text;
                    if (typeof idx !== 'number' || typeof text !== 'string' || !text) return;
                    setChunks((prev) => {
                        // Idempotent: if we've seen this idx, replace; else append.
                        const seenAt = prev.findIndex((p) => p.idx === idx);
                        const line: ChunkLine = { idx, text };
                        if (seenAt >= 0) {
                            const next = [...prev];
                            next[seenAt] = line;
                            return next;
                        }
                        return [...prev, line].sort((a, b) => a.idx - b.idx);
                    });
                },
            });
        } catch (err) {
            if (cancelledRef.current) {
                onClose();
                return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            setErrorMessage(msg);
            setStep('error');
        } finally {
            sseAbortRef.current = null;
        }
    };

    const handleCancel = async () => {
        cancelledRef.current = true;
        // Phase 1 (Rust upload): tell Rust to abort the stream.
        const uploadId = uploadIdRef.current;
        if (uploadId) {
            try { await cancelAudioUpload(uploadId); } catch { /* best effort */ }
        }
        // Phase 2 (sidecar pipeline): tell sidecar to mark job cancelled.
        const jobId = jobIdRef.current;
        if (jobId) {
            try { await cancelJob(jobId); } catch { /* best effort */ }
        }
        // Close SSE so we don't hang waiting for events.
        if (sseAbortRef.current) {
            sseAbortRef.current.abort();
            sseAbortRef.current = null;
        }
        // If we don't get a terminal SSE event soon, just close.
        if (jobState && isTerminal(jobState.status)) return;
        setTimeout(() => onClose(), 250);
    };

    const handleOpenReady = (id: number) => {
        onMeetingReady(id);
        onClose();
    };

    // ── Progress percentage for current stage ──
    const uploadPct = totalBytes > 0 ? bytesSent / totalBytes : 0;
    const pipelinePct = jobState ? Math.max(0, Math.min(1, jobState.progress || 0)) : 0;
    const showLabel =
        step === 'uploading'
            ? `${formatBytes(bytesSent)} / ${totalBytes > 0 ? formatBytes(totalBytes) : '?'}`
            : (jobState?.message || '');

    return (
        <div className="upload-modal-overlay" onClick={(e) => {
            if (e.target === e.currentTarget && (step === 'pick' || step === 'done' || step === 'error' || step === 'duplicate')) {
                onClose();
            }
        }}>
            <div className="upload-modal-card" role="dialog" aria-modal="true" aria-label={tr.title}>
                <div className="upload-modal-header">
                    <h2 className="upload-modal-title">{tr.title}</h2>
                    {(step === 'pick' || step === 'done' || step === 'error' || step === 'duplicate') && (
                        <button className="upload-modal-close" onClick={onClose} aria-label={tr.close}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                            </svg>
                        </button>
                    )}
                </div>

                {/* ── Step: PICK ─────────────────────────────────────── */}
                {step === 'pick' && (
                    <div className="upload-modal-body">
                        <p className="upload-modal-subtitle">{tr.subtitle}</p>

                        <button className="upload-file-picker" onClick={handlePick} type="button">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" />
                                <line x1="12" x2="12" y1="3" y2="15" />
                            </svg>
                            <span>{filePath ? basenameFromPath(filePath) : tr.pickFile}</span>
                        </button>

                        {filePath && (
                            <>
                                <div className="upload-field">
                                    <label className="upload-field-label">{tr.titleLabel}</label>
                                    <input
                                        className="upload-field-input"
                                        type="text"
                                        value={title}
                                        onChange={(e) => setTitle(e.target.value)}
                                        placeholder={tr.titlePlaceholder}
                                    />
                                </div>
                                <div className="upload-field">
                                    <label className="upload-field-label">{tr.languageLabel}</label>
                                    <CustomSelect
                                        className="upload-language-select"
                                        value={language}
                                        onChange={setLanguage}
                                        options={NVIDIA_STT_LANGUAGES}
                                    />
                                </div>
                            </>
                        )}

                        <p className="upload-modal-hint">{tr.hint}</p>

                        <div className="upload-modal-actions">
                            <button className="action-btn" onClick={onClose}>{tr.cancel}</button>
                            <button
                                className="action-btn primary"
                                disabled={!filePath}
                                onClick={() => void handleStart()}
                            >
                                {tr.start}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step: UPLOADING ────────────────────────────────── */}
                {step === 'uploading' && (
                    <div className="upload-modal-body">
                        <div className="upload-stage-label">{tr.uploading}</div>
                        <div className="upload-progress-bar">
                            <div className="upload-progress-fill" style={{ width: `${(uploadPct * 100).toFixed(1)}%` }} />
                        </div>
                        <div className="upload-progress-meta">{showLabel} · {(uploadPct * 100).toFixed(0)}%</div>

                        <div className="upload-modal-actions">
                            <button className="action-btn danger" onClick={() => void handleCancel()}>
                                {cancelledRef.current ? tr.cancelling : tr.cancel}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step: PIPELINE ─────────────────────────────────── */}
                {step === 'pipeline' && (
                    <div className="upload-modal-body">
                        <div className="upload-stage-label">{tr.processing}</div>
                        <div className="upload-progress-bar">
                            <div className="upload-progress-fill" style={{ width: `${(pipelinePct * 100).toFixed(1)}%` }} />
                        </div>
                        <div className="upload-progress-meta">
                            {showLabel || ' '} · {(pipelinePct * 100).toFixed(0)}%
                        </div>
                        {jobState && jobState.total_chunks > 0 && (() => {
                            // Past transcription stage: show ✓ + summarizing hint so the
                            // user understands the LLM call (which can take minutes) is
                            // running and the bar isn't stuck.
                            const transcribingDone =
                                jobState.processed_chunks >= jobState.total_chunks
                                || (jobState.status === 'finalizing' && pipelinePct >= 0.88);
                            return (
                                <>
                                    <div className="upload-progress-sub">
                                        {transcribingDone
                                            ? tr.chunkStatsDone(jobState.total_chunks)
                                            : tr.chunkStats(jobState.processed_chunks, jobState.total_chunks)}
                                    </div>
                                    {transcribingDone && pipelinePct >= 0.9 && (
                                        <div className="upload-progress-sub upload-progress-sub--accent">
                                            {tr.summarizingHint}
                                        </div>
                                    )}
                                </>
                            );
                        })()}

                        {chunks.length > 0 && (
                            <div className="upload-chunk-preview" aria-label={tr.transcript}>
                                <div className="upload-chunk-preview-label">{tr.transcript}</div>
                                <div className="upload-chunk-preview-body">
                                    {chunks.map((c) => (
                                        <p key={c.idx} className="upload-chunk-line">{c.text}</p>
                                    ))}
                                    <div ref={chunksEndRef} />
                                </div>
                            </div>
                        )}

                        <div className="upload-modal-actions">
                            <button className="action-btn danger" onClick={() => void handleCancel()}>
                                {cancelledRef.current ? tr.cancelling : tr.cancel}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step: DONE ─────────────────────────────────────── */}
                {step === 'done' && readyMeetingId !== null && (
                    <div className="upload-modal-body upload-modal-done">
                        <div className="upload-done-icon">
                            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6 9 17l-5-5" />
                            </svg>
                        </div>
                        <h3 className="upload-modal-stage-title">{tr.done}</h3>
                        <p className="upload-modal-stage-desc">{tr.doneDesc}</p>
                        <div className="upload-modal-actions">
                            <button className="action-btn" onClick={onClose}>{tr.close}</button>
                            <button
                                className="action-btn primary"
                                onClick={() => handleOpenReady(readyMeetingId)}
                            >
                                {tr.openMeeting}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step: DUPLICATE ────────────────────────────────── */}
                {step === 'duplicate' && duplicateMeetingId !== null && (
                    <div className="upload-modal-body upload-modal-done">
                        <div className="upload-done-icon" style={{ background: '#fef3c7', color: '#b45309' }}>
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="9" /><path d="M12 7v6" /><circle cx="12" cy="16" r="0.5" />
                            </svg>
                        </div>
                        <h3 className="upload-modal-stage-title">{tr.duplicate}</h3>
                        <p className="upload-modal-stage-desc">{tr.duplicateDesc(duplicateMeetingId)}</p>
                        <div className="upload-modal-actions">
                            <button className="action-btn" onClick={onClose}>{tr.close}</button>
                            <button
                                className="action-btn primary"
                                onClick={() => handleOpenReady(duplicateMeetingId)}
                            >
                                {tr.openExisting}
                            </button>
                        </div>
                    </div>
                )}

                {/* ── Step: ERROR ────────────────────────────────────── */}
                {step === 'error' && (
                    <div className="upload-modal-body upload-modal-done">
                        <div className="upload-done-icon" style={{ background: '#fee2e2', color: '#b91c1c' }}>
                            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6" /><path d="M9 9l6 6" />
                            </svg>
                        </div>
                        <h3 className="upload-modal-stage-title">{tr.error}</h3>
                        <p className="upload-modal-stage-desc upload-error-detail">{errorMessage}</p>
                        <div className="upload-modal-actions">
                            <button className="action-btn" onClick={onClose}>{tr.close}</button>
                            <button className="action-btn primary" onClick={resetAll}>{tr.tryAgain}</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
