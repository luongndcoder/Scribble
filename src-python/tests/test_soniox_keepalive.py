"""Tests for the Soniox audio-sender + keepalive loop.

Root cause of "all speakers collapse to Speaker 1 on long meetings": Soniox
idle-closes the WS after >20s with no audio AND no keepalive, our auto-reconnect
then opens a fresh session whose speaker-diarization context is reset. The fix
is a single sender thread that emits keepalive during silence so the one
session (and its diarization) stays alive.

These tests exercise the sender loop in isolation with a fake session.
"""

import queue
import threading
import time

from stt import SonioxStreamingSTT


def _make_streamer(idle_sec: float) -> SonioxStreamingSTT:
    s = SonioxStreamingSTT("fake-key")
    s._KEEPALIVE_IDLE_SEC = idle_sec  # speed up the silence branch for tests
    s._audio_queue = queue.Queue()
    s._stopped = False
    return s


def test_sender_forwards_audio_and_keepalives_on_silence():
    s = _make_streamer(idle_sec=0.02)
    calls = {"audio": [], "ka": 0}

    class FakeSession:
        def send_byte_chunk(self, chunk):
            calls["audio"].append(chunk)

        def keep_alive(self):
            calls["ka"] += 1

    s._audio_queue.put(b"frame-1")
    t = threading.Thread(target=s._run_audio_sender, args=(FakeSession(),), daemon=True)
    t.start()
    time.sleep(0.12)  # ~6 idle cycles → several keepalives
    s._stopped = True
    s._audio_queue.put(None)
    t.join(timeout=1.0)

    assert calls["audio"] == [b"frame-1"]
    assert calls["ka"] >= 1  # keepalive fired during silence
    assert not t.is_alive()


def test_sender_exits_when_session_send_fails():
    s = _make_streamer(idle_sec=0.01)

    class BoomSession:
        def send_byte_chunk(self, chunk):
            raise RuntimeError("ws closed")

        def keep_alive(self):
            raise RuntimeError("ws closed")

    # Empty queue → keep_alive() raises → loop must exit (not spin forever).
    t = threading.Thread(target=s._run_audio_sender, args=(BoomSession(),), daemon=True)
    t.start()
    t.join(timeout=1.0)
    assert not t.is_alive()


def test_sender_stops_on_none_sentinel():
    s = _make_streamer(idle_sec=5.0)  # long idle so only the sentinel ends it

    class FakeSession:
        def send_byte_chunk(self, chunk):
            pass

        def keep_alive(self):
            pass

    s._audio_queue.put(None)
    t = threading.Thread(target=s._run_audio_sender, args=(FakeSession(),), daemon=True)
    t.start()
    t.join(timeout=1.0)
    assert not t.is_alive()
