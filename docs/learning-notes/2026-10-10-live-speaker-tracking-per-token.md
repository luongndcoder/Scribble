# Nhiệm vụ

Ở mode Local, việc nhận diện người nói khi ghi âm kém và không realtime. Mục tiêu: tách người nói theo thời gian thực giống cách Soniox làm.

# Đã sửa gì

- `src-tauri/src/stt/speaker_tracker.rs` (mới): tracker dùng cửa sổ trượt 1,5s, cứ 0,5s một lần. Nó so mỗi cửa sổ với centroid của từng speaker (centroid cập nhật dần kiểu EMA) và với reference của lượt nói hiện tại. Có hysteresis (cần nhiều cửa sổ liên tiếp xác nhận), kiểm tra self-similarity trước khi ghi nhận người mới, và lùi thời điểm đổi người về đúng chỗ bắt đầu. Kết quả là một timeline `sample → speaker` kèm `stable_until`.
- `src-tauri/src/stt/speaker_segments.rs` (mới): gom token BPE theo speaker, chỉ cắt ở đầu từ.
- `src-tauri/src/stt/local.rs`: worker gán speaker cho từng token theo timestamp. Phần đã chắc chắn mà có ranh giới đổi người thì chốt final ngay; phần còn lại là partial kèm speaker tạm thời.
- `src-tauri/src/stt/live_diarize.rs`: bỏ `LiveDiarizer` (quyết định một lần cho cả câu); chỉ còn quản lý profile của phiên, reset và warm-up.
- `src-tauri/src/stt.rs`: writer chỉ còn chuyển tiếp event; reader cấp audio cho tracker; khi dừng thì chốt tracker trước rồi mới flush engine.
- Bỏ trần số người (`DEFAULT_MAX_SPEAKERS`) ở cả diarizer upload lẫn tracker.
- Live tracker dùng model hynt ResNet34 (`resolve_live_model_path`); diarizer upload vẫn dùng ERes2Net.
- Công cụ đo bằng Rust trong `src-tauri/examples/`: `soniox_labels`, `tracker_eval` (có cache embedding và grid tham số), `speaker_oracle`, `live_diar_eval`.

# Vấn đề thực sự

1. Sherpa chỉ chốt một câu sau 1,2s im lặng, nên một "câu" dài 10–20s và chứa nhiều người, nhưng chỉ được gán một speaker.
2. Cổng ghi nhận người mới so ứng viên với *các profile đã có* thay vì so ứng viên với *chính nó*, nên chặn đúng những giọng khác biệt nhất.
3. Audio đuôi 3s của câu trước bị trộn vào câu sau.
4. Embedding của cửa sổ ngắn nhiễu hơn nhiều so với ngưỡng đang đặt. Trần oracle chỉ khoảng 73–80%, nên phải dựa vào ngữ cảnh của lượt nói và hysteresis.

# Tại sao chọn cách này

Sherpa có sẵn timestamp cho từng token, decoding là greedy nên token chỉ thêm vào chứ không bị sửa. Vì vậy gán speaker theo từng token là khả thi mà không cần đổi engine STT. Tách tracker ra thread riêng thì text không bao giờ phải chờ diarize.

# Hình dạng production

```
PCM ─┬─> sherpa worker ──tokens+ts──┐
     └─> SpeakerTracker ─timeline──>├─> group_by_speaker ─> final (đã chắc) / partial (tạm)
```

# Các cách khác khả thi

1. Re-cluster định kỳ toàn bộ lịch sử, rồi gửi `speaker_correction` để sửa nhãn cũ (Otter làm kiểu này).
2. Model embedding lớn hơn (ResNet293: oracle 80% nhưng mất khoảng 1,5s CPU cho mỗi cửa sổ).
3. Giữ cách quyết định theo câu, chỉ sửa các bug.

# Tại sao không chọn các cách đó

1. Re-cluster đúng hơn về danh tính, nhưng UI phải sửa những đoạn đã hiển thị, và store phải lưu text theo từng chunk. Nên làm khi danh tính speaker là ưu tiên số một.
2. ResNet293 không chạy kịp realtime trên CPU.
3. Giữ cách theo câu thì không bao giờ realtime được, vì câu dài tới 20s.

# Khái niệm cốt lõi cần nắm

- **Oracle ceiling:** đo trần của model trước khi chỉnh ngưỡng. Nếu trần thấp thì chỉnh ngưỡng vô ích.
- **Thước đo phải hợp lệ:** Soniox gộp 8 người thành 3 nên không dùng làm chuẩn danh tính được, nhưng ranh giới đổi người của nó vẫn dùng được.
- **Provisional vs stable** (giống token final / non-final của Soniox).

# Lỗi thường gặp

- `try_recv()` lấy luôn tín hiệu dừng rồi vứt đi, khiến thread chờ mãi (deadlock khi `finish()` join thread).
- Một cửa sổ mơ hồ reset chuỗi xác nhận, nên người mới không bao giờ được xác nhận.
- Gửi audio cho Soniox realtime nhanh hơn tốc độ thực chỉ làm audio xếp hàng phía server; tiến trình trông như bị treo.

# Ví dụ nhỏ

```rust
// Mỗi TỪ lấy speaker của mảnh token đầu tiên — không bao giờ cắt giữa từ.
if i == from || tokens[i].starts_with(' ') { word_speaker = speaker_at(times[i]); }
```

# Lần sau nên nghĩ thế nào

Trước khi chỉnh thuật toán, hãy đo trần của model và kiểm tra ground truth có đáng tin không. Lần này có ba lần "kết quả xấu" thực ra là do thước đo sai, không phải do code.
