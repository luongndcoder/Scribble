import { useEffect, useMemo, useState } from 'react';
import { useAppStore, Meeting } from '../stores/appStore';
import {
    getMeetings,
    deleteMeeting,
    resetDiarize,
    updateMeeting,
    downloadMeetingAudio,
    downloadMeetingMinutes,
    downloadTextFile,
} from '../lib/api';
import { IS_TAURI } from '../lib/sidecar';
import { showConfirm } from './ConfirmDialog';
import { useToast } from './Toast';
import { UploadAudioModal } from './UploadAudioModal';
import { t } from '../i18n';
import { IconClose, IconDots, IconMic, IconPlus, IconSearch, IconUpload } from './icons/scribble-icons';

export function MeetingList() {
    const { meetings, setMeetings, setCurrentView, setCurrentMeetingId, setDraftId, setActiveTab, lang, recording, backendOnline } = useAppStore();
    const { showToast } = useToast();
    const [editingMeetingId, setEditingMeetingId] = useState<number | null>(null);
    const [editingTitle, setEditingTitle] = useState('');
    const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
    const [searchQuery, setSearchQuery] = useState('');
    const [uploadModalOpen, setUploadModalOpen] = useState(false);
    const [openMenuId, setOpenMenuId] = useState<number | null>(null);
    const [closingMenuId, setClosingMenuId] = useState<number | null>(null);

    const closeMenu = () => {
        if (openMenuId === null) return;
        const id = openMenuId;
        setClosingMenuId(id);
        setTimeout(() => {
            setOpenMenuId((cur) => (cur === id ? null : cur));
            setClosingMenuId((cur) => (cur === id ? null : cur));
        }, 150);
    };

    // Close the overflow menu on outside click / Escape.
    useEffect(() => {
        if (openMenuId === null) return;
        const onDocClick = () => closeMenu();
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('click', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    });

    const openUploadModal = () => {
        if (recording) {
            showToast(
                lang === 'vi'
                    ? 'Đang ghi âm — dừng ghi âm trước khi upload file'
                    : 'Recording in progress — stop recording first before uploading',
                'warning',
            );
            return;
        }
        setUploadModalOpen(true);
    };

    const handleUploadReady = async (meetingId: number) => {
        try {
            await loadMeetings();
        } catch { /* best effort refresh */ }
        setCurrentMeetingId(meetingId);
        setDraftId(null);
        // Route based on whether summary was generated:
        //   - summary present → tab 'summary' (biên bản)
        //   - summary empty → tab 'recording' (transcript only — LLM skipped
        //     because user chưa cấu hình AI API key, OR auto-summarize failed)
        // Without this guard, user without LLM key lands on empty "Biên bản"
        // tab and thinks the upload failed.
        const meeting = useAppStore.getState().meetings.find((m) => m.id === meetingId);
        const hasSummary = (meeting?.summary || '').trim().length > 0;
        setActiveTab(hasSummary ? 'summary' : 'recording');
        setCurrentView('detail');
    };

    const filteredMeetings = useMemo(() => {
        if (!searchQuery.trim()) return meetings;
        const q = searchQuery.toLowerCase();
        return meetings.filter((m) => String(m.title || '').toLowerCase().includes(q));
    }, [meetings, searchQuery]);

    useEffect(() => {
        loadMeetings();
        const onOnline = () => loadMeetings();
        window.addEventListener('backend-online', onOnline);
        return () => window.removeEventListener('backend-online', onOnline);
    }, []);

    const loadMeetings = async () => {
        try { setMeetings(await getMeetings()); } catch (e) { console.warn('[meetings] Load failed:', e); }
    };

    const busyKey = (action: string, id: number) => `${action}:${id}`;
    const isBusy = (action: string, id: number) => !!busyMap[busyKey(action, id)];
    const runBusy = async (action: string, id: number, task: () => Promise<void>) => {
        const key = busyKey(action, id);
        if (busyMap[key]) return;
        setBusyMap((prev) => ({ ...prev, [key]: true }));
        try {
            await task();
        } finally {
            setBusyMap((prev) => ({ ...prev, [key]: false }));
        }
    };

    const handleDelete = async (e: React.MouseEvent, id: number) => {
        e.stopPropagation();
        const yes = await showConfirm(t('delete_confirm', lang), lang);
        if (!yes) return;
        await runBusy('delete', id, async () => {
            await deleteMeeting(id);
            await loadMeetings();
        });
    };

    const openMeeting = (meeting: Meeting) => {
        setCurrentMeetingId(meeting.id);
        setDraftId(meeting.status === 'draft' ? meeting.id : null);
        setCurrentView('detail');
    };

    const newMeeting = async () => {
        // Reset the diarizer WITHOUT blocking navigation.
        //
        // This used to be `await resetDiarize()` before switching screens, so a
        // slow or not-yet-ready backend made the button look dead: nothing
        // happened until the request settled. Opening a new meeting is local
        // state only — the reset is a best-effort backend hint, so it now runs
        // in the background and the UI switches immediately.
        resetDiarize().catch((e) => console.warn('[meetings] Diarize reset failed:', e));
        const store = useAppStore.getState();
        // Reset all state for a fresh meeting
        store.clearTranscript();
        store.setDraftId(null);
        store.setSeconds(0);
        store.setInterimText('');
        store.setInterimSpeaker('Speaker 1', 0);
        store.setIsTranscribing(false);
        store.setTransientSummary('');
        setCurrentMeetingId(null);
        setActiveTab('recording');
        setCurrentView('detail');
    };

    const parseSqliteTimestamp = (raw: string): Date => {
        const value = (raw || '').trim();
        if (!value) return new Date();
        // SQLite CURRENT_TIMESTAMP returns "YYYY-MM-DD HH:MM:SS" in UTC.
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
            return new Date(value.replace(' ', 'T') + 'Z');
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
    };

    const formatDate = (d: string) => {
        const machineTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return parseSqliteTimestamp(d).toLocaleString(lang === 'vi' ? 'vi-VN' : 'en-US', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            ...(machineTimezone ? { timeZone: machineTimezone } : {}),
        });
    };

    const formatDuration = (s: number) => {
        const total = Math.floor(s);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = total % 60;
        if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
        if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
        return `${sec}s`;
    };

    const fmtSec = (v: number | string | undefined) => {
        const n = Number.parseFloat(String(v ?? '0'));
        if (!Number.isFinite(n) || n < 0) return '0:00';
        const m = Math.floor(n / 60);
        const sec = Math.floor(n % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    };

    const safeFilenameBase = (title: string, fallback: string) =>
        (title || fallback)
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, ' ')
            .trim() || fallback;

    const hasMinutes = (meeting: Meeting) => String(meeting?.summary || '').trim().length > 0;
    const hasTranscript = (meeting: Meeting) => String(meeting?.transcript || '').trim().length > 0;

    /** Distinct speaker count for the list subtitle (0 when unknown). */
    const speakerCount = (meeting: Meeting): number => {
        try {
            const parsed = JSON.parse(String(meeting?.transcript || ''));
            if (Array.isArray(parsed)) {
                const ids = new Set<number>();
                for (const p of parsed) {
                    const id = Number((p as Record<string, unknown>)?.speakerId);
                    if (Number.isFinite(id)) ids.add(id);
                }
                return ids.size;
            }
        } catch { /* legacy plain-text transcript */ }
        return 0;
    };

    // Plain-text transcript — kept identical to MeetingDetail.exportTranscript
    // so list & detail downloads produce the same .txt format:
    //   [start - end] Speaker: text   (translation on next line, indented)
    const buildTranscriptText = (meeting: Meeting): string => {
        const raw = String(meeting?.transcript || '').trim();
        if (!raw) return '';
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const lines: string[] = [];
                for (const part of parsed) {
                    if (!part || typeof part !== 'object') continue;
                    const p = part as Record<string, unknown>;
                    const text = String(p.text || '').trim();
                    if (!text) continue;
                    const speakerId = Number(p.speakerId ?? 0);
                    const fallbackSpeaker = `Speaker ${Number.isFinite(speakerId) ? speakerId + 1 : 1}`;
                    const speaker = String(p.speaker || fallbackSpeaker).trim() || fallbackSpeaker;
                    const time = `[${fmtSec(p.startTime as string | undefined)} - ${fmtSec(p.endTime as string | undefined)}]`;
                    let line = `${time} ${speaker}: ${text}`;
                    const translation = String(p.translation || '').trim();
                    if (translation) line += `\n    \u2192 ${translation}`;
                    lines.push(line);
                }
                return lines.join('\n\n').trim();
            }
        } catch { }
        // Legacy plain-text transcript — return as-is.
        return raw;
    };

    const startRename = (e: React.MouseEvent, meeting: Meeting) => {
        e.stopPropagation();
        setEditingMeetingId(meeting.id);
        setEditingTitle(String(meeting.title || ''));
    };

    const cancelRename = (e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        setEditingMeetingId(null);
        setEditingTitle('');
    };

    const saveRename = async (id: number) => {
        const nextTitle = editingTitle.trim();
        if (!nextTitle) return;
        await runBusy('rename', id, async () => {
            await updateMeeting(id, { title: nextTitle });
            await loadMeetings();
        });
        cancelRename();
    };

    const exportAudio = async (e: React.MouseEvent, meeting: Meeting) => {
        e.stopPropagation();
        await runBusy('audio', meeting.id, async () => {
            try {
                const base = safeFilenameBase(String(meeting.title || ''), `meeting-${meeting.id}`);
                await downloadMeetingAudio(meeting.id, `${base}.mp3`, 'mp3');
                showToast(lang === 'vi' ? 'Đã tải file ghi âm' : 'Audio downloaded', 'success');
            } catch (err) {
                showToast(lang === 'vi' ? 'Tải ghi âm thất bại' : 'Audio download failed', 'error');
            }
        });
    };

    const exportMinutes = async (e: React.MouseEvent, meeting: Meeting) => {
        e.stopPropagation();
        if (!hasMinutes(meeting)) return;
        await runBusy('minutes', meeting.id, async () => {
            try {
                const base = safeFilenameBase(String(meeting.title || ''), `meeting-${meeting.id}`);
                try {
                    await downloadMeetingMinutes(meeting.id, `${base}-minutes.docx`, 'docx');
                } catch {
                    await downloadMeetingMinutes(meeting.id, `${base}-minutes.md`, 'md');
                }
                showToast(lang === 'vi' ? 'Đã tải biên bản' : 'Minutes downloaded', 'success');
            } catch (err) {
                showToast(lang === 'vi' ? 'Tải biên bản thất bại' : 'Minutes download failed', 'error');
            }
        });
    };

    const exportTranscript = async (e: React.MouseEvent, meeting: Meeting) => {
        e.stopPropagation();
        if (!hasTranscript(meeting)) return;
        await runBusy('transcript', meeting.id, async () => {
            try {
                const base = safeFilenameBase(String(meeting.title || ''), `meeting-${meeting.id}`);
                const content = buildTranscriptText(meeting);
                if (!content) return;
                await downloadTextFile(`${base}-transcript.txt`, content);
                showToast(lang === 'vi' ? 'Đã tải transcript' : 'Transcript downloaded', 'success');
            } catch (err) {
                showToast(lang === 'vi' ? 'Tải transcript thất bại' : 'Transcript download failed', 'error');
            }
        });
    };

    return (
        <section className="view active t-page-enter-left">
            <div className="pane-header">
                <h2 className="pane-title">{lang === 'vi' ? 'Lịch sử cuộc họp' : 'Meeting History'}</h2>
                <div className="pane-actions">
                    {IS_TAURI && (
                        <button
                            className="action-btn"
                            onClick={openUploadModal}
                            disabled={recording || !backendOnline}
                            title={
                                !backendOnline
                                    ? (lang === 'vi' ? 'Đang khởi động — vui lòng chờ' : 'Starting up — please wait')
                                    : recording
                                        ? (lang === 'vi' ? 'Đang ghi âm — dừng trước khi upload' : 'Stop recording before uploading')
                                        : (lang === 'vi' ? 'Upload file ghi âm có sẵn' : 'Upload an audio file')
                            }
                        >
                            <IconUpload size={14} strokeWidth={2.25} />
                            <span>{lang === 'vi' ? 'Tải file lên' : 'Upload file'}</span>
                        </button>
                    )}
                    {/* NOT gated on `backendOnline`: creating a meeting only
                        touches local state, so it works the instant the app
                        opens. Gating it made the button look dead for the
                        first ~1s of every launch, which read as a crash. */}
                    <button
                        className="action-btn primary"
                        onClick={newMeeting}
                        disabled={recording}
                        title={recording ? (lang === 'vi' ? 'Đang ghi âm' : 'Recording') : undefined}
                    >
                        <IconPlus size={14} strokeWidth={2.25} />
                        <span>{lang === 'vi' ? 'Cuộc họp mới' : 'New Meeting'}</span>
                    </button>
                </div>
            </div>

            {/* Search + Stats row */}
            {meetings.length > 0 && (
                <div className="meetings-toolbar">
                    <div className="meetings-search-wrap">
                        <IconSearch size={14} className="meetings-search-icon" />
                        <input
                            className="meetings-search-input"
                            type="search"
                            placeholder={lang === 'vi' ? 'Tìm cuộc họp...' : 'Search meetings...'}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        {searchQuery && (
                            <button className="meetings-search-clear" onClick={() => setSearchQuery('')} aria-label="Clear search">
                                <IconClose size={12} strokeWidth={2.25} />
                            </button>
                        )}
                    </div>
                    <span className="meetings-count">
                        {filteredMeetings.length !== meetings.length
                            ? `${filteredMeetings.length} / ${meetings.length}`
                            : meetings.length}{' '}
                        {lang === 'vi' ? 'cuộc họp' : 'meetings'}
                    </span>
                </div>
            )}

            <div className="meetings-grid">
                {filteredMeetings.length === 0 && meetings.length === 0 ? (
                    <div className="list-empty">
                        <IconMic size={40} style={{ opacity: 0.3, marginBottom: 12 }} strokeWidth={1.17} />
                        <div>{lang === 'vi' ? 'Chưa có cuộc họp nào' : 'No meetings yet'}</div>
                        <div style={{ fontSize: '0.82rem', marginTop: 4, opacity: 0.6 }}>
                            {lang === 'vi' ? 'Nhấn "Cuộc họp mới" để bắt đầu' : 'Click "New Meeting" to get started'}
                        </div>
                    </div>
                ) : filteredMeetings.length === 0 ? (
                    <div className="list-empty">
                        <IconSearch size={32} style={{ opacity: 0.3, marginBottom: 10 }} />
                        <div>{lang === 'vi' ? 'Không tìm thấy cuộc họp nào' : 'No meetings found'}</div>
                        <div style={{ fontSize: '0.82rem', marginTop: 4, opacity: 0.6 }}>
                            {lang === 'vi' ? `Không khớp với "${searchQuery}"` : `No match for "${searchQuery}"`}
                        </div>
                    </div>
                ) : filteredMeetings.map((m) => (
                    <div className={`meeting-card${openMenuId === m.id ? ' menu-open' : ''}`} key={m.id}>
                        <div className="meeting-card-info" onClick={() => openMeeting(m)}>
                            <div className={`meeting-card-title ${editingMeetingId === m.id ? 'editing' : ''}`}>
                                {m.status === 'draft' && <span className="draft-badge">Draft</span>}
                                {editingMeetingId === m.id ? (
                                    <div className="meeting-title-edit" onClick={(e) => e.stopPropagation()}>
                                        <input
                                            className="meeting-title-input"
                                            value={editingTitle}
                                            onChange={(e) => setEditingTitle(e.target.value)}
                                            onBlur={() => void saveRename(m.id)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Escape') {
                                                    e.preventDefault();
                                                    cancelRename();
                                                }
                                                if (e.key === 'Enter') {
                                                    e.preventDefault();
                                                    (e.target as HTMLInputElement).blur();
                                                }
                                            }}
                                            autoFocus
                                        />
                                    </div>
                                ) : (
                                    m.title || 'Untitled Meeting'
                                )}
                            </div>
                            <div className="meeting-card-date">
                                {formatDate(m.created_at)}
                                {m.audio_duration > 0 && ` · ${formatDuration(m.audio_duration)}`}
                                {speakerCount(m) > 0 && ` · ${speakerCount(m)} ${lang === 'vi' ? 'người nói' : 'speakers'}`}
                                {m.status === 'draft' && ` · ${lang === 'vi' ? 'bản nháp' : 'draft'}`}
                            </div>
                        </div>
                        <div className="meeting-card-actions">
                            <button
                                className="card-action-btn card-menu-btn"
                                data-tooltip={lang === 'vi' ? 'Thao tác khác' : 'More actions'}
                                aria-label={lang === 'vi' ? 'Thao tác khác' : 'More actions'}
                                aria-expanded={openMenuId === m.id && closingMenuId !== m.id}
                                aria-haspopup="menu"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (openMenuId === m.id && closingMenuId !== m.id) {
                                        closeMenu();
                                    } else {
                                        setClosingMenuId(null);
                                        setOpenMenuId(m.id);
                                    }
                                }}
                            >
                                <IconDots size={15} />
                            </button>
                            {openMenuId === m.id && (
                                <div className={`card-menu${closingMenuId === m.id ? ' is-closing' : ''}`} role="menu" onClick={(e) => e.stopPropagation()}>
                                    <button role="menuitem" className="card-menu-item" disabled={isBusy('rename', m.id)}
                                        onClick={(e) => { closeMenu(); startRename(e, m); }}>
                                        {lang === 'vi' ? 'Đổi tên' : 'Rename'}
                                    </button>
                                    <button role="menuitem" className="card-menu-item" disabled={isBusy('audio', m.id)}
                                        onClick={(e) => { closeMenu(); void exportAudio(e, m); }}>
                                        {lang === 'vi' ? 'Tải ghi âm' : 'Download audio'}
                                    </button>
                                    <button role="menuitem" className="card-menu-item" disabled={isBusy('minutes', m.id) || !hasMinutes(m)}
                                        onClick={(e) => { closeMenu(); void exportMinutes(e, m); }}>
                                        {lang === 'vi' ? 'Tải biên bản' : 'Export minutes'}
                                    </button>
                                    <button role="menuitem" className="card-menu-item" disabled={isBusy('transcript', m.id) || !hasTranscript(m)}
                                        onClick={(e) => { closeMenu(); void exportTranscript(e, m); }}>
                                        {lang === 'vi' ? 'Tải transcript' : 'Export transcript'}
                                    </button>
                                    <button role="menuitem" className="card-menu-item danger" disabled={isBusy('delete', m.id)}
                                        onClick={(e) => { closeMenu(); void handleDelete(e, m.id); }}>
                                        {lang === 'vi' ? 'Xoá' : 'Delete'}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            <UploadAudioModal
                open={uploadModalOpen}
                onClose={() => setUploadModalOpen(false)}
                onMeetingReady={handleUploadReady}
            />
        </section>
    );
}
