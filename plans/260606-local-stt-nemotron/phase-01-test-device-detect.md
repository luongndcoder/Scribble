# Phase 01 — TEST: Device detection

**Slice A · TDD red.** blockedBy: —

## Goal
Viết unit test (fail/red) cho `detect_tier()` trước khi impl.

## Files
- CREATE `src-python/tests/test_device_detect.py` (~60 LOC)
- CREATE/UPDATE `src-python/tests/conftest.py` — fixture monkeypatch `platform.system/machine`, `onnxruntime.get_available_providers`.

## Test cases (red)
- #1 macOS arm64 → `"A"`
- #2 CUDA provider available → `"B"`
- #3 else (Win iGPU / Mac Intel / Linux no-cuda) → `"C"`
- #4 `detect_tier(override="C")` thắng auto → `"C"`
- `DeviceInfo` trả đủ field `{tier, os, arch, has_cuda, reason}`.

## Mock
- `monkeypatch.setattr(platform, "system", lambda: "Darwin")` v.v.
- `monkeypatch.setattr(onnxruntime, "get_available_providers", lambda: [...])`.

## Done when
pytest chạy, các test này **fail** vì module chưa tồn tại (red đúng kỳ vọng).

## Rubric: general-code
