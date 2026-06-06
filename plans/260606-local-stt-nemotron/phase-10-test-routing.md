# Phase 10 — TEST: Provider routing (local)

**Slice D · TDD red.** blockedBy: 09

## Files
- CREATE `src-python/tests/test_stt_routing.py` (~80 LOC)

## Test cases (red)
- #9 upload_pipeline: `stt_provider="local"` → dispatch `transcribe_local_file`, KHÔNG đòi API key.
- #10 provider lạ → fallback `nvidia` (giữ hành vi hiện tại ở `:1466-1467`).
- #11 main.py realtime: `stt_provider="local"` → chọn cloud fallback (default nvidia), KHÔNG crash, KHÔNG khởi tạo streaming class local.

## Mock
- `db.get_setting` monkeypatch trả `local`; `transcribe_local_file` mock; assert được gọi.
- main.py: mock streamer factory, assert chọn `NvidiaStreamingSTT` khi provider=local.

## Done when
Test fail (red) — routing chưa nhận `local`.

## Rubric: general-code
