# Nhiệm vụ

Bỏ toàn bộ các bước Python khỏi CI/CD (macOS, Windows, Linux, release manifest), vì backend giờ là Rust native (axum chạy in-process trong Tauri).

# Đã sửa gì

- `scripts/fetch-build-deps.sh` (mới), dùng chung cho CI và `build.sh`. Mọi file tải về đều được pin sha256 và cache lại.
  - Tải Zipformer-30M streaming từ HuggingFace `hynt/Zipformer-30M-RNNT-Streaming-6000h`, bản encoder chunk-16. Bản này được chọn sau khi đối chiếu sha256 với file đang bundle.
  - Tải ffmpeg static (`eugeneware/ffmpeg-static` b6.1.1) và đặt thành sidecar `src-tauri/binaries/scribble-ffmpeg-<triple>`.
  - Chỉ kiểm tra sự tồn tại của `tokens.txt` và `speaker_embedding_resnet34.onnx` (hai file này commit trong git).
- `tauri.conf.json`: `externalBin: ["binaries/scribble-ffmpeg"]`.
- `api/audio.rs::find_ffmpeg`: ưu tiên `scribble-ffmpeg` nằm cạnh executable, sau đó mới tới PATH và Homebrew.
- `build-macos.yml`, `build.yml`, `build-linux.yml`:
  - Xoá setup-python, uv, PyInstaller, các bước tạo sidecar shim và model CAM++.
  - Thêm bước "Fetch models + ffmpeg".
  - Riêng macOS:
    - Thêm bước kiểm tra Metal toolchain.
    - Build `--features mlx` với `MLX_RS_METAL_PATH`.
    - Đặt `MACOSX_DEPLOYMENT_TARGET=14.0`.
    - Upload `mlx.metallib` lên release.
- `release-manifest.yml`: thay `python3` heredoc bằng `node` heredoc. Logic giữ nguyên.
- `build.sh`: gọi `scripts/fetch-build-deps.sh` thay cho phần tự kiểm tra model.
- `.gitignore`: ignore các file model tải về. Chỉ `tokens.txt` và resnet34 là commit được.

# Vấn đề thực sự

Chỉ xoá các bước Python thì CI vẫn hỏng, vì Python đang gánh ngầm 2 việc:

1. **ffmpeg**: trước đây đi kèm qua wheel `imageio-ffmpeg` bên trong sidecar. Bản Rust không bundle ffmpeg, nên trên máy người dùng không có Homebrew, upload và export audio đều lỗi "ffmpeg binary not found". Lỗi này đã có sẵn trong bản Rust, chỉ chưa ai thấy vì máy dev có Homebrew.
2. **Model**: model chưa từng được commit; máy dev có sẵn nên build local vẫn chạy. Trên CI checkout sạch thì không có model nào.

# Tại sao chọn cách này

- **Một script dùng cho cả CI và local**: không bị lệch giữa hai môi trường, và tự kiểm chứng được bằng `bash scripts/fetch-build-deps.sh` trên máy.
- **Sidecar `externalBin`, không dùng `resources`**: Tauri đặt sidecar cạnh exe, giữ quyền thực thi và codesign nó cùng app (cần cho notarize). Một file nằm trong resources thì có thể mất bit `+x`, và trên macOS không được ký như một executable.
- **Tên `scribble-ffmpeg`**: gói `.deb` cài sidecar vào `/usr/bin`. Nếu đặt tên `ffmpeg` sẽ đụng với package ffmpeg của hệ thống.
- **Pin sha256**: HuggingFace hoặc GitHub có thể bị thay file. Build phải tái lập được và an toàn trước supply chain.

# Hình dạng production

```
CI (tag v*) → fetch-build-deps.sh <triple>
            → [macOS] Metal? → tauri build --features mlx (MLX_RS_METAL_PATH)
            → upload DMG / tar.gz / .sig / mlx.metallib
release-manifest → node dựng latest.json từ các .sig
App: Contents/MacOS/{voicescribe, scribble-ffmpeg}, Resources/{zipformer, resnet34}
```

App macOS tăng từ 90MB lên 108.6MB (DMG) vì có thêm ffmpeg.

# Các cách khác khả thi

1. Decode audio bằng Rust (crate `symphonia`), bỏ hẳn ffmpeg.
2. Host các model trên GitHub Release riêng (vd tag `models-v1`) thay vì commit vào git.
3. Commit cả 4 file Zipformer vào git.
4. Bỏ ffmpeg trong resources thay vì dùng externalBin.

# Tại sao không chọn các cách đó

1. Symphonia decode được mp3/m4a/wav, nhưng còn silencedetect (VAD split) và export audio phải viết lại. Nhiều việc hơn, nên làm thành task riêng nếu muốn app nhẹ thêm khoảng 18MB.
2. Repo nhẹ hơn nhưng thêm một bước upload thủ công, và dễ quên khi đổi model. Đáng dùng khi model lớn hơn 100MB (giới hạn của GitHub).
3. Repo phình thêm khoảng 50MB mà HuggingFace đã host ổn định. Có pin sha256 thì vẫn tái lập được.
4. Gặp vấn đề quyền `+x` và codesign như đã nêu ở trên.

# Khái niệm cốt lõi cần nắm

- **Tauri externalBin**: file nguồn phải có tên `name-<target-triple>[.exe]`; khi bundle, Tauri bỏ hậu tố triple và đặt file cạnh main exe.
- **Phụ thuộc ngầm khi migrate**: tính năng mà runtime cũ (Python wheel) "tặng kèm" sẽ biến mất khi đổi runtime. Hãy liệt kê mọi binary và model mà bản cũ ship kèm.
- **Build tái lập được**: mọi input lấy từ mạng phải pin theo hash, không pin theo "latest".

# Lỗi thường gặp

- Test trên máy dev có Homebrew, nên không thấy lỗi thiếu ffmpeg của người dùng thật.
- Quên `MACOSX_DEPLOYMENT_TARGET`: mlx-sys sẽ build với target cũ và ra lỗi "MLX requires macOS >= 14.0".
- Lấy sha256 từ file đã tải dở: phải so với digest của GitHub hoặc HuggingFace (API `tree/main` có `lfs.oid`, release asset có `digest`).
- Heredoc trong YAML `run: |`: dấu kết thúc (`JSEOF`) nằm ở cột 0 sau khi YAML bỏ indent chung, nên phải giữ cùng mức indent với nội dung.

# Ví dụ nhỏ

```bash
bash scripts/fetch-build-deps.sh                       # host triple
bash scripts/fetch-build-deps.sh x86_64-pc-windows-msvc
env -i PATH=/usr/bin:/bin Scribble.app/Contents/MacOS/scribble-ffmpeg -version   # không cần Homebrew
```

# Lần sau nên nghĩ thế nào

Khi bỏ một runtime (Python sidecar), đừng chỉ hỏi "bước nào gọi Python". Hãy hỏi "runtime đó đang cung cấp những gì": binary đi kèm, model, file sinh ra lúc build. Sau đó test bản build trên môi trường sạch (checkout sạch, PATH tối giản) thay vì máy dev.
