/**
 * API Client for Python FastAPI sidecar
 *
 * All requests go to the local Python server spawned by Tauri.
 * In dev mode, the Python server runs at http://localhost:8765
 */

import { fetchSidecar, readResponseError, sidecarUrl, SIDECAR_HTTP_BASES } from './sidecar';
import type { Meeting } from '../stores/appStore';
import type { SettingsData, DiagnoseResult } from '../types/stt';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const res = await fetchSidecar(path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...options?.headers,
        },
    });
    if (!res.ok) {
        throw new Error(await readResponseError(res));
    }
    return res.json();
}

// ─── Health ───
export interface HealthNetwork {
    /** TCP probe result against 1.1.1.1:443 — true = internet reachable. */
    online: boolean;
    /** Probe latency in ms, null when offline. */
    latency_ms: number | null;
    /** Age of the cached probe result in ms (for staleness debugging). */
    age_ms: number;
}
export interface HealthResponse {
    status: string;
    version?: string;
    /** v1.2.14: backend-side internet reachability snapshot. */
    network?: HealthNetwork;
}
export const checkHealth = () => request<HealthResponse>('/health');
/** Force a fresh network probe — use after a suspected outage, NOT in poll loops. */
export const pingNetwork = () => request<HealthNetwork>('/ping-network');

/** Markers of a DNS/offline/unreachable error string — mirrors the backend's
 *  `_NETWORK_ERROR_MARKERS` in api/diagnose.py. Used to classify a raw error
 *  message bubbled up from a failed backend job (Soniox unreachable, etc.). */
const _NETWORK_ERROR_MARKERS = [
    'nodename nor servname',
    'name or service not known',
    'getaddrinfo failed',
    'temporary failure in name resolution',
    'errno 8',
    'errno -2',
    'errno -3',
    '11001',
    'failed to establish a new connection',
    'max retries exceeded',
    'connection refused',
    'network is unreachable',
    'no route to host',
    'name resolution',
];
/** True when a raw error string looks like a lost-internet / DNS failure. */
export function looksLikeNetworkError(msg: string | null | undefined): boolean {
    if (!msg) return false;
    const lower = msg.toLowerCase();
    return _NETWORK_ERROR_MARKERS.some((m) => lower.includes(m));
}

/**
 * Call AFTER an API/SSE request fails to decide whether the cause was a lost
 * internet connection. Force-probes /ping-network so the offline banner can
 * appear within ~1 probe instead of waiting up to 20s for the passive /health
 * poll cadence. Side-effect: writes the result into the global store via the
 * injected setter so any mounted <NetworkOfflineBanner/> reacts immediately.
 *
 * Returns true if confirmed offline, false if online, null if undetermined
 * (the sidecar itself was unreachable — a different failure surfaced elsewhere).
 *
 * `setNetworkOnline` is injected (not imported) to keep this lib free of a
 * direct store dependency and avoid a circular import.
 */
export async function detectOfflineAfterFailure(
    setNetworkOnline: (v: boolean | null) => void,
): Promise<boolean | null> {
    // Fast path: the webview's own connectivity flag. When the OS says we're
    // offline, trust it without a round-trip (the sidecar probe would just
    // confirm it after a 2s timeout anyway).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setNetworkOnline(false);
        return true;
    }
    try {
        const n = await pingNetwork();
        setNetworkOnline(n.online);
        return n.online ? false : true;
    } catch {
        // Sidecar unreachable — can't attribute the failure to the network.
        // Leave the store value untouched; backend-status handling owns this.
        return null;
    }
}

// ─── Transcription ───
export async function transcribeDiarize(audioBlob: Blob): Promise<{
    text: string;
    chunk_id?: string;
    segments: Array<{ speaker: string; speaker_id: number; chunk_id?: string; text: string }>;
    speakers: number;
}> {
    const form = new FormData();
    form.append('audio', audioBlob, 'chunk.webm');
    const res = await fetchSidecar('/transcribe-diarize', {
        method: 'POST',
        body: form,
    });
    if (!res.ok) {
        throw new Error(await readResponseError(res));
    }
    return res.json();
}

export const resetDiarize = async () => {
    const res = await fetchSidecar('/diarize-reset', { method: 'POST' });
    if (!res.ok) {
        throw new Error(await readResponseError(res));
    }
    return res;
};

// Translation is done directly in TranscriptView via fetch + SSE
export const summarize = (meetingId: number, language: string) =>
    fetchSidecar('/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId, language }),
    });

// ─── Meetings CRUD ───
export const getMeetings = () => request<Meeting[]>('/meetings');
export const getMeeting = (id: number) => request<Meeting>(`/meetings/${id}`);
export const meetingAudioStreamUrl = (id: number) =>
    sidecarUrl(SIDECAR_HTTP_BASES[0], `/meetings/${id}/audio/stream`);
export const createMeeting = (data: Partial<Meeting>) =>
    request<{ id: number }>('/meetings', {
        method: 'POST',
        body: JSON.stringify(data),
    });
export const updateMeeting = (id: number, data: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/meetings/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
    });
export const deleteMeeting = (id: number) =>
    request<{ ok: boolean }>(`/meetings/${id}`, { method: 'DELETE' });

// ─── Drafts ───
export const createDraft = (title: string) =>
    request<{ id: number }>('/drafts', {
        method: 'POST',
        body: JSON.stringify({ title }),
    });
export const appendDraft = (id: number, textOrPart: string | object, duration: number) =>
    fetchSidecar(`/drafts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
            typeof textOrPart === 'string'
                ? { appendText: textOrPart, audioDuration: duration }
                : { part: textOrPart, audioDuration: duration }
        ),
    });

export const appendDraftAudio = (id: number, audioBlob: Blob, filename = 'recording.webm') => {
    const form = new FormData();
    form.append('audio', audioBlob, filename);
    return fetchSidecar(`/drafts/${id}/audio`, {
        method: 'PATCH',
        body: form,
    });
};

function parseDownloadFilename(contentDisposition: string | null): string | null {
    if (!contentDisposition) return null;
    const utf8 = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8?.[1]) {
        try { return decodeURIComponent(utf8[1]); } catch { } // invalid URI encoding
    }
    const quoted = contentDisposition.match(/filename=\"([^\"]+)\"/i);
    if (quoted?.[1]) return quoted[1];
    const plain = contentDisposition.match(/filename=([^;]+)/i);
    if (plain?.[1]) return plain[1].trim();
    return null;
}

export async function downloadMeetingAudio(
    id: number,
    fallbackName = 'meeting-audio.mp3',
    /** mp3 = ~43MB/hr (default), wav = ~115MB/hr (lossless), mp4 = AAC */
    format: 'wav' | 'mp3' | 'mp4' = 'mp3'
) {
    const path = `/meetings/${id}/audio?format=${encodeURIComponent(format)}`;

    // In Tauri: use invoke to save via Rust (tries multiple sidecar URLs)
    if (window.__TAURI_INTERNALS__) {
        const { invoke } = await import('@tauri-apps/api/core');

        // Try each sidecar base URL via Rust download (avoids JS memory issues)
        for (const base of SIDECAR_HTTP_BASES) {
            try {
                const savedPath = await invoke('download_and_save_file', {
                    url: sidecarUrl(base, path),
                    filename: fallbackName,
                });
                return savedPath;
            } catch (e) {
                console.warn(`[api] Rust download via ${base} failed:`, e);
            }
        }

        // If all Rust downloads failed, throw with context
        throw new Error('Audio download failed: could not connect to sidecar from any URL');
    }

    // Browser fallback (non-Tauri)
    const res = await fetchSidecar(path);
    if (!res.ok) {
        throw new Error(await readResponseError(res));
    }
    const blob = await res.blob();
    const expectedName = fallbackName.toLowerCase().endsWith(`.${format}`)
        ? fallbackName
        : `${fallbackName.replace(/\.[^/.]+$/, '')}.${format}`;
    const name = parseDownloadFilename(res.headers.get('Content-Disposition')) || expectedName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

export async function downloadMeetingMinutes(
    id: number,
    fallbackName = 'meeting-minutes.md',
    format: 'md' | 'docx' = 'md'
) {
    const path = `/meetings/${id}/minutes?format=${encodeURIComponent(format)}`;

    if (window.__TAURI_INTERNALS__) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const res = await fetchSidecar(path);
            if (!res.ok) throw new Error(await readResponseError(res));
            const arrayBuffer = await res.arrayBuffer();
            const bytes = Array.from(new Uint8Array(arrayBuffer));
            await invoke('save_audio_file', {
                bytes,
                filename: fallbackName.toLowerCase().endsWith(`.${format}`)
                    ? fallbackName
                    : `${fallbackName.replace(/\.[^/.]+$/, '')}.${format}`,
            });
            return;
        } catch (e) {
            console.warn('[api] Tauri save minutes file failed:', e);
        }
    }

    const res = await fetchSidecar(path);
    if (!res.ok) {
        throw new Error(await readResponseError(res));
    }
    const blob = await res.blob();
    const expectedName = fallbackName.toLowerCase().endsWith(`.${format}`)
        ? fallbackName
        : `${fallbackName.replace(/\.[^/.]+$/, '')}.${format}`;
    const name = parseDownloadFilename(res.headers.get('Content-Disposition')) || expectedName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

export async function downloadTextFile(filename: string, content: string) {
    const bytes = new TextEncoder().encode(content);

    if (window.__TAURI_INTERNALS__) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('save_audio_file', {
                bytes: Array.from(bytes),
                filename,
            });
            return;
        } catch (e) {
            console.warn('[api] Tauri save_text_file failed:', e);
        }
    }

    const blob = new Blob([bytes], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
// ─── Retry failed Soniox chunks (v1.2.13) ───
// Triggers re-transcription of upload_chunks rows marked status='failed' for
// the given meeting. Returns a job_id the caller subscribes to via SSE just
// like a normal upload — when the retry job ends DONE the transcript is
// merged in-place (per-chunk rebuild keeps timeline correct).
export const retryFailedChunks = (meetingId: number) =>
    request<{ job_id: string; meeting_id: number; retry_chunks: number }>(
        `/meetings/${meetingId}/retry-failed-chunks`,
        { method: 'POST' },
    );

// ─── Settings ───
export const getSettings = () => request<SettingsData>('/settings');

// ─── Local/offline STT ───
export interface LocalDeviceInfo {
    tier: string;
    os: string;
    arch: string;
    has_cuda: boolean;
    reason: string;
    model_available: boolean;
    model_id: string;
    license: string;
    supported_languages: string[];
}
export const getLocalDeviceInfo = () => request<LocalDeviceInfo>('/local/device-info');

export const saveSettings = (data: Record<string, unknown>) =>
    request<{ ok: boolean }>('/settings', {
        method: 'POST',
        body: JSON.stringify(data),
    });

// ─── Diagnostics ───
export const diagnose = (lang: string, signal?: AbortSignal) =>
    request<DiagnoseResult>(`/diagnose?lang=${lang}`, { signal });

// ─── LLM Models ───
export const fetchLLMModels = (
    provider: string,
    apiKey: string,
    baseUrl?: string,
): Promise<{ models: string[]; error?: string }> => {
    const params = new URLSearchParams({ provider, api_key: apiKey });
    if (baseUrl) params.set('base_url', baseUrl);
    return request<{ models: string[]; error?: string }>(`/models?${params}`);
};

