# Phase 2 (IMPL): Config + migration (GREEN)

**blockedBy:** phase-02-test-review-config (approved).

## Changes

### `src-python/main.py`
- `DIARIZE_MIN_BYTES = 16000 * 2` → `16000 * 2 * 2` (1.0s). Áp dụng cả nvidia (`~356`) và local (`~644`) handler. Nếu cần test → đưa thành module-level constant import được.

### `src-python/diarize.py`
- `reset()`: xác nhận đã clear toàn bộ state (profiles/next_id/last_speaker/pending*). (Hiện đã có — chỉ verify + thêm test-cover.)
- Thresholds: GIỮ default cũ ở phase này; giá trị tune cuối chốt ở **phase-03** sau khi đo (tránh đoán mò). Đảm bảo tất cả vẫn `os.getenv(...)` override được.

## Verify
- `pytest tests/test_diarize_migration.py` → xanh (trừ case 4 placeholder cho tới phase-03).
- Full suite pass.

## Acceptance
- [ ] min-bytes = 1.0s ở cả 2 handler; reset clear sạch; env-override hoạt động; suite pass.
