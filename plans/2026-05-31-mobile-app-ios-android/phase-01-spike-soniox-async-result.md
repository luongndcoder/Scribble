# Phase 01 — Spike Result: Soniox Async File API

> Verdict: ✅ **PASS** — kiến trúc cloud-direct giữ nguyên. Async + diarization xác nhận.
> Nguồn: (1) code desktop chạy thật `src-python/stt.py` (`[soniox-async]` Phase A/B), (2) docs Soniox.

## Decision gate → PASS

| Câu hỏi | Kết quả |
|---------|---------|
| Async file API tồn tại? | ✅ REST API có thật |
| Diarization trên async? | ✅ `enable_speaker_diarization=true`, mỗi token có field `speaker` (chứng minh bởi desktop `model=stt-async-v4`) |
| Timestamps? | ✅ token có `start_ms` / `end_ms` |
| Đa ngôn ngữ? | ✅ `language_hints[]` + `enable_language_identification` optional (60+ ngôn ngữ) |
| Format nhận? | ✅ aac, aiff, amr, flac, mp3, ogg, wav, webm, **m4a, mp4** — phủ output expo-audio |
| Cost | ~**$0.10/giờ** async (≈ $1.50/1M audio tokens) — rẻ hơn realtime; vẫn hiển thị cảnh báo phút như desktop |
| Python SDK chạy RN? | ❌ KHÔNG — nhưng SDK chỉ wrap REST → TS gọi thẳng REST (fetch + FormData) |

→ **Không pivot.** Phase 04 dựng `soniox-client` theo contract dưới. Record-to-file v1 giữ nguyên.

## REST contract (spec cho `@scribble/core/soniox-client`)

Base: `https://api.soniox.com/v1` · Auth: `Authorization: Bearer <SONIOX_KEY>`

```
1. POST /v1/files            (multipart form-data, field file)      → { id: file_id }
2. POST /v1/transcriptions   { model:"stt-async-v4", file_id,
                               language_hints:["vi"],
                               enable_speaker_diarization:true }     → { id: transcription_id }
3. GET  /v1/transcriptions/{id}                                     → { status: queued|processing|completed|error,
                                                                        audio_duration_ms?, error_message? }
4. GET  /v1/transcriptions/{id}/transcript                          → { tokens:[{text,speaker,language,start_ms,end_ms}] }
5. cleanup: DELETE /v1/transcriptions/{id}  + DELETE /v1/files/{file_id}
```

### Port từ desktop (logic tái dùng nguyên tắc, viết lại TS)
- **Poll**: throughput ~10x realtime; deadline 1800s, gia hạn theo `audio_duration_ms`; in-poll retry (5 lần, backoff 3→30s) cho network blip; `status=error` → hard fail không retry. (port `transcribe_soniox_file_id`)
- **Parse** `tokens[]` → `TranscriptPart[]`: gộp token cùng `speaker` liên tiếp; split khi đổi speaker / gap ≥ 2s / segment ≥ 60s; hallucination filter. (port `_parse_soniox_segments`)
- **Webhook**: Soniox hỗ trợ webhook thay polling — v1 dùng polling (đơn giản, hợp "đóng app quay lại poll tiếp" qua `soniox_job_id` lưu DB). Webhook = cân nhắc v2.

### TS interface (đề xuất)
```ts
// packages/core/soniox-client
submitFile(fileUri: string, key: string): Promise<{ fileId: string }>
createJob(fileId: string, opts: { languageHints: string[]; key: string }): Promise<{ transcriptionId: string }>
pollUntilDone(transcriptionId, key, onProgress?): Promise<void>   // throws SonioxTerminalError on status=error/402
getTranscript(transcriptionId, key): Promise<TranscriptPart[]>     // parse + group
cleanup(transcriptionId, fileId, key): Promise<void>              // best-effort
```

## Còn lại (hẹp, làm trong Phase 04, KHÔNG chặn)
- Smoke test multipart upload từ **RN fetch + FormData** (file:// uri) lên `/v1/files` — RN FormData append `{uri, name, type}`; verify trên device.
- Theo dõi giới hạn size/duration thực tế (docs không nêu cap rõ) — đặt ngưỡng cảnh báo client.
- Quyết polling vs webhook (v1 = polling).
