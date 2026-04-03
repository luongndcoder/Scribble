/** Types for STT WebSocket messages and API responses. */

export interface SttSegment {
    text: string;
    speaker_id?: number;
    speaker?: string;
    chunk_id?: string;
}

export interface SttTranscribeResponse {
    text?: string;
    segments?: SttSegment[];
    chunk_id?: string;
    speakers?: Record<string, string>;
}

export interface SttWsMessage {
    type?: string;
    text?: string;
    is_final?: boolean;
    speaker?: string;
    speaker_id?: number;
    chunk_id?: string;
    translation?: string;
    append?: boolean;
    error?: string;
    segments?: SttSegment[];
}

export interface DiagnoseResult {
    stt: { status: string; message: string };
    llm: { status: string; message: string };
}

export interface SettingsData {
    nvidia_api_key?: string;
    soniox_api_key?: string;
    llm_api_key?: string;
    stt_provider?: string;
    stt_language?: string;
    soniox_language_hints?: string;
    max_speakers?: string;
    llm_provider?: string;
    llm_model?: string;
    app_language?: string;
    [key: string]: string | undefined;
}

export interface SummaryStructured {
    title?: string;
    summary?: string;
    actionItems?: { text: string }[];
    [key: string]: unknown;
}
