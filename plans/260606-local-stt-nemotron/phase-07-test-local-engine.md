# Phase 07 — TEST: PhoWhisper ONNX engine (batch)

**Slice C · TDD red.** blockedBy: 06

## Files
- CREATE `src-python/tests/test_local_stt.py` (~90 LOC)
- ADD wav fixture `src-python/tests/fixtures/sample_vi_2s.wav` (16kHz mono, ~2s).

## Test cases (red)
- #7 `transcribe_local_file(path, "vi")` khi model chưa tải → raise lỗi rõ ràng "model chưa tải" (dùng `model_path_or_none` → None).
- #8 `PhoWhisperOnnxEngine.transcribe_pcm(pcm, "vi")` với session mock → trả text non-empty; hallucination filter (`filter_hallucinations`) áp dụng; vi → `normalize_vietnamese_text`.
- Integration smoke (`skipif` model absent): load model thật + transcribe fixture → text non-empty.

## Mock
- `onnxruntime.InferenceSession` mock (spec=True) trả tensor giả → decode path test được mà không tải model.

## Done when
Test fail (red), `local_stt.py` chưa có.

## Rubric: general-code
