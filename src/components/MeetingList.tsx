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

export function MeetingList() {
    const { meetings, setMeetings, setCurrentView, setCurrentMeetingId, setDraftId, setActiveTab, lang, recording } = useAppStore();
    const { showToast } = useToast();
    const [editingMeetingId, setEditingMeetingId] = useState<number | null>(null);
    const [editingTitle, setEditingTitle] = useState('');
    const [busyMap, setBusyMap] = useState<Record<string, boolean>>({});
    const [searchQuery, setSearchQuery] = useState('');
    const [uploadModalOpen, setUploadModalOpen] = useState(false);

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
        setActiveTab('summary');
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
        try {
            await resetDiarize();
        } catch (e) { console.warn('[meetings] Diarize reset failed:', e); }
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
        const m = Math.floor(s / 60), sec = Math.floor(s % 60);
        return `${m}m ${sec}s`;
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

    const buildTranscriptMarkdown = (meeting: Meeting): string => {
        const title = safeFilenameBase(
            String(meeting?.title || ''),
            `meeting-${meeting?.id ?? 'unknown'}`
        );
        const raw = String(meeting?.transcript || '').trim();
        if (!raw) return '';

        const lines: string[] = [
            `# ${lang === 'vi' ? 'Transcript cuộc họp' : 'Meeting Transcript'}: ${title}`,
            '',
        ];

        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const part of parsed) {
                    if (!part || typeof part !== 'object') continue;
                    const p = part as Record<string, unknown>;
                    const text = String(p.text || '').trim();
                    if (!text) continue;
                    const speakerId = Number(p.speakerId ?? 0);
                    const fallbackSpeaker = `Speaker ${Number.isFinite(speakerId) ? speakerId + 1 : 1}`;
                    const speaker = String(p.speaker || fallbackSpeaker).trim() || fallbackSpeaker;
                    const startTime = p.startTime as string | undefined;
                    const endTime = p.endTime as string | undefined;
                    const hasRange = String(startTime || '').trim() || String(endTime || '').trim();
                    const range = hasRange
                        ? ` (${fmtSec(startTime)} - ${fmtSec(endTime)})`
                        : '';
                    lines.push(`## ${speaker}${range}`);
                    lines.push(text);
                    const translation = String(p.translation || '').trim();
                    if (translation) lines.push(`> ${translation}`);
                    lines.push('');
                }
                return lines.join('\n').trim();
            }
        } catch { }

        const rawLines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
        if (!rawLines.length) return '';
        return `${lines.join('\n')}\n${rawLines.map((line) => `- ${line}`).join('\n')}`.trim();
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
                await downloadMeetingAudio(meeting.id, `${base}.wav`, 'wav');
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
                const markdown = buildTranscriptMarkdown(meeting);
                if (!markdown) return;
                await downloadTextFile(`${base}-transcript.md`, markdown);
                showToast(lang === 'vi' ? 'Đã tải transcript' : 'Transcript downloaded', 'success');
            } catch (err) {
                showToast(lang === 'vi' ? 'Tải transcript thất bại' : 'Transcript download failed', 'error');
            }
        });
    };

    return (
        <section className="view active">
            <div className="pane-header">
                <h2 className="pane-title">{lang === 'vi' ? 'Lịch sử cuộc họp' : 'Meeting History'}</h2>
                <div className="pane-actions">
                    {IS_TAURI && (
                        <button
                            className="action-btn"
                            onClick={openUploadModal}
                            disabled={recording}
                            title={
                                recording
                                    ? (lang === 'vi' ? 'Đang ghi âm — dừng trước khi upload' : 'Stop recording before uploading')
                                    : (lang === 'vi' ? 'Upload file ghi âm có sẵn' : 'Upload an audio file')
                            }
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                                strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="17 8 12 3 7 8" />
                                <line x1="12" x2="12" y1="3" y2="15" />
                            </svg>
                            <span>{lang === 'vi' ? 'Upload file' : 'Upload file'}</span>
                        </button>
                    )}
                    <button className="action-btn primary" onClick={newMeeting} disabled={recording}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                            strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 5v14" /><path d="M5 12h14" />
                        </svg>
                        <span>{lang === 'vi' ? 'Cuộc họp mới' : 'New Meeting'}</span>
                    </button>
                </div>
            </div>

            {/* Search + Stats row */}
            {meetings.length > 0 && (
                <div className="meetings-toolbar">
                    <div className="meetings-search-wrap">
                        <svg className="meetings-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
                        </svg>
                        <input
                            className="meetings-search-input"
                            type="search"
                            placeholder={lang === 'vi' ? 'Tìm cuộc họp...' : 'Search meetings...'}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                        {searchQuery && (
                            <button className="meetings-search-clear" onClick={() => setSearchQuery('')} aria-label="Clear search">
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                                </svg>
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
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: 12 }}>
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
                        </svg>
                        <div>{lang === 'vi' ? 'Chưa có cuộc họp nào' : 'No meetings yet'}</div>
                        <div style={{ fontSize: '0.82rem', marginTop: 4, opacity: 0.6 }}>
                            {lang === 'vi' ? 'Nhấn "Cuộc họp mới" để bắt đầu' : 'Click "New Meeting" to get started'}
                        </div>
                    </div>
                ) : filteredMeetings.length === 0 ? (
                    <div className="list-empty">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: 10 }}>
                            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
                        </svg>
                        <div>{lang === 'vi' ? 'Không tìm thấy cuộc họp nào' : 'No meetings found'}</div>
                        <div style={{ fontSize: '0.82rem', marginTop: 4, opacity: 0.6 }}>
                            {lang === 'vi' ? `Không khớp với "${searchQuery}"` : `No match for "${searchQuery}"`}
                        </div>
                    </div>
                ) : filteredMeetings.map((m) => (
                    <div className="meeting-card" key={m.id}>
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
                            </div>
                        </div>
                        <div className="meeting-card-actions" style={{ opacity: 1 }}>
                            <button
                                className="card-action-btn"
                                onClick={(e) => startRename(e, m)}
                                disabled={isBusy('rename', m.id)}
                                title={lang === 'vi' ? 'Đổi tên cuộc họp' : 'Rename meeting'}
                                aria-label={lang === 'vi' ? 'Đổi tên cuộc họp' : 'Rename meeting'}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 20h9" />
                                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                </svg>
                            </button>
                            <button
                                className={`card-action-btn${isBusy('audio', m.id) ? ' is-busy' : ''}`}
                                onClick={(e) => void exportAudio(e, m)}
                                disabled={isBusy('audio', m.id)}
                                title={lang === 'vi' ? 'Tải file ghi âm' : 'Download audio'}
                                aria-label={lang === 'vi' ? 'Tải file ghi âm' : 'Download audio'}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                    <polyline points="7 10 12 15 17 10" />
                                    <line x1="12" x2="12" y1="15" y2="3" />
                                </svg>
                            </button>
                            <button
                                className={`card-action-btn${isBusy('minutes', m.id) ? ' is-busy' : ''}`}
                                onClick={(e) => void exportMinutes(e, m)}
                                disabled={isBusy('minutes', m.id) || !hasMinutes(m)}
                                title={lang === 'vi' ? 'Export biên bản' : 'Export minutes'}
                                aria-label={lang === 'vi' ? 'Export biên bản' : 'Export minutes'}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <path d="M14 2v6h6" />
                                    <path d="M8 13h8" />
                                    <path d="M8 17h8" />
                                </svg>
                            </button>
                            <button
                                className={`card-action-btn${isBusy('transcript', m.id) ? ' is-busy' : ''}`}
                                onClick={(e) => void exportTranscript(e, m)}
                                disabled={isBusy('transcript', m.id) || !hasTranscript(m)}
                                title={lang === 'vi' ? 'Export transcript' : 'Export transcript'}
                                aria-label={lang === 'vi' ? 'Export transcript' : 'Export transcript'}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M4 6h16" />
                                    <path d="M4 12h16" />
                                    <path d="M4 18h10" />
                                </svg>
                            </button>
                            <button className="card-action-btn card-delete-btn" onClick={(e) => handleDelete(e, m.id)}
                                disabled={isBusy('delete', m.id)}
                                aria-label="Delete">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                                    strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18" /><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                                    <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
                                </svg>
                            </button>
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
