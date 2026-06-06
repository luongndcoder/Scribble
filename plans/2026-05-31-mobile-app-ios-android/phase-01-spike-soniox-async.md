# Phase 01 — Spike: Soniox Async File API (DECISION GATE)

> Loại: spike de-risk (hands-on, KHÔNG TDD). Chặn Phase 04 (soniox-client) + Phase 08 (upload).
> Mục tiêu: xác minh giả định nền của toàn kiến trúc cloud-direct — rủi ro #2.
> Có thể dùng `/be-research` để đối chiếu docs Soniox, nhưng PHẢI test bằng 1 file thật.

## Câu hỏi cần trả lời (giả định trong brainstorm)

1. Soniox có **async file transcription API** (upload file → job → poll/callback) ngoài realtime WS không? Endpoint + auth (Bearer key)?
2. Async có **speaker diarization** (speaker labels) không, hay diarization chỉ ở realtime? ⟵ **câu chốt nhất**: nếu async KHÔNG diarize → kiến trúc đổi.
3. **Giới hạn**: max file size, max duration, định dạng nhận (m4a/aac/wav/mp4?), thời gian xử lý ~ realtime ratio.
4. **Ngôn ngữ**: hỗ trợ vi + đa ngôn ngữ trộn trong 1 file (như realtime)?
5. **Cost** model async (per phút?) so realtime — để hiển thị cảnh báo phút như desktop.
6. **Response shape**: tokens/segments có `start_ms/end_ms` + `speaker` không? → map sang `TranscriptPart[]`.
7. Có **timestamps** đủ để render `0:14 – 0:39` per turn không?

## Cách làm

- Lấy 1 file họp thật **đa người nói, ~10–15'** (m4a). Dùng Soniox API key sẵn có.
- Gọi async flow bằng curl/script Node: submit file → poll job → lấy result JSON. Lưu raw response làm fixture.
- Đối chiếu với docs chính thức (qua `/be-research` nếu cần) cho limits/cost/ngôn ngữ.

## DECISION GATE — rẽ nhánh kiến trúc

| Kết quả | Quyết định |
|--------|-----------|
| ✅ Async **có diarization + timestamps + limit/cost OK** | Đi tiếp đúng plan: Phase 04 dựng `soniox-client` (submit/poll/parse). Record-to-file v1 giữ nguyên. |
| ⚠️ Async OK nhưng **thiếu diarization** | Cân nhắc: (a) chấp nhận v1 không tách người nói cho bản async + bật diarization ở v2 live-WS; hoặc (b) đẩy realtime-WS lên sớm. **Báo user chọn.** |
| ⚠️ Limit xấu (file ngắn / đắt / format hẹp) | Điều chỉnh UX (giới hạn độ dài, nén client trước upload) hoặc đổi sang chunk-on-device. **Báo user.** |
| ❌ Không có async file API tin cậy | Pivot: realtime-WS streaming thành path chính ngay v1 (đắt hơn — đổi Phase 06). **Báo user trước khi đi tiếp.** |

## Deliverable

- `spikes/soniox-async/SPIKE-RESULT.md`: endpoint + auth, có/không diarization, limits (size/duration/format), ngôn ngữ, cost, response shape mẫu (+ fixture JSON), khuyến nghị mapping `TranscriptPart[]`.
- Fixture JSON dùng lại làm test data Phase 04.
- Cập nhật `plan.md` → risk #2 status + chốt nhánh kiến trúc.
