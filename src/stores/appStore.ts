import { create } from 'zustand';

function safeGetItem(key: string, fallback: string = ''): string {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}

function safeSetItem(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch {}
}

export interface TranscriptPart {
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
}

export interface Meeting {
    id: number;
    title: string;
    transcript: string;
    summary: string;
    audio_duration: number;
    created_at: string;
    status?: string;
}

interface AppState {
    // Recording
    recording: boolean;
    paused: boolean;
    seconds: number;
    draftId: number | null;
    recordingStartedAt: string;

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
    addTranscriptPart: (part: TranscriptPart) => void;
    appendToLastPart: (text: string, endTime: string, chunkId?: string) => void;
    replaceLastPartText: (text: string, endTime: string, chunkId?: string) => void;
    revertLastPartToBase: () => void;
    updateTranscriptTranslation: (idx: number, translation: string) => void;
    updateTranscriptSpeakerByChunk: (chunkId: string, speakerId: number, speaker: string) => void;
    setTranscriptParts: (parts: TranscriptPart[]) => void;
    clearTranscript: () => void;
    setTranslationEnabled: (v: boolean) => void;
    setTranslationLang: (v: string) => void;
    setCurrentView: (v: 'list' | 'detail' | 'recording') => void;
    setActiveTab: (v: 'recording' | 'summary') => void;
    setSettingsOpen: (v: boolean) => void;
    setLang: (v: 'vi' | 'en') => void;
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
}

export const useAppStore = create<AppState>((set) => ({
    recording: false,
    paused: false,
    seconds: 0,
    draftId: null,
    recordingStartedAt: '',
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
    meetings: [],
    currentMeetingId: null,
    transientSummary: '',
    summaryLoading: false,
    summaryLang: safeGetItem('scribble:summaryLang', 'vi'),
    summaryTemplate: safeGetItem('scribble:summaryTemplate', 'mom'),
    customPrompt: safeGetItem('scribble:customPrompt'),

    setRecording: (v) => set({ recording: v }),
    setPaused: (v) => set({ paused: v }),
    setSeconds: (v) => set({ seconds: v }),
    setDraftId: (v) => set({ draftId: v }),
    setRecordingStartedAt: (v) => set({ recordingStartedAt: v }),
    addTranscriptPart: (part) =>
        set((s) => ({ transcriptParts: [...s.transcriptParts, part] })),
    appendToLastPart: (text, endTime, chunkId) =>
        set((s) => {
            const parts = [...s.transcriptParts];
            if (parts.length > 0) {
                const last = { ...parts[parts.length - 1] };
                // Save current text as base before appending new chunk
                last._baseText = last.text;
                last.text += ' ' + text;
                last.endTime = endTime;
                if (chunkId) {
                    const ids = Array.isArray(last.chunkIds) ? [...last.chunkIds] : [];
                    if (last.chunkId && !ids.includes(last.chunkId)) ids.push(last.chunkId);
                    if (!ids.includes(chunkId)) ids.push(chunkId);
                    last.chunkIds = ids;
                    last.chunkId = chunkId; // Update to new chunk_id
                }
                parts[parts.length - 1] = last;
            }
            return { transcriptParts: parts };
        }),
    replaceLastPartText: (text, endTime, chunkId) =>
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
                if (chunkId) {
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
    setTranscriptParts: (parts) => set({ transcriptParts: parts }),
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
}));
