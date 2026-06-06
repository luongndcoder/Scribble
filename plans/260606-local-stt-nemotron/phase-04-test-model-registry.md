# Phase 04 — TEST: Model registry + bundled resolution

**Slice B · TDD red.** blockedBy: 03
**Revised 2026-06-06:** Tier C bundle vào installer → KHÔNG Rust download ở Phase 1 (defer Tier A/B). Registry resolve bundled dir trước.

## Files
- CREATE `src-python/tests/test_model_registry.py` (~70 LOC)

## Test cases (red)
- #5 `resolve("C")` → `ModelSpec` có `model_id`, `files` (tokens/encoder/decoder/joiner), `url`, `sha256`, `size_bytes`, `license="cc-by-nc-nd-4.0"`.
- `resolve("C")` model_id chứa `zipformer-vi-30M-int8`.
- #6a `bundled_model_dir(spec)` khi thư mục bundle tồn tại (tmp_path giả) + đủ files → trả `Path`.
- #6b `bundled_model_dir(spec)` khi thiếu file → `None`.
- #6c `model_path_or_none(spec)`: ưu tiên bundled dir; không có bundled + không cache → `None` (không raise).
- `resolve("A")` / `resolve("B")` → spec placeholder (download, chưa bundle) — chỉ cần không raise.

## Mock
- `monkeypatch` đường dẫn bundled base (vd `model_registry._bundled_base`) trỏ `tmp_path`.

## Done when
Test fail (red) — registry chưa tồn tại.

## Rubric: general-code
