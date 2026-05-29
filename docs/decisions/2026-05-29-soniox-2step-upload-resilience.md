# Soniox 2-step upload + Resilience Architecture

**Date:** 2026-05-29
**Version:** v1.2.14
**Status:** Shipped
**Tags:** architecture, resilience, soniox, upload-pipeline

## Context

v1.2.13 shipped Soniox chunked path (>3.5h files auto-split, per-chunk persist, retry banner). User testing surfaced 3 classes of friction the v1.2.13 design didn't handle:

1. **Network blip mid-upload** — wifi rớt 5s giữa Soniox transcribe → entire 200MB chunk redone from scratch
2. **DOM lag on 4h+ transcripts** — auto-load-more append-only → unbounded DOM growth → app freeze
3. **Sidecar crash mid-upload** — meeting stuck `status='uploading'` zombie state; user phải re-upload toàn bộ

3 architectural decisions below address these collectively.

---

## Decision 1: Soniox 2-step upload pattern

### What

Refactor `transcribe_soniox_file()` from single bundled call into 3 phases:

| Phase | API call | Cost on retry |
|---|---|---|
| A — Upload | `POST /v1/files` (multipart, 200MB) | Full re-upload |
| B.1 — Create job | `POST /v1/transcriptions` (JSON ~1KB) | Cheap re-POST |
| B.2 — Poll loop | `GET /v1/transcriptions/{id}` (every 3s) | In-poll retry handles network blips |
| B.3 — Fetch result | `GET .../transcript` | Cheap re-fetch |
| Cleanup | `DELETE /v1/files/{id}` | Best-effort |

Plus 3 custom exception types: `SonioxUploadError`, `SonioxJobError`, `SonioxPollError` để retry loop biết phase nào fail mà CHỈ retry phase đó.

### Why this matters

- **Phase B failure không force re-upload**: 5xx khi create job → retry chỉ POST 1KB JSON thay vì 200MB binary
- **In-poll resilience**: tolerate 5 consecutive network errors with linear backoff (3s/6s/9s/12s/15s, cap 30s) trước khi bubble up — wifi blip 30s không kill 200MB upload
- **Phase-aware retry loop in upload_pipeline.py**: `cached_file_id` được preserve qua retry attempts; chỉ reset khi `SonioxUploadError`
- **Fail-fast**: sai API key / file format → fail tại Phase A trước khi tốn upload 200MB

### Consequences

**Wins:**
- Cost matrix: 5xx-after-upload từ "800MB redo" → "200MB + 4KB"
- UI message rõ ràng: "Đang tải file lên" vs "Soniox đang xử lý" vs "Thử lại tải lên" vs "Thử lại xử lý"
- Error attribution chính xác hơn cho user feedback

**Trade-offs:**
- Resumable upload vẫn KHÔNG support (Soniox không cung cấp) — Phase A re-upload từ 0 vẫn là pain cho file lớn
- Caller giờ own file lifecycle (cleanup trong `finally`); orphan file risk nếu code path bỏ sót — mitigation: cleanup ở finally ngoài retry loop

### Alternatives considered

- **Webhook callback thay polling**: rejected — Scribble là desktop app localhost, không có public HTTPS endpoint cho Soniox callback (xem chi tiết trong conversation v1.2.14)
- **`audio_url` thay file upload**: rejected — Scribble không host CDN (zero manual setup principle)

### Files

- `src-python/stt.py` — new `upload_soniox_file()`, `transcribe_soniox_file_id()`, `delete_soniox_file()`, custom exceptions
- `src-python/services/upload_pipeline.py` — chunked retry loop với `cached_file_id`

### References

- [Soniox Upload File](https://soniox.com/docs/stt/api-reference/files/upload_file)
- [Soniox Create Transcription](https://soniox.com/docs/stt/api-reference/transcriptions/create_transcription)

---

## Decision 2: Sliding window cap cho transcript rendering

### What

Transcript pagination chuyển từ "cursor-based open-tail" (v1.2.13) sang **sliding window** với cap cứng MAX_WINDOW_SIZE=400 parts. Both edges slide:

- Scroll lên đầu → start lùi 200, end lùi 200 (trim 200 parts dưới)
- Scroll xuống đáy → end tiến 200, start tiến 200 (trim 200 parts trên)
- Reach tail → cả 2 anchor về `null` (default tail-follow mode, live append flow tự nhiên)

Cursor model: `topAnchorChunkId` + `bottomAnchorChunkId` (cả 2 đều chunkId, stable across mutations). Scroll restoration qua `data-chunk-id` attribute + getBoundingClientRect anchor.

### Why

4h+ recordings → 1500+ transcript parts → mỗi part ~150-300px DOM → 300k+ pixel scroll height → WebKit/WebView2 freeze.

v1.2.13 cursor mode chỉ slide TOP, BOTTOM open. Scroll up nhiều lần = DOM grow unbounded.

### Consequences

**Wins:**
- DOM cap cứng 400 parts bất kể transcript dài bao nhiêu
- Live recording UX: tail-follow tự động khi user ở đáy, không yank khi user scroll lên đọc
- Scroll position preservation cả 2 chiều (anchor element approach robust hơn scrollHeight delta)

**Trade-offs:**
- `topAnchor` có thể "drift" 1 vị trí mỗi live append khi user pin nửa chừng + tail open — accepted (user near tail muốn follow live anyway)
- Render-layer only — store vẫn giữ full array (export/copy/search vẫn thấy ALL)

### Files

- `src/components/MeetingDetail.tsx` — `visibleStartIdx` cap formula `Math.max(startFromAnchor, visibleEndIdx - MAX_WINDOW_SIZE)`
- `src/index.css` — sentinel styles (top + bottom)

---

## Decision 3: Boot-time meeting resurrection

### What

Sidecar startup scan `meetings WHERE status='uploading'` (stuck từ crash trước) và apply 3-policy:

| State | Action |
|---|---|
| Có chunks status='done' | Flip pending chunks → 'failed', meeting → 'saved' (partial transcript đã có sẵn từ per-chunk rebuild) |
| Có chunks, none done | Flip pending → 'failed', meeting → 'failed'. File audio giữ nguyên → retry-failed-chunks endpoint resume |
| Không có chunks | Delete meeting + audio file (v1.2.11 cleanup policy) — không có gì resumable |

Plus **Fix C (preserve meeting on cancel/fail)**: failure handler giờ kiểm tra `_has_chunk_plan(meeting_id)` — nếu có chunk plan, KHÔNG xoá meeting + audio (multi-GB file không bị mất).

### Why

v1.2.13: sidecar crash giữa upload → meeting zombie state, retry banner không hiện, user phải re-upload toàn bộ. Cancel mid-upload → meeting bị xoá kèm audio file → cũng phải re-upload.

### Consequences

**Wins:**
- Recovery automatic on next boot — không cần user action
- Cancel an toàn — chunk plan + audio file giữ lại, có thể resume
- v1.2.11 duplicate-detection vẫn không bị poison (chỉ delete khi truly không có gì)

**Trade-offs:**
- Boot scan latency O(stuck_meetings) — typically 0-2 rows, không lo
- "saved" status với failed chunks: user mở meeting thấy partial transcript + retry banner (đúng intent)

### Files

- `src-python/db.py` — `mark_pending_chunks_failed()`, `list_stuck_uploading_meetings()`
- `src-python/main.py` — lifespan hook call `resurrect_stuck_meetings_on_boot()`
- `src-python/services/upload_pipeline.py` — `_has_chunk_plan()` helper + failure handler branch

---

## Combined cost matrix (v1.2.14 vs v1.2.13)

| Failure scenario | v1.2.13 | v1.2.14 |
|---|---|---|
| Wifi blip <15s khi poll | Bubble exception → re-upload 200MB | In-poll retry tự lành, không bubble |
| 5xx khi create job | Re-upload 200MB × 4 = 800MB | Re-POST 1KB × 4 = 4KB |
| Sai API key | Fail SAU 200MB upload | Fail TẠI Phase A, 0 byte tốn |
| Sidecar crash mid-upload | Meeting zombie + re-upload toàn bộ | Auto-resurrect + retry chỉ failed chunks |
| Cancel mid-chunked upload | Delete meeting + audio file | Preserve + status='cancelled', resume được |
| Render 4h transcript | DOM grow unbounded → freeze | DOM cap 400 parts, smooth |

---

## Open questions

- **Soniox file expiration policy**: docs không nói file_id giữ bao lâu nếu không transcribe. Hiện code cleanup ngay trong `finally` nên không lo, nhưng nếu Soniox auto-purge sau 24h, edge case sidecar crash giữa Phase A & B có thể lose file. Cần liên hệ Soniox support để confirm.
- **Network probe target choice**: hiện dùng `1.1.1.1:443` Cloudflare. Có nên check thêm `api.soniox.com:443` để detect Soniox-specific outage tách biệt với generic internet down? Defer to v1.2.15 nếu user feedback need.
- **Test infrastructure**: project chưa có pytest suite. Smoke tests inline trong conversation pass nhưng không repeatable. v1.2.15 nên invest vào pytest setup cho regression coverage.
