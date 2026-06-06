# Phase 08 — TEST REVIEW GATE: Local engine

**Slice C · user gate.** blockedBy: 07

## Checklist review
- [ ] Batch contract `transcribe_local_file(path, language)` khớp shape `transcribe_nvidia_streaming` (callsite upload_pipeline reuse được)?
- [ ] Mock onnxruntime hợp lý — không tải model thật trong CI?
- [ ] Hallucination filter + VN normalize có test?
- [ ] Lỗi "model chưa tải" propagate rõ ràng lên pipeline → fallback/thông báo?
- [ ] Decode tokenizer PhoWhisper: cần asset tokenizer kèm model? (xác nhận trong artifact)

## Output
Approve → Phase 09. Reject → sửa Phase 07.
