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
    /** When the backend hits a terminal STT error (billing, auth, etc.) it
     *  may send either `error: "<message string>"` (legacy shape) or
     *  `error: true` alongside `text: "..."` (Soniox path). Accept both. */
    error?: string | boolean;
    /** `terminal: true` distinguishes a fatal STT error (stream is dead — stop
     *  recording + toast) from a transient connection error (which falls back
     *  to chunk mode). Sent by `/ws/soniox-stream` for Soniox 402, auth fail,
     *  etc. Older sidecars omit this field — treat any onTerminalError handler
     *  presence + `error` truthy as terminal for backwards-compat. */
    terminal?: boolean;
    /** Non-terminal status heartbeat from backend (e.g. Soniox auto-reconnect
     *  after a session-duration cap). Render as interim banner, NOT as a
     *  transcript part. */
    info?: boolean;
    segments?: SttSegment[];
    /** Soniox token-level offsets (ms from stream start). Present on
     *  real-time STT events when the upstream tokens carry timestamps. */
    start_ms?: number;
    end_ms?: number;
}

export interface DiagnoseResult {
    stt: { status: string; message: string; offline?: boolean };
    llm: { status: string; message: string; offline?: boolean };
    /** Present when the backend short-circuited because the machine is offline
     *  (or a provider raised a DNS/unreachable error). */
    network?: { online: boolean };
    backend?: string;
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
