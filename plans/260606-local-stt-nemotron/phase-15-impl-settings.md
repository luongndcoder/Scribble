# Phase 15 — IMPL: Settings backend + frontend

**Slice E · green.** blockedBy: 14

## Files
- MODIFY `src-python/api/settings.py` (~40 LOC): `GET /api/local/device-info` gọi `device_detect.get_device_info(override)` + `model_registry` status. Save loop generic giữ nguyên.
- MODIFY `src/components/SettingsPanel.tsx` (~150 LOC):
  - `sttProvider` type → `'nvidia' | 'soniox' | 'local'`; state `localTier`, `localLang`, `modelStatus`.
  - Tab provider thứ 3 "Local (offline)" (`:336-343`); panel local: hiển thị detected tier + lý do, **không API key**, nút "Tải model" → invoke Tauri `ensure_local_model(tier)`, progress bar lắng `local-model-progress`, trạng thái (chưa tải/đang tải X%/sẵn sàng vX) + retry.
  - Save: `body.stt_provider='local'`, `body.local_stt_language`, `body.local_model_tier` (`:122-127`).
- MODIFY i18n file: label + trạng thái download (vi/en).

## Notes
- Khi provider=local: hiển thị note "Recording realtime dùng cloud (local chỉ cho upload)" (4b-2).
- **[RED-TEAM privacy]** Nếu provider=local + chưa có cloud key: nút Recording disable + tooltip "Realtime offline chưa hỗ trợ trên máy này; dùng Upload file". Cảnh báo rõ audio sẽ rời máy nếu fallback cloud — đúng với động cơ privacy của user.

## Done when
Test Phase 13 pass; manual: bật local → tải model → upload file → transcript ra; provider revert → app như cũ.

## Rubric: api-endpoint
