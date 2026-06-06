# Phase 03 — IMPL: Device detection

**Slice A · green.** blockedBy: 02

## Files
- CREATE `src-python/local/__init__.py`
- CREATE `src-python/local/device_detect.py` (~80 LOC)

## Impl
```python
def detect_tier(override: str | None = None) -> str:
    # override in {"A","B","C"} thắng auto; "auto"/None → auto-detect
    # Darwin + arm64 → "A"
    # "CUDAExecutionProvider" in ort.get_available_providers() → "B"
    # else → "C"
def get_device_info(override=None) -> DeviceInfo  # {tier, os, arch, has_cuda, reason}
```
- Log prefix `STATUS:` khi detect (theo logging convention).
- Phase 1 chỉ cần phân biệt C / không-C chính xác; A/B detect tối giản, hoàn thiện Phase 2/3.

## Done when
Test Phase 01 **pass** (green). Không đổi file khác.

## Rubric: general-code
