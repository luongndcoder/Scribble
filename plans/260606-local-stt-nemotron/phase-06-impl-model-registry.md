# Phase 06 — IMPL: Model registry + bundled resolution

**Slice B · green.** blockedBy: 05
**Revised 2026-06-06:** Python-only. Rust download (Tauri commands) **defer sang Phase 2/3** (Tier A/B). Tier C dùng model bundled.

## Files
- CREATE `src-python/local/model_registry.py` (~90 LOC):
  - `@dataclass ModelSpec{model_id, version, files: list[str], url, sha256, size_bytes, archive, license}`.
  - `MODEL_REGISTRY = {"C": <zipformer-vi-30M-int8 spec>, "A": <placeholder MLX>, "B": <placeholder ONNX-CUDA>}`.
  - `resolve(tier, override=None) -> ModelSpec`.
  - `_bundled_base() -> Path` — thư mục model bundle cạnh sidecar (PyInstaller `sys._MEIPASS/models/local` hoặc `src-python/models/local` khi dev).
  - `bundled_model_dir(spec) -> Path|None` — `_bundled_base()/spec.model_id` nếu tồn tại + đủ `spec.files`.
  - `download_cache_dir(spec) -> Path|None` — `~/.voicescribe/models/<tier>/<model_id>` nếu `.version` khớp (cho override/Tier A-B).
  - `model_path_or_none(spec) -> Path|None` — bundled trước → download cache → None.

## Notes
- KHÔNG thêm Python dep. KHÔNG sửa `lib.rs` ở Phase 1.
- Tier C spec: url = k2-fsa release `sherpa-onnx-zipformer-vi-30M-int8-2026-02-09.tar.bz2` (cho update/override sau), license `cc-by-nc-nd-4.0`.

## Done when
Test Phase 04 pass.

## Rubric: general-code
