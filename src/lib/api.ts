/**
 * API Client for Python FastAPI sidecar
 *
 * All requests go to the local Python server spawned by Tauri.
 * In dev mode, the Python server runs at http://localhost:8765
 */

import { fetchSidecar, readResponseError, sidecarUrl, SIDECAR_HTTP_BASES } from './sidecar';

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
export const checkHealth = () => request<{ status: string }>('/health');

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
export const getMeetings = () => request<any[]>('/meetings');
export const getMeeting = (id: number) => request<any>(`/meetings/${id}`);
export const createMeeting = (data: any) =>
    request<{ id: number }>('/meetings', {
        method: 'POST',
        body: JSON.stringify(data),
    });
export const updateMeeting = (id: number, data: any) =>
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
        try { return decodeURIComponent(utf8[1]); } catch { }
    }
    const quoted = contentDisposition.match(/filename=\"([^\"]+)\"/i);
    if (quoted?.[1]) return quoted[1];
    const plain = contentDisposition.match(/filename=([^;]+)/i);
    if (plain?.[1]) return plain[1].trim();
    return null;
}

export async function downloadMeetingAudio(
    id: number,
    fallbackName = 'meeting-audio.wav',
    format: 'wav' | 'mp4' = 'wav'
) {
    const path = `/meetings/${id}/audio?format=${encodeURIComponent(format)}`;

    // In Tauri: use invoke to save via Rust, or open URL directly
    if ((window as any).__TAURI_INTERNALS__) {
        const { invoke } = await import('@tauri-apps/api/core');
        try {
            // Use Rust command to download and save directly (avoids JS memory overhead)
            const savedPath = await invoke('download_and_save_file', {
                url: sidecarUrl(SIDECAR_HTTP_BASES[0], path),
                filename: fallbackName,
            });
            return savedPath;
        } catch (e) {
            console.warn('[api] Tauri download_and_save_file failed, trying JS fallback:', e);
            // JS fallback: fetch then save via Rust
            const res = await fetchSidecar(path);
            if (!res.ok) throw new Error(await readResponseError(res));
            const arrayBuffer = await res.arrayBuffer();
            const bytes = Array.from(new Uint8Array(arrayBuffer));
            await invoke('save_audio_file', {
                bytes,
                filename: fallbackName,
            });
            return;
        }
    }

    // Browser fallback
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

    if ((window as any).__TAURI_INTERNALS__) {
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

    if ((window as any).__TAURI_INTERNALS__) {
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
// ─── Settings ───
export const getSettings = () => request<any>('/settings');
export const saveSettings = (data: any) =>
    request<{ ok: boolean }>('/settings', {
        method: 'POST',
        body: JSON.stringify(data),
    });

// ─── Diagnostics ───
export const diagnose = (lang: string) =>
    request<any>(`/diagnose?lang=${lang}`);
