# Phase 00 — Spike: Background Recording (iOS + Android)

> Loại: spike de-risk (throwaway prototype, KHÔNG TDD, KHÔNG ship). Chặn Phase 06.
> Mục tiêu: chứng minh app **ghi âm dài, chạy nền, khoá màn hình KHÔNG mất audio** — rủi ro #1.

## Câu hỏi cần trả lời

1. Lib nào record-to-file ổn nhất trên Expo cho **background + long-running**? (`expo-audio` + config plugin foreground-service vs `react-native-audio-recorder-player` vs `react-native-nitro-sound`)
2. iOS: `UIBackgroundModes:[audio]` + AVAudioSession category đủ để ghi tiếp khi khoá màn hình / chuyển app? Có bị suspend không?
3. Android: foreground service (type `microphone`) + wake lock — ghi tiếp khi tắt màn hình? Notification bắt buộc hiển thị thế nào?
4. Interruption (cuộc gọi đến), route change (cắm/rút tai nghe, Bluetooth) — recover hay hỏng file?
5. File output format Soniox nuốt được (m4a/aac/wav) + dung lượng ~60' bao nhiêu?

## Cách làm

- Tạo Expo prototype tối thiểu (dev client, KHÔNG Expo Go vì cần native config): 1 nút record/stop + timer.
- Cấu hình `app.config.ts`: iOS `infoPlist.UIBackgroundModes:['audio']` + `NSMicrophoneUsageDescription`; Android `permissions:[RECORD_AUDIO, FOREGROUND_SERVICE, FOREGROUND_SERVICE_MICROPHONE, WAKE_LOCK]` + foreground service plugin.
- Build dev client qua EAS (cả iOS device thật + Android device thật — simulator KHÔNG đại diện background behavior).

## Đo / kịch bản test (device thật)

| # | Kịch bản | Pass khi |
|---|----------|----------|
| 1 | Record 60' liên tục, app foreground | file đủ ~60', không cụt |
| 2 | Record 60', **khoá màn hình** sau 1' | audio liên tục, không gián đoạn khi khoá |
| 3 | Record, chuyển sang app khác 5' rồi quay lại | vẫn ghi suốt |
| 4 | Đang record, có **cuộc gọi đến** 30s | recover sau cuộc gọi (hoặc pause-resume sạch), file không hỏng |
| 5 | Cắm/rút tai nghe + Bluetooth giữa chừng | không crash, không mất đoạn |
| 6 | iOS low-power mode / Android battery optimization | vẫn ghi (ghi nhận nếu OEM Android giết service) |

## Exit / Decision criteria

- ✅ **PASS** → chốt lib audio + config chính xác cho Phase 06; ghi vào `plan.md` mục Unresolved.
- ⚠️ **PARTIAL** (vd Android OEM giết foreground service trên 1 số máy) → tài liệu hoá workaround (battery-opt exemption prompt) + giới hạn known-issues.
- ❌ **FAIL** (không ghi nền tin cậy được bằng JS/RN module) → escalate: cân nhắc native module tự viết hoặc đổi chiến lược (record-in-foreground với cảnh báo). Báo user trước khi đi tiếp.

## Deliverable

- `spikes/background-audio/` prototype + `SPIKE-RESULT.md`: lib chốt, config snippet iOS+Android, bảng kết quả 6 kịch bản, known-issues, khuyến nghị Phase 06.
- Cập nhật `plan.md` → dependency audio + risk #1 status.
