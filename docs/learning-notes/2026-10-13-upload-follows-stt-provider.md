# Nhiệm vụ

Upload file audio để lấy transcript phải đi theo cấu hình STT trong Settings: chọn Soniox thì gọi Soniox, chọn Local thì dùng đúng engine local đã chọn (Zipformer hoặc Nemotron). Trước đó upload luôn chạy model local Zipformer.

# Đã sửa gì

- `src-tauri/src/stt/soniox_async.rs` (mới): port Soniox Async API từ `src-python/stt.py`. Các bước: `POST /v1/files` → `POST /v1/transcriptions` (`stt-async-v5`, bật diarization) → poll mỗi 3s (chịu được network blip, 429, 5xx) → `GET .../transcript` → xoá transcription + file. `parse_segments` tách segment khi đổi speaker, khi im lặng ≥2s, hoặc khi segment dài ≥60s.
- `src-tauri/src/pipeline/mod.rs`: thêm `soniox_transcript_parts`, cho ra cùng shape part với `build_transcript_parts`. Speaker được đánh số lại theo thứ tự xuất hiện.
- `src-tauri/src/api/upload.rs::run_pipeline`: đọc `stt_provider`.
  - `soniox`: upload `normalized.wav`, bỏ qua VAD split và local diarizer.
  - Ngược lại: giữ nguyên path local.
- `src-tauri/src/stt/local.rs::transcribe_wav_file`: dùng engine theo `local_engine`.
  - Engine upload riêng được cache theo model dir.
  - Nemotron chưa tải thì fallback sang Zipformer.
  - Gọi `reset_stream` + `flush` cho đúng contract của Nemotron.
- `examples/latency_probe.rs`: sửa lỗi compile còn sót từ lần đổi trait `StreamingAsr`.

# Vấn đề thực sự

Khi port Python → Rust, pipeline upload cố tình "drop provider matrix": chỉ giữ một đường local. UI Settings vẫn cho chọn Soniox, `UploadAudioModal` cũng kiểm tra key Soniox, nhưng backend bỏ qua lựa chọn này. Kết quả là cấu hình nói một đằng, backend chạy một nẻo, và người dùng không có lỗi nào để nhận ra điều đó.

# Tại sao chọn cách này

- Soniox Async nhận cả file một lần và tự diarize. Chất lượng speaker tốt hơn diarizer local, và không cần cắt chunk.
- Chỉ rẽ nhánh ở một chỗ trong `run_pipeline`. Phần lưu transcript, tóm tắt và cancel vẫn dùng chung.
- Engine upload tách khỏi engine live, để upload không làm hỏng state của buổi ghi âm đang chạy.

# Hình dạng production

```
upload → normalize_to_wav → stt_provider?
   ├─ soniox → soniox_async::transcribe_file(normalized.wav) → soniox_transcript_parts
   └─ local  → split_into_chunks → transcribe_wav_file(engine theo local_engine) per chunk
              → chunk_speaker_map → build_transcript_parts
→ save transcript → (optional) summarize
```

Progress của Soniox được ánh xạ vào khoảng 0.15–0.80 của job. Cancel được kiểm tra trong vòng poll, và khi cancel thì xoá transcription phía Soniox.

# Các cách khác khả thi

1. Dùng Soniox realtime WebSocket, feed file nhanh (giống `soniox_labels` example).
2. Vẫn cắt VAD chunk rồi gửi từng chunk lên Soniox Async.
3. Dùng chung engine live (`get_stream_engine`) cho upload.

# Tại sao không chọn các cách đó

1. Realtime xử lý gần bằng tốc độ thực: file 1 giờ mất khoảng 1 giờ. Async thì nhanh hơn nhiều và rẻ hơn. Realtime chỉ đáng dùng khi cần stream kết quả.
2. Mỗi chunk sẽ có speaker ID riêng, phải ghép lại và mất tính nhất quán. Chỉ đáng làm khi file vượt giới hạn của Soniox (Python tách ở mức >3.5h).
3. Nếu đang ghi âm mà upload song song thì hai luồng giẫm state lên nhau (Nemotron giữ cache encoder liên tục). Cách này chỉ hợp lý nếu chắc chắn không bao giờ chạy song song và cần tiết kiệm RAM (MLX khoảng 1.2GB).

# Khái niệm cốt lõi cần nắm

- **Async vs realtime STT**: async là upload rồi poll; nhanh, có diarization cho cả file. Realtime thì nhận kết quả từng phần nhưng tốc độ ≈ 1x.
- **Poll với retry có phân loại**: lỗi 4xx (trừ 429) thì fail ngay. 429, 5xx và lỗi mạng thì backoff rồi poll tiếp.
- **Cleanup best-effort**: xoá file/transcription phía Soniox nhưng không được che mất kết quả thật.
- **Engine cache theo key**: cache theo model dir, nên đổi Settings sẽ build lại engine.

# Lỗi thường gặp

- Port từ Python mà âm thầm bỏ một nhánh tính năng, trong khi UI vẫn hiển thị nhánh đó.
- Quên `flush()` cho Nemotron: chunk cuối cần right context nên sẽ bị mất đuôi.
- Test dữ liệu quá ngắn (1 ký tự) bị filter min-chars loại, khiến test fail sai lý do.
- In API key trong log/probe: probe chỉ đọc key từ DB và không in ra.

# Ví dụ nhỏ

```rust
let segs = soniox_async::transcribe_file(&key, &wav, &["vi".into()], |f, m| eprintln!("{f:.2} {m}"), || false).await?;
let parts = pipeline::soniox_transcript_parts(&segs); // [{"speaker":"Speaker 1","text":...}, ...]
```

Chạy thử thật trên 90s audio HaveASip: 6 segment, 2 speaker, text đúng.

# Lần sau nên nghĩ thế nào

Mỗi khi port một tính năng, liệt kê mọi setting mà UI cho người dùng chọn và kiểm tra backend có đọc setting đó không (grep key, ví dụ `stt_provider`). Setting mà UI lưu nhưng backend không đọc là dấu hiệu chắc chắn có bug "cấu hình không có tác dụng".
