# Phase 09 — IMPL: PhoWhisper ONNX engine (batch)

**Slice C · green.** blockedBy: 08

## Files
- CREATE `src-python/local_stt.py` (~220 LOC):
  - `LocalSTTEngine` (base): `load_model(model_dir)`, `transcribe_pcm(pcm, lang) -> str`, `close()`.
  - `PhoWhisperOnnxEngine(LocalSTTEngine)`: mở `onnxruntime.InferenceSession` (encoder/decoder ONNX), mel feature extraction (numpy/scipy đã có), greedy decode + tokenizer.
  - `transcribe_local_file(path, language) -> str`: resolve model path (`model_path_or_none`); thiếu → raise; dùng `find_ffmpeg` normalize 16kHz mono PCM (tái dùng pattern `stt.py`); gọi `transcribe_pcm`; apply `filter_hallucinations` + (vi) `normalize_vietnamese_text`.
  - Singleton/load cache engine theo model_dir (tránh reload mỗi chunk).

## Notes
- Import dùng chung từ `stt.py`: `filter_hallucinations`, `normalize_vietnamese_text`, `get_language_code`, `_strip_wav_header`.
- KHÔNG có `LocalStreamingSTT` (4b-2). Log prefix `LOADED:`/`COMPLETED:`/`FAILED:`.

## Done when
Test Phase 07 pass (unit + smoke nếu model có).

## Rubric: general-code
