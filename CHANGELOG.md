# Changelog

Tất cả thay đổi đáng chú ý của Scribble được ghi tại đây.

## [1.3.0] - 2026-06-09

### Added
- Ghi âm realtime offline qua nemotron MLX (macOS Apple Silicon): không cần cloud key, đa ngôn ngữ, có UI tải và theo dõi tiến trình model.
- STT offline tiếng Việt (sherpa-onnx) bundled sẵn.
- Đồng bộ phát lại với transcript: auto-scroll theo audio, bấm timestamp để seek.
- Tùy chọn khi upload: tạo biên bản ngay hoặc chỉ lấy transcript (mặc định tắt).

### Changed
- Chuyển model tách người nói sang CAM++ zh-cn-common 200k (192-dim) + diarization theo cửa sổ 2s, cải thiện độ chính xác cho tiếng Việt và ngôn ngữ châu Á.
- Kiểu biên bản mặc định: "Phân tích chi tiết".
- Tinh gọn UI tab Local.

### Fixed
- Chọn provider Local không còn yêu cầu Nvidia API key (upload, ghi âm, kiểm tra kết nối).
- Soniox phiên dài (>1h) không còn gộp toàn bộ vào một speaker.
- Trạng thái "Sẵn sàng dùng offline" chỉ hiển thị khi model tải xong.

### Removed
- Model voxceleb CAM++ cũ và phần code embedding/cluster không còn dùng.
