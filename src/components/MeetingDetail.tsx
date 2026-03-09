import { useEffect, useMemo, useRef, useState } from 'react';
import { TranscriptPart, useAppStore } from '../stores/appStore';
import { getMeeting, updateMeeting, downloadMeetingAudio, downloadMeetingMinutes, downloadTextFile } from '../lib/api';
import { fetchSidecar } from '../lib/sidecar';
import { consumeSseResponse } from '../lib/sse';
import { showConfirm } from './ConfirmDialog';
import { useToast } from './Toast';

const SPEAKER_COLORS = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
const abortControllers: Record<number, AbortController> = {};

type LegacyMinutes = {
    title?: string;
    attendees?: unknown;
    keyPoints?: unknown;
    decisions?: unknown;
    actionItems?: unknown;
    summary?: string;
};

function toTextArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
}

function toActionItems(value: unknown): Array<{ task: string; assignee: string; deadline: string }> {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => {
            if (!item || typeof item !== 'object') return null;
            const row = item as Record<string, unknown>;
            return {
                task: String(row.task || '').trim(),
                assignee: String(row.assignee || '').trim(),
                deadline: String(row.deadline || '').trim(),
            };
        })
        .filter((item): item is { task: string; assignee: string; deadline: string } => Boolean(item && item.task));
}

function parseLegacyMinutes(raw: string): LegacyMinutes | null {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;

    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const payload = fence?.[1] || trimmed;
    if (!(payload.startsWith('{') && payload.endsWith('}'))) return null;

    try {
        const parsed = JSON.parse(payload);
        if (!parsed || typeof parsed !== 'object') return null;
        const record = parsed as Record<string, unknown>;
        const hasLegacyKey = ['title', 'attendees', 'keyPoints', 'decisions', 'actionItems', 'summary']
            .some((k) => k in record);
        if (!hasLegacyKey) return null;
        return record as LegacyMinutes;
    } catch {
        return null;
    }
}

function legacyMinutesToMarkdown(data: LegacyMinutes, lang: string): string {
    const vi = lang === 'vi';
    const attendees = toTextArray(data.attendees);
    const keyPoints = toTextArray(data.keyPoints);
    const decisions = toTextArray(data.decisions);
    const actionItems = toActionItems(data.actionItems);
    const title = String(data.title || '').trim()
        || (vi ? 'Biên bản cuộc họp' : 'Meeting Minutes');
    const summary = String(data.summary || '').trim();

    const parts: string[] = [
        `# ${title}`,
        `## ${vi ? 'Thành phần tham gia' : 'Attendees'}`,
        attendees.length ? attendees.map((x) => `- ${x}`).join('\n') : `- ${vi ? 'Chưa có dữ liệu' : 'Missing data'}`,
        `## ${vi ? 'Nội dung trao đổi chính' : 'Key Discussion'}`,
        keyPoints.length ? keyPoints.map((x) => `- ${x}`).join('\n') : `- ${vi ? 'Chưa có dữ liệu' : 'Missing data'}`,
        `## ${vi ? 'Quyết định quan trọng' : 'Key Decisions'}`,
        decisions.length ? decisions.map((x) => `- ${x}`).join('\n') : `- ${vi ? 'Chưa có dữ liệu' : 'Missing data'}`,
        `## ${vi ? 'Action items (What - Who - When)' : 'Action Items (What - Who - When)'}`,
        actionItems.length
            ? actionItems.map((x, idx) => `${idx + 1}. **What:** ${x.task}\n   **Who:** ${x.assignee || (vi ? 'Chưa rõ' : 'TBD')}\n   **When:** ${x.deadline || (vi ? 'Chưa rõ' : 'TBD')}`).join('\n')
            : `- ${vi ? 'Chưa có dữ liệu' : 'Missing data'}`,
    ];

    if (summary) {
        parts.push(`## ${vi ? 'Tóm tắt' : 'Summary'}`);
        parts.push(summary);
    }

    return parts.join('\n\n').trim();
}

function normalizeSummaryMarkdown(raw: string, lang: string): string {
    const trimmed = (raw || '').trim();
    if (!trimmed) return '';
    const legacy = parseLegacyMinutes(trimmed);
    if (legacy) return legacyMinutesToMarkdown(legacy, lang);
    return trimmed;
}

function toSpeakerId(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function toTimeString(value: unknown): string {
    if (value === null || value === undefined) return '0';
    const n = Number(value);
    if (Number.isFinite(n)) return String(n);
    const text = String(value).trim();
    return text || '0';
}

function toTimeNumber(value: string): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function collapseTranscriptSnapshots(parts: TranscriptPart[]): { parts: TranscriptPart[]; changed: boolean } {
    const next: TranscriptPart[] = [];
    let changed = false;

    const pushChunkIds = (target: string[], value: unknown) => {
        if (typeof value !== 'string') return;
        const trimmed = value.trim();
        if (!trimmed || target.includes(trimmed)) return;
        target.push(trimmed);
    };

    for (const raw of parts) {
        const current: TranscriptPart = {
            ...raw,
            speakerId: toSpeakerId(raw.speakerId),
            startTime: toTimeString(raw.startTime),
            endTime: toTimeString(raw.endTime),
        };
        const last = next[next.length - 1];
        if (!last) {
            next.push(current);
            continue;
        }

        const sameSpeaker =
            toSpeakerId(last.speakerId) === toSpeakerId(current.speakerId)
            || (last.speaker && current.speaker && last.speaker === current.speaker);
        const sameStart = toTimeString(last.startTime) === toTimeString(current.startTime);
        const lastText = (last.text || '').trim();
        const currentText = (current.text || '').trim();
        const snapshotLike =
            !lastText
            || !currentText
            || lastText === currentText
            || lastText.startsWith(currentText)
            || currentText.startsWith(lastText);

        if (sameSpeaker && sameStart && snapshotLike) {
            changed = true;
            const chunkIds: string[] = [];
            pushChunkIds(chunkIds, last.chunkId);
            if (Array.isArray(last.chunkIds)) last.chunkIds.forEach((id) => pushChunkIds(chunkIds, id));
            pushChunkIds(chunkIds, current.chunkId);
            if (Array.isArray(current.chunkIds)) current.chunkIds.forEach((id) => pushChunkIds(chunkIds, id));

            const keepCurrentText = currentText.length >= lastText.length;
            const mergedText = keepCurrentText ? current.text : last.text;
            const mergedTranslation =
                (current.translation || '').length >= (last.translation || '').length
                    ? current.translation
                    : last.translation;
            const merged: TranscriptPart = {
                ...last,
                ...current,
                text: mergedText,
                translation: mergedTranslation,
                startTime: toTimeString(last.startTime),
                endTime: String(Math.max(toTimeNumber(last.endTime), toTimeNumber(current.endTime))),
                speakerId: toSpeakerId(current.speakerId ?? last.speakerId),
                speaker: current.speaker || last.speaker,
                chunkId: chunkIds[0] || current.chunkId || last.chunkId,
                chunkIds: chunkIds.length ? chunkIds : undefined,
                timestamp: current.timestamp || last.timestamp,
            };
            next[next.length - 1] = merged;
            continue;
        }

        next.push(current);
    }

    return { parts: next, changed };
}

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderInlineMarkdown(input: string): string {
    const escaped = escapeHtml(input);
    return escaped
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function markdownToHtml(markdown: string): string {
    if (!markdown.trim()) return '';
    const lines = markdown.replace(/\r/g, '').split('\n');
    const html: string[] = [];
    let paragraph: string[] = [];
    let inUl = false;
    let inOl = false;
    let inTable = false;


    const flushParagraph = () => {
        if (!paragraph.length) return;
        html.push(`<p>${paragraph.map((line) => renderInlineMarkdown(line)).join('<br/>')}</p>`);
        paragraph = [];
    };
    const closeLists = () => {
        if (inUl) {
            html.push('</ul>');
            inUl = false;
        }
        if (inOl) {
            html.push('</ol>');
            inOl = false;
        }
    };
    const closeTable = () => {
        if (inTable) {
            html.push('</tbody></table>');
            inTable = false;

        }
    };

    const isTableRow = (line: string) => line.startsWith('|') && line.endsWith('|') && line.includes('|');
    const isSeparatorRow = (line: string) => /^\|[\s\-:|]+\|$/.test(line);
    const parseTableCells = (line: string) =>
        line.split('|').slice(1, -1).map((c) => renderInlineMarkdown(c.trim()));

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) {
            flushParagraph();
            closeLists();
            closeTable();
            continue;
        }

        // Table rows
        if (isTableRow(line)) {
            if (isSeparatorRow(line)) continue; // skip separator row |---|---|
            flushParagraph();
            closeLists();
            if (!inTable) {
                html.push('<table><thead><tr>');
                parseTableCells(line).forEach((cell) => html.push(`<th>${cell}</th>`));
                html.push('</tr></thead><tbody>');
                inTable = true;

                continue;
            }
            html.push('<tr>');
            parseTableCells(line).forEach((cell) => html.push(`<td>${cell}</td>`));
            html.push('</tr>');
            continue;
        }

        // Non-table line → close table if open
        closeTable();

        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            closeLists();
            const level = heading[1].length;
            html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
            continue;
        }

        // Blockquotes
        const blockquote = line.match(/^>\s*(.*)$/);
        if (blockquote) {
            flushParagraph();
            closeLists();
            html.push(`<blockquote>${renderInlineMarkdown(blockquote[1])}</blockquote>`);
            continue;
        }

        const unordered = line.match(/^[-*]\s+(.+)$/);
        if (unordered) {
            flushParagraph();
            if (inOl) {
                html.push('</ol>');
                inOl = false;
            }
            if (!inUl) {
                html.push('<ul>');
                inUl = true;
            }
            html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
            continue;
        }

        const ordered = line.match(/^\d+\.\s+(.+)$/);
        if (ordered) {
            flushParagraph();
            if (inUl) {
                html.push('</ul>');
                inUl = false;
            }
            if (!inOl) {
                html.push('<ol>');
                inOl = true;
            }
            html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
            continue;
        }

        paragraph.push(line);
    }

    flushParagraph();
    closeLists();
    closeTable();
    return html.join('\n');
}

export function MeetingDetail() {
    const {
        recording, paused, transcriptParts, translationEnabled,
        setCurrentView, lang, activeTab, setActiveTab,
        currentMeetingId, draftId, setTranscriptParts, isTranscribing, interimText,
        translationLang, interimSpeaker, interimSpeakerId, meetings, transientSummary,
        summaryLoading,
    } = useAppStore();
    const { showToast } = useToast();
    const viewingMeetingId = currentMeetingId || draftId;

    const transcriptRef = useRef<HTMLDivElement>(null);
    const [meetingData, setMeetingData] = useState<any>(null);
    const [interimTranslation, setInterimTranslation] = useState('');
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const [editingText, setEditingText] = useState('');
    const [editingSpeakerId, setEditingSpeakerId] = useState<number | null>(null);
    const [editingSpeakerAnchorIdx, setEditingSpeakerAnchorIdx] = useState<number | null>(null);
    const [editingSpeakerName, setEditingSpeakerName] = useState('');
    const [downloadingAudio, setDownloadingAudio] = useState(false);
    const [exportPickerOpen, setExportPickerOpen] = useState(false);
    const [exportingMinutesFormat, setExportingMinutesFormat] = useState<'md' | 'docx' | null>(null);
    const interimTranslateAbortRef = useRef<AbortController | null>(null);
    const lastPartTranslateKeyRef = useRef('');
    const lastInterimSentRef = useRef('');
    const lastInterimReqAtRef = useRef(0);
    const interimBusyRef = useRef(false);
    const interimTranslationRef = useRef('');
    const interimSourceTranslatedRef = useRef('');
    const partSourceTranslatedRef = useRef<Record<number, string>>({});
    const prevTranscriptLenRef = useRef(0);

    const mergeStreamingTranslation = (previous: string, nextFull: string): string => {
        if (!previous) return nextFull;
        if (!nextFull) return previous;
        if (nextFull.startsWith(previous)) return nextFull;
        if (previous.startsWith(nextFull)) return previous;

        // Best-effort overlap merge: keep read history and append only new tail.
        const maxOverlap = Math.min(previous.length, nextFull.length);
        for (let i = maxOverlap; i >= 8; i--) {
            if (previous.slice(-i) === nextFull.slice(0, i)) {
                return previous + nextFull.slice(i);
            }
        }

        // If model rewrites heavily, avoid shrinking and forcing reread.
        return nextFull.length >= previous.length ? nextFull : previous;
    };

    const joinTranslationTail = (base: string, tail: string): string => {
        if (!base) return tail;
        if (!tail) return base;
        if (/^[\s,.;:!?)}\]]/.test(tail) || /[\s\n]$/.test(base)) return base + tail;
        return `${base} ${tail}`;
    };

    const computeSourceDelta = (previousSource: string, nextSource: string): { mode: 'noop' | 'append' | 'rewrite'; text: string } => {
        const prev = previousSource.trim();
        const next = nextSource.trim();
        if (!next) return { mode: 'noop', text: '' };
        if (!prev) return { mode: 'rewrite', text: next };
        if (prev === next) return { mode: 'noop', text: '' };
        if (next.startsWith(prev)) {
            const tail = next.slice(prev.length).trim();
            return tail ? { mode: 'append', text: tail } : { mode: 'noop', text: '' };
        }
        if (prev.startsWith(next)) {
            // ASR rollback/shrink: avoid jumping translation backwards.
            return { mode: 'noop', text: '' };
        }
        const maxOverlap = Math.min(prev.length, next.length);
        for (let i = maxOverlap; i >= 12; i--) {
            if (prev.slice(-i) === next.slice(0, i)) {
                const tail = next.slice(i).trim();
                return tail ? { mode: 'append', text: tail } : { mode: 'noop', text: '' };
            }
        }
        return { mode: 'rewrite', text: next };
    };

    const persistTranscriptParts = async (parts: TranscriptPart[]) => {
        const meetingId = currentMeetingId || draftId;
        if (!meetingId) return;
        try {
            await updateMeeting(meetingId, {
                transcript: parts,
                audioDuration: useAppStore.getState().seconds,
            });
        } catch (e) {
            console.error('[detail] Failed to persist transcript edits:', e);
        }
    };

    const downloadAudio = async () => {
        const meetingId = currentMeetingId || draftId;
        if (!meetingId || downloadingAudio) return;
        setDownloadingAudio(true);
        try {
            const rawTitle = (meetingData?.title || `meeting-${meetingId}`).toString();
            const safeTitle = rawTitle.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || `meeting-${meetingId}`;
            await downloadMeetingAudio(meetingId, `${safeTitle}.wav`, 'wav');
            showToast(lang === 'vi' ? '✅ Đã tải ghi âm thành công!' : '✅ Audio downloaded!', 'success');
        } catch (e) {
            console.warn('[detail] Download audio failed:', e);
            showToast(lang === 'vi' ? '❌ Tải ghi âm thất bại' : '❌ Audio download failed', 'error');
        } finally {
            setDownloadingAudio(false);
        }
    };

    const downloadMinutes = async (format: 'md' | 'docx') => {
        if (exportingMinutesFormat) return;
        const meetingId = currentMeetingId || draftId;
        const liveSummary = viewingMeetingId
            ? meetings.find((m) => m.id === viewingMeetingId)?.summary
            : undefined;
        const rawSummary = (liveSummary || meetingData?.summary || transientSummary || '').trim();
        const markdown = normalizeSummaryMarkdown(rawSummary, lang);
        if (!markdown) return;

        setExportingMinutesFormat(format);
        try {
            const fallbackId = meetingId || 'draft';
            const rawTitle = (meetingData?.title || `meeting-${fallbackId}`).toString();
            const safeTitle = rawTitle.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || `meeting-${fallbackId}`;
            const filename = `${safeTitle}-minutes.${format}`;

            if (format === 'md') {
                await downloadTextFile(filename, markdown);
            } else {
                if (!meetingId) {
                    throw new Error(lang === 'vi'
                        ? 'Không thể xuất DOCX khi chưa có bản ghi cuộc họp'
                        : 'Cannot export DOCX before meeting is saved');
                }
                await downloadMeetingMinutes(meetingId, filename, 'docx');
            }
            setExportPickerOpen(false);
            showToast(lang === 'vi' ? 'Đã xuất biên bản' : 'Minutes exported', 'success');
        } catch (e) {
            console.warn('[detail] Download minutes failed:', e);
            showToast(lang === 'vi' ? 'Xuất biên bản thất bại' : 'Export failed', 'error');
        } finally {
            setExportingMinutesFormat(null);
        }
    };

    const exportTranscript = async () => {
        if (transcriptParts.length === 0) return;
        const meetingId = currentMeetingId || draftId;
        const fallbackId = meetingId || 'draft';
        const rawTitle = (meetingData?.title || `meeting-${fallbackId}`).toString();
        const safeTitle = rawTitle.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || `meeting-${fallbackId}`;

        const lines = transcriptParts.map((p) => {
            const time = `[${fmtSec(p.startTime)} - ${fmtSec(p.endTime)}]`;
            let line = `${time} ${p.speaker}: ${p.text}`;
            if (p.translation) line += `\n    → ${p.translation}`;
            return line;
        });
        const content = lines.join('\n\n');
        try {
            await downloadTextFile(`${safeTitle}-transcript.txt`, content);
            showToast(lang === 'vi' ? 'Đã xuất transcript' : 'Transcript exported', 'success');
        } catch (e) {
            showToast(lang === 'vi' ? 'Xuất transcript thất bại' : 'Export failed', 'error');
        }
    };
    const applyTranscriptUpdate = async (nextParts: TranscriptPart[]) => {
        setTranscriptParts(nextParts);
        await persistTranscriptParts(nextParts);
    };

    const startEditTranscript = (idx: number) => {
        setEditingIndex(idx);
        setEditingText(transcriptParts[idx]?.text || '');
    };

    const cancelEditTranscript = () => {
        setEditingIndex(null);
        setEditingText('');
    };

    const startEditSpeaker = (speakerId: number, anchorIdx: number) => {
        const source = transcriptParts.find((p) => p.speakerId === speakerId);
        if (!source) return;
        setEditingSpeakerId(speakerId);
        setEditingSpeakerAnchorIdx(anchorIdx);
        setEditingSpeakerName(source.speaker);
    };

    const cancelEditSpeaker = () => {
        setEditingSpeakerId(null);
        setEditingSpeakerAnchorIdx(null);
        setEditingSpeakerName('');
    };

    const saveEditTranscript = async (idx: number) => {
        const text = editingText.trim();
        if (!text) return;
        const next = transcriptParts.map((p, i) =>
            i === idx ? { ...p, text, translation: '' } : p
        );
        setEditingIndex(null);
        setEditingText('');
        await applyTranscriptUpdate(next);
    };

    const saveEditSpeaker = async () => {
        if (editingSpeakerId === null) return;
        const source = transcriptParts.find((p) => p.speakerId === editingSpeakerId);
        if (!source) return;
        const trimmed = editingSpeakerName.trim();
        if (!trimmed) return;
        if (trimmed === source.speaker) {
            cancelEditSpeaker();
            return;
        }
        const next = transcriptParts.map((p) =>
            p.speakerId === editingSpeakerId ? { ...p, speaker: trimmed } : p
        );
        cancelEditSpeaker();
        await applyTranscriptUpdate(next);
    };

    const deleteTranscriptAt = async (idx: number) => {
        const confirmed = await showConfirm(
            lang === 'vi' ? 'Xóa đoạn transcript này?' : 'Delete this transcript item?',
            lang
        );
        if (!confirmed) return;
        const next = transcriptParts.filter((_, i) => i !== idx);
        cancelEditTranscript();
        cancelEditSpeaker();
        await applyTranscriptUpdate(next);
    };

    const deleteAllTranscript = async () => {
        if (transcriptParts.length === 0) return;
        const confirmed = await showConfirm(
            lang === 'vi' ? 'Xóa toàn bộ transcript?' : 'Delete all transcript items?',
            lang
        );
        if (!confirmed) return;
        cancelEditTranscript();
        cancelEditSpeaker();
        setInterimTranslation('');
        interimTranslationRef.current = '';
        await applyTranscriptUpdate([]);
        showToast(lang === 'vi' ? 'Đã xoá toàn bộ transcript' : 'Transcript cleared', 'info');
    };

    // Load meeting data from DB when viewing a saved meeting
    const prevLoadedMeetingRef = useRef<string | number | null>(null);
    useEffect(() => {
        if (!viewingMeetingId || recording) return;
        let cancelled = false;
        const requestedMeetingId = viewingMeetingId;
        const isSameMeeting = prevLoadedMeetingRef.current === requestedMeetingId;

        // Only clear when switching to a DIFFERENT meeting.
        // When recording stops on the same meeting, keep the transcript in-memory
        // so interim text promoted by stopRecording() is preserved.
        if (!isSameMeeting) {
            setMeetingData(null);
            setTranscriptParts([]);
            cancelEditTranscript();
            cancelEditSpeaker();
        }
        prevLoadedMeetingRef.current = requestedMeetingId;

        (async () => {
            try {
                const m = await getMeeting(requestedMeetingId);
                if (cancelled) return;
                const activeMeetingId = useAppStore.getState().currentMeetingId || useAppStore.getState().draftId;
                if (activeMeetingId !== requestedMeetingId) return;

                setMeetingData(m);
                let parts: TranscriptPart[] = [];

                // Parse transcript — JSON array (new format) or plain text (legacy)
                if (typeof m.transcript === 'string' && m.transcript.trim()) {
                    try {
                        const parsed = JSON.parse(m.transcript);
                        if (Array.isArray(parsed)) {
                            parts = parsed.map((p: any) => ({
                                text: p.text || '',
                                speaker: p.speaker || 'Speaker 1',
                                speakerId: toSpeakerId(p.speakerId ?? p.speaker_id ?? 0),
                                chunkId: p.chunkId || p.chunk_id || undefined,
                                chunkIds: Array.isArray(p.chunkIds) ? p.chunkIds.filter((id: any) => typeof id === 'string') : undefined,
                                startTime: toTimeString(p.startTime),
                                endTime: toTimeString(p.endTime),
                                timestamp: p.timestamp || '',
                                translation: p.translation || '',
                            }));
                        }
                    } catch {
                        const lines = m.transcript.split('\n').filter((l: string) => l.trim());
                        parts = lines.map((line: string) => ({
                            text: line.trim(),
                            speaker: 'Speaker 1',
                            speakerId: 0,
                            startTime: '0',
                            endTime: '0',
                            timestamp: '',
                            translation: '',
                        }));
                    }
                }
                const normalized = collapseTranscriptSnapshots(parts);
                setTranscriptParts(normalized.parts);
                if (normalized.changed) {
                    const duration = Number(m.audio_duration ?? m.audioDuration ?? 0);
                    void updateMeeting(requestedMeetingId, {
                        transcript: normalized.parts,
                        audioDuration: Number.isFinite(duration) ? duration : 0,
                    }).catch((err) => console.warn('[detail] Failed to cleanup duplicated transcript snapshots:', err));
                }
            } catch (e) {
                if (!cancelled) {
                    console.error('[detail] Failed to load meeting:', e);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [viewingMeetingId, recording, setTranscriptParts]);

    // Auto-scroll
    useEffect(() => {
        transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
    }, [transcriptParts, interimText, interimTranslation, isTranscribing]);

    useEffect(() => {
        if (prevTranscriptLenRef.current !== transcriptParts.length) {
            partSourceTranslatedRef.current = {};
            prevTranscriptLenRef.current = transcriptParts.length;
        }
        if (transcriptParts.length === 0) {
            interimSourceTranslatedRef.current = '';
            lastInterimSentRef.current = '';
            lastInterimReqAtRef.current = 0;
        }
    }, [transcriptParts.length]);

    useEffect(() => {
        interimTranslateAbortRef.current?.abort();
        interimTranslateAbortRef.current = null;
        interimBusyRef.current = false;
        interimTranslationRef.current = '';
        interimSourceTranslatedRef.current = '';
        lastInterimSentRef.current = '';
        lastInterimReqAtRef.current = 0;
        setInterimTranslation('');
        partSourceTranslatedRef.current = {};
    }, [translationLang, translationEnabled]);

    // Translate latest part
    const latestPart = transcriptParts[transcriptParts.length - 1];
    useEffect(() => {
        if (!translationEnabled || !latestPart?.text) return;
        const idx = transcriptParts.length - 1;
        const translateKey = `${idx}:${latestPart.speakerId}:${latestPart.text}:${translationLang}`;
        if (lastPartTranslateKeyRef.current === translateKey) return;
        lastPartTranslateKeyRef.current = translateKey;
        translatePart(idx, latestPart);
    }, [translationEnabled, translationLang, transcriptParts.length, latestPart?.text, latestPart?.speakerId]);

    // Realtime interim translation (mainly for Nvidia streaming)
    useEffect(() => {
        if (!translationEnabled || !isTranscribing || !interimText.trim()) {
            interimTranslateAbortRef.current?.abort();
            interimTranslateAbortRef.current = null;
            interimBusyRef.current = false;
            setInterimTranslation('');
            interimTranslationRef.current = '';
            interimSourceTranslatedRef.current = '';
            if (!isTranscribing) {
                lastInterimSentRef.current = '';
                lastInterimReqAtRef.current = 0;
            }
            return;
        }

        if (interimBusyRef.current) return;

        const fullSource = interimText.trim();
        const prevSource = interimSourceTranslatedRef.current;
        const delta = computeSourceDelta(prevSource, fullSource);
        if (delta.mode === 'noop') return;
        const requestText = delta.text;
        const appendMode = delta.mode === 'append';
        const prevSent = lastInterimSentRef.current;
        const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
        const deltaLen = Math.max(0, requestText.length);
        const deltaWords = Math.max(0, countWords(requestText));
        const endsSentence = /[.!?…:;。！？]$/.test(fullSource);
        const now = Date.now();
        const minIntervalMs = appendMode ? (endsSentence ? 700 : 1200) : (endsSentence ? 1200 : 2800);
        const minDeltaLen = appendMode ? (endsSentence ? 8 : 14) : (endsSentence ? 20 : 45);
        const minDeltaWords = appendMode ? (endsSentence ? 2 : 3) : (endsSentence ? 4 : 9);
        const minStartLen = appendMode ? 0 : (endsSentence ? 24 : 48);
        const minStartWords = appendMode ? 0 : (endsSentence ? 6 : 10);

        // Aggressive gate to reduce LLM calls while keeping "live enough" updates.
        const intervalReady = now - lastInterimReqAtRef.current >= minIntervalMs;
        const enoughDelta = deltaLen >= minDeltaLen || deltaWords >= minDeltaWords;
        const firstRequestReady = !prevSent && requestText.length >= minStartLen && countWords(requestText) >= minStartWords;
        const shouldTranslate = intervalReady && (firstRequestReady || enoughDelta || (endsSentence && deltaLen > 0));
        if (!shouldTranslate) return;

        const timeout = window.setTimeout(async () => {
            if (interimBusyRef.current) return;
            interimBusyRef.current = true;
            const ac = new AbortController();
            interimTranslateAbortRef.current = ac;
            lastInterimReqAtRef.current = Date.now();
            const baseAtRequest = interimTranslationRef.current;

            try {
                const res = await fetchSidecar('/translate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: requestText, targetLang: translationLang }),
                    signal: ac.signal,
                });
                let translated = '';
                await consumeSseResponse(res, {
                    onToken: (token) => {
                        translated += token;
                        const merged = appendMode
                            ? joinTranslationTail(baseAtRequest, translated)
                            : mergeStreamingTranslation(baseAtRequest, translated);
                        if (merged !== interimTranslationRef.current) {
                            interimTranslationRef.current = merged;
                            setInterimTranslation(merged);
                        }
                    },
                    onErrorEvent: (message) => {
                        console.warn('[detail] Interim translation SSE error:', message);
                    },
                });
                if (translated.trim()) {
                    lastInterimSentRef.current = fullSource;
                    interimSourceTranslatedRef.current = fullSource;
                }
            } catch (err: any) {
                if (err?.name !== 'AbortError') {
                    console.error('[detail] Interim translation error:', err);
                }
            } finally {
                interimBusyRef.current = false;
            }
        }, endsSentence ? 220 : 750);

        return () => window.clearTimeout(timeout);
    }, [translationEnabled, isTranscribing, interimText, translationLang]);

    const translatePart = async (idx: number, part: any) => {
        if (!part?.text) return;
        if (abortControllers[idx]) abortControllers[idx].abort();
        const ac = new AbortController(); abortControllers[idx] = ac;
        try {
            const currentSource = String(part.text || '').trim();
            if (!currentSource) return;
            const previousSource = partSourceTranslatedRef.current[idx] || '';
            const delta = computeSourceDelta(previousSource, currentSource);
            if (delta.mode === 'noop') return;

            const appendMode = delta.mode === 'append';
            const requestText = delta.text;
            const baseTranslation = useAppStore.getState().transcriptParts[idx]?.translation || '';
            const tl = useAppStore.getState().translationLang;
            const res = await fetchSidecar('/translate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: requestText, targetLang: tl }), signal: ac.signal,
            });
            const baseAtRequest = baseTranslation;
            let translated = '';
            await consumeSseResponse(res, {
                onToken: (token) => {
                    translated += token;
                    const merged = appendMode
                        ? joinTranslationTail(baseAtRequest, translated)
                        : mergeStreamingTranslation(baseAtRequest, translated);
                    useAppStore.getState().updateTranscriptTranslation(idx, merged);
                },
                onErrorEvent: (message) => {
                    console.warn('[detail] Part translation SSE error:', message);
                },
            });
            if (translated.trim()) {
                partSourceTranslatedRef.current[idx] = currentSource;
            }
        } catch { }
    };

    const fmtSec = (v: string) => { const n = parseFloat(v) || 0; return `${Math.floor(n / 60)}:${Math.floor(n % 60).toString().padStart(2, '0')}`; };
    const interimSpeakerColor = SPEAKER_COLORS[interimSpeakerId % SPEAKER_COLORS.length];
    const liveSummary = viewingMeetingId
        ? meetings.find((m) => m.id === viewingMeetingId)?.summary
        : undefined;
    const summaryRaw = (liveSummary || meetingData?.summary || transientSummary || '').trim();
    const minutesMarkdown = useMemo(
        () => normalizeSummaryMarkdown(summaryRaw, lang),
        [summaryRaw, lang]
    );
    const minutesHtml = useMemo(
        () => markdownToHtml(minutesMarkdown),
        [minutesMarkdown]
    );
    const hasMinutes = minutesMarkdown.trim().length > 0;

    return (
        <section className="view active detail-view">
            {/* Back button */}
            <div className="detail-header">
                <button className="back-btn" onClick={() => setCurrentView('list')}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m15 18-6-6 6-6" />
                    </svg>
                    <span>{lang === 'vi' ? 'Cuộc họp' : 'Meetings'}</span>
                </button>
            </div>

            {/* Sub-tabs */}
            <nav className="sub-tabs">
                <button className={`sub-tab ${activeTab === 'recording' ? 'active' : ''}`} onClick={() => setActiveTab('recording')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
                    </svg>
                    <span>{lang === 'vi' ? 'Ghi âm' : 'Recording'}</span>
                </button>
                <button className={`sub-tab ${activeTab === 'summary' ? 'active' : ''}`} onClick={() => setActiveTab('summary')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z" />
                    </svg>
                    <span>{lang === 'vi' ? 'Biên bản' : 'Minutes'}</span>
                </button>
            </nav>

            {/* Recording Pane */}
            <div className="detail-pane recording-pane" style={{ display: activeTab === 'recording' ? 'flex' : 'none' }}>
                <div className="pane-header">
                    <h2 className="pane-title">{lang === 'vi' ? 'Phiên dịch trực tiếp' : 'Live Transcription'}</h2>
                    <div className="pane-actions">
                        {transcriptParts.length > 0 && (
                            <button className="action-btn" onClick={exportTranscript}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
                                </svg>
                                <span>{lang === 'vi' ? 'Xuất transcript' : 'Export transcript'}</span>
                            </button>
                        )}
                        {(currentMeetingId || draftId) && (
                            <button className="action-btn" onClick={downloadAudio} disabled={downloadingAudio}>
                                {downloadingAudio ? (lang === 'vi' ? 'Đang tải...' : 'Downloading...') : (lang === 'vi' ? 'Tải ghi âm' : 'Download audio')}
                            </button>
                        )}
                        {transcriptParts.length > 0 && (
                            <button className="action-btn danger" onClick={deleteAllTranscript}>
                                {lang === 'vi' ? 'Xóa hết' : 'Clear all'}
                            </button>
                        )}
                        {recording && (
                            <span className="rec-indicator">
                                <span className="rec-dot-live" />
                                <span>{paused ? (lang === 'vi' ? 'Tạm dừng' : 'Paused') : (lang === 'vi' ? 'Ghi âm' : 'Recording')}</span>
                            </span>
                        )}
                    </div>
                </div>

                {transcriptParts.length === 0 && !recording ? (
                    <div className="welcome-state">
                        <div className="welcome-icon">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
                            </svg>
                        </div>
                        <div className="welcome-title">{lang === 'vi' ? 'Chào mừng đến Scribble!' : 'Welcome to Scribble!'}</div>
                        <div className="welcome-sub">{lang === 'vi' ? 'Nhấn nút Record để bắt đầu phiên dịch trực tiếp' : 'Press Record to start live transcription'}</div>
                    </div>
                ) : transcriptParts.length === 0 && recording ? (
                    <div className={`listening-state ${isTranscribing && interimText ? 'has-live' : ''}`}>
                        <div className="listening-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            </svg>
                        </div>
                        <div className="listening-title">{paused ? (lang === 'vi' ? 'Tạm dừng ghi âm' : 'Recording paused') : (lang === 'vi' ? 'Đang lắng nghe...' : 'Listening for speech...')}</div>
                        <div className="listening-sub">{paused ? (lang === 'vi' ? 'Nhấn tiếp tục để ghi âm' : 'Click resume to continue') : (lang === 'vi' ? 'Hãy nói để xem phiên dịch trực tiếp' : 'Speak to see live transcription')}</div>
                        {isTranscribing && interimText && (
                            <div className="listening-live-preview">
                                <div className="interim-bubble" style={{ marginTop: 12, maxWidth: 520 }}>
                                    <span className="speaker-badge" style={{ '--speaker-color': interimSpeakerColor } as React.CSSProperties}>
                                        {interimSpeaker}
                                    </span>
                                    <span className="interim-dot" />
                                    <span className="interim-text">{interimText}</span>
                                </div>
                                {translationEnabled && interimTranslation && (
                                    <div className="transcript-translation streaming" style={{ maxWidth: 520 }}>
                                        {interimTranslation}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="transcript-list" ref={transcriptRef}>
                        {transcriptParts.map((part, i) => {
                            const speakerColor = SPEAKER_COLORS[part.speakerId % SPEAKER_COLORS.length];
                            return (
                                <div className={`transcript-item ${i === transcriptParts.length - 1 && recording ? 'live' : ''}`} key={i}>
                                    <div className="transcript-actions">
                                        <button
                                            className="transcript-action-btn"
                                            onClick={() => startEditTranscript(i)}
                                            title={lang === 'vi' ? 'Sửa transcript' : 'Edit transcript'}
                                            aria-label={lang === 'vi' ? 'Sửa transcript' : 'Edit transcript'}
                                        >
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M12 20h9" />
                                                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                                            </svg>
                                        </button>
                                        <button
                                            className="transcript-action-btn"
                                            onClick={() => startEditSpeaker(part.speakerId, i)}
                                            title={lang === 'vi' ? 'Đổi tên speaker (áp dụng toàn bộ)' : 'Rename speaker (apply all)'}
                                            aria-label={lang === 'vi' ? 'Đổi tên speaker' : 'Rename speaker'}
                                        >
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <circle cx="12" cy="8" r="4" />
                                                <path d="M6 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
                                            </svg>
                                        </button>
                                        <button
                                            className="transcript-action-btn t-delete-btn"
                                            onClick={() => deleteTranscriptAt(i)}
                                            title={lang === 'vi' ? 'Xóa đoạn này' : 'Delete this item'}
                                            aria-label={lang === 'vi' ? 'Xóa đoạn này' : 'Delete this item'}
                                        >
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M3 6h18" />
                                                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                            </svg>
                                        </button>
                                    </div>
                                    <div className="transcript-time">
                                        {editingSpeakerId === part.speakerId && editingSpeakerAnchorIdx === i ? (
                                            <div className="speaker-edit-wrap">
                                                <input
                                                    className="speaker-edit-input"
                                                    value={editingSpeakerName}
                                                    onChange={(e) => setEditingSpeakerName(e.target.value)}
                                                    autoFocus
                                                />
                                                <button className="speaker-edit-btn" onClick={cancelEditSpeaker}>
                                                    {lang === 'vi' ? 'Hủy' : 'Cancel'}
                                                </button>
                                                <button className="speaker-edit-btn primary" onClick={saveEditSpeaker} disabled={!editingSpeakerName.trim()}>
                                                    {lang === 'vi' ? 'Lưu' : 'Save'}
                                                </button>
                                            </div>
                                        ) : (
                                            <span className="speaker-badge" style={{ '--speaker-color': speakerColor } as React.CSSProperties}>
                                                {part.speaker}
                                            </span>
                                        )}
                                        <span style={{ marginLeft: 8 }}>{fmtSec(part.startTime)} – {fmtSec(part.endTime)}</span>
                                    </div>
                                    {editingIndex === i ? (
                                        <div className="transcript-edit-wrap">
                                            <textarea
                                                className="transcript-edit-input"
                                                value={editingText}
                                                onChange={(e) => setEditingText(e.target.value)}
                                                autoFocus
                                                rows={3}
                                            />
                                            <div className="transcript-edit-actions">
                                                <button className="action-btn" onClick={cancelEditTranscript}>
                                                    {lang === 'vi' ? 'Hủy' : 'Cancel'}
                                                </button>
                                                <button className="action-btn primary" onClick={() => saveEditTranscript(i)} disabled={!editingText.trim()}>
                                                    {lang === 'vi' ? 'Lưu' : 'Save'}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="transcript-text">{part.text}</div>
                                    )}
                                    {part.translation && (
                                        <div className="transcript-translation">{part.translation}</div>
                                    )}
                                </div>
                            );
                        })}
                        {isTranscribing && interimText && (
                            <>
                                <div className="interim-bubble">
                                    <span className="speaker-badge" style={{ '--speaker-color': interimSpeakerColor } as React.CSSProperties}>
                                        {interimSpeaker}
                                    </span>
                                    <span className="interim-dot" />
                                    <span className="interim-text">{interimText}</span>
                                </div>
                                {translationEnabled && interimTranslation && (
                                    <div className="transcript-translation streaming">
                                        {interimTranslation}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                )}
            </div>

            {/* Summary Pane */}
            <div className="detail-pane summary-pane" style={{ display: activeTab === 'summary' ? 'flex' : 'none' }}>
                <div className="pane-header">
                    <h2 className="pane-title">{lang === 'vi' ? 'Biên bản cuộc họp' : 'Meeting Minutes'}</h2>
                    <div className="pane-actions">
                        {hasMinutes && (
                            <button className="action-btn" onClick={() => setExportPickerOpen(true)}>
                                {lang === 'vi' ? 'Xuất biên bản' : 'Export minutes'}
                            </button>
                        )}
                    </div>
                </div>
                {hasMinutes ? (
                    <div
                        className="minutes-body"
                        style={{ padding: '16px' }}
                        dangerouslySetInnerHTML={{ __html: minutesHtml }}
                    />
                ) : summaryLoading ? (
                    <div className="summary-empty">
                        <div className="summary-loading-spinner" />
                        <p>{lang === 'vi' ? 'Đang tạo biên bản, vui lòng chờ...' : 'Generating minutes, please wait...'}</p>
                    </div>
                ) : (
                    <div className="summary-empty">
                        <p>{lang === 'vi' ? 'Chưa có biên bản. Nhấn "Tạo biên bản" sau khi thu âm.' : 'No minutes yet. Click "Create Minutes" after recording.'}</p>
                    </div>
                )}
            </div>

            {exportPickerOpen && (
                <div className="export-overlay show" onClick={() => !exportingMinutesFormat && setExportPickerOpen(false)}>
                    <div className="export-picker" onClick={(e) => e.stopPropagation()}>
                        <div className="export-picker-title">{lang === 'vi' ? 'Xuất biên bản cuộc họp' : 'Export meeting minutes'}</div>
                        <button className="export-option" onClick={() => downloadMinutes('md')} disabled={!!exportingMinutesFormat}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 3v12" />
                                <path d="m7 10 5 5 5-5" />
                                <path d="M5 21h14" />
                            </svg>
                            <div>
                                <div className="export-option-name">Markdown (.md)</div>
                                <div className="export-option-desc">{lang === 'vi' ? 'Gọn nhẹ, dễ chỉnh sửa' : 'Portable and easy to edit'}</div>
                            </div>
                        </button>
                        <button className="export-option" onClick={() => downloadMinutes('docx')} disabled={!!exportingMinutesFormat}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <path d="M14 2v6h6" />
                                <path d="M8 13h8" />
                                <path d="M8 17h8" />
                            </svg>
                            <div>
                                <div className="export-option-name">Word (.docx)</div>
                                <div className="export-option-desc">{lang === 'vi' ? 'Định dạng tài liệu để chia sẻ' : 'Document format for sharing'}</div>
                            </div>
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
}
