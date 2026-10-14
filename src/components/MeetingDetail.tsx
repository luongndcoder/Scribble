import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { TranscriptPart, Meeting, partKey, useAppStore } from '../stores/appStore';
import { getMeeting, getMeetings, updateMeeting, downloadMeetingAudio, downloadMeetingMinutes, downloadTextFile, retryFailedChunks, meetingAudioStreamUrl } from '../lib/api';
import AudioPlayer, { type AudioPlayerHandle } from './AudioPlayer';
import { subscribeJobEvents } from '../lib/upload-audio';
import { showConfirm } from './ConfirmDialog';
import { useToast } from './Toast';
import { MeetingAttachments } from './MeetingAttachments';
import { NetworkOfflineBanner } from './NetworkOfflineBanner';
import { splitTextIntoSentences, splitTranslationForSentences } from '../lib/transcriptUtils';
import { IconArrowDown, IconChevronLeft, IconClose, IconCopy, IconDownload, IconEdit, IconMic, IconMinutes, IconPage, IconPlay, IconSearch, IconSpeaker, IconTranslate, IconTrash, IconWarning } from './icons/scribble-icons';

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

/**
 * Live interim preview row. Subscribes ONLY to interim fields via selectors,
 * so every streaming WS message re-renders just this row — the committed
 * transcript list above never re-renders for interim updates.
 */
function InterimRow() {
    const recording = useAppStore((s) => s.recording);
    const lastSpeakerId = useAppStore((s) =>
        s.transcriptParts.length ? s.transcriptParts[s.transcriptParts.length - 1].speakerId : null);
    const interimText = useAppStore((s) => s.interimText);
    const interimSpeaker = useAppStore((s) => s.interimSpeaker);
    const interimSpeakerId = useAppStore((s) => s.interimSpeakerId);
    const interimTranslation = useAppStore((s) => s.interimTranslation);
    const translationEnabled = useAppStore((s) => s.translationEnabled);
    const seconds = useAppStore((s) => s.seconds);

    if (!recording || !interimText.trim()) return null;
    // Same speaker as the live paragraph → shown inline at its end
    // (LiveInterimTail), so committing the final doesn't move the text.
    if (lastSpeakerId === interimSpeakerId) return null;
    const speakerColor = SPEAKER_COLORS[interimSpeakerId % SPEAKER_COLORS.length];
    const mm = Math.floor(seconds / 60);
    const ss = Math.floor(seconds % 60).toString().padStart(2, '0');

    return (
        <div className="transcript-item interim" aria-live="polite">
            <div className="transcript-time">
                <span className="speaker-badge" style={{ '--speaker-color': speakerColor } as React.CSSProperties}>
                    {interimSpeaker}
                </span>
                <span className="transcript-interim-hint">{mm}:{ss}</span>
            </div>
            <div className="transcript-stack">
                <div className="transcript-text transcript-interim-text">{interimText}</div>
                {translationEnabled && interimTranslation ? (
                    <div className="translation-text">{interimTranslation}</div>
                ) : null}
            </div>
        </div>
    );
}

/**
 * Interim words of the live paragraph's speaker, rendered dimmed right after
 * its committed text. Subscribes narrowly so streaming updates re-render only
 * this span — the paragraph itself re-renders only when a final lands, and the
 * words stay exactly where they were (no row appearing/disappearing).
 */
function LiveInterimTail({ speakerId }: { speakerId: number }) {
    const recording = useAppStore((s) => s.recording);
    const interimText = useAppStore((s) => s.interimText);
    const interimSpeakerId = useAppStore((s) => s.interimSpeakerId);
    const text = interimText.trim();
    if (!recording || !text || interimSpeakerId !== speakerId) return null;
    return <span className="transcript-interim-inline">{' '}{text}</span>;
}

/** Live paragraph text: settled words, tentative tail (Soniox non-final
 *  tokens), then the interim preview. */
function LiveText({ text, tentativeLen, speakerId }: { text: string; tentativeLen: number; speakerId: number }) {
    const cut = Math.max(0, text.length - tentativeLen);
    return (
        <>
            {text.slice(0, cut)}
            {cut < text.length && <span className="transcript-tentative">{text.slice(cut)}</span>}
            <LiveInterimTail speakerId={speakerId} />
        </>
    );
}

export function MeetingDetail() {
    const {
        recording, paused, transcriptParts,
        setCurrentView, lang, activeTab, setActiveTab,
        currentMeetingId, draftId, setTranscriptParts,
        meetings, transientSummary,
        summaryLoading, translationEnabled, setTranslationEnabled,
        aiConfigured, setSettingsOpen, liveStatus,
    } = useAppStore();
    // Boolean selector: re-renders only when interim appears/disappears, not
    // on every streamed word.
    const hasInterim = useAppStore((s) => s.recording && s.interimText.trim().length > 0);

    // Live translation: read via subscription + DOM ref (avoids re-render of entire list)
    const liveTranslationRef = useRef<HTMLElement>(null);
    useEffect(() => {
        // Subscribe to interimTranslation changes and update DOM directly
        const unsub = useAppStore.subscribe((state, prev) => {
            if (state.interimTranslation !== prev.interimTranslation && liveTranslationRef.current) {
                liveTranslationRef.current.textContent = state.interimTranslation ? `↪ ${state.interimTranslation}` : '';
            }
        });
        return unsub;
    }, []);

    const { showToast } = useToast();
    const viewingMeetingId = currentMeetingId || draftId;

    const transcriptRef = useRef<HTMLDivElement>(null);
    const searchInputRef = useRef<HTMLInputElement>(null);

    // ── Playback ↔ transcript sync ───────────────────────────────────────
    // As the saved audio plays, follow the transcript to the segment being
    // spoken (auto-scroll) and let the user click a segment's timestamp to
    // jump the audio there. `activeChunkId` is the itemKey of the part that
    // contains the current playhead — we ONLY setState when it changes (not
    // on every timeupdate ~4×/s) so the big transcript list doesn't re-render
    // continuously. `autoFollow` pauses when the user scrolls by hand.
    const audioPlayerRef = useRef<AudioPlayerHandle>(null);
    const [activeChunkId, setActiveChunkId] = useState<string | null>(null);
    const activeChunkIdRef = useRef<string | null>(null);
    const [autoFollow, setAutoFollow] = useState(true);
    const autoFollowRef = useRef(true);
    const programmaticScrollRef = useRef(false);
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
    const [topAnchorChunkId, setTopAnchorChunkId] = useState<string | null>(null);
    const [bottomAnchorChunkId, setBottomAnchorChunkId] = useState<string | null>(null);
    const [transcriptSearch, setTranscriptSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);

    // Reset both anchors when switching meetings — different meeting means
    // different transcriptParts identity, window must restart. The load effect
    // then re-pins the window to page 1 once the new transcript arrives.
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

    // Transcript search (detail view). When a query is present we bypass the
    // sliding-window and render every matching part (matches are usually few),
    // so search covers the WHOLE transcript, not just the visible window.
    const transcriptQuery = debouncedSearch.trim().toLowerCase();
    const isTranscriptSearching = searchOpen && transcriptQuery.length > 0;
    const searchMatchedRows = useMemo(() => {
        if (!transcriptQuery) return [] as { part: TranscriptPart; absoluteIdx: number }[];
        const rows: { part: TranscriptPart; absoluteIdx: number }[] = [];
        transcriptParts.forEach((part, i) => {
            const hay = `${part.text || ''}\n${part.translation || ''}\n${part.speaker || ''}`.toLowerCase();
            if (hay.includes(transcriptQuery)) rows.push({ part, absoluteIdx: i });
        });
        return rows;
    }, [transcriptParts, transcriptQuery]);

    const transcriptRows = isTranscriptSearching
        ? searchMatchedRows
        : visibleParts.map((part, visibleIdx) => ({ part, absoluteIdx: visibleStartIdx + visibleIdx }));

    // ── Playback ↔ transcript sync helpers ──────────────────────────────
    // Stable itemKey identical to the one used in the render map below, so
    // `activeChunkId` matches the DOM `data-chunk-id` for scroll targeting.
    // Priority: immutable part.id → first chunkId (never rewritten on append)
    // → index fallback (shifts on delete; last resort only).
    const itemKeyFor = useCallback(
        (part: TranscriptPart, absoluteIdx: number) => partKey(part, absoluteIdx),
        [],
    );

    // Map the current audio position (seconds) → itemKey of the part being
    // spoken. Prefer a part whose [start, end) brackets `t`; otherwise the
    // last part that has already started (covers gaps between segments).
    const chunkIdAtTime = useCallback(
        (t: number): string | null => {
            let candidate: string | null = null;
            for (let i = 0; i < transcriptParts.length; i++) {
                const p = transcriptParts[i];
                const start = toTimeNumber(p.startTime);
                const end = toTimeNumber(p.endTime);
                if (t >= start) {
                    candidate = itemKeyFor(p, i);
                    if (end > start && t < end) break;
                } else {
                    break; // parts are chronological — no later part can match
                }
            }
            return candidate;
        },
        [transcriptParts, itemKeyFor],
    );

    // Fired ~4×/s by AudioPlayer. Only commit to state when the active part
    // actually changes → avoids re-rendering the whole transcript list on
    // every tick.
    const handlePlaybackTime = useCallback(
        (sec: number) => {
            const id = chunkIdAtTime(sec);
            if (id !== activeChunkIdRef.current) {
                activeChunkIdRef.current = id;
                setActiveChunkId(id);
            }
        },
        [chunkIdAtTime],
    );

    // True when a saved audio file is available to seek (playback mode).
    const canSeekPlayback = !recording && !!meetingData?.audio_path;

    // Click a segment's timestamp → jump audio there + re-arm auto-follow.
    const seekToPart = useCallback((part: TranscriptPart) => {
        const start = toTimeNumber(part.startTime);
        autoFollowRef.current = true;
        setAutoFollow(true);
        audioPlayerRef.current?.seek(start);
    }, []);

    // Auto-scroll the active segment into view when it changes (unless the
    // user scrolled away by hand). Skipped during transcript search (rows
    // there are the match set, not the playback window).
    useEffect(() => {
        if (!autoFollow || !activeChunkId || isTranscriptSearching) return;
        const container = transcriptRef.current;
        if (!container) return;
        const el = container.querySelector<HTMLElement>(
            `[data-chunk-id="${CSS.escape(activeChunkId)}"]`,
        );
        if (!el) return; // active part outside the sliding window — skip
        programmaticScrollRef.current = true;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const timer = setTimeout(() => { programmaticScrollRef.current = false; }, 700);
        return () => clearTimeout(timer);
    }, [activeChunkId, autoFollow, isTranscriptSearching]);

    // Detect a hand scroll (vs our own programmatic scrollIntoView) and pause
    // auto-follow so playback doesn't yank the user back.
    useEffect(() => {
        const container = transcriptRef.current;
        if (!container) return;
        const onScroll = () => {
            if (programmaticScrollRef.current) return;
            if (autoFollowRef.current) {
                autoFollowRef.current = false;
                setAutoFollow(false);
            }
        };
        container.addEventListener('scroll', onScroll, { passive: true });
        return () => container.removeEventListener('scroll', onScroll);
        // Re-attach when the transcript container (re)mounts — e.g. parts load
        // after the initial render, or the user switches meetings.
    }, [viewingMeetingId, transcriptParts.length, canSeekPlayback]);

    // Reset sync state when switching meetings.
    useEffect(() => {
        activeChunkIdRef.current = null;
        setActiveChunkId(null);
        autoFollowRef.current = true;
        setAutoFollow(true);
    }, [viewingMeetingId]);

    // Re-arm auto-follow + jump to the active part (used by the floating pill).
    const resumeFollow = useCallback(() => {
        autoFollowRef.current = true;
        setAutoFollow(true);
        const container = transcriptRef.current;
        const id = activeChunkIdRef.current;
        if (container && id) {
            const el = container.querySelector<HTMLElement>(
                `[data-chunk-id="${CSS.escape(id)}"]`,
            );
            if (el) {
                programmaticScrollRef.current = true;
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => { programmaticScrollRef.current = false; }, 700);
            }
        }
    }, []);

    // Debounce search input so filtering doesn't re-run on every keystroke.
    useEffect(() => {
        const t = setTimeout(() => setDebouncedSearch(transcriptSearch), 200);
        return () => clearTimeout(t);
    }, [transcriptSearch]);

    const toggleTranscriptSearch = () => {
        setSearchOpen((open) => {
            const next = !open;
            if (!next) setTranscriptSearch('');
            else requestAnimationFrame(() => searchInputRef.current?.focus());
            return next;
        });
    };
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

    // v1.2.14: load-more via IntersectionObserver (Facebook-feed pattern).
    // Replaces the scrollTop-threshold heuristic which kept firing as the user
    // sat near the edge — observer fires ONLY on visibility transitions, plus
    // a 600ms cooldown safety net so a window re-render that keeps the
    // sentinel partially visible can't burst into a load loop.
    const loadingMoreRef = useRef(false);
    const topSentinelRef = useRef<HTMLDivElement>(null);
    const bottomSentinelRef = useRef<HTMLDivElement>(null);

    const loadOlder = useCallback(() => {
        if (loadingMoreRef.current) return;
        const el = transcriptRef.current;
        if (!el || !hasOlderParts) return;
        loadingMoreRef.current = true;

        const anchor = captureScrollAnchor(el);
        const total = transcriptParts.length;
        // Slide window backward by one page; cap size at MAX_WINDOW_SIZE.
        // Keep tail open when newEnd === total so live appends still flow.
        const newStart = Math.max(0, visibleStartIdx - TRANSCRIPT_PAGE_SIZE);
        const newEnd = Math.min(total, newStart + MAX_WINDOW_SIZE);
        setTopAnchorChunkId(newStart > 0 ? (transcriptParts[newStart]?.chunkId || null) : null);
        setBottomAnchorChunkId(
            newEnd < total ? (transcriptParts[newEnd - 1]?.chunkId || null) : null,
        );

        requestAnimationFrame(() => {
            const elNow = transcriptRef.current;
            if (elNow) restoreScrollAnchor(elNow, anchor);
            // Cooldown — prevents instant re-trigger if the sentinel happens
            // to remain partially visible after the slide. User must scroll
            // away + back to load the next page.
            setTimeout(() => { loadingMoreRef.current = false; }, 600);
        });
    }, [hasOlderParts, visibleStartIdx, transcriptParts]);

    const loadNewer = useCallback(() => {
        if (loadingMoreRef.current) return;
        const el = transcriptRef.current;
        if (!el || !hasNewerParts) return;
        loadingMoreRef.current = true;

        const anchor = captureScrollAnchor(el);
        const total = transcriptParts.length;
        // Slide window forward by one page. When new window reaches the array
        // tail, UNSET BOTH anchors to drop back into default tail-follow mode.
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

        requestAnimationFrame(() => {
            const elNow = transcriptRef.current;
            if (elNow) restoreScrollAnchor(elNow, anchor);
            setTimeout(() => { loadingMoreRef.current = false; }, 600);
        });
    }, [hasNewerParts, visibleEndIdx, transcriptParts]);

    // Attach IntersectionObserver to whichever sentinels are mounted. The
    // observer fires only on viewport-entry transitions (isIntersecting
    // true → only when the user scrolls so the sentinel comes INTO view from
    // OFF-screen). After load, scroll restoration keeps user at the same
    // chunk → sentinel slides OUT of viewport → observer state resets, ready
    // for the next user-initiated scroll to top/bottom.
    useEffect(() => {
        const container = transcriptRef.current;
        if (!container) return;

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    if (entry.target === topSentinelRef.current) {
                        loadOlder();
                    } else if (entry.target === bottomSentinelRef.current) {
                        loadNewer();
                    }
                }
            },
            {
                root: container,
                // 10% visibility = clear "user actually scrolled to see it".
                // Lower would fire on momentum bounces; higher would require
                // dragging fully on-screen which feels sluggish.
                threshold: 0.1,
            },
        );

        if (topSentinelRef.current) observer.observe(topSentinelRef.current);
        if (bottomSentinelRef.current) observer.observe(bottomSentinelRef.current);
        return () => observer.disconnect();
    }, [loadOlder, loadNewer, hasOlderParts, hasNewerParts]);

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

                // No minutes yet → land the user on the Recording tab instead of
                // an empty "Biên bản" pane. Tied to load so it only fires when a
                // meeting is opened (not during summarize, which sets the summary
                // tab itself and streams content in).
                const hasSavedSummary = typeof m.summary === 'string' && m.summary.trim().length > 0;
                if (!hasSavedSummary) {
                    setActiveTab('recording');
                }

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
                // Older saved transcripts may lack chunkId on every part. The
                // transcript windowing anchors on chunkId, so a missing chunkId
                // makes the page-1 init fail → window falls back to the tail,
                // hiding the meeting's opening behind a perpetual "loading older
                // parts" spinner. Synthesize a stable unique chunkId by index
                // for any part missing one.
                normalized.parts.forEach((part, i) => {
                    if (!part.chunkId) part.chunkId = `idx-${i}`;
                });
                setTranscriptParts(normalized.parts);

                // Open a freshly-opened SAVED transcript at page 1 (the
                // beginning), not mid-stream. We do this HERE — tied to the
                // load — instead of in a reactive effect, because an effect
                // watching transcriptParts fires on STALE store data when the
                // detail view mounts (the previous meeting's parts are still in
                // the store until this load replaces them), which made the
                // positioning flaky (sometimes mid-transcript, sometimes page
                // 1). React batches these state updates with setTranscriptParts
                // above, so the window renders straight at [0, PAGE_SIZE] with
                // no intermediate tail flash.
                // Skip when resuming the SAME meeting (e.g. recording just
                // stopped) so we don't yank the user away from where they were.
                if (!isSameMeeting && !recording) {
                    setTopAnchorChunkId(null);
                    setBottomAnchorChunkId(
                        normalized.parts.length > TRANSCRIPT_PAGE_SIZE
                            ? (normalized.parts[TRANSCRIPT_PAGE_SIZE - 1]?.chunkId ?? null)
                            : null,
                    );
                    requestAnimationFrame(() => {
                        const el = transcriptRef.current;
                        if (el) el.scrollTop = 0;
                    });
                }

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

    // (Page-1 positioning for a freshly-opened saved transcript is handled in
    // the load effect above — tied to the load event so it anchors on the
    // just-loaded parts, not stale store data from the previous meeting.)

    // Auto-scroll: only when the user is near the bottom AND tail is open
    // (so we don't yank them away while they're reading mid-transcript via
    // the sliding window). 80px tolerance = roughly one transcript row.
    // Fires ONLY when content actually grows (new part or longer last text) —
    // never on interim toggles or translation-token updates, which used to
    // restart the smooth scroll dozens of times per second (visible stutter).
    const lastScrollSigRef = useRef('');
    // Live follow: "stuck to bottom" is decided by where the USER left the
    // scroll (onScroll below), not by measuring after content grew — a new
    // multi-line paragraph alone exceeded the old 80px threshold and silently
    // stopped auto-follow mid-meeting.
    const stickToBottomRef = useRef(true);
    const isTailOpenRef = useRef(isTailOpen);
    isTailOpenRef.current = isTailOpen;
    const [showJumpLive, setShowJumpLive] = useState(false);
    useEffect(() => {
        const el = transcriptRef.current;
        if (!el) return;
        if (!isTailOpen) return; // user scrolled up — don't fight them
        const last = transcriptParts[transcriptParts.length - 1];
        const sig = `${transcriptParts.length}:${last ? last.text.length : 0}`;
        if (sig === lastScrollSigRef.current) return;
        lastScrollSigRef.current = sig;
        if (recording) {
            // Instant: smooth scrolls restarted on every final and stuttered.
            if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
            return;
        }
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom < 80) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
    }, [transcriptParts, isTailOpen, recording]);
    // Interim words grow the live paragraph without touching transcriptParts;
    // follow them via a store subscription (no MeetingDetail re-render).
    useEffect(() => useAppStore.subscribe((state, prev) => {
        if (!state.recording || state.interimText === prev.interimText) return;
        const el = transcriptRef.current;
        if (el && isTailOpenRef.current && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    }), []);
    useEffect(() => {
        if (recording) {
            stickToBottomRef.current = true;
        } else {
            setShowJumpLive(false);
        }
    }, [recording]);
    const handleTranscriptScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
        stickToBottomRef.current = distance < 48;
        setShowJumpLive(recording && (distance > 240 || !isTailOpenRef.current));
    };
    const jumpToLive = () => {
        // Re-open the sliding window at the tail, then pin to the bottom.
        setTopAnchorChunkId(null);
        setBottomAnchorChunkId(null);
        stickToBottomRef.current = true;
        setShowJumpLive(false);
        requestAnimationFrame(() => {
            const el = transcriptRef.current;
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        });
    };


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

    const subTabsRef = useRef<HTMLElement>(null);
    const [subTabPill, setSubTabPill] = useState<{ left: number; width: number } | null>(null);
    useEffect(() => {
        const nav = subTabsRef.current;
        if (!nav) return;
        const activeBtn = nav.querySelector<HTMLElement>('.sub-tab.active');
        if (activeBtn) {
            setSubTabPill({ left: activeBtn.offsetLeft, width: activeBtn.offsetWidth });
        }
    }, [activeTab, lang]);

    return (
        <section className="view active detail-view t-page-enter-right">
            {/* Compact toolbar: back button + tab switcher on ONE row.
                Earlier these lived on two separate rows (~90px combined). */}
            <div className="detail-toolbar">
                <button
                    className={`back-btn back-btn-compact ${recording ? 'is-locked' : ''}`}
                    title={recording ? (lang === 'vi' ? 'Đang ghi âm — bấm Dừng trước khi quay lại' : 'Recording — stop before going back') : undefined}
                    onClick={() => {
                        // v1.2.14 fix: block back navigation while recording.
                        // Leaving the detail view tears down RecordingBar →
                        // WebSocket disconnects → realtime transcript breaks.
                        // User must explicitly stop recording first.
                        if (recording) {
                            showToast(
                                lang === 'vi'
                                    ? 'Đang ghi âm — vui lòng bấm Dừng trước khi quay lại danh sách'
                                    : 'Recording in progress — please stop recording before going back',
                                'warning',
                            );
                            return;
                        }
                        setCurrentView('list');
                    }}
                >
                    <IconChevronLeft size={14} strokeWidth={2.25} />
                    <span>{lang === 'vi' ? 'Cuộc họp' : 'Meetings'}</span>
                </button>

                <nav ref={subTabsRef} className={`sub-tabs sub-tabs-compact${subTabPill ? ' has-pill' : ''}`}>
                    {subTabPill && (
                        <span
                            className="sub-tabs-pill"
                            aria-hidden="true"
                            style={{
                                transform: `translateX(${subTabPill.left}px)`,
                                width: `${subTabPill.width}px`,
                            }}
                        />
                    )}
                    <button className={`sub-tab ${activeTab === 'recording' ? 'active' : ''}`} onClick={() => setActiveTab('recording')}>
                        <IconMic size={13} />
                        <span>{lang === 'vi' ? 'Ghi âm' : 'Recording'}</span>
                    </button>
                    {/* Minutes tab locks when AI isn't configured — UNLESS this
                        meeting already has a summary (so old, already-summarized
                        meetings stay viewable). Locked → guide to Settings
                        instead of switching to an empty/unusable pane. */}
                    <button
                        className={`sub-tab ${activeTab === 'summary' ? 'active' : ''} ${(!aiConfigured && !hasMinutes) ? 'locked' : ''}`}
                        onClick={() => {
                            if (!aiConfigured && !hasMinutes) {
                                showToast(
                                    lang === 'vi'
                                        ? 'Chưa cấu hình Trợ lý AI. Đang mở Cài đặt để bật tính năng biên bản.'
                                        : 'AI Assistant not set up. Opening Settings to enable minutes.',
                                    'info',
                                );
                                setSettingsOpen(true);
                                return;
                            }
                            setActiveTab('summary');
                        }}
                        title={(!aiConfigured && !hasMinutes)
                            ? (lang === 'vi'
                                ? 'Cấu hình Trợ lý AI trong Cài đặt để dùng tính năng biên bản'
                                : 'Configure the AI Assistant in Settings to use minutes')
                            : undefined}
                        aria-disabled={(!aiConfigured && !hasMinutes) ? true : undefined}
                    >
                        <IconMinutes size={13} />
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
            <div className={`detail-pane recording-pane${activeTab === 'recording' ? ' t-pane-enter' : ''}`} style={{ display: activeTab === 'recording' ? 'flex' : 'none' }}>
                <div className="pane-header">
                    <div className="pane-title-row">
                        <h2 className="pane-title">{lang === 'vi' ? 'Bản ghi' : 'Transcript'}</h2>
                    </div>
                    <div className="pane-actions">
                        {/* Cabin-translation toggle, co-located with the
                            transcript it affects (mirrors the bottom-bar
                            toggle — same store state). */}
                        <button
                            className={`action-btn ${translationEnabled ? 'active' : ''}`}
                            onClick={() => setTranslationEnabled(!translationEnabled)}
                            title={lang === 'vi' ? 'Hiện bản dịch song ngữ' : 'Show bilingual translation'}
                            aria-label={lang === 'vi' ? 'Hiện bản dịch song ngữ' : 'Show bilingual translation'}
                            aria-pressed={translationEnabled}
                        >
                            <IconTranslate size={14} />
                            <span>{translationEnabled ? (lang === 'vi' ? 'Dịch: Bật' : 'Translate: On') : (lang === 'vi' ? 'Dịch: Tắt' : 'Translate: Off')}</span>
                        </button>
                        {transcriptParts.length > 0 && (
                            <button className={`action-btn icon-only ${searchOpen ? 'active' : ''}`} onClick={toggleTranscriptSearch} title={lang === 'vi' ? 'Tìm trong transcript' : 'Search transcript'} aria-label={lang === 'vi' ? 'Tìm trong transcript' : 'Search transcript'}>
                                <IconSearch size={14} />
                            </button>
                        )}
                        {transcriptParts.length > 0 && (
                            <button className="action-btn icon-only" onClick={copyTranscript} title={lang === 'vi' ? 'Copy transcript' : 'Copy transcript'}>
                                <IconCopy size={14} />
                            </button>
                        )}
                        {transcriptParts.length > 0 && (
                            <button className="action-btn" onClick={exportTranscript}>
                                <IconDownload size={14} />
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

                {(currentMeetingId || draftId) && !recording && meetingData?.audio_path ? (
                    <AudioPlayer
                        ref={audioPlayerRef}
                        src={meetingAudioStreamUrl((currentMeetingId || draftId) as number)}
                        onTime={handlePlaybackTime}
                    />
                ) : null}

                {canSeekPlayback && !autoFollow && activeChunkId && (
                    <button type="button" className="transcript-follow-pill" onClick={resumeFollow}>
                        <IconArrowDown size={13} />
                        <span>{lang === 'vi' ? 'Cuộn theo audio' : 'Follow audio'}</span>
                    </button>
                )}

                {transcriptParts.length === 0 && !recording ? (
                    <div className="welcome-state">
                        <div className="welcome-icon">
                            <IconMic size={28} strokeWidth={1.35} />
                        </div>
                        <div className="welcome-title">{lang === 'vi' ? 'Chào mừng đến Scribble!' : 'Welcome to Scribble!'}</div>
                        <div className="welcome-sub">{lang === 'vi' ? 'Nhấn nút Record để bắt đầu phiên dịch trực tiếp' : 'Press Record to start live transcription'}</div>
                    </div>
                ) : transcriptParts.length === 0 && recording && !hasInterim ? (
                    <div className="listening-state">
                        <div className="listening-icon">
                            <IconMic size={24} style={{ color: '#ef4444' }} />
                        </div>
                        {/* Two distinct states. "Connecting" covers the
                            ~0.5-1.5s where the mic is opening and the model
                            is being wired up — during which the old copy said
                            "Listening for speech", so a user who pressed
                            record and saw no text assumed it had broken.
                            Showing a start-up state makes the wait legible. */}
                        <div className="listening-title">
                            {(() => {
                                const titleText = paused
                                    ? (lang === 'vi' ? 'Tạm dừng ghi âm' : 'Recording paused')
                                    : liveStatus === 'connecting'
                                        ? (lang === 'vi' ? 'Đang kết nối mic...' : 'Connecting microphone...')
                                        : (lang === 'vi' ? 'Đang lắng nghe...' : 'Listening for speech...');
                                return !paused ? (
                                    <span className="t-shimmer" data-text={titleText}>{titleText}</span>
                                ) : titleText;
                            })()}
                        </div>
                        <div className="listening-sub">
                            {paused
                                ? (lang === 'vi' ? 'Nhấn tiếp tục để ghi âm' : 'Click resume to continue')
                                : liveStatus === 'connecting'
                                    ? (lang === 'vi' ? 'Chuẩn bị xong sẽ hiện chữ ngay khi bạn nói' : 'Text appears as soon as you speak')
                                    : (lang === 'vi' ? 'Hãy nói để xem phiên dịch trực tiếp' : 'Speak to see live transcription')}
                        </div>
                    </div>
                ) : (
                    <div
                        className={`transcript-list ${translationEnabled ? 'with-translation' : ''}`}
                        ref={transcriptRef}
                        onScroll={handleTranscriptScroll}
                    >
                        {searchOpen && (
                            <div className="transcript-search">
                                <IconSearch size={15} className="transcript-search-icon" />
                                <input
                                    ref={searchInputRef}
                                    className="transcript-search-input"
                                    placeholder={lang === 'vi' ? 'Tìm trong transcript...' : 'Search transcript...'}
                                    value={transcriptSearch}
                                    onChange={(e) => setTranscriptSearch(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); toggleTranscriptSearch(); } }}
                                />
                                {isTranscriptSearching && (
                                    <span className="transcript-search-count">
                                        {searchMatchedRows.length} {lang === 'vi' ? 'kết quả' : 'results'}
                                    </span>
                                )}
                                <button className="transcript-search-clear" onClick={toggleTranscriptSearch} aria-label={lang === 'vi' ? 'Đóng tìm kiếm' : 'Close search'}>
                                    <IconClose size={14} />
                                </button>
                            </div>
                        )}
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
                                            <IconWarning size={20} />
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
                        {/* Top sentinel — fires IntersectionObserver when it
                            scrolls into view (10% visible), triggering loadOlder.
                            Only one load per user-initiated scroll into the
                            sentinel — observer fires on transition only, plus
                            600ms cooldown safety net. */}
                        {!isTranscriptSearching && hasOlderParts && (
                            <div
                                ref={topSentinelRef}
                                className="transcript-load-sentinel"
                                aria-live="polite"
                            >
                                <span className="transcript-load-sentinel-spinner" aria-hidden />
                                <span>
                                    {lang === 'vi'
                                        ? `Đang ẩn ${visibleStartIdx} đoạn cũ hơn — cuộn đến đây để tải thêm`
                                        : `${visibleStartIdx} older part(s) hidden — scroll here to load more`}
                                </span>
                            </div>
                        )}
                        {transcriptRows.map(({ part, absoluteIdx }) => {
                            // absoluteIdx = index in the full transcriptParts array —
                            // used by edit / delete / speaker-rename callbacks. In
                            // search mode rows come from searchMatchedRows (whole
                            // transcript); otherwise from the sliding window.
                            const speakerColor = SPEAKER_COLORS[part.speakerId % SPEAKER_COLORS.length];
                            const isLive = absoluteIdx === transcriptParts.length - 1 && recording;
                            // data-chunk-id powers the sliding-window scroll
                            // anchor — captureScrollAnchor / restoreScrollAnchor
                            // walk children by this attribute to keep the
                            // user pinned at the same visible part during
                            // window slides.
                            const itemKey = itemKeyFor(part, absoluteIdx);
                            return (
                                <div
                                    className={`transcript-item ${isLive ? 'live' : ''} ${itemKey === activeChunkId ? 'playing' : ''}`}
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
                                            <IconSpeaker size={13} />
                                        </button>
                                        <button
                                            className="transcript-action-btn t-delete-btn"
                                            onClick={() => deleteTranscriptAt(absoluteIdx)}
                                            title={lang === 'vi' ? 'Xóa đoạn này' : 'Delete this item'}
                                            aria-label={lang === 'vi' ? 'Xóa đoạn này' : 'Delete this item'}
                                        >
                                            <IconTrash size={13} />
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
                                        {canSeekPlayback ? (
                                            <button
                                                type="button"
                                                className="transcript-seek-btn"
                                                style={{ marginLeft: 8 }}
                                                onClick={() => seekToPart(part)}
                                                title={lang === 'vi' ? 'Tua audio đến đoạn này' : 'Jump audio to this segment'}
                                            >
                                                <IconPlay size={11} />
                                                <span>{fmtSec(part.startTime)} – {fmtSec(part.endTime)}</span>
                                            </button>
                                        ) : (
                                            <span style={{ marginLeft: 8 }}>{fmtSec(part.startTime)} – {fmtSec(part.endTime)}</span>
                                        )}
                                    </div>
                                    <TranscriptSentences
                                        text={part.text}
                                        highlight={transcriptQuery}
                                        translation={part.translation}
                                        translationEnabled={translationEnabled}
                                        isLive={isLive}
                                        tentativeLen={part._tentativeLen || 0}
                                        speakerId={part.speakerId}
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
                        {/* Live interim preview — subscribed narrowly so each
                            WS message re-renders ONLY this row, never the
                            whole transcript list. Hidden when empty. */}
                        <InterimRow />
                        {showJumpLive && (
                            <button type="button" className="jump-live-btn" onClick={jumpToLive}>
                                <IconArrowDown size={13} strokeWidth={1.98} />
                                <span>{lang === 'vi' ? 'Về đoạn mới nhất' : 'Jump to latest'}</span>
                            </button>
                        )}
                        {/* Bottom sentinel — IntersectionObserver triggers
                            loadNewer when it reaches viewport. Same one-shot
                            transition + 600ms cooldown semantics as top. */}
                        {isTranscriptSearching && searchMatchedRows.length === 0 && (
                            <div className="transcript-search-empty">
                                {lang === 'vi' ? 'Không tìm thấy đoạn nào khớp' : 'No matching parts found'}
                            </div>
                        )}
                        {!isTranscriptSearching && hasNewerParts && (
                            <div
                                ref={bottomSentinelRef}
                                className="transcript-load-sentinel"
                                aria-live="polite"
                            >
                                <span className="transcript-load-sentinel-spinner" aria-hidden />
                                <span>
                                    {lang === 'vi'
                                        ? `Đang ẩn ${transcriptParts.length - visibleEndIdx} đoạn mới hơn — cuộn đến đây để tải`
                                        : `${transcriptParts.length - visibleEndIdx} newer part(s) hidden — scroll here to load`}
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
            <div className={`detail-pane summary-pane${activeTab === 'summary' ? ' t-pane-enter' : ''}`} style={{ display: activeTab === 'summary' ? 'flex' : 'none' }}>
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
                        <p>
                            <span
                                className="t-shimmer"
                                data-text={lang === 'vi' ? 'Đang tạo biên bản, vui lòng chờ...' : 'Generating minutes, please wait...'}
                            >
                                {lang === 'vi' ? 'Đang tạo biên bản, vui lòng chờ...' : 'Generating minutes, please wait...'}
                            </span>
                        </p>
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
                            <IconDownload size={18} />
                            <div>
                                <div className="export-option-name">Markdown (.md)</div>
                                <div className="export-option-desc">{lang === 'vi' ? 'Gọn nhẹ, dễ chỉnh sửa' : 'Portable and easy to edit'}</div>
                            </div>
                        </button>
                        <button className="export-option" onClick={() => downloadMinutes('docx')} disabled={!!exportingMinutesFormat}>
                            <IconPage size={18} />
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

// Wrap query matches in <mark> for transcript search highlighting (display mode only).
function highlightText(text: string, query: string): React.ReactNode {
    if (!query) return text;
    const q = query.toLowerCase();
    const lower = text.toLowerCase();
    const out: React.ReactNode[] = [];
    let i = 0;
    let k = 0;
    while (i < text.length) {
        const idx = lower.indexOf(q, i);
        if (idx < 0) { out.push(text.slice(i)); break; }
        if (idx > i) out.push(text.slice(i, idx));
        out.push(<mark className="transcript-hl" key={k++}>{text.slice(idx, idx + q.length)}</mark>);
        i = idx + q.length;
    }
    return out;
}

const TranscriptSentences = memo(function TranscriptSentences({
    text,
    translation,
    translationEnabled,
    isLive,
    tentativeLen = 0,
    speakerId = 0,
    liveTranslationRef,
    onSave,
    highlight
}: {
    text: string;
    translation?: string;
    translationEnabled?: boolean;
    isLive?: boolean;
    tentativeLen?: number;
    speakerId?: number;
    liveTranslationRef?: React.RefObject<HTMLElement | null>;
    onSave?: (newText: string) => void;
    highlight?: string;
}) {
    const lang = useAppStore((s) => s.lang);
    const [editMode, setEditMode] = useState(false);
    const [editVal, setEditVal] = useState('');

    // Sentence pairing for the bilingual view. While LIVE the text still
    // streams in, so any regrouping would make sentences jump — render the
    // raw text until the part settles, then split into stable sentences
    // with proportionally-mapped translations.
    const sentences = useMemo(
        () => (isLive ? [text] : splitTextIntoSentences(text)),
        [isLive, text],
    );
    const sentenceTranslations = useMemo(
        () => splitTranslationForSentences(sentences, translation || ''),
        [sentences, translation],
    );
    const showSentenceMode = !isLive && sentences.length > 1;
    // Translation column only earns its half of the row when there is
    // something to show — otherwise the text takes the full width instead
    // of staring at an empty gutter.
    const showTranslationCol = translationEnabled && (Boolean(translation) || isLive);

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

    const deleteLabel = lang === 'vi' ? 'Xoá đoạn này' : 'Delete part';
    const editLabel = lang === 'vi' ? 'Sửa đoạn này' : 'Edit part';
    // Deliberate entry only (double-click or the pencil button) — a single
    // click must keep working for text selection/copy.
    const enterEdit = () => {
        if (!onSave || editMode) return;
        setEditMode(true);
        setEditVal(text);
    };
    const editBtn = onSave ? (
        <button
            className="sentence-edit-btn"
            onClick={(e) => { e.stopPropagation(); enterEdit(); }}
            title={editLabel}
            aria-label={editLabel}
        >
            <IconEdit size={12} />
        </button>
    ) : null;
    const deleteBtn = onSave ? (
        <button
            className="sentence-delete-btn"
            onClick={(e) => { e.stopPropagation(); handleDelete(); }}
            title={deleteLabel}
            aria-label={deleteLabel}
        >
            <IconClose size={12} />
        </button>
    ) : null;

    return (
        <div className="transcript-sentences">
            <div className="sentence-group">
                <div className={showSentenceMode ? "sentence-pairs-mode" : "transcript-stack"}>
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
                        ) : showSentenceMode ? (
                            <div className="sentence-pairs">
                                <div className="sentence-row sentence-actions-row">
                                    {editBtn}
                                    {deleteBtn}
                                </div>
                                {sentences.map((sentence, si) => (
                                    <div key={si} className={`sentence-pair${si % 2 === 1 ? ' alt' : ''}`}>
                                        <div
                                            className="transcript-text"
                                            onDoubleClick={enterEdit}
                                            style={onSave ? { cursor: 'text', flex: 1 } : undefined}
                                            title={onSave ? (lang === 'vi' ? 'Nhấp đúp để sửa' : 'Double-click to edit') : undefined}
                                        >
                                            {highlight ? highlightText(sentence, highlight) : sentence}
                                        </div>
                                        {showTranslationCol && (
                                            <div className="translation-text">
                                                {sentenceTranslations[si] ?? ''}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="sentence-row">
                                <div
                                    className="transcript-text"
                                    onDoubleClick={enterEdit}
                                    style={onSave ? { cursor: 'text', flex: 1 } : undefined}
                                    title={onSave ? (lang === 'vi' ? 'Nhấp đúp để sửa' : 'Double-click to edit') : undefined}
                                >
                                    {isLive
                                        ? <LiveText text={text} tentativeLen={tentativeLen} speakerId={speakerId} />
                                        : highlight ? highlightText(text, highlight) : text}
                                </div>
                                {editBtn}
                                {deleteBtn}
                            </div>
                        )}
                    {showTranslationCol && !showSentenceMode && (
                        <div className="translation-text">
                            {translation || (isLive ? '' : '')}
                            {isLive && (
                                <span
                                    ref={(el) => {
                                        if (liveTranslationRef) liveTranslationRef.current = el;
                                        if (el) {
                                            const currentLive = useAppStore.getState().interimTranslation;
                                            el.textContent = currentLive || '';
                                        }
                                    }}
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
    prev.isLive === next.isLive &&
    prev.tentativeLen === next.tentativeLen &&
    prev.speakerId === next.speakerId
);
