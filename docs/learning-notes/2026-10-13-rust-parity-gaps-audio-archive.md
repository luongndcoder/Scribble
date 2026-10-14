# Nhiệm vụ

Rà lại các chức năng còn thiếu sau khi migrate backend Python sang Rust, rồi sửa 4 nhóm lỗi đã chọn:

1. Lưu audio và auto-save transcript khi ghi system audio; dọn các upload bị kẹt.
2. Làm upload Soniox an toàn hơn.
3. Sửa các lỗi nhỏ.
4. Dọn code thừa và port route retry.

# Đã sửa gì

- **`src-tauri/src/audio_archive.rs` (mới).**
  - `SystemArchive` ghi PCM của system audio vào `meeting_N.pcm` và đặt file này làm `audio_path`.
  - Chunk mic (chế độ "both") được ghi vào file phụ `meeting_N_mic.<ext>`.
  - `finalize_mix` dùng ffmpeg trộn hai file thành `meeting_N_mix.m4a`. Bước này chạy lazy, ở lần phát hoặc tải audio đầu tiên.
  - Khi resume một draft đã mix, file mix cũ được chuyển thành `_prev.m4a` và concat vào đầu ở lần mix sau.
- **`stt.rs`:** cả hai WebSocket handler đọc `source` và `meeting_id`, và ghi archive khi `source=system`.
- **`draft_audio.rs`:** chunk mic không còn bị bỏ đi (`pcm_active`) mà được ghi vào file phụ.
- **`audio.rs`:** `stream_audio` và `download_audio` gọi `finalize_mix` trước khi phục vụ file.
- **`RecordingBar.tsx`:**
  - Autosave transcript mỗi 30 giây (chỉ khi transcript thay đổi), áp dụng cho mọi chế độ ghi.
  - Hàm `serializeTranscriptParts` dùng chung cho autosave và lúc bấm Stop.
- **`upload.rs`:**
  - `fail` gọi `discard_if_empty`: chưa có transcript thì xoá meeting và audio.
  - `recover_stuck_uploads` chạy lúc khởi động.
  - Upload ra audio rỗng thì đặt meeting về `saved`.
  - Route `POST /meetings/:id/retry-failed-chunks` chạy lại toàn bộ pipeline.
  - Lý do bỏ qua biên bản giờ là `user_opted_out`, `summarize_error: …` hoặc `summarize_empty`.
- **`soniox_async.rs`:**
  - Upload stream thẳng từ đĩa (`ReaderStream`), có retry backoff 2/4/8 giây.
  - `transcribe_file_split` tách file dài hơn 3.5 giờ và từ chối file dài hơn 24 giờ.
- **`transcription.rs`:** thay `blocking_send` (có thể panic trong async) bằng unbounded relay cộng một forwarder task.
- **`diagnose.rs`:** cảnh báo khi đã chọn Nemotron nhưng chưa tải model.
- **`lib.rs`:**
  - Thêm `tauri-plugin-log` (stdout và file xoay vòng 5MB).
  - Bỏ `SidecarState` và các command `stop_sidecar`/`check_sidecar`.
  - Bỏ exit hook từng `kill -9` tiến trình đang giữ port 8765, tức là chính app.
- **Dọn code thừa:** xoá `LogPanel.tsx` cùng CSS của nó, và hàm `appendDraft` ở frontend.
- **Test mới:**
  - `tests/system_audio_archive.rs`: chạy WebSocket thật, ghi file mic phụ, rồi mix bằng ffmpeg.
  - `tests/upload_recovery.rs`.

# Vấn đề thực sự

Bản port Rust giữ đúng các route nhưng làm mất một số hành vi ngầm:

- WebSocket bỏ qua `meeting_id`, nên không có audio archive.
- Job chỉ nằm trong RAM, nên meeting bị kẹt ở `uploading` khi app crash.
- Không có logger, nên mọi `log::*` bị bỏ.
- Exit hook của sidecar cũ giờ "giết" chính app.

So route là chưa đủ. Phải so sánh **side effect** (file nào được ghi, cột DB nào được cập nhật) và **contract chuỗi** (ví dụ `user_opted_out`).

# Tại sao chọn cách này

- **Mix lazy lúc phát/tải:** status vẫn là `draft` cho tới khi người dùng tạo biên bản, nên không có thời điểm "kết thúc" rõ ràng. Còn lần nghe hoặc tải đầu tiên thì chắc chắn xảy ra sau khi đã ghi xong.
- **Tập `ACTIVE`:** không bao giờ mix khi WebSocket vẫn đang ghi vào meeting đó.
- **Autosave ở frontend thay vì server:** frontend là nguồn transcript duy nhất (đã gồm speaker và translation). Lưu đúng format lúc Stop thì không bị lệch giữa hai nơi, và mic mode cũng được bảo vệ (Python chỉ autosave ở system mode).
- **Retry chạy lại toàn bộ:** Rust không lưu trạng thái từng chunk. Dùng lại `run_pipeline` đơn giản và đúng, đổi lại tốn quota Soniox hơn.

# Hình dạng production

```
Tauri capture ─PCM→ /ws/*-stream?source=system&meeting_id=N ─→ audio/meeting_N.pcm (audio_path)
Webview mic ─webm→ PATCH /drafts/N/audio ─→ audio/meeting_N_mic.webm
GET /meetings/N/audio[/stream] → finalize_mix → audio/meeting_N_mix.m4a (mono AAC 64k)
Boot → recover_stuck_uploads ; Upload fail → discard_if_empty
Logs → ~/Library/Logs/com.scribble.app/scribble.log
```

# Các cách khác khả thi

1. Mix realtime trong Rust: nhận cả mic lẫn system PCM rồi cộng sample.
2. Mix ngay khi WebSocket đóng (eager), thay vì lazy.
3. Autosave phía server, giống Python: WebSocket handler tự ghép transcript rồi ghi DB.
4. Port đầy đủ `upload_chunks` để retry chỉ những chunk lỗi.

# Tại sao không chọn các cách đó

1. Mic đi qua webview (MediaRecorder webm), không đi qua Rust; phải đổi luồng capture, rủi ro cao. Nên làm khi capture mic chuyển hẳn sang Rust (cpal).
2. Lúc WebSocket đóng thì chunk webm cuối của mic có thể chưa tới (MediaRecorder flush trễ hơn). Mix sớm sẽ mất đuôi.
3. Server không biết speaker và translation mà frontend đã gán, nên dễ lưu một bản khác với bản Stop lưu.
4. Phải thêm bảng, migration và state machine. Đáng làm khi các file rất dài với Soniox hay lỗi giữa chừng.

# Khái niệm cốt lõi cần nắm

- **Parity audit:** so route → hành vi → side effect → contract chuỗi/enum mà UI so sánh bằng `===`.
- **Container không nối được với raw PCM:** webm và PCM là hai định dạng khác nhau, phải giữ hai file rồi mix bằng `amix`; nối kiểu `concat` cần cùng layout (`aformat` mono/48k/fltp).
- **`blocking_send` trong async:** panic khi gọi từ runtime thread. Dùng relay unbounded, hoặc `send().await` ở một task riêng.
- **Log mà không có logger:** crate `log` là facade; không ai `set_logger` thì mọi record bị bỏ một cách im lặng.

# Lỗi thường gặp

- Tin agent nói "no gap" khi thực ra Python cũng có lỗ (delete meeting không xoá file audio). "Giống Python" không có nghĩa là "đúng".
- Sửa sang `git rm --cached` làm thay đổi index của người dùng; phải `git reset -- file` để trả lại.
- Perl regex với ký tự nhiều byte (`─+`) khớp sai vì perl không chạy ở chế độ utf8; nên dùng `[^\n]*`.
- Exit hook của kiến trúc cũ (kill theo port) trở thành tự sát sau khi đổi kiến trúc.

# Ví dụ nhỏ

```bash
cargo test --features mlx --test system_audio_archive -- --nocapture
# [local-stream] ws_frames_in=20 ws_bytes_in=64000 → pcm 64000 bytes → mic companion → _mix.m4a
```

# Lần sau nên nghĩ thế nào

Khi đổi runtime hoặc kiến trúc, lập bảng: endpoint, query param, file ghi ra, cột DB, giá trị enum mà UI so sánh, hook lifecycle (start/exit). Mỗi dòng phải có test hoặc được kiểm tra bằng tay. Đặc biệt soi các param được "nhận nhưng bỏ qua" như `meeting_id`.
