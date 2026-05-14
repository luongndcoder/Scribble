/**
 * MeetingAttachments — manages reference materials (md/txt) attached to a
 * meeting. The sidecar feeds these into the LLM as background context when
 * generating the summary, so users can prime the AI with project briefs,
 * agendas, glossaries, etc.
 *
 * UX:
 *   - Compact list with filename, size, delete button
 *   - "+ Thêm tài liệu" picks one file at a time (md/txt only)
 *   - Errors surface as toasts; no modal overlay (cheap action)
 *   - Empty state explains what attachments do (people forget if hidden)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ALLOWED_ATTACHMENT_EXTENSIONS,
    ATTACHMENT_ACCEPT,
    deleteAttachment,
    formatAttachmentSize,
    listAttachments,
    uploadAttachment,
    type AttachmentMeta,
    type AttachmentsListResponse,
} from '../lib/attachments';
import { useAppStore } from '../stores/appStore';
import { useToast } from './Toast';

interface Props {
    meetingId: number;
    /** Notify parent so it can offer "regenerate summary" if needed. Optional. */
    onChange?: () => void;
}

export function MeetingAttachments({ meetingId, onChange }: Props) {
    const { lang } = useAppStore();
    const { showToast } = useToast();

    const [list, setList] = useState<AttachmentsListResponse | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [uploading, setUploading] = useState<boolean>(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const tr = lang === 'vi'
        ? {
              title: 'Tài liệu tham khảo',
              subtitle: 'AI dùng các file này làm context khi tạo biên bản (md, txt — tối đa 1 MB/file).',
              add: '+ Thêm tài liệu',
              empty: 'Chưa có tài liệu nào. Thêm brief dự án, agenda hoặc thuật ngữ để AI tham khảo.',
              uploading: 'Đang tải lên…',
              deleteTitle: (name: string) => `Xoá tài liệu ${name}?`,
              deletedToast: 'Đã xoá tài liệu',
              uploadedToast: 'Đã thêm tài liệu — bấm "Tạo biên bản" để AI dùng tài liệu này',
              regenerateHint: 'Tài liệu chỉ áp dụng cho lần tạo biên bản TIẾP THEO. Bấm "Tạo biên bản" để regenerate với context mới.',
              loadFailed: 'Không tải được danh sách tài liệu',
              wrongExt: `Chỉ chấp nhận: ${ALLOWED_ATTACHMENT_EXTENSIONS.join(', ')}`,
              totalLabel: (used: string, max: string) => `${used} / ${max}`,
              countLabel: (n: number, max: number) => `${n}/${max} file`,
              warnLarge: 'Tổng dung lượng đang lớn — với LLM có context 128k (vd: gpt-4o-mini) có thể bị cắt bớt khi tạo biên bản. Cân nhắc dùng model context lớn hơn (Claude, Gemini) hoặc gỡ bớt file.',
          }
        : {
              title: 'Reference materials',
              subtitle: 'AI uses these as context when generating minutes (md, txt — max 1 MB each).',
              add: '+ Add file',
              empty: 'No reference materials yet. Add a project brief, agenda, or glossary to give the AI context.',
              uploading: 'Uploading…',
              deleteTitle: (name: string) => `Delete ${name}?`,
              deletedToast: 'Attachment removed',
              uploadedToast: 'Attachment added — click "Create Minutes" to apply',
              regenerateHint: 'Reference materials only apply on the NEXT minutes generation. Click "Create Minutes" to regenerate with the new context.',
              loadFailed: 'Failed to load attachments',
              wrongExt: `Only ${ALLOWED_ATTACHMENT_EXTENSIONS.join(', ')} files are allowed`,
              totalLabel: (used: string, max: string) => `${used} / ${max}`,
              countLabel: (n: number, max: number) => `${n}/${max} files`,
              warnLarge: 'Total size is getting large — 128k-context LLMs (e.g. gpt-4o-mini) may truncate during summary. Consider a larger-context model (Claude, Gemini) or removing some files.',
          };

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const data = await listAttachments(meetingId);
            setList(data);
        } catch (err) {
            console.warn('[attachments] load failed', err);
            showToast(tr.loadFailed, 'error');
        } finally {
            setLoading(false);
        }
    }, [meetingId, showToast, tr.loadFailed]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const handlePick = () => {
        if (uploading) return;
        fileInputRef.current?.click();
    };

    const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        // Always reset so the same file can be re-picked after delete + add.
        e.target.value = '';
        if (!file) return;

        // Light client-side extension check — server rejects too, but this
        // gives an instant toast and avoids the round-trip.
        const lower = file.name.toLowerCase();
        const okExt = ALLOWED_ATTACHMENT_EXTENSIONS.some((ext) => lower.endsWith(ext));
        if (!okExt) {
            showToast(tr.wrongExt, 'error');
            return;
        }

        setUploading(true);
        try {
            await uploadAttachment(meetingId, file);
            showToast(tr.uploadedToast, 'success');
            await refresh();
            onChange?.();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showToast(msg, 'error');
        } finally {
            setUploading(false);
        }
    };

    const handleDelete = async (att: AttachmentMeta) => {
        if (deletingId !== null) return;
        if (!window.confirm(tr.deleteTitle(att.filename))) return;
        setDeletingId(att.id);
        try {
            await deleteAttachment(meetingId, att.id);
            showToast(tr.deletedToast, 'success');
            await refresh();
            onChange?.();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            showToast(msg, 'error');
        } finally {
            setDeletingId(null);
        }
    };

    const items = list?.items ?? [];
    const totalBytes = list?.total_bytes ?? 0;
    const maxTotal = list?.max_total_bytes ?? 0;
    const warnTotal = list?.warn_total_bytes ?? 0;
    const maxFiles = list?.max_files ?? 0;
    const limitReached = list ? items.length >= maxFiles : false;
    const overWarnThreshold = list ? totalBytes >= warnTotal : false;

    return (
        <div className="meeting-attachments">
            <div className="meeting-attachments-header">
                <div>
                    <h3 className="meeting-attachments-title">{tr.title}</h3>
                    <p className="meeting-attachments-subtitle">{tr.subtitle}</p>
                </div>
                <div className="meeting-attachments-actions">
                    {list && items.length > 0 && (
                        <span className="meeting-attachments-meta">
                            {tr.countLabel(items.length, maxFiles)} ·{' '}
                            {tr.totalLabel(formatAttachmentSize(totalBytes), formatAttachmentSize(maxTotal))}
                        </span>
                    )}
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept={ATTACHMENT_ACCEPT}
                        style={{ display: 'none' }}
                        onChange={handleFileChosen}
                    />
                    <button
                        type="button"
                        className="action-btn primary"
                        disabled={uploading || limitReached}
                        onClick={handlePick}
                    >
                        {uploading ? tr.uploading : tr.add}
                    </button>
                </div>
            </div>

            {loading && !list && (
                <div className="meeting-attachments-skeleton" />
            )}

            {list && items.length === 0 && (
                <div className="meeting-attachments-empty">{tr.empty}</div>
            )}

            {overWarnThreshold && (
                <div className="meeting-attachments-warning" role="alert">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                        <path d="M12 9v4" />
                        <path d="M12 17h.01" />
                    </svg>
                    <span>{tr.warnLarge}</span>
                </div>
            )}

            {items.length > 0 && (
                <div className="meeting-attachments-hint">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 16v-4" />
                        <path d="M12 8h.01" />
                    </svg>
                    <span>{tr.regenerateHint}</span>
                </div>
            )}

            {items.length > 0 && (
                <ul className="meeting-attachments-list">
                    {items.map((att) => (
                        <li key={att.id} className="meeting-attachments-item">
                            <span className="meeting-attachments-icon" aria-hidden>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <polyline points="14 2 14 8 20 8" />
                                </svg>
                            </span>
                            <div className="meeting-attachments-item-body">
                                <div className="meeting-attachments-item-name" title={att.filename}>
                                    {att.filename}
                                </div>
                                <div className="meeting-attachments-item-meta">
                                    {formatAttachmentSize(att.size_bytes)} ·{' '}
                                    {att.mime_type.replace('text/', '')}
                                </div>
                            </div>
                            <button
                                type="button"
                                className="meeting-attachments-delete"
                                onClick={() => void handleDelete(att)}
                                disabled={deletingId === att.id}
                                aria-label={`Delete ${att.filename}`}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
