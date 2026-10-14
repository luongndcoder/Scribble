# Nhiệm vụ

Người dùng báo phần tạo biên bản (meeting minutes) "chưa ổn". Rà lại toàn bộ luồng `/summarize` và auto-summary sau upload trong bản Rust, so với bản Python cũ (`summarize.py`, `upload_pipeline.py`).

# Đã sửa gì

- **`src-tauri/src/llm.rs`:**
  - `SseLineBuffer`: gom byte theo dòng rồi mới decode UTF-8. Trước đây mỗi network chunk được `from_utf8_lossy` riêng, nên ký tự tiếng Việt bị cắt giữa hai chunk biến thành `�`.
  - `llm_client()`: bỏ total timeout (300s cho stream, 120s cho map step), thay bằng `connect_timeout` 15s + `read_timeout` 600s, giống `httpx.Timeout(600, connect=5)` của OpenAI SDK.
  - `chunk_transcript` đo độ dài bằng `chars().count()` thay vì byte.
  - Single-pass luôn có nhãn `Transcript:` như Python.
  - Map/section step dùng temperature 0.2 như Python (`complete_with_temperature`).
  - `complete` trả `""` khi `content` null (reasoning model hết budget), thay vì làm hỏng cả MapReduce.
- **`api/transcription.rs`:** `load_reference_context` và `reference_system_note` thành `pub(crate)` để dùng chung.
- **`api/upload.rs`:** auto-summary sau upload dùng đúng khối `=== REFERENCE MATERIALS ===` và system note. Trước đó text đính kèm được dán thô trước transcript.
- **`use-summarize.ts`:** stream lỗi giữa chừng thì không lưu bản cụt, khôi phục summary cũ trong store.
- **Test mới:** `multibyte_char_split_across_network_chunks_stays_intact`, `chunk_size_counts_characters_not_bytes`.

# Vấn đề thực sự

Bản port giữ đúng prompt và đúng format SSE nhưng sai ở tầng transport và tầng đếm:

- Decode UTF-8 theo network chunk, không theo dòng.
- Timeout tổng cho một request stream dài nhiều phút.
- `str::len()` trong Rust là byte, còn `len()` trong Python là ký tự.

Cả ba đều không lộ ra khi test bằng transcript tiếng Anh ngắn.

# Tại sao chọn cách này

- Buffer byte và tách theo `\n` là cách tối thiểu: `\n` không bao giờ nằm trong một chuỗi UTF-8 nhiều byte, nên một dòng hoàn chỉnh luôn decode được.
- `read_timeout` vẫn bắt được kết nối chết, nhưng không cắt một stream chậm mà vẫn đang chạy.
- Dùng lại hàm của `/summarize` cho upload, thay vì copy chuỗi prompt sang chỗ thứ hai.

# Hình dạng production

```
POST /summarize ─→ llm::summarize_stream_with_context
   ├─ < 120k chars: 1 stream call (Transcript: …)
   └─ ≥ 120k chars: map (0.2) → section reduce (0.2) → final stream
provider SSE bytes → SseLineBuffer → handle_stream_line → event: chunk {"token": …}
Upload pipeline → summarize_transcript → cùng reference block + system note
```

# Các cách khác khả thi

1. Dùng `std::str::from_utf8` với `Utf8Error::valid_up_to()` để giữ lại phần đuôi chưa đủ byte.
2. Dùng crate `eventsource-stream` để parse SSE.
3. Giữ total timeout nhưng tăng lên 30 phút.

# Tại sao không chọn các cách đó

1. Đúng, nhưng phức tạp hơn tách theo dòng, trong khi SSE vốn đã xử lý theo dòng.
2. Thêm dependency cho một parser chỉ khoảng 20 dòng. Nên dùng khi cần hỗ trợ đầy đủ spec SSE (`id:`, `retry:`, multi-line data).
3. Vẫn cắt được meeting rất dài với model chậm, và một kết nối treo phải chờ 30 phút mới báo lỗi.

# Khái niệm cốt lõi cần nắm

- **Ranh giới network chunk không trùng với ranh giới ký tự:** phải decode sau khi đã gom đủ một đơn vị logic (một dòng, một frame).
- **Total timeout và read timeout:** stream dài cần read timeout (idle), không cần total timeout.
- **Byte và ký tự:** con số "15.000 ký tự" của Python là code point. Trong Rust phải dùng `chars().count()`.

# Lỗi thường gặp

- Test parser SSE chỉ với ASCII, nên lỗi UTF-8 không bao giờ hiện ra.
- Copy hằng số timeout từ một request ngắn sang một request stream.
- Port một hàm `load_*` nhưng chỉ trả dữ liệu thô, bỏ mất phần framing nằm ở hàm khác.
- Frontend lưu kết quả một phần khi stream báo lỗi, đè lên dữ liệu tốt trước đó.

# Ví dụ nhỏ

```rust
let wire = "data: {\"choices\":[{\"delta\":{\"content\":\"họp ạ\"}}]}\n";
let cut = wire.find('ạ').unwrap() + 1; // cắt giữa 3 byte của "ạ"
// Cách cũ: from_utf8_lossy(&bytes[..cut]) + from_utf8_lossy(&bytes[cut..]) → "họp ��"
// Cách mới: SseLineBuffer chỉ decode khi gặp '\n' → "họp ạ"
```

# Lần sau nên nghĩ thế nào

Khi port code xử lý text hoặc stream sang Rust, cần kiểm tra ba điểm:

- Đơn vị đo là byte hay ký tự?
- Decode ở ranh giới nào?
- Timeout là tổng hay idle?

Luôn có ít nhất một test với tiếng Việt có dấu, và một test cắt input ở vị trí xấu nhất.
