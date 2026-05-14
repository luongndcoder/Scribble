/**
 * Meeting attachments client — reference materials (md/txt) attached to a
 * meeting, fed into the LLM as background context for summary generation.
 *
 * Web-safe: uses HTML `<input type="file">` for picking (md/txt are tiny so
 * the WebKitGTK OOM caveat that drives Tauri picking for audio doesn't
 * apply here — these files cap at 200 KB).
 */

import { fetchSidecar, readResponseError } from './sidecar';

export interface AttachmentMeta {
  id: number;
  meeting_id: number;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface AttachmentFull extends AttachmentMeta {
  content_text: string;
}

export interface AttachmentsListResponse {
  items: AttachmentMeta[];
  total_bytes: number;
  max_total_bytes: number;
  max_files: number;
  max_file_bytes: number;
}

export const ALLOWED_ATTACHMENT_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

/** Convenience for the file picker `accept` attribute. */
export const ATTACHMENT_ACCEPT = ALLOWED_ATTACHMENT_EXTENSIONS.join(',');

/** Pretty 1.5 KB / 12.3 KB / 0.4 MB. */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function listAttachments(meetingId: number): Promise<AttachmentsListResponse> {
  const res = await fetchSidecar(`/meetings/${meetingId}/attachments`);
  if (!res.ok) throw new Error(await readResponseError(res));
  return (await res.json()) as AttachmentsListResponse;
}

export async function uploadAttachment(
  meetingId: number,
  file: File,
): Promise<AttachmentMeta> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetchSidecar(`/meetings/${meetingId}/attachments`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(await readResponseError(res));
  return (await res.json()) as AttachmentMeta;
}

export async function fetchAttachment(
  meetingId: number,
  attachmentId: number,
): Promise<AttachmentFull> {
  const res = await fetchSidecar(`/meetings/${meetingId}/attachments/${attachmentId}`);
  if (!res.ok) throw new Error(await readResponseError(res));
  return (await res.json()) as AttachmentFull;
}

export async function deleteAttachment(
  meetingId: number,
  attachmentId: number,
): Promise<void> {
  const res = await fetchSidecar(
    `/meetings/${meetingId}/attachments/${attachmentId}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(await readResponseError(res));
}
