# Phase 13 — TEST: Settings (device-info + local provider)

**Slice E · TDD red.** blockedBy: 12

## Files
- CREATE `src-python/tests/test_settings_local.py` (~60 LOC)
- (Frontend) thêm test vitest cho SettingsPanel state nếu repo có harness; nếu không → manual checklist trong Phase 14.

## Test cases (red)
- `GET /api/local/device-info` → trả `{tier, os, arch, has_cuda, reason, model_status}`.
- Save `stt_provider=local` + `local_stt_language=vi` + `local_model_tier=auto` → persist + read-back đúng.
- Default-on-read: settings thiếu key → trả default (`auto`, `vi`).

## Done when
Test fail (red) — endpoint chưa có.

## Rubric: api-endpoint
