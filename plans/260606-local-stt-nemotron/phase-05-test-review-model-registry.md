# Phase 05 — TEST REVIEW GATE: Model registry + download

**Slice B · user gate.** blockedBy: 04

## Checklist review
- [ ] `ModelSpec` đủ field cho download + verify + cache?
- [ ] sha256-verify-trước-extract được test (test #13)?
- [ ] Cache-key version pattern khớp pattern sidecar hiện có (`lib.rs`)?
- [ ] **Unresolved Q1:** nguồn PhoWhisper ONNX artifact + license đã xác nhận chưa? (cần chốt url/sha256 thực trước Phase 06)
- [ ] Resume HTTP Range: bắt buộc hay defer? (Q3)

## Output
Approve → Phase 06. Reject → sửa Phase 04.
