import { memo, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { TranscriptPart, Meeting, useAppStore } from '../stores/appStore';
import { getMeeting, getMeetings, updateMeeting, downloadMeetingAudio, downloadMeetingMinutes, downloadTextFile } from '../lib/api';
import { showConfirm } from './ConfirmDialog';
import { useToast } from './Toast';
import { MeetingAttachments } from './MeetingAttachments';

const SPEAKER_COLORS = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
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

function htmlToMarkdown(html: string): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lines: string[] = [];

    const inlineText = (el: Element): string => {
        let result = '';
        el.childNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                result += node.textContent || '';
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = (node as Element).tagName.toLowerCase();
                const inner = inlineText(node as Element);
                if (tag === 'strong' || tag === 'b') result += `**${inner}**`;
                else if (tag === 'em' || tag === 'i') result += `*${inner}*`;
                else if (tag === 'code') result += `\`${inner}\``;
                else if (tag === 'br') result += '\n';
                else result += inner;
            }
        });
        return result;
    };

    const processNode = (node: Element) => {
        const tag = node.tagName.toLowerCase();
        if (tag === 'h1') { lines.push(`# ${inlineText(node)}`); lines.push(''); }
        else if (tag === 'h2') { lines.push(`## ${inlineText(node)}`); lines.push(''); }
        else if (tag === 'h3') { lines.push(`### ${inlineText(node)}`); lines.push(''); }
        else if (tag === 'p') {
            const text = inlineText(node);
            if (text.trim()) { lines.push(text); lines.push(''); }
        }
        else if (tag === 'blockquote') { lines.push(`> ${inlineText(node)}`); lines.push(''); }
        else if (tag === 'ul') {
            node.querySelectorAll(':scope > li').forEach((li) => {
                lines.push(`- ${inlineText(li)}`);
            });
            lines.push('');
        }
        else if (tag === 'ol') {
            let idx = 1;
            node.querySelectorAll(':scope > li').forEach((li) => {
                lines.push(`${idx++}. ${inlineText(li)}`);
            });
            lines.push('');
        }
        else if (tag === 'table') {
            const thead = node.querySelector('thead');
            const tbody = node.querySelector('tbody');
            if (thead) {
                const ths = Array.from(thead.querySelectorAll('th')).map((th) => inlineText(th));
                lines.push(`| ${ths.join(' | ')} |`);
                lines.push(`| ${ths.map(() => '---').join(' | ')} |`);
            }
            if (tbody) {
                tbody.querySelectorAll('tr').forEach((tr) => {
                    const tds = Array.from(tr.querySelectorAll('td')).map((td) => inlineText(td));
                    lines.push(`| ${tds.join(' | ')} |`);
                });
            }
            lines.push('');
        }
        else {
            // Fallback: just get text
            const text = inlineText(node);
            if (text.trim()) { lines.push(text); lines.push(''); }
        }
    };

    Array.from(doc.body.children).forEach(processNode);
    // Clean up trailing empty lines
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function MeetingDetail() {
    const {
        recording, paused, transcriptParts,
        setCurrentView, lang, activeTab, setActiveTab,
        currentMeetingId, draftId, setTranscriptParts, isTranscribing,
        meetings, transientSummary,
        summaryLoading, translationEnabled,
    } = useAppStore();

    // Live translation: read via subscription + DOM ref (avoids re-render of entire list)
    const liveTranslationRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        // Subscribe to interimTranslation changes and update DOM directly
        const unsub = useAppStore.subscribe((state, prev) => {
            if (state.interimTranslation !== prev.interimTranslation && liveTranslationRef.current) {
                liveTranslationRef.current.textContent = state.interimTranslation ? `↪ ${state.interimTranslation}` : '';
            }
        });
        return unsub;
    }, []);

    const wordCount = useMemo(() => {
        return transcriptParts.reduce((acc, p) => acc + (p.text || '').trim().split(/\s+/).filter(Boolean).length, 0);
    }, [transcriptParts]);
    const { showToast } = useToast();
    const viewingMeetingId = currentMeetingId || draftId;

    const transcriptRef = useRef<HTMLDivElement>(null);
    const [meetingData, setMeetingData] = useState<Meeting | null>(null);
    const [meetingLoading, setMeetingLoading] = useState(false);
    const [editingSpeakerId, setEditingSpeakerId] = useState<number | null>(null);
    const [editingSpeakerAnchorIdx, setEditingSpeakerAnchorIdx] = useState<number | null>(null);
    const [editingSpeakerName, setEditingSpeakerName] = useState('');
    const [downloadingAudio, setDownloadingAudio] = useState(false);
    const [exportPickerOpen, setExportPickerOpen] = useState(false);
    const [exportingMinutesFormat, setExportingMinutesFormat] = useState<'md' | 'docx' | null>(null);
    const [editingMinutes, setEditingMinutes] = useState(false);
    const minutesEditRef = useRef<HTMLDivElement>(null);

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
            showToast(lang === 'vi' ? 'Đã tải ghi âm thành công!' : 'Audio downloaded!', 'success');
        } catch (e) {
            console.warn('[detail] Download audio failed:', e);
            showToast(lang === 'vi' ? 'Tải ghi âm thất bại' : 'Audio download failed', 'error');
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

    const copyTranscript = async () => {
        if (transcriptParts.length === 0) return;
        const lines = transcriptParts.map((p) => `${p.speaker}: ${p.text}`);
        const text = lines.join('\n\n');
        try {
            await navigator.clipboard.writeText(text);
            showToast(lang === 'vi' ? 'Đã copy transcript' : 'Transcript copied!', 'success');
        } catch {
            showToast(lang === 'vi' ? 'Copy thất bại' : 'Copy failed', 'error');
        }
    };
    const applyTranscriptUpdate = async (nextParts: TranscriptPart[]) => {
        setTranscriptParts(nextParts);
        await persistTranscriptParts(nextParts);
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
        cancelEditSpeaker();
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
            useAppStore.getState().setTransientSummary('');
            cancelEditSpeaker();
        }
        prevLoadedMeetingRef.current = requestedMeetingId;
        setMeetingLoading(true);

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
                            parts = parsed.map((p: Record<string, unknown>) => ({
                                text: (p.text as string) || '',
                                speaker: (p.speaker as string) || 'Speaker 1',
                                speakerId: toSpeakerId((p.speakerId ?? p.speaker_id ?? 0) as number),
                                chunkId: (p.chunkId as string) || (p.chunk_id as string) || undefined,
                                chunkIds: Array.isArray(p.chunkIds) ? (p.chunkIds as unknown[]).filter((id): id is string => typeof id === 'string') : undefined,
                                startTime: toTimeString(p.startTime as string),
                                endTime: toTimeString(p.endTime as string),
                                timestamp: String(p.timestamp || ''),
                                translation: String(p.translation || ''),
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
                    const duration = Number(m.audio_duration ?? 0);
                    void updateMeeting(requestedMeetingId, {
                        transcript: normalized.parts,
                        audioDuration: Number.isFinite(duration) ? duration : 0,
                    }).catch((err) => console.warn('[detail] Failed to cleanup duplicated transcript snapshots:', err));
                }
            } catch (e) {
                if (!cancelled) {
                    console.error('[detail] Failed to load meeting:', e);
                }
            } finally {
                if (!cancelled) setMeetingLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [viewingMeetingId, recording, setTranscriptParts]);

    // Auto-scroll
    useEffect(() => {
        transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
    }, [transcriptParts, isTranscribing]);


    // Translation is now handled inline by the backend (cabin-style).
    // Each WebSocket message includes a 'translation' field when enabled.
    // RecordingBar.tsx reads data.translation and updates transcriptParts directly.

    const fmtSec = (v: string) => { const n = parseFloat(v) || 0; return `${Math.floor(n / 60)}:${Math.floor(n % 60).toString().padStart(2, '0')}`; };

    const liveSummary = viewingMeetingId
        ? meetings.find((m) => m.id === viewingMeetingId)?.summary
        : undefined;
    const summaryRaw = (liveSummary || meetingData?.summary || transientSummary || '').trim();
    const minutesMarkdown = useMemo(
        () => normalizeSummaryMarkdown(summaryRaw, lang),
        [summaryRaw, lang]
    );
    const minutesHtml = useMemo(
        () => DOMPurify.sanitize(markdownToHtml(minutesMarkdown)),
        [minutesMarkdown]
    );
    const hasMinutes = minutesMarkdown.trim().length > 0;

    return (
        <section className="view active detail-view">
            {/* Compact toolbar: back button + tab switcher on ONE row.
                Earlier these lived on two separate rows (~90px combined). */}
            <div className="detail-toolbar">
                <button className="back-btn back-btn-compact" onClick={() => setCurrentView('list')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m15 18-6-6 6-6" />
                    </svg>
                    <span>{lang === 'vi' ? 'Cuộc họp' : 'Meetings'}</span>
                </button>

                <nav className="sub-tabs sub-tabs-compact">
                    <button className={`sub-tab ${activeTab === 'recording' ? 'active' : ''}`} onClick={() => setActiveTab('recording')}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
                        </svg>
                        <span>{lang === 'vi' ? 'Ghi âm' : 'Recording'}</span>
                    </button>
                    <button className={`sub-tab ${activeTab === 'summary' ? 'active' : ''}`} onClick={() => setActiveTab('summary')}>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z" />
                        </svg>
                        <span>{lang === 'vi' ? 'Biên bản' : 'Minutes'}</span>
                    </button>
                </nav>

                {/* Active pane's actions show inline on the right side of the
                    toolbar — saves a whole pane-header row. */}
                <div className="detail-toolbar-actions">
                    {activeTab === 'summary' && (
                        <>
                            {hasMinutes && !editingMinutes && (
                                <button className="action-btn action-btn-compact" onClick={() => setEditingMinutes(true)}>
                                    {lang === 'vi' ? 'Chỉnh sửa' : 'Edit'}
                                </button>
                            )}
                            {editingMinutes && (
                                <>
                                    <button className="action-btn action-btn-compact" onClick={() => setEditingMinutes(false)}>
                                        {lang === 'vi' ? 'Huỷ' : 'Cancel'}
                                    </button>
                                    <button className="action-btn action-btn-compact primary" onClick={async () => {
                                        if (!viewingMeetingId || !minutesEditRef.current) return;
                                        const md = htmlToMarkdown(minutesEditRef.current.innerHTML);
                                        await updateMeeting(viewingMeetingId as number, { summary: md });
                                        const updated = await getMeeting(viewingMeetingId);
                                        setMeetingData(updated);
                                        const list = await getMeetings();
                                        if (list) useAppStore.getState().setMeetings(list);
                                        setEditingMinutes(false);
                                        showToast(lang === 'vi' ? 'Đã lưu biên bản' : 'Minutes saved', 'success');
                                    }}>
                                        {lang === 'vi' ? 'Lưu' : 'Save'}
                                    </button>
                                </>
                            )}
                            {hasMinutes && !editingMinutes && (
                                <button className="action-btn action-btn-compact" onClick={() => setExportPickerOpen(true)}>
                                    {lang === 'vi' ? 'Xuất biên bản' : 'Export'}
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>

            {meetingLoading && !meetingData && (
                <div style={{ textAlign: 'center', padding: '32px 0', opacity: 0.6 }}>
                    <div className="summary-loading-spinner" />
                </div>
            )}

            {/* Recording Pane */}
            <div className="detail-pane recording-pane" style={{ display: activeTab === 'recording' ? 'flex' : 'none' }}>
                <div className="pane-header">
                    <div className="pane-title-row">
                        <h2 className="pane-title">{lang === 'vi' ? 'Phiên dịch trực tiếp' : 'Live Transcription'}</h2>
                        {wordCount > 0 && (
                            <span className="word-count-badge">{wordCount} {lang === 'vi' ? 'từ' : 'words'}</span>
                        )}
                    </div>
                    <div className="pane-actions">
                        {transcriptParts.length > 0 && (
                            <button className="action-btn icon-only" onClick={copyTranscript} title={lang === 'vi' ? 'Copy transcript' : 'Copy transcript'}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
                                </svg>
                            </button>
                        )}
                        {transcriptParts.length > 0 && (
                            <button className="action-btn" onClick={exportTranscript}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
                                </svg>
                                <span>{lang === 'vi' ? 'Xuất transcript' : 'Export'}</span>
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
                    <div className="listening-state">
                        <div className="listening-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            </svg>
                        </div>
                        <div className="listening-title">{paused ? (lang === 'vi' ? 'Tạm dừng ghi âm' : 'Recording paused') : (lang === 'vi' ? 'Đang lắng nghe...' : 'Listening for speech...')}</div>
                        <div className="listening-sub">{paused ? (lang === 'vi' ? 'Nhấn tiếp tục để ghi âm' : 'Click resume to continue') : (lang === 'vi' ? 'Hãy nói để xem phiên dịch trực tiếp' : 'Speak to see live transcription')}</div>
                    </div>
                ) : (
                    <div className={`transcript-list ${translationEnabled ? 'with-translation' : ''}`} ref={transcriptRef}>
                        {transcriptParts.map((part, i) => {
                            const speakerColor = SPEAKER_COLORS[part.speakerId % SPEAKER_COLORS.length];
                            const isLive = i === transcriptParts.length - 1 && recording;
                            return (
                                <div className={`transcript-item ${isLive ? 'live' : ''}`} key={i}>
                                    <div className="transcript-actions">
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
                                                    onBlur={() => void saveEditSpeaker()}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Escape') { e.preventDefault(); cancelEditSpeaker(); }
                                                        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                                                    }}
                                                    autoFocus
                                                />
                                            </div>
                                        ) : (
                                            <span className="speaker-badge" style={{ '--speaker-color': speakerColor } as React.CSSProperties}>
                                                {part.speaker}
                                            </span>
                                        )}
                                        <span style={{ marginLeft: 8 }}>{fmtSec(part.startTime)} – {fmtSec(part.endTime)}</span>
                                    </div>
                                    <TranscriptSentences
                                        text={part.text}
                                        translation={part.translation}
                                        translationEnabled={translationEnabled}
                                        isLive={isLive}
                                        liveTranslationRef={liveTranslationRef}
                                        onSave={(newText) => {
                                            const next = transcriptParts.map((p, j) =>
                                                j === i ? { ...p, text: newText, translation: '' } : p
                                            );
                                            void applyTranscriptUpdate(next);
                                        }}
                                    />
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Summary Pane — pane-header moved up into the toolbar above to
                save a ~60px row. The "Biên bản cuộc họp" h2 is gone too: the
                active tab pill already says "Biên bản" so the duplicate
                heading was redundant. */}
            <div className="detail-pane summary-pane" style={{ display: activeTab === 'summary' ? 'flex' : 'none' }}>
                {viewingMeetingId && typeof viewingMeetingId === 'number' && (
                    <MeetingAttachments meetingId={viewingMeetingId} />
                )}
                {editingMinutes ? (
                    <div
                        ref={minutesEditRef}
                        className="minutes-body minutes-editable"
                        contentEditable
                        suppressContentEditableWarning
                        dangerouslySetInnerHTML={{ __html: minutesHtml }}
                        style={{ padding: '16px' }}
                    />
                ) : hasMinutes ? (
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

const TranscriptSentences = memo(function TranscriptSentences({
    text,
    translation,
    translationEnabled,
    isLive,
    liveTranslationRef,
    onSave
}: {
    text: string;
    translation?: string;
    translationEnabled?: boolean;
    isLive?: boolean;
    liveTranslationRef?: React.RefObject<HTMLDivElement | null>;
    onSave?: (newText: string) => void;
}) {
    const [editMode, setEditMode] = useState(false);
    const [editVal, setEditVal] = useState('');

    const handleSave = () => {
        const trimmed = editVal.trim();
        if (onSave && trimmed !== text) {
            onSave(trimmed);
        }
        setEditMode(false);
        setEditVal('');
    };

    const handleDelete = () => {
        if (onSave) onSave('');
    };

    const deleteBtn = onSave ? (
        <button
            className="sentence-delete-btn"
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
            title="Xoá đoạn này"
            aria-label="Delete part"
        >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
        </button>
    ) : null;

    return (
        <div className="transcript-sentences">
            <div className="sentence-group">
                <div className={translationEnabled ? "transcript-columns" : ""}>
                    <div className={translationEnabled ? "transcript-col-text" : ""}>
                        {editMode ? (
                            <textarea
                                className="sentence-edit-input"
                                value={editVal}
                                onChange={(e) => setEditVal(e.target.value)}
                                onBlur={handleSave}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') { e.preventDefault(); setEditMode(false); setEditVal(''); }
                                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
                                }}
                                autoFocus
                                rows={Math.max(1, Math.min(10, Math.ceil(editVal.length / 60)))}
                                style={{ width: '100%', resize: 'vertical', minHeight: '32px' }}
                            />
                        ) : (
                            <div className="sentence-row">
                                <div 
                                    className="transcript-text" 
                                    onClick={() => {
                                        if (!onSave) return;
                                        setEditMode(true);
                                        setEditVal(text);
                                    }} 
                                    style={onSave ? { cursor: 'text', flex: 1 } : undefined}
                                >
                                    {text}
                                </div>
                                {deleteBtn}
                            </div>
                        )}
                    </div>
                    {translationEnabled && (
                        <div className="transcript-col-translation">
                            {translation && <div className="translation-text">{translation}</div>}
                            {isLive && (
                                <div
                                    ref={(el) => {
                                        if (liveTranslationRef) liveTranslationRef.current = el;
                                        if (el) {
                                            const currentLive = useAppStore.getState().interimTranslation;
                                            el.textContent = currentLive || '';
                                        }
                                    }}
                                    className="translation-text"
                                />
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}, (prev, next) =>
    prev.text === next.text &&
    prev.translation === next.translation &&
    prev.translationEnabled === next.translationEnabled &&
    prev.isLive === next.isLive
);
