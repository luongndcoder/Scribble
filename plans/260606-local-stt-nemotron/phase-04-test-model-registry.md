# Phase 04 — TEST: Model registry + cache resolver

**Slice B · TDD red.** blockedBy: 03

## Files
- CREATE `src-python/tests/test_model_registry.py` (~70 LOC)
- CREATE `src-tauri/src/` Rust unit test stub (sha256 + cache-key) — trong `lib.rs` `#[cfg(test)]`.

## Test cases (red)
- #5 `resolve("C")` → `ModelSpec` có đủ `model_id/version/url/sha256/size_bytes/archive`.
- #6 `model_path_or_none(spec)` khi cache thiếu → `None` (KHÔNG raise).
- `model_path_or_none` khi `.version` khớp → trả `Path`.
- #12 (Rust) cache-key đổi khi `version` đổi → `needs_extract=true`.
- #13 (Rust) sha256 mismatch → trả Err, không extract.

## Mock
- `tmp_path` giả cache dir; tạo/không tạo `.version`.

## Done when
Test fail (red) vì registry chưa tồn tại.

## Rubric: general-code
