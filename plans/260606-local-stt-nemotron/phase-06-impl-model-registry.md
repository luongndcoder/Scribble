# Phase 06 — IMPL: Model registry + Rust download/cache

**Slice B · green.** blockedBy: 05

## Files
- CREATE `src-python/local/model_registry.py` (~90 LOC) — `MODEL_REGISTRY` dict, `resolve(tier, override)`, `model_path_or_none(spec)`, cache base `~/.voicescribe/models/<tier>/<model_id>/`.
- MODIFY `src-tauri/src/lib.rs` (~150 LOC):
  - `ensure_local_model(tier: String) -> Result<ModelStatus>` — check `.version` → nếu thiếu/khác: `reqwest` download `.tar.zst` (resume nếu Q3=yes) → **sha256 verify** → `extract_tar_zst` (đã có) → ghi `.version` → emit `local-model-progress` events.
  - `local_model_status(tier: String) -> ModelStatus{installed, downloading, progress, version, path}`.
  - Register 2 command vào `invoke_handler`.

## Notes
- Verify sha256 **trước** extract; mismatch → xóa file tải dở, trả Err.
- Tái dùng `dirs::home_dir()` cho path cross-OS.
- KHÔNG thêm Python dep (download ở Rust).

## Done when
Test Phase 04 pass (Python + Rust unit).

## Rubric: general-code
