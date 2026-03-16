# Scribble — Hướng dẫn cài đặt / Installation Guide

## 🪟 Windows

### Cảnh báo SmartScreen
Khi cài đặt lần đầu, Windows SmartScreen có thể hiện cảnh báo **"Windows protected your PC"**. Đây là hành vi bình thường với phần mềm mới chưa có nhiều lượt tải.

**Cách bỏ qua:**
1. Click **"More info"** (Xem thêm)
2. Click **"Run anyway"** (Vẫn chạy)

### Cảnh báo Windows Defender / Antivirus
Một số phần mềm diệt virus có thể cảnh báo nhầm (false positive). Nếu gặp:
1. Mở **Windows Security** → **Virus & threat protection**
2. Click **"Protection history"**
3. Tìm file bị chặn → Click **"Actions"** → **"Allow"**
4. Hoặc thêm thư mục cài đặt Scribble vào **"Exclusions"**

---

## 🍎 macOS

### Cảnh báo "unidentified developer"
macOS Gatekeeper có thể chặn app chưa được Apple notarize.

**Cách 1: System Settings**
1. Mở **System Settings** → **Privacy & Security**
2. Cuộn xuống tìm thông báo về Scribble
3. Click **"Open Anyway"**

**Cách 2: Terminal**
```bash
xattr -cr /Applications/Scribble.app
```

### Quyền Microphone
Khi mở lần đầu, macOS sẽ hỏi quyền truy cập Microphone. Click **"Allow"** để app hoạt động bình thường.

---

## ❓ FAQ

**Q: Scribble có phải virus không?**
A: Không. Scribble là phần mềm mã nguồn mở. Cảnh báo xuất hiện vì phần mềm chưa có chữ ký số (code signing certificate) từ nhà phát hành thương mại. Bạn có thể kiểm tra mã nguồn tại repository.

**Q: Tại sao antivirus flag Scribble?**
A: Scribble sử dụng một backend Python được đóng gói (PyInstaller). Một số phần mềm diệt virus nhận diện nhầm pattern đóng gói này với malware. Đây là false positive phổ biến với nhiều ứng dụng Python.

**Q: Làm sao biết file tải về là an toàn?**
A: Luôn tải Scribble từ trang chính thức hoặc GitHub Releases. Bạn có thể kiểm tra hash (SHA256) của file tải về với hash trên trang Releases.
