# Phase 2 (REVIEW GATE): Config + migration tests

**HARD GATE.**

Trình bày: 4 test cases. Lưu ý case 4 (`default_thresholds`) là **placeholder** — giá trị cuối chốt ở phase-03 sau khi đo trên audio thật. Confirm với user:
- Nâng `DIARIZE_MIN_BYTES` 0.5s→1.0s chấp nhận được (đánh đổi: segment <1s sẽ không diarize, giữ last speaker — phù hợp vì CAM++ cần ≥1s).
- Reset-on-model-change OK.

User approve → `phase-02-impl-config-migration.md`.
