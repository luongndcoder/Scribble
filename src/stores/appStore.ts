import { create } from 'zustand';

function safeGetItem(key: string, fallback: string = ''): string {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; } // private browsing
}

function safeSetItem(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch {} // private browsing or quota
}

export interface TranscriptPart {
    /** Stable identity for React keys — assigned once at creation, NEVER
     *  mutated by append/replace (chunkId used to be overwritten, which
     *  remounted the row on every chunk and made the text visibly jump). */
    id?: string;
    text: string;
    speaker: string;
    speakerId: number;
    chunkId?: string;
    chunkIds?: string[];
    startTime: string;
    endTime: string;
    timestamp: string;
    translation: string;
    _baseText?: string; // Text before current in-progress chunk (for replace-in-place)
    /** Length of the trailing slice of `text` that is still tentative (Soniox
     *  non-final tokens). Display-only: rendered dimmed while live. */
    _tentativeLen?: number;
}

/** Live STT pipeline phase — drives the empty-state copy, the timer and
 *  whether trailing finals are accepted after Stop. */
export type LiveStatus = 'idle' | 'connecting' | 'live' | 'stopping';

export type ThemeMode = 'light' | 'dark' | 'system';

/** Resolve the effective theme (system → OS preference). */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
        return 'dark';
    }
    return 'light';
}

/** Apply the effective theme to <html data-theme>. Call on boot + on change. */
export function applyTheme(mode: ThemeMode): void {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = resolveTheme(mode);
}
export interface Meeting {
    id: number;
    title: string;
    transcript: string;
    summary: string;
    audio_duration: number;
    created_at: string;
    status?: string;
    audio_path?: string;
    /** v1.2.13: number of Soniox chunks still in status='failed' for this
     *  meeting. When > 0, MeetingDetail shows a "Thử lại" banner. */
    failed_chunks_count?: number;
}

interface AppState {
    // Recording
    recording: boolean;
    paused: boolean;
    seconds: number;
    draftId: number | null;
    recordingStartedAt: string;
    liveStatus: LiveStatus;

    // Transcript
    transcriptParts: TranscriptPart[];
    isTranscribing: boolean;
    interimText: string;
    interimTranslation: string;
    interimSpeaker: string;
    interimSpeakerId: number;

    // Translation
    translationEnabled: boolean;
    translationLang: string;

    // UI
    currentView: 'list' | 'detail' | 'recording';
    activeTab: 'recording' | 'summary';
    settingsOpen: boolean;
    lang: 'vi' | 'en';
    /** Sidecar health — drives which buttons are interactive during startup. */
    backendOnline: boolean;
    /** v1.2.14: backend-reported internet reachability (TCP 1.1.1.1:443 probe).
     *  null = unknown yet, true = online, false = no internet. Used to surface
     *  a banner during long uploads when the user's wifi drops. */
    networkOnline: boolean | null;
    /** Whether the AI assistant (LLM) is configured enough to summarize:
     *  credential (key, or compatible+baseURL) AND a model. Drives the
     *  enable/disable of all minutes-related actions. Default true to avoid a
     *  flash-disable before the first settings read resolves. */
    aiConfigured: boolean;

    // Meetings
    meetings: Meeting[];
    currentMeetingId: number | null;
    transientSummary: string;
    summaryLoading: boolean;
    summaryLang: string;
    summaryTemplate: string;
    customPrompt: string;

    // Actions
    setRecording: (v: boolean) => void;
    setPaused: (v: boolean) => void;
    setSeconds: (v: number) => void;
    setDraftId: (v: number | null) => void;
    setRecordingStartedAt: (v: string) => void;
    setLiveStatus: (v: LiveStatus) => void;
    addTranscriptPart: (part: TranscriptPart) => void;
    appendToLastPart: (text: string, endTime: string, chunkId?: string, tentativeLen?: number) => void;
    replaceLastPartText: (text: string, endTime: string, chunkId?: string, tentativeLen?: number) => void;
    revertLastPartToBase: () => void;
    updateTranscriptTranslation: (idx: number, translation: string) => void;
    /** Append raw text (e.g. trailing punctuation) to part `idx`. */
    appendTextToPart: (idx: number, suffix: string) => void;
    updateTranscriptSpeakerByChunk: (chunkId: string, speakerId: number, speaker: string) => void;
    setTranscriptParts: (parts: TranscriptPart[]) => void;
    clearTranscript: () => void;
    setTranslationEnabled: (v: boolean) => void;
    setTranslationLang: (v: string) => void;
    setCurrentView: (v: 'list' | 'detail' | 'recording') => void;
    setActiveTab: (v: 'recording' | 'summary') => void;
    setSettingsOpen: (v: boolean) => void;
    setLang: (v: 'vi' | 'en') => void;
    setBackendOnline: (v: boolean) => void;
    setNetworkOnline: (v: boolean | null) => void;
    setAiConfigured: (v: boolean) => void;
    setMeetings: (m: Meeting[]) => void;
    setCurrentMeetingId: (id: number | null) => void;
    setTransientSummary: (v: string) => void;
    setSummaryLoading: (v: boolean) => void;
    setIsTranscribing: (v: boolean) => void;
    setInterimText: (v: string) => void;
    setInterimTranslation: (v: string) => void;
    setInterimSpeaker: (speaker: string, speakerId: number) => void;
    setSummaryLang: (v: string) => void;
    setSummaryTemplate: (v: string) => void;
    setCustomPrompt: (v: string) => void;
    theme: ThemeMode;
    setTheme: (v: ThemeMode) => void;
}

let partSeq = 0;
/** Assign-once stable id for transcript parts (React keys, scroll anchors). */
export function nextPartId(): string {
    partSeq += 1;
    return `p-${Date.now().toString(36)}-${partSeq}`;
}

/** Canonical stable key — mirrors MeetingDetail's itemKeyFor. */
export function partKey(part: TranscriptPart, index: number): string {
    return part.id || part.chunkId || `t-${index}`;
}

export const useAppStore = create<AppState>((set) => ({
    recording: false,
    paused: false,
    seconds: 0,
    draftId: null,
    recordingStartedAt: '',
    liveStatus: 'idle',
    transcriptParts: [],
    isTranscribing: false,
    interimText: '',
    interimTranslation: '',
    interimSpeaker: 'Speaker 1',
    interimSpeakerId: 0,
    translationEnabled: safeGetItem('scribble:translationEnabled') === 'true',
    translationLang: safeGetItem('scribble:translationLang', 'en'),
    currentView: 'list',
    activeTab: 'recording',
    settingsOpen: false,
    lang: 'vi',
    backendOnline: false,
    networkOnline: null,
    aiConfigured: true,
    meetings: [],
    currentMeetingId: null,
    transientSummary: '',
    summaryLoading: false,
    summaryLang: safeGetItem('scribble:summaryLang', 'vi'),
    summaryTemplate: safeGetItem('scribble:summaryTemplate', 'deep'),
    customPrompt: safeGetItem('scribble:customPrompt'),

    setRecording: (v) => set({ recording: v }),
    setPaused: (v) => set({ paused: v }),
    setSeconds: (v) => set({ seconds: v }),
    setDraftId: (v) => set({ draftId: v }),
    setRecordingStartedAt: (v) => set({ recordingStartedAt: v }),
    setLiveStatus: (v) => set({ liveStatus: v }),
    addTranscriptPart: (part) =>
        set((s) => ({
            transcriptParts: [...s.transcriptParts, part.id ? part : { ...part, id: nextPartId() }],
        })),
    appendToLastPart: (text, endTime, chunkId, tentativeLen = 0) =>
        set((s) => {
            const parts = [...s.transcriptParts];
            if (parts.length > 0) {
                const last = { ...parts[parts.length - 1] };
                // Save current text as base before appending new chunk
                last._baseText = last.text;
                // Punctuation the model emits only after hearing what follows
                // (", nhưng…", "? Vì vậy…") closes the previous words: no space.
                last.text += (/^[,.?!;:…]/.test(text) ? '' : ' ') + text;
                last.endTime = endTime;
                last._tentativeLen = tentativeLen;
                if (chunkId) {
                    // Extend the id set, but NEVER rewrite last.chunkId:
                    // it feeds React keys — changing it remounts the row.
                    const ids = Array.isArray(last.chunkIds) ? [...last.chunkIds] : [];
                    if (last.chunkId && !ids.includes(last.chunkId)) ids.push(last.chunkId);
                    if (!ids.includes(chunkId)) ids.push(chunkId);
                    last.chunkIds = ids;
                }
                parts[parts.length - 1] = last;
            }
            return { transcriptParts: parts };
        }),
    replaceLastPartText: (text, endTime, chunkId, tentativeLen = 0) =>
        set((s) => {
            const parts = [...s.transcriptParts];
            if (parts.length > 0) {
                const last = { ...parts[parts.length - 1] };
                // If there's a _baseText (from appendToLastPart), prepend it
                // so we only replace the current chunk's portion, not the whole text
                if (last._baseText) {
                    last.text = last._baseText + ' ' + text;
                } else {
                    last.text = text;
                }
                last.endTime = endTime;
                last._tentativeLen = tentativeLen;
                if (chunkId) {
                    // Same as append: extend chunkIds, keep chunkId (key) stable.
                    const ids = Array.isArray(last.chunkIds) ? [...last.chunkIds] : [];
                    if (last.chunkId && !ids.includes(last.chunkId)) ids.push(last.chunkId);
                    if (!ids.includes(chunkId)) ids.push(chunkId);
                    last.chunkIds = ids;
                    if (!last.chunkId) last.chunkId = chunkId;
                }
                parts[parts.length - 1] = last;
            }
            return { transcriptParts: parts };
        }),
    revertLastPartToBase: () =>
        set((s) => {
            const parts = [...s.transcriptParts];
            if (parts.length > 0) {
                const last = { ...parts[parts.length - 1] };
                if (last._baseText) {
                    // Restore to text before the wrong chunk was appended
                    last.text = last._baseText;
                    last._baseText = undefined;
                    // Remove the latest chunkId (the wrong one)
                    if (Array.isArray(last.chunkIds) && last.chunkIds.length > 1) {
                        last.chunkIds = last.chunkIds.slice(0, -1);
                        last.chunkId = last.chunkIds[last.chunkIds.length - 1];
                    }
                    parts[parts.length - 1] = last;
                } else {
                    // No base text — the entire part was the wrong chunk, remove it
                    parts.pop();
                }
            }
            return { transcriptParts: parts };
        }),
    appendTextToPart: (idx, suffix) =>
        set((s) => {
            const parts = [...s.transcriptParts];
            if (parts[idx]) parts[idx] = { ...parts[idx], text: parts[idx].text + suffix };
            return { transcriptParts: parts };
        }),
    updateTranscriptTranslation: (idx, translation) =>
        set((s) => {
            const parts = [...s.transcriptParts];
            if (parts[idx]) {
                parts[idx] = { ...parts[idx], translation };
            }
            return { transcriptParts: parts };
        }),
    updateTranscriptSpeakerByChunk: (chunkId, speakerId, speaker) =>
        set((s) => ({
            transcriptParts: s.transcriptParts.map((part) => {
                const ids = new Set<string>();
                if (part.chunkId) ids.add(part.chunkId);
                if (Array.isArray(part.chunkIds)) {
                    part.chunkIds.forEach((id) => {
                        if (id) ids.add(id);
                    });
                }
                if (!ids.has(chunkId)) return part;
                return { ...part, speakerId, speaker };
            }),
        })),
    setTranscriptParts: (parts) => set({
        // Backend-loaded parts have no id — assign stable ones once here so
        // React keys stay put across reloads (never derive keys from index).
        transcriptParts: parts.map((p) => (p.id ? p : { ...p, id: nextPartId() })),
    }),
    clearTranscript: () => set({ transcriptParts: [], seconds: 0, transientSummary: '' }),
    setTranslationEnabled: (v) => {
        safeSetItem('scribble:translationEnabled', String(v));
        set({ translationEnabled: v });
    },
    setTranslationLang: (v) => {
        safeSetItem('scribble:translationLang', v);
        set({ translationLang: v });
    },
    setCurrentView: (v) => set({ currentView: v }),
    setActiveTab: (v) => set({ activeTab: v }),
    setSettingsOpen: (v) => set({ settingsOpen: v }),
    setLang: (v) => set({ lang: v }),
    setBackendOnline: (v) => set({ backendOnline: v }),
    setNetworkOnline: (v) => set({ networkOnline: v }),
    setAiConfigured: (v) => set({ aiConfigured: v }),
    setMeetings: (m) => set({ meetings: m }),
    setCurrentMeetingId: (id) => set({ currentMeetingId: id }),
    setTransientSummary: (v) => set({ transientSummary: v }),
    setSummaryLoading: (v) => set({ summaryLoading: v }),
    setIsTranscribing: (v) => set({ isTranscribing: v }),
    setInterimText: (v) => set({ interimText: v }),
    setInterimTranslation: (v) => set({ interimTranslation: v }),
    setInterimSpeaker: (speaker, speakerId) => set({ interimSpeaker: speaker, interimSpeakerId: speakerId }),
    setSummaryLang: (v) => {
        safeSetItem('scribble:summaryLang', v);
        set({ summaryLang: v });
    },
    setSummaryTemplate: (v) => {
        safeSetItem('scribble:summaryTemplate', v);
        set({ summaryTemplate: v });
    },
    setCustomPrompt: (v) => {
        safeSetItem('scribble:customPrompt', v);
        set({ customPrompt: v });
    },
    theme: (safeGetItem('scribble:theme', 'system') as ThemeMode) || 'system',
    setTheme: (v) => {
        safeSetItem('scribble:theme', v);
        applyTheme(v);
        set({ theme: v });
    },
}));
