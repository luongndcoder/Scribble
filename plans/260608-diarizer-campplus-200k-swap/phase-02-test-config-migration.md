# Phase 2 (TEST): Config + migration (RED)

**Depends:** phase-01-impl.
**Goal:** Tests cho min-bytes mới, reset-on-model-change, threshold defaults (env-overridable). CHỈ tests.

## Test file: `src-python/tests/test_diarize_migration.py`

### Cases
1. `test_diarize_min_bytes_is_1s`: import `DIARIZE_MIN_BYTES` từ `main` (cả nvidia + local handler dùng cùng giá trị) → = `16000*2*2` (1.0s @16k 16-bit). (Nếu hằng số nằm local trong hàm → expose thành module-level constant để test được.)
2. `test_reset_clears_state`: nạp vài profile giả vào `diarizer._profiles`, set `_last_speaker_id` → `reset()` → `_profiles==[]`, `_next_id==0`, `_last_speaker_id is None`. (Bảo vệ chống profile model cũ lẫn model mới.)
3. `test_thresholds_env_overridable`: set `DIARIZE_MATCH_THRESHOLD=0.55` env → reload module → `MATCH_THRESHOLD==0.55`. (Đảm bảo tune nhanh không cần sửa code.)
4. `test_default_thresholds_documented`: assert default `MATCH_THRESHOLD`/`STRONG_MATCH_THRESHOLD` = giá trị sau-tune ghi trong plan (chốt ở phase-03 sau khi đo). Placeholder cho tới khi có số.

## Expected: FAIL (min-bytes chưa nâng; thresholds chưa chốt).

## Acceptance
- [ ] Tests viết xong, RED đúng lý do.
