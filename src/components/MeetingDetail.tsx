import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { TranscriptPart, Meeting, useAppStore } from '../stores/appStore';
import { getMeeting, getMeetings, updateMeeting, downloadMeetingAudio, downloadMeetingMinutes, downloadTextFile, retryFailedChunks } from '../lib/api';
import { subscribeJobEvents } from '../lib/upload-audio';
import { showConfirm } from './ConfirmDialog';
import { useToast } from './Toast';
import { MeetingAttachments } from './MeetingAttachments';
import { NetworkOfflineBanner } from './NetworkOfflineBanner';

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

    // ── Retry failed Soniox chunks (v1.2.13) ─────────────────────────────
    // Shown when the upload pipeline finished with some chunks in status=
    // 'failed'. Banner offers a one-click "Thử lại" that hits the backend
    // retry endpoint and subscribes to its SSE so the transcript updates
    // live while the previously-failed chunks re-transcribe.
    const [retryingChunks, setRetryingChunks] = useState(false);
    const [retryProgress, setRetryProgress] = useState<{ progress: number; message: string } | null>(null);
    const retryAbortRef = useRef<AbortController | null>(null);
    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (retryAbortRef.current) {
                retryAbortRef.current.abort();
                retryAbortRef.current = null;
            }
        };
    }, []);

    // ── Sliding-window pagination ────────────────────────────────────────
    // Long sessions (4h+) can produce 500+ transcript parts. Rendering all
    // at once tanks the DOM. v1.2.14 upgrades the v1.2.13 cursor-based
    // pagination to a sliding window: BOTH ends slide in lockstep so the
    // DOM never exceeds MAX_WINDOW_SIZE parts regardless of how far the
    // user scrolls. The store still holds the full array → export, copy,
    // minutes-generation, search see EVERYTHING. Pure render-layer cap.
    //
    // Cursors = chunkIds (not indices) for stability across mutations.
    // Array indices shift when the user deletes/appends; chunkIds don't.
    //   - `topAnchorChunkId === null`  → window flush with array start
    //   - `bottomAnchorChunkId === null` → tail-open mode (live recording
    //     keeps flowing parts onto the bottom; window auto-extends).
    //
    // Window invariants:
    //   - `visibleEndIdx - visibleStartIdx <= MAX_WINDOW_SIZE` (DOM cap)
    //   - When `visibleEndIdx === transcriptParts.length`, bottom anchor is
    //     reset to null so subsequent live-appended parts stay visible.
    const TRANSCRIPT_PAGE_SIZE = 200;
    const MAX_WINDOW_SIZE = 400; // hard DOM cap — slides instead of growing
    const SCROLL_LOAD_THRESHOLD = 120; // px from top OR bottom
    const [topAnchorChunkId, setTopAnchorChunkId] = useState<string | null>(null);
    const [bottomAnchorChunkId, setBottomAnchorChunkId] = useState<string | null>(null);

    // Reset both anchors when switching meetings — different meeting means
    // different transcriptParts identity, window must restart from tail.
    const prevMeetingKeyRef = useRef<string | number | null>(null);
    useEffect(() => {
        const key = currentMeetingId || draftId || null;
        if (prevMeetingKeyRef.current !== key) {
            prevMeetingKeyRef.current = key;
            setTopAnchorChunkId(null);
            setBottomAnchorChunkId(null);
        }
    }, [currentMeetingId, draftId]);

    // Resolve bottom anchor → end index (exclusive). null = open tail.
    const visibleEndIdx = useMemo(() => {
        const total = transcriptParts.length;
        if (bottomAnchorChunkId === null) return total;
        const idx = transcriptParts.findIndex((p) => p.chunkId === bottomAnchorChunkId);
        return idx < 0 ? total : idx + 1;
    }, [transcriptParts, bottomAnchorChunkId]);

    // Resolve top anchor → start index. Hard-caps window at MAX_WINDOW_SIZE
    // by clamping start ≥ end - MAX. This guards the corner case where the
    // user pinned topAnchor with tail-open mode: live appends would
    // otherwise grow visibleEndIdx unbounded, pushing window past the cap.
    // Trade-off: topAnchor's "pin to this exact part" intent slowly drifts
    // as live appends shift the cap forward — but only when the user is at
    // tail anyway (they likely want to follow live), so acceptable.
    const visibleStartIdx = useMemo(() => {
        const total = transcriptParts.length;
        let startFromAnchor: number;
        if (topAnchorChunkId === null) {
            if (bottomAnchorChunkId !== null) {
                const bIdx = transcriptParts.findIndex((p) => p.chunkId === bottomAnchorChunkId);
                startFromAnchor = bIdx >= 0
                    ? Math.max(0, bIdx + 1 - MAX_WINDOW_SIZE)
                    : Math.max(0, total - TRANSCRIPT_PAGE_SIZE);
            } else {
                startFromAnchor = Math.max(0, total - TRANSCRIPT_PAGE_SIZE);
            }
        } else {
            const idx = transcriptParts.findIndex((p) => p.chunkId === topAnchorChunkId);
            startFromAnchor = idx < 0 ? Math.max(0, total - TRANSCRIPT_PAGE_SIZE) : idx;
        }
        // Hard DOM cap — slides instead of growing past MAX_WINDOW_SIZE.
        return Math.max(startFromAnchor, visibleEndIdx - MAX_WINDOW_SIZE);
    }, [transcriptParts, topAnchorChunkId, bottomAnchorChunkId, visibleEndIdx]);

    const visibleParts = useMemo(
        () => transcriptParts.slice(visibleStartIdx, visibleEndIdx),
        [transcriptParts, visibleStartIdx, visibleEndIdx],
    );
    const hasOlderParts = visibleStartIdx > 0;
    const hasNewerParts = visibleEndIdx < transcriptParts.length;
    // Tail-open mode — used by live auto-scroll to decide whether to follow
    // new parts (yes if user is at tail) vs stay put (no if they scrolled up).
    const isTailOpen = bottomAnchorChunkId === null;

    // Capture the chunkId at the top of the viewport for scroll restoration.
    // Walking children is cheap (window capped at MAX_WINDOW_SIZE parts).
    const captureScrollAnchor = (el: HTMLDivElement): { chunkId: string; viewportTop: number } | null => {
        const containerTop = el.getBoundingClientRect().top;
        const items = el.querySelectorAll<HTMLDivElement>('[data-chunk-id]');
        for (const item of items) {
            const rect = item.getBoundingClientRect();
            if (rect.bottom >= containerTop) {
                const cid = item.dataset.chunkId;
                if (cid) return { chunkId: cid, viewportTop: rect.top - containerTop };
            }
        }
        return null;
    };

    const restoreScrollAnchor = (
        el: HTMLDivElement,
        anchor: { chunkId: string; viewportTop: number } | null,
    ) => {
        if (!anchor) return;
        const containerTop = el.getBoundingClientRect().top;
        const node = el.querySelector<HTMLDivElement>(
            `[data-chunk-id="${CSS.escape(anchor.chunkId)}"]`,
        );
        if (!node) return;
        const newTop = node.getBoundingClientRect().top - containerTop;
        // Push scroll by the visual delta so the anchored part stays where
        // the user saw it. Works for both prepend (positive shift) and the
        // bottom-trim case (top items removed → negative shift).
        el.scrollTop += newTop - anchor.viewportTop;
    };

    // Single scroll handler — fires up-load OR down-load depending on which
    // edge the user is near. Throttled via inflight ref so a momentum bounce
    // doesn't trigger 2 loads in a row.
    const loadingMoreRef = useRef(false);
    const handleTranscriptScroll = useCallback(() => {
        if (loadingMoreRef.current) return;
        const el = transcriptRef.current;
        if (!el) return;

        const nearTop = el.scrollTop <= SCROLL_LOAD_THRESHOLD;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        const nearBottom = distanceFromBottom <= SCROLL_LOAD_THRESHOLD;

        const wantsUpLoad = nearTop && hasOlderParts;
        const wantsDownLoad = nearBottom && hasNewerParts;
        if (!wantsUpLoad && !wantsDownLoad) return;

        loadingMoreRef.current = true;
        const anchor = captureScrollAnchor(el);
        const total = transcriptParts.length;

        if (wantsUpLoad) {
            // Slide window backward by one page; cap size at MAX_WINDOW_SIZE
            // by trimming the same number of parts off the bottom. Keep
            // tail open when newEnd === total so live appends still flow
            // naturally — visibleStartIdx's hard cap (start ≥ end - MAX)
            // prevents unbounded growth even in tail-open mode.
            const newStart = Math.max(0, visibleStartIdx - TRANSCRIPT_PAGE_SIZE);
            const newEnd = Math.min(total, newStart + MAX_WINDOW_SIZE);
            setTopAnchorChunkId(newStart > 0 ? (transcriptParts[newStart]?.chunkId || null) : null);
            setBottomAnchorChunkId(
                newEnd < total ? (transcriptParts[newEnd - 1]?.chunkId || null) : null,
            );
        } else if (wantsDownLoad) {
            // Slide window forward by one page; cap size at MAX_WINDOW_SIZE
            // by trimming the same number of parts off the top. When the new
            // window reaches the array tail, UNSET BOTH anchors to drop back
            // into default tail-follow mode (window collapses to PAGE_SIZE,
            // live appends auto-flow into view).
            const newEnd = Math.min(total, visibleEndIdx + TRANSCRIPT_PAGE_SIZE);
            const newStart = Math.max(0, newEnd - MAX_WINDOW_SIZE);
            const reachedTail = newEnd === total;
            setTopAnchorChunkId(
                reachedTail || newStart === 0
                    ? null
                    : (transcriptParts[newStart]?.chunkId || null),
            );
            setBottomAnchorChunkId(
                reachedTail ? null : (transcriptParts[newEnd - 1]?.chunkId || null),
            );
        }

        requestAnimationFrame(() => {
            const elNow = transcriptRef.current;
            if (elNow) restoreScrollAnchor(elNow, anchor);
            loadingMoreRef.current = false;
        });
    }, [hasOlderParts, hasNewerParts, visibleStartIdx, visibleEndIdx, transcriptParts]);

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
            await downloadMeetingAudio(meetingId, `${safeTitle}.mp3`, 'mp3');
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

    // Refetch meeting from DB and refresh in-memory transcript. Called
    // after retry succeeds OR whenever an SSE event signals the transcript
    // landed new chunks (per-chunk persist commits to DB → we re-load).
    const refreshMeetingFromDb = async () => {
        const id = currentMeetingId || draftId;
        if (!id) return;
        try {
            const m = await getMeeting(id);
            setMeetingData(m);
            if (typeof m.transcript === 'string' && m.transcript.trim()) {
                try {
                    const parsed = JSON.parse(m.transcript);
                    if (Array.isArray(parsed)) setTranscriptParts(parsed);
                } catch { /* not JSON — likely legacy plain text, ignore */ }
            }
            // Sync meetings list so MeetingList badge counts update too.
            try {
                const list = await getMeetings();
                if (list) useAppStore.getState().setMeetings(list);
            } catch { /* best effort */ }
        } catch (err) {
            console.warn('[detail] refreshMeetingFromDb failed:', err);
        }
    };

    const handleRetryFailedChunks = async () => {
        const id = currentMeetingId || draftId;
        if (!id || retryingChunks) return;
        // Warn about overwrite — retry rebuilds transcript from DB chunks,
        // wiping any manual speaker renames/edits done since last chunk
        // completed. User can dismiss this if they've made edits.
        const confirmed = await showConfirm(
            lang === 'vi'
                ? 'Thử lại các phần lỗi sẽ ghi đè các chỉnh sửa transcript thủ công kể từ lần phiên âm trước. Tiếp tục?'
                : 'Retrying failed chunks will overwrite any manual transcript edits made since the last transcription. Continue?',
            lang,
        );
        if (!confirmed) return;

        setRetryingChunks(true);
        setRetryProgress({ progress: 0, message: lang === 'vi' ? 'Đang khởi động lại...' : 'Starting retry...' });

        try {
            const { job_id } = await retryFailedChunks(id as number);
            const abort = new AbortController();
            retryAbortRef.current = abort;
            await subscribeJobEvents(job_id, {
                signal: abort.signal,
                onStatus: (state) => {
                    setRetryProgress({ progress: state.progress || 0, message: state.message || '' });
                    if (state.status === 'done') {
                        showToast(
                            lang === 'vi' ? 'Đã transcribe các phần lỗi' : 'Failed chunks retried',
                            'success',
                        );
                        void refreshMeetingFromDb();
                    } else if (state.status === 'failed') {
                        const stillFailed = state.error || (lang === 'vi' ? 'Một số phần vẫn lỗi' : 'Some chunks still failed');
                        showToast(stillFailed, 'error');
                        // Even on failure, refresh to pick up any chunks
                        // that DID succeed before the new failure.
                        void refreshMeetingFromDb();
                    }
                },
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.toLowerCase().includes('abort')) {
                showToast(
                    lang === 'vi' ? `Thử lại thất bại: ${msg}` : `Retry failed: ${msg}`,
                    'error',
                );
            }
        } finally {
            setRetryingChunks(false);
            setRetryProgress(null);
            retryAbortRef.current = null;
        }
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

    // Auto-scroll: only when the user is near the bottom AND tail is open
    // (so we don't yank them away while they're reading mid-transcript via
    // the sliding window). 80px tolerance = roughly one transcript row.
    useEffect(() => {
        const el = transcriptRef.current;
        if (!el) return;
        if (!isTailOpen) return; // user scrolled up — don't fight them
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom < 80) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
    }, [transcriptParts, isTranscribing, isTailOpen]);


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
                    <div
                        className={`transcript-list ${translationEnabled ? 'with-translation' : ''}`}
                        ref={transcriptRef}
                        onScroll={handleTranscriptScroll}
                    >
                        {/* v1.2.14: Internet-offline banner. Self-renders only
                            when the backend's TCP probe (1.1.1.1:443) flips to
                            offline — e.g. wifi drops mid-retry. Visible at the
                            top of the transcript so the user understands why
                            the retry banner below isn't progressing. */}
                        <NetworkOfflineBanner />
                        {/* Retry banner (v1.2.13): shown when the Soniox upload
                            pipeline left some chunks in status='failed'. Lets
                            the user one-click retry just those chunks without
                            re-uploading the source file. */}
                        {(() => {
                            const failedCount = Number(meetingData?.failed_chunks_count || 0);
                            if (failedCount <= 0 && !retryingChunks) return null;
                            const inProgress = retryingChunks;
                            return (
                                <div className="retry-chunks-banner">
                                    <div className="retry-chunks-banner-icon">
                                        {inProgress ? (
                                            <span className="retry-chunks-spinner" aria-hidden />
                                        ) : (
                                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M12 2 2 22h20L12 2Z" />
                                                <line x1="12" x2="12" y1="9" y2="14" />
                                                <circle cx="12" cy="17" r="0.5" />
                                            </svg>
                                        )}
                                    </div>
                                    <div className="retry-chunks-banner-body">
                                        <div className="retry-chunks-banner-title">
                                            {inProgress
                                                ? (lang === 'vi' ? 'Đang thử lại các phần lỗi...' : 'Retrying failed chunks...')
                                                : (lang === 'vi'
                                                    ? `${failedCount} phần phiên âm thất bại`
                                                    : `${failedCount} transcription part(s) failed`)}
                                        </div>
                                        <div className="retry-chunks-banner-sub">
                                            {inProgress
                                                ? (retryProgress?.message || (lang === 'vi' ? 'Đang xử lý...' : 'Processing...'))
                                                : (lang === 'vi'
                                                    ? 'Transcript hiện chỉ có các phần đã transcribe xong. Nhấn "Thử lại" để retry các phần còn lỗi.'
                                                    : 'Transcript shows only successful parts. Click "Retry" to re-attempt the failed parts.')}
                                        </div>
                                        {inProgress && retryProgress && (
                                            <div className="retry-chunks-progress-bar">
                                                <div
                                                    className="retry-chunks-progress-fill"
                                                    style={{ width: `${Math.max(0, Math.min(100, retryProgress.progress * 100))}%` }}
                                                />
                                            </div>
                                        )}
                                    </div>
                                    {!inProgress && (
                                        <button
                                            className="retry-chunks-banner-btn"
                                            onClick={() => void handleRetryFailedChunks()}
                                        >
                                            {lang === 'vi' ? 'Thử lại' : 'Retry'}
                                        </button>
                                    )}
                                </div>
                            );
                        })()}
                        {/* Sentinel shown at top of list when older parts
                            are hidden. Pure status indicator — no click
                            handler. Scrolling within SCROLL_LOAD_THRESHOLD
                            px of this sentinel auto-loads the next page. */}
                        {hasOlderParts && (
                            <div className="transcript-load-sentinel" aria-live="polite">
                                <span className="transcript-load-sentinel-spinner" aria-hidden />
                                <span>
                                    {lang === 'vi'
                                        ? `Đang ẩn ${visibleStartIdx} đoạn cũ hơn — cuộn lên để tải thêm`
                                        : `${visibleStartIdx} older part(s) hidden — scroll up to load more`}
                                </span>
                            </div>
                        )}
                        {visibleParts.map((part, visibleIdx) => {
                            // Absolute index in the full transcriptParts array — used
                            // for callbacks that mutate the full store (edit / delete /
                            // speaker rename). `visibleIdx` alone would mis-target items
                            // whenever `hasOlderParts` is true.
                            const absoluteIdx = visibleStartIdx + visibleIdx;
                            const speakerColor = SPEAKER_COLORS[part.speakerId % SPEAKER_COLORS.length];
                            const isLive = absoluteIdx === transcriptParts.length - 1 && recording;
                            // data-chunk-id powers the sliding-window scroll
                            // anchor — captureScrollAnchor / restoreScrollAnchor
                            // walk children by this attribute to keep the
                            // user pinned at the same visible part during
                            // window slides.
                            const itemKey = part.chunkId || `t-${absoluteIdx}`;
                            return (
                                <div
                                    className={`transcript-item ${isLive ? 'live' : ''}`}
                                    key={itemKey}
                                    data-chunk-id={itemKey}
                                >
                                    <div className="transcript-actions">
                                        <button
                                            className="transcript-action-btn"
                                            onClick={() => startEditSpeaker(part.speakerId, absoluteIdx)}
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
                                            onClick={() => deleteTranscriptAt(absoluteIdx)}
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
                                        {editingSpeakerId === part.speakerId && editingSpeakerAnchorIdx === absoluteIdx ? (
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
                                                j === absoluteIdx ? { ...p, text: newText, translation: '' } : p
                                            );
                                            void applyTranscriptUpdate(next);
                                        }}
                                    />
                                </div>
                            );
                        })}
                        {/* Bottom sentinel — surfaces when the sliding window
                            has trimmed newer parts off the bottom (user scrolled
                            up past MAX_WINDOW_SIZE then back). Cuộn xuống tự
                            động slide window forward. */}
                        {hasNewerParts && (
                            <div className="transcript-load-sentinel" aria-live="polite">
                                <span className="transcript-load-sentinel-spinner" aria-hidden />
                                <span>
                                    {lang === 'vi'
                                        ? `Đang ẩn ${transcriptParts.length - visibleEndIdx} đoạn mới hơn — cuộn xuống để tải`
                                        : `${transcriptParts.length - visibleEndIdx} newer part(s) hidden — scroll down to load`}
                                </span>
                            </div>
                        )}
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
