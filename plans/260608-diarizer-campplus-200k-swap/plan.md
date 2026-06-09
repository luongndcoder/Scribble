# Plan: Swap diarizer embedding model → CAM++ zh-cn-common 200k

- **Created:** 2026-06-08
- **Lane:** normal (no `intake.md`; Scribble desktop app — Mobio hard gates merchant_id/auth/Kafka/Mongo KHÔNG áp dụng). Strong-validation vì swap model asset của core diarizer (ảnh hưởng cả realtime + upload).
- **Mode:** `--hard` (research done + red-team).
- **Brainstorm:** đã thực hiện (đối chiếu repo 3D-Speaker, xác nhận voxceleb→zh-cn-common 200k). User confirmed.

## Chosen Approach

Thay file ONNX embedding của diarizer từ `voxceleb_CAM++` (train VoxCeleb / giọng Âu-Mỹ) sang **CAM++ `iic/speech_campplus_sv_zh-cn_16k-common`** (200k speakers, Quan thoại/đa dạng) để embedding phân biệt giọng **châu Á / cùng giới tiếng Việt** tốt hơn. Cùng kiến trúc CAM++ ~28MB, cùng fbank 80-dim, node `feats`/`embs` GIỐNG HỆT → KHÔNG đổi `_compute_fbank`, KHÔNG remap node. Bundle model (zero-setup), giữ `voxceleb` làm fallback.

**⚠ Khác biệt then chốt (XÁC NHẬN qua Phase 0 spike — KHÔNG phải drop-in 512):**
- Embedding **192-dim** (không phải 512) → đổi dim-check `!=512`→`!=192` + reset profile.
- **Thang cosine đổi hẳn:** voxceleb cho cosine **0.87–0.98** cho MỌI giọng Việt (mù → gộp hết Speaker 1); zh-cn 200k spread **0.14–0.69** (phân biệt thật). → `MATCH_THRESHOLD`/`STRONG_MATCH_THRESHOLD` PHẢI hạ mạnh (~**0.40–0.50** thay vì 0.68/0.78). Đây là phần việc chính của swap, tune ở Phase 3.

**Spike evidence (260608, meeting_15 ~13min, 8×2.5s windows):** pairwise-cosine spread voxceleb=**0.112** vs zh-cn-200k=**0.547** (5×). Determinism/L2/dim-192/node-names/fbank-compat/Apache-2.0 đều PASS → **GO**. ONNX nguồn: `Alkd/campplus-zh-cn-common-200k-onnx` (Apache-2.0) hoặc self-export từ `funasr/campplus` (.bin Apache-2.0, cần torch).

**Vì sao không phải các approach khác:**
- Đổi thuật toán (offline clustering cho realtime): không khả thi realtime (cần audio tương lai); upload đã có `batch_diarizer.cluster_speakers`.
- Chỉ tune ngưỡng trên model cũ: voxceleb embedding kém cho giọng Việt cùng giới → trần chất lượng thấp, dễ over-split.
- cnceleb (ONNX sẵn): generalization hẹp hơn 200k → dùng làm spike trung gian nếu cần, không phải đích.

## Scope & Blast Radius

**In scope:** `diarize.py` (`_init_model` path + node-name introspection + reset-on-model-change), `batch_diarizer.py` (dùng node-name introspected), `scribble-sidecar.spec` (bundle model mới), model asset mới, re-tune hằng số ngưỡng (env-overridable), nâng `DIARIZE_MIN_BYTES`, 1 script export ONNX (`scripts/`), tests.

**Out of scope (YAGNI):** đổi `_compute_fbank` (đã khớp), đổi thuật toán online matching, đổi clustering upload, UI Settings cho diarization (defer — chỉ env override), download-on-demand (chọn bundle).

**Blast radius:** diarizer là singleton dùng chung realtime (`main.py` 2 WS handlers + warmup) và upload (`upload_pipeline.py`/`batch_diarizer.py`). Sai → speaker sai trên MỌI path. → Verify embedding sanity + manual test cả 2 path trước khi tin.

## Files (mapping)

| File | Change |
| --- | --- |
| `scripts/export_campplus_onnx.py` (NEW) | One-time dev script: PyTorch zh-cn-common → ONNX (qua speakerlab/3D-Speaker), in node names + dim |
| `src-python/models/speech_campplus_sv_zh-cn_16k-common.onnx` (NEW asset) | Model bundle ~28MB |
| `src-python/diarize.py` | `_init_model`: thêm candidate path model mới (ưu tiên) + fallback voxceleb; introspect `session.get_inputs/outputs()[0].name` → lưu `self._in_name/_out_name`; dùng trong `_identify_campplus`. Reset profiles khi model file đổi (đã reset theo session). Nâng comment. |
| `src-python/services/batch_diarizer.py` | `extract_embedding` dùng `diarizer._in_name/_out_name` thay hardcode `feats`/`embs` |
| `src-python/diarize.py` (constants) | Re-tune `MATCH_THRESHOLD`/`STRONG_MATCH_THRESHOLD`/`CROSS_GENDER_*` defaults sau khi đo; nâng `DIARIZE_MIN_BYTES` (ở `main.py`) 0.5s→1.0s |
| `src-python/main.py` | `DIARIZE_MIN_BYTES = 16000*2` → `16000*2*2` (1.0s); idem trong local WS handler |
| `src-python/scribble-sidecar.spec` | `datas`: thêm model mới (giữ voxceleb fallback) |
| `src-python/tests/test_diarize_loader.py` (NEW) | Tests loader + node introspection + dim + determinism |
| `src-python/tests/test_diarize_migration.py` (NEW) | Tests reset-on-model-change + min-bytes + threshold defaults |

## Test Plan

### Test Strategy
- **Test type:** Unit (loader/config/migration) + **Manual acceptance** (chất lượng diarization — cần audio tiếng Việt thật, KHÔNG unit-test được speaker discrimination).
- **Coverage target:** loader/config/migration paths ~70%; chất lượng = manual gate.
- **Runner:** pytest (venv `src-python/.venv`).

### Test Cases (outline)
| # | Target | Scenario | Expected | Priority |
| --- | --- | --- | --- | --- |
| 1 | `_init_model` | Model mới tồn tại | session load, `_model_loaded=True`, `_session` không None | P0 |
| 2 | `_init_model` | Introspect node names | `_in_name`/`_out_name` = tên thật từ ONNX (không hardcode) | P0 |
| 3 | `_identify_campplus` | Chạy embedding | output 512-dim, L2-normalized | P0 |
| 4 | embedding | Cùng input 2 lần | embedding giống hệt (determinism) | P0 |
| 5 | `extract_embedding` (batch) | Dùng node introspected | trả 512-dim, không lỗi KeyError node | P0 |
| 6 | `reset()` | Sau khi đổi model | profiles rỗng, next_id=0, last_speaker=None | P0 |
| 7 | `DIARIZE_MIN_BYTES` | Constant | = 1.0s (16000*2*2 bytes) | P1 |
| 8 | fallback | Model mới thiếu, voxceleb còn | load voxceleb, không crash | P1 |
| 9 | **Manual** | Meeting ≥2 người **cùng giới** tiếng Việt (realtime + upload) | tách đúng ≥2 speaker, KHÔNG gộp hết Speaker 1 | P0 |
| 10 | **Manual** | 1 người nói dài | KHÔNG over-split thành nhiều speaker | P0 |

### Mock Dependencies
- ONNX session: dùng model thật trong test (đã bundle) — không mock (cần verify thật). Nếu CI không có model → skip mark.
- Test audio: 1 wav ngắn bundled trong `tests/fixtures/` cho determinism test (không cần đa speaker).

### Prerequisites
- Model ONNX phải có trước Slice 1 (Slice 0 spike lo việc này).
- conftest: thêm fixture `diarizer_real` (singleton load model thật) + skip-if-missing.

## Phases (TDD ordering)

| Phase | File | Depends |
| --- | --- | --- |
| 0 (spike) | `phase-00-spike-acquire-verify-onnx.md` | — |
| 1-test | `phase-01-test-loader.md` | 0 |
| 1-review | `phase-01-test-review-loader.md` | 1-test |
| 1-impl | `phase-01-impl-loader.md` | 1-review |
| 2-test | `phase-02-test-config-migration.md` | 1-impl |
| 2-review | `phase-02-test-review-config.md` | 2-test |
| 2-impl | `phase-02-impl-config-migration.md` | 2-review |
| 3 | `phase-03-packaging-validation.md` | 2-impl |

## Risks & Rollback

| Risk | Mitigation |
| --- | --- |
| ONNX export sai (node/dim khác) | Slice 0 spike verify TRƯỚC khi code integration; node-name introspection thay vì hardcode |
| Embedding model mới KHÔNG tốt hơn cho giọng Việt | Slice 0 embedding sanity + Slice 3 manual A/B với audio thật; nếu không cải thiện → giữ voxceleb (git revert) |
| Re-tune ngưỡng gây over-split | Tune dựa số liệu log thật; giữ env-override để chỉnh nhanh không rebuild |
| Profile cũ (voxceleb) lẫn model mới | reset diarizer state khi model đổi (đã reset per session) |
| App size +28MB | Chấp nhận (desktop ~240MB); có thể drop voxceleb sau khi validate |
| **Rollback** | Model bundle cũ vẫn còn → đổi path ưu tiên về voxceleb + revert constants = 1 commit revert |

## Evaluation Rubric

rubric: general-code
rubric_version: 1
notes: |
  Trọng tâm: (1) node-name introspection đúng/không hardcode; (2) reset state khi đổi model tránh profile lẫn; (3) fallback an toàn khi thiếu model; (4) embedding sanity (cosine self>others) là gate bắt buộc trước khi tin. Chất lượng diarization = manual acceptance, không phải unit gate.
