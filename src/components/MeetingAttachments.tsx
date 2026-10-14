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
import { IconChevronDown, IconInfo, IconPage, IconPaperclip, IconTrash, IconWarning } from './icons/scribble-icons';

interface Props {
    meetingId: number;
    /** Notify parent so it can offer "regenerate summary" if needed. Optional. */
    onChange?: () => void;
}

/** Per-user preference: should the attachments panel default to collapsed?
 *  Persist so the user's choice survives between meetings. */
const COLLAPSED_KEY = 'scribble:attachments-collapsed';

export function MeetingAttachments({ meetingId, onChange }: Props) {
    const { lang } = useAppStore();
    const { showToast } = useToast();

    const [list, setList] = useState<AttachmentsListResponse | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [uploading, setUploading] = useState<boolean>(false);
    const [deletingId, setDeletingId] = useState<number | null>(null);
    // Default: collapsed once there are attachments (user already knows they
    // exist — give the minutes the screen space). Empty state stays expanded
    // so users know the feature is there.
    const [expanded, setExpanded] = useState<boolean>(() => {
        try {
            const stored = localStorage.getItem(COLLAPSED_KEY);
            if (stored === 'true') return false;
            if (stored === 'false') return true;
        } catch { /* SSR / private mode */ }
        return false; // default to collapsed
    });
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const setExpandedPersist = (v: boolean) => {
        setExpanded(v);
        try { localStorage.setItem(COLLAPSED_KEY, v ? 'false' : 'true'); } catch { /* ignore */ }
    };

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
    const warnTotal = list?.warn_total_bytes ?? 0;
    const maxFiles = list?.max_files ?? 0;
    const limitReached = list ? items.length >= maxFiles : false;
    const overWarnThreshold = list ? totalBytes >= warnTotal : false;
    const hasItems = items.length > 0;
    // Empty state always renders open — the user needs to discover the
    // feature. When there's at least one file, honour the collapse state.
    const isOpen = !hasItems || expanded;

    return (
        <div
            className={`meeting-attachments t-acc ${isOpen ? 'meeting-attachments--open' : 'meeting-attachments--collapsed'}`}
            data-open={isOpen ? 'true' : 'false'}
        >
            {/* Compact one-line header — always visible. Clicking it toggles. */}
            <button
                type="button"
                className="meeting-attachments-bar"
                onClick={() => hasItems && setExpandedPersist(!expanded)}
                disabled={!hasItems}
                aria-expanded={isOpen}
            >
                <span className="meeting-attachments-bar-icon" aria-hidden>
                    <IconPaperclip size={14} />
                </span>
                <span className="meeting-attachments-bar-title">{tr.title}</span>
                {hasItems && (
                    <span className="meeting-attachments-bar-meta">
                        {tr.countLabel(items.length, maxFiles)}
                        {' · '}
                        {formatAttachmentSize(totalBytes)}
                    </span>
                )}
                <span className="meeting-attachments-bar-spacer" />
                {hasItems && (
                    <span className="meeting-attachments-bar-chevron t-acc-chevron" aria-hidden>
                        <IconChevronDown size={14} strokeWidth={2.25} />
                    </span>
                )}
            </button>

            <div className="t-acc-panel">
                <div className="t-acc-panel-inner" style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: isOpen ? 8 : 0 }}>
                    {/* Subtitle + add button row */}
                    <div className="meeting-attachments-actions-row">
                        <p className="meeting-attachments-subtitle">{tr.subtitle}</p>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept={ATTACHMENT_ACCEPT}
                            style={{ display: 'none' }}
                            onChange={handleFileChosen}
                        />
                        <button
                            type="button"
                            className="action-btn primary action-btn-compact"
                            disabled={uploading || limitReached}
                            onClick={handlePick}
                        >
                            {uploading ? tr.uploading : tr.add}
                        </button>
                    </div>

                    {loading && !list && (
                        <div className="meeting-attachments-skeleton" />
                    )}

                    {list && items.length === 0 && (
                        <div className="meeting-attachments-empty">{tr.empty}</div>
                    )}

                    {overWarnThreshold && (
                        <div className="meeting-attachments-warning" role="alert">
                            <IconWarning size={14} />
                            <span>{tr.warnLarge}</span>
                        </div>
                    )}

                    {hasItems && (
                        <div className="meeting-attachments-hint">
                            <IconInfo size={12} />
                            <span>{tr.regenerateHint}</span>
                        </div>
                    )}

                    {hasItems && (
                        <ul className="meeting-attachments-list">
                            {items.map((att) => (
                                <li key={att.id} className="meeting-attachments-item">
                                    <span className="meeting-attachments-icon" aria-hidden>
                                        <IconPage size={18} />
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
                                        <IconTrash size={16} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}
