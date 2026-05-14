/**
 * Frontend bridge for the upload-audio feature.
 *
 * Desktop (Tauri): file pick + streaming upload happen in Rust to avoid
 *   WebKitGTK OOM on Linux with large files. JS only orchestrates.
 * Web (docker/browser): not supported in v1 — uploadAudio will throw.
 *
 * Pipeline:
 *   pickAudioFile()                → file path (Rust dialog)
 *   uploadAudio(path, opts)        → streams from Rust → sidecar
 *                                    emits upload-audio-progress events
 *   subscribeJobEvents(jobId, ...) → SSE for sidecar pipeline progress
 *   cancelAudioUpload(uploadId)    → aborts mid-stream (Rust side)
 *   cancelJob(jobId)               → aborts sidecar pipeline (server side)
 */

import { fetchSidecar, IS_TAURI, readResponseError, sidecarUrl, SIDECAR_HTTP_BASES } from './sidecar';
import { consumeSseResponse, type SseEventPayload } from './sse';

export interface UploadResult {
  upload_id: string;
  job_id: string;
  meeting_id: number;
}

export interface UploadProgressPayload {
  upload_id: string;
  bytes_sent: number;
  total_bytes: number;
}

export type JobStatus =
  | 'pending'
  | 'uploading'
  | 'normalizing'
  | 'transcribing'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface JobState {
  job_id: string;
  meeting_id: number;
  status: JobStatus;
  progress: number;
  message: string;
  error: string | null;
  total_chunks: number;
  processed_chunks: number;
  created_at: number;
  updated_at: number;
}

export interface JobChunkPayload {
  type: 'chunk';
  idx?: number;
  text?: string;
  start_ms?: number;
  end_ms?: number;
  [key: string]: unknown;
}

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'done',
  'failed',
  'cancelled',
]);

export const UPLOAD_PROGRESS_EVENT = 'upload-audio-progress';
export const DUPLICATE_ERROR_PREFIX = 'DUPLICATE:';

function ensureTauri(action: string): void {
  if (!IS_TAURI) {
    throw new Error(
      `${action} requires the desktop app — web build does not support upload yet`,
    );
  }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  ensureTauri(`invoke ${cmd}`);
  const tauri = await import('@tauri-apps/api/core');
  return tauri.invoke<T>(cmd, args);
}

/**
 * Open native file dialog (audio/video filter). Returns absolute path of the
 * selected file or null when the user cancels.
 */
export async function pickAudioFile(): Promise<string | null> {
  return invoke<string | null>('pick_audio_file');
}

/**
 * Stream a local file to the sidecar /meetings/upload-audio endpoint.
 * Returns once the sidecar has acknowledged the upload with {job_id, meeting_id}.
 *
 * onProgress is called continuously during the streaming phase (Rust → sidecar).
 * After this resolves, listen on the sidecar SSE via subscribeJobEvents() for
 * the rest of the pipeline (normalize → STT → diarize → summarize).
 */
export async function uploadAudio(
  args: { filePath: string; title?: string; language?: string },
  onProgress?: (payload: UploadProgressPayload) => void,
): Promise<UploadResult> {
  ensureTauri('uploadAudio');

  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = onProgress
    ? await listen<UploadProgressPayload>(
        UPLOAD_PROGRESS_EVENT,
        (e: { payload: UploadProgressPayload }) => onProgress(e.payload),
      )
    : null;

  try {
    return await invoke<UploadResult>('upload_audio_to_sidecar', {
      filePath: args.filePath,
      title: args.title ?? null,
      language: args.language ?? 'vi',
    });
  } finally {
    if (unlisten) unlisten();
  }
}

/** Signal cancel to the Rust streaming side mid-upload. */
export async function cancelAudioUpload(uploadId: string): Promise<boolean> {
  return invoke<boolean>('cancel_audio_upload', { uploadId });
}

/** One-shot poll of the sidecar-side job status. */
export async function getJobState(jobId: string): Promise<JobState> {
  const res = await fetchSidecar(`/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) throw new Error(await readResponseError(res));
  return res.json();
}

/** Tell the sidecar to mark a running job cancelled. */
export async function cancelJob(jobId: string): Promise<void> {
  const res = await fetchSidecar(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(await readResponseError(res));
}

interface SubscribeOptions {
  onStatus?: (state: JobState) => void;
  onChunk?: (chunk: JobChunkPayload) => void;
  onEvent?: (raw: SseEventPayload) => void;
  /** Set true to abort the SSE connection from outside. */
  signal?: AbortSignal;
}

/**
 * Subscribe to the sidecar SSE stream for a job. Resolves when the job reaches
 * a terminal state (done / failed / cancelled) or the signal is aborted.
 *
 * Falls back across SIDECAR_HTTP_BASES so localhost/127.0.0.1 oddities don't
 * break in dev.
 */
export async function subscribeJobEvents(
  jobId: string,
  opts: SubscribeOptions = {},
): Promise<JobState | null> {
  const path = `/jobs/${encodeURIComponent(jobId)}/events`;

  let lastState: JobState | null = null;

  let lastError: unknown = null;
  for (const base of SIDECAR_HTTP_BASES) {
    try {
      const res = await fetch(sidecarUrl(base, path), {
        signal: opts.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!res.ok) {
        throw new Error(await readResponseError(res));
      }

      await consumeSseResponse(res, {
        onEvent: (raw) => {
          opts.onEvent?.(raw);
          const json = raw.json;
          if (!json) return;
          if (json.type === 'chunk') {
            opts.onChunk?.(json as JobChunkPayload);
            return;
          }
          // status frame
          lastState = json as unknown as JobState;
          opts.onStatus?.(lastState);
        },
      });

      return lastState;
    } catch (err) {
      lastError = err;
      // try next base
    }
  }

  throw lastError ?? new Error('Sidecar SSE unavailable');
}

export function isTerminal(status: JobStatus | string | undefined | null): boolean {
  return !!status && TERMINAL_STATUSES.has(status as JobStatus);
}

export function isDuplicateError(error: string | null | undefined): number | null {
  if (!error || !error.startsWith(DUPLICATE_ERROR_PREFIX)) return null;
  const parsed = Number(error.slice(DUPLICATE_ERROR_PREFIX.length));
  return Number.isFinite(parsed) ? parsed : null;
}
