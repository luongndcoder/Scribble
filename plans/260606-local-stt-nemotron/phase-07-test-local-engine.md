# Phase 07 — TEST: sherpa-onnx engine (batch)

**Slice C · TDD red.** blockedBy: 06
**Revised 2026-06-06:** Runtime = sherpa-onnx (wrapper mỏng), KHÔNG hand-roll ONNX decode.

## Files
- CREATE `src-python/tests/test_local_stt.py` (~80 LOC)

## Test cases (red)
- #7 `transcribe_local_file(path, "vi")` khi model dir không resolve được (bundled+cache đều thiếu) → raise lỗi rõ ràng "model local chưa sẵn sàng".
- #8a `SherpaOnnxEngine.transcribe_pcm(pcm_float32, "vi")` với `sherpa_onnx.OfflineRecognizer` mock → trả `stream.result.text`, áp `filter_hallucinations`, vi → `normalize_vietnamese_text`.
- #8b PCM int16 bytes → float32 normalize `[-1,1]` đúng (helper `_pcm_int16_to_float32`).
- Engine load 1 lần (singleton) — gọi 2 lần cùng model_dir không tạo recognizer mới.
- Integration smoke (`skipif` model bundled absent): load thật + transcribe wav fixture → text non-empty.

## Mock
- `monkeypatch sherpa_onnx.OfflineRecognizer.from_transducer` → fake recognizer; `create_stream/accept_waveform/decode_stream`; `stream.result.text` giả.

## Done when
Test fail (red) — `local_stt.py` chưa có.

## Rubric: general-code
