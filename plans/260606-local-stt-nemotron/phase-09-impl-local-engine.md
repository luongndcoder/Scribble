# Phase 09 — IMPL: sherpa-onnx engine (batch)

**Slice C · green.** blockedBy: 08
**Revised 2026-06-06:** sherpa-onnx wrapper (gọn ~120 LOC thay vì ~220 hand-roll).

## Files
- CREATE `src-python/local_stt.py` (~120 LOC):
  - `LocalSTTEngine` (base): `transcribe_pcm(pcm_float32, lang) -> str`, `close()`.
  - `SherpaOnnxEngine(LocalSTTEngine)`: `sherpa_onnx.OfflineRecognizer.from_transducer(tokens, encoder, decoder, joiner, num_threads=4, sample_rate=16000)`; `transcribe_pcm`: `stream=create_stream(); stream.accept_waveform(16000, pcm); decode_stream(stream); return stream.result.text`.
  - `_pcm_int16_to_float32(pcm_bytes) -> np.ndarray` (numpy, KHÔNG soundfile).
  - `transcribe_local_file(path, language) -> str`: resolve `model_path_or_none(resolve("C"))`; thiếu → raise "model local chưa sẵn sàng"; `find_ffmpeg` normalize 16kHz mono WAV (tái dùng pattern stt.py) → `_strip_wav_header` → int16→float32 → `transcribe_pcm`; apply `filter_hallucinations` + (vi) `normalize_vietnamese_text`.
  - Engine cache singleton theo model_dir (`_ENGINE_CACHE: dict`).

## Notes
- Import dùng chung từ `stt.py`: `filter_hallucinations`, `normalize_vietnamese_text`, `_strip_wav_header`.
- `sherpa_onnx` import lazy (trong hàm) để tránh fail import khi chạy test mock / môi trường thiếu.
- Log `LOADED:`/`COMPLETED:`/`FAILED:`.

## Done when
Test Phase 07 pass.

## Rubric: general-code
