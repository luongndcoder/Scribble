# Regression Checklist — Tính năng cũ KHÔNG được vỡ

> Chạy thủ công sau mỗi phase trên dev machine. Trước khi tag release, chạy đủ trên cả 3 OS.

## Cách dùng

1. Copy checklist này ra issue/PR mỗi lần test
2. Tick từng item, ghi rõ OS và build version
3. **Bất kỳ item nào fail → không merge**, fix rồi test lại từ đầu

## A. Realtime recording flow (TÍNH NĂNG CŨ QUAN TRỌNG NHẤT)

### A1. Cơ bản
- [ ] Mở app → tab Recording → bấm "Start" → mic permission OK
- [ ] Nói 1 phút → text xuất hiện realtime
- [ ] Bấm "Stop" → recording dừng → meeting được lưu vào history

### A2. Diarization
- [ ] 2 người thay nhau nói → speaker 1 / speaker 2 phân biệt đúng
- [ ] Người nói cũ quay lại → speaker_id giữ nguyên (không tạo speaker 3 nhầm)

### A3. Sửa transcript
- [ ] Click vào 1 dòng transcript → edit → save → reload meeting → còn nguyên
- [ ] Delete 1 dòng → reload → vẫn bị xoá

### A4. Summarize
- [ ] Bấm "Generate Minutes" → chờ → minutes hiện đủ: title, key points, action items, decisions, risks, next steps
- [ ] Đổi LLM model trong settings → re-summarize → minutes mới khác

### A5. Export
- [ ] Export Word (.docx) → mở bằng MS Word/LibreOffice → format đúng
- [ ] Export Markdown (.md) → mở bằng editor → format đúng

### A6. Audio playback
- [ ] Mở meeting cũ → bấm play audio → nghe được, seek được
- [ ] Download audio → file hợp lệ (mở bằng VLC OK)

### A7. Cabin translation realtime
- [ ] Bật toggle "Dịch cabin" → chọn English
- [ ] Ghi âm tiếng Việt → bản dịch English xuất hiện dưới mỗi dòng

## B. Meeting history

### B1. Liệt kê
- [ ] Mở history → thấy meeting cũ (trước update upload)
- [ ] Date/time hiển thị đúng timezone
- [ ] Số lượng speaker đúng

### B2. Mở chi tiết
- [ ] Click vào meeting cũ → transcript đầy đủ
- [ ] Audio player load được
- [ ] Minutes (nếu đã generate) hiển thị đủ

### B3. Xoá meeting
- [ ] Xoá 1 meeting → biến mất khỏi list
- [ ] Audio file dưới disk cũng bị xoá

## C. Settings

### C1. STT/LLM config
- [ ] Đổi STT language → save → reload app → vẫn còn
- [ ] Đổi LLM model name → save → reload → vẫn còn
- [ ] Đổi Nvidia API key → save → realtime recording mới dùng key mới

### C2. Cabin language
- [ ] Đổi cabin target language → save → reload → vẫn còn

## D. Sidecar lifecycle

### D1. Start/stop
- [ ] Mở app lần đầu → sidecar tự start → port 8765 ping OK
- [ ] Đóng app → sidecar tự stop (kiểm bằng task manager)

### D2. Recovery
- [ ] Force kill sidecar (kill -9 PID) → app phát hiện → start lại
- [ ] Crash app khi đang ghi âm → mở lại → có draft, transcript dở vẫn còn

## E. Auto-save draft

- [ ] Đang ghi âm → tắt mạng → text vẫn xuất hiện (offline OK với Riva cached?)
  - *Note: thực tế Riva cần internet, item này chỉ verify UI không crash*
- [ ] Đang ghi âm → đóng app đột ngột → mở lại → draft còn nguyên trong history
- [ ] Chunks transcript được persist vào DB ngay sau mỗi STT call

## F. Cross-platform specific

### F1. macOS
- [ ] App mở được sau khi `xattr -cr` (per README)
- [ ] Mic permission dialog xuất hiện lần đầu
- [ ] Filename tiếng Việt NFD hiển thị đúng trong UI (không thành `o`+dấu)

### F2. Windows
- [ ] NSIS installer install thành công với English + Vietnamese language
- [ ] WebView2 load UI đúng
- [ ] Sidecar không nhảy console window (creationflags=CREATE_NO_WINDOW)

### F3. Linux (Ubuntu 22.04)
- [ ] AppImage chạy được (FUSE mounted)
- [ ] .deb install qua `dpkg -i` thành công
- [ ] WebKitGTK render UI đúng, không crash khi click button bất kỳ

## G. Update mechanism

- [ ] App v1.1.3 → kiểm tra update → thấy v1.1.4 → download → install → khởi động OK

## Báo cáo template

```markdown
## Regression test report — Phase X

**Date:** YYYY-MM-DD
**Branch:** claude/...
**Build version:** 1.1.5-dev
**Tester:** @username

### macOS arm64 (M2, macOS 14.x)
- Section A: ✅ pass
- Section B: ✅ pass
- ...

### Windows x64 (Windows 11)
- Section A: ✅ pass
- Section A4: ❌ FAIL — minutes export lỗi do encoding cp1252
  - Fix: PR #XX

### Ubuntu 22.04 (VM)
- Section A: ⚠️ skipped (chưa test)
- ...

**Verdict:** NO-GO until A4 Windows fix merged.
```

## Smoke test rút gọn (chỉ ~10 phút, chạy sau mỗi commit lớn)

Nếu không có thời gian chạy full checklist, ít nhất:

1. A1 (start record → stop → save)
2. A4 (generate minutes)
3. A6 (audio playback)
4. B1 (history list)
5. C1 (settings persist)

5 item này là smoke test tối thiểu — fail bất kỳ là dấu hiệu code mới đã làm vỡ thứ gì đó nghiêm trọng.
