import { create } from 'zustand';

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

    // Transcript
    transcriptParts: TranscriptPart[];
    isTranscribing: boolean;
    interimText: string;
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

    // Actions
    setRecording: (v: boolean) => void;
    setPaused: (v: boolean) => void;
    setSeconds: (v: number) => void;
    setDraftId: (v: number | null) => void;
    addTranscriptPart: (part: TranscriptPart) => void;
    appendToLastPart: (text: string, endTime: string, chunkId?: string) => void;
    replaceLastPartText: (text: string, endTime: string, chunkId?: string) => void;
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
    setInterimSpeaker: (speaker: string, speakerId: number) => void;
}

export const useAppStore = create<AppState>((set) => ({
    recording: false,
    paused: false,
    seconds: 0,
    draftId: null,
    transcriptParts: [],
    isTranscribing: false,
    interimText: '',
    interimSpeaker: 'Speaker 1',
    interimSpeakerId: 0,
    translationEnabled: false,
    translationLang: 'en',
    currentView: 'list',
    activeTab: 'recording',
    settingsOpen: false,
    lang: 'vi',
    meetings: [],
    currentMeetingId: null,
    transientSummary: '',
    summaryLoading: false,

    setRecording: (v) => set({ recording: v }),
    setPaused: (v) => set({ paused: v }),
    setSeconds: (v) => set({ seconds: v }),
    setDraftId: (v) => set({ draftId: v }),
    addTranscriptPart: (part) =>
        set((s) => ({ transcriptParts: [...s.transcriptParts, part] })),
    appendToLastPart: (text, endTime, chunkId) =>
        set((s) => {
            const parts = [...s.transcriptParts];
            if (parts.length > 0) {
                const last = { ...parts[parts.length - 1] };
                last.text += ' ' + text;
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
    replaceLastPartText: (text, endTime, chunkId) =>
        set((s) => {
            const parts = [...s.transcriptParts];
            if (parts.length > 0) {
                const last = { ...parts[parts.length - 1] };
                last.text = text;
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
    setTranslationEnabled: (v) => set({ translationEnabled: v }),
    setTranslationLang: (v) => set({ translationLang: v }),
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
    setInterimSpeaker: (speaker, speakerId) => set({ interimSpeaker: speaker, interimSpeakerId: speakerId }),
}));
