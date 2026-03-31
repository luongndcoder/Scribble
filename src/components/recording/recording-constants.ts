/** Shared constants for the recording subsystem. */

// VAD (Voice Activity Detection)
export const SILENCE_DURATION_MS = 400;
export const MIN_CHUNK_SEC = 2;
export const MAX_CHUNK_SEC = 4;
export const VAD_INTERVAL_MS = 80;
export const SILENCE_RMS_THRESHOLD = 0.015;

// WebSocket
export const WS_CONNECT_TIMEOUT_MS = 1800;
export const WS_PATH_NVIDIA = "/ws/nvidia-stream";
export const WS_PATH_SONIOX = "/ws/soniox-stream";

// Audio
export const TARGET_SAMPLE_RATE = 16000;
export const ARCHIVE_CHUNK_INTERVAL_MS = 4000;
export const SCRIPT_PROCESSOR_BUFFER = 4096;

// Speaker offset for system audio (to avoid ID collision with mic)
export const SYSTEM_SPEAKER_ID_OFFSET = 100;

export const isTauri = !!window.__TAURI_INTERNALS__;

export async function safeInvoke(cmd: string, args?: Record<string, unknown>) {
    if (!isTauri) {
        console.warn(`[Tauri] Not in Tauri env, skipping invoke('${cmd}')`);
        return null;
    }
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(cmd, args);
}
