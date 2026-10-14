# Nhiệm vụ

Đưa model NVIDIA Nemotron 3.5 ASR Streaming 0.6B vào app, chạy bằng Rust (không Python). Trên macOS dùng bản MLX (GPU), các nền tảng khác chạy ONNX. Model tải về khi người dùng chọn trong Cài đặt.

# Đã sửa gì

- `src-tauri/src/stt/local.rs`: thêm trait `StreamingAsr` (accept / flush / is_endpoint / tokens / finalize / set_language / reset_stream) để worker live không phụ thuộc engine. Engine sherpa nhận diện được cả Zipformer lẫn Nemotron ONNX (`StreamingModelKind`), đặt ngôn ngữ cho từng stream bằng `set_option("language")`.
- `src-tauri/src/stt/model_download.rs` (mới): tải model theo gói (ONNX int8 683MB, hoặc MLX bf16 1,2GB khi build có feature `mlx`), ghi vào `*.part` rồi mới rename, có progress.
- `src-tauri/src/stt/nemotron_mlx/` (mới, chỉ macOS + feature `mlx`): port của `mlx-audio` (MIT) sang `mlx-rs`. `mel.rs` là frontend log-mel streaming; `model.rs` gồm encoder FastConformer có cache, prompt ngôn ngữ và decoder RNN-T greedy; `mod.rs` là engine, kèm endpoint giả lập và nạp `mlx.metallib` từ app bundle.
- `src-tauri/src/stt.rs`: WS `/ws/local-stream` chọn engine theo setting `local_engine`, lấy ngôn ngữ từ `stt_language`.
- `src-tauri/src/api/mod.rs`: `/local/model-status` và `/local/download-model` báo theo engine, nhận `?engine=`.
- `src/components/SettingsPanel.tsx`: chọn Zipformer / Nemotron trong mục Local.
- `src/components/recording/stt-message-reducer.ts` + `appStore.ts`: dấu câu đến muộn ở đầu final được nối vào cuối câu trước.
- `Cargo.toml`: `mlx-rs` là dependency tuỳ chọn sau feature `mlx`. `build.sh` bật feature này khi máy build có Metal Toolchain, và chép `mlx.metallib` vào `Contents/Resources/`.

# Vấn đề thực sự

1. sherpa-onnx đã hỗ trợ Nemotron từ v1.13.5, nhưng ngôn ngữ phải đặt theo từng stream (`set_option`), và feature dim là 128 chứ không phải 80.
2. Chưa ai port Nemotron sang `mlx-rs`, nên phải tự port toàn bộ khoảng 1.900 dòng Python.
3. `mlx-rs` luôn biên dịch shader Metal, nên máy build cần Metal Toolchain, và file `mlx.metallib` bị ghi vào một đường dẫn chỉ tồn tại trên máy build.

# Tại sao chọn cách này

- Làm ONNX trước vì có ngay một bản tham chiếu chạy được để đối chiếu với bản MLX tự port, đồng thời đó cũng là engine cho Windows/Linux.
- Dùng trait `StreamingAsr` để tracker người nói và luồng partial/final dùng lại nguyên vẹn, không phải viết lại cho từng engine.
- Viết forward bằng `Array` + ops thay vì các struct `Module`: code bám sát bản Python từng dòng nên dễ đối chiếu.

# Hình dạng production

```
WS PCM → LocalStreamingStt worker → Arc<dyn StreamingAsr>
            ├─ sherpa: Zipformer (bundled) / Nemotron ONNX (download)
            └─ macOS+mlx: NemotronMlxEngine (GPU, download, metallib in bundle)
         → token + timestamp → SpeakerTracker → final/partial kèm speaker
```

# Các cách khác khả thi

1. Chỉ dùng ONNX trên mọi nền tảng.
2. Gọi Python `mlx-audio` qua subprocess.
3. Dùng NeMo-Speech.cpp (bản GGUF chính thức của NVIDIA).

# Tại sao không chọn các cách đó

1. ONNX trên Mac ăn 4 luồng CPU suốt cuộc họp; MLX chạy GPU và để CPU rảnh. Nếu không cần hiệu năng trên Mac thì ONNX là đủ.
2. Python bị loại bỏ khỏi sản phẩm; mang lại runtime Python là đi ngược quyết định đó.
3. GGUF/C++ cần thêm FFI và một runtime mới; đáng cân nhắc nếu sau này cần CUDA trên Windows.

# Khái niệm cốt lõi cần nắm

- **Cache-aware streaming:** mỗi layer giữ cache attention 56 frame và cache conv 8 frame, nên mỗi chunk 560ms chỉ tính phần mới, không tính lại từ đầu.
- **Prompt ngôn ngữ:** vector one-hot 128 chiều được nối vào output của encoder rồi đi qua một MLP.
- **Shader biên dịch lúc build:** phải ship file `mlx.metallib` cùng app.
- **Lazy evaluation của MLX:** muốn đo thời gian từng phần thì phải `eval()` trước khi bấm giờ.

# Lỗi thường gặp

- Tắt `default-features` của `mlx-rs` vẫn không tắt được Metal, vì `mlx-rs` bật mặc định feature của `mlx-sys`.
- Chuyển activation sang bf16 không làm nhanh hơn. Nút thắt là chi phí khởi chạy kernel cho các chunk nhỏ, không phải chi phí đổi kiểu dữ liệu.
- Endpoint 1,2s cắt câu trước khi model kịp phát dấu câu.

# Ví dụ nhỏ

```rust
// Chọn engine theo thư mục model.
#[cfg(all(target_os = "macos", feature = "mlx"))]
if nemotron_mlx::is_mlx_dir(dir) { return NemotronMlxEngine::new(dir).map(|e| Arc::new(e) as _); }
StreamingZipformerEngine::new(dir).map(|e| Arc::new(e) as _)
```

# Lần sau nên nghĩ thế nào

Khi port một model, hãy dựng một bản tham chiếu chạy được trước (ở đây là ONNX), rồi đối chiếu đầu ra của bản port với nó. Với một dependency biên dịch native, kiểm tra từ đầu xem artefact build nằm ở đâu và có được ship cùng app không.
