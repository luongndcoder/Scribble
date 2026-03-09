"""
Speaker Diarization — WeSpeaker CAM++ embeddings
"""

import os
import subprocess
import threading
import time

import numpy as np

# ── Tunable parameters (configurable via env vars) ────────────────────────────
MATCH_THRESHOLD        = float(os.getenv("DIARIZE_MATCH_THRESHOLD",        "0.60"))
STRONG_MATCH_THRESHOLD = float(os.getenv("DIARIZE_STRONG_MATCH_THRESHOLD", "0.75"))
MAX_SPEAKERS           = int(os.getenv("DIARIZE_MAX_SPEAKERS",             "8"))
SWITCH_CONFIRM_HITS    = int(os.getenv("DIARIZE_SWITCH_CONFIRM_HITS",      "2"))
NEW_SPEAKER_CONFIRM_HITS = int(os.getenv("DIARIZE_NEW_SPEAKER_CONFIRM_HITS", "2"))
CROSS_GENDER_PENALTY   = float(os.getenv("DIARIZE_CROSS_GENDER_PENALTY",   "0.04"))
MERGE_SIM_THRESHOLD    = float(os.getenv("DIARIZE_MERGE_SIM_THRESHOLD",    "0.94"))
EMA_UPDATE_MIN_SIM     = float(os.getenv("DIARIZE_EMA_UPDATE_MIN_SIM",     "0.50"))

# ── Internal constants (hardcoded — no need to tune via env) ──────────────────
# Core
AMBIGUOUS_GAP                       = 0.05
# Pitch
MIN_PITCH_FRAMES                    = 6
PITCH_PENALTY_FACTOR                = 0.06
PITCH_DIFF_DENOM                    = 120.0
FEMALE_F0_HZ                        = 165.0
MALE_F0_HZ                          = 145.0
CROSS_GENDER_MIN_DIFF               = 25.0
CROSS_GENDER_EXTRA_THRESHOLD        = 0.05
CROSS_GENDER_STRONG_MATCH_THRESHOLD = 0.85
SOFT_CROSS_GENDER_FACTOR            = 0.003
# Sticky / hysteresis
WEAK_MATCH_MARGIN                   = 0.04
STICKY_RECENT_SEC                   = 5.0
STICKY_SIM_MARGIN                   = 0.04
LOW_PITCH_STICKY_BONUS              = 0.00
STABLE_LAST_SPEAKER_BONUS           = 0.02
# Switch confirmation
SWITCH_STRONG_SIM                   = 0.75
SWITCH_STRONG_GAP                   = 0.08
INSTANT_SWITCH_SIM                  = 0.80
INSTANT_SWITCH_GAP                  = 0.15
# New speaker debounce
NEW_SPEAKER_MIN_SECONDS             = 1.5
SAME_ZONE_WEAK_PITCH_DIFF_FEMALE    = 40.0
SAME_ZONE_WEAK_PITCH_DIFF_MALE      = 60.0
NEW_SPEAKER_SELF_SIM                = 0.65
NEW_SPEAKER_CONFIRM_WINDOW_SEC      = 8.0
# Mouthprint
MOUTHPRINT_MIN_FRAMES               = 6
MOUTHPRINT_CLOSE_DIST               = 0.30
MOUTHPRINT_FAR_DIST                 = 0.65
MOUTHPRINT_CLOSE_BOOST              = 0.02
MOUTHPRINT_PENALTY_SCALE            = 0.15
MOUTHPRINT_MAX_PENALTY              = 0.08
MOUTHPRINT_FRAME_SIZE               = 1024
# Vietnamese tone proxy
VI_TONE_DIFF_DENOM                  = 80.0
VI_TONE_PENALTY_FACTOR              = 0.03
SPLIT_TONE_PENALTY                  = 0.05
# Reconciler
RECONCILE_INTERVAL_SEC              = 4.0
PATCH_WINDOW_SEC                    = 30.0
MERGE_CONFIRM_HITS                  = 3
MERGE_MIN_PROFILE_HITS              = 4
MERGE_MAX_PITCH_DIFF_HZ             = 18.0
MAX_PATCHES_PER_PASS                = 6
MAX_PATCH_RATIO                     = 0.35

# ── Source-aware runtime config (compat with main.py) ────────────────────────
_CFG_DEFAULT = {
    "match_threshold": MATCH_THRESHOLD,
    "pitch_penalty_factor": PITCH_PENALTY_FACTOR,
    "switch_confirm_hits": SWITCH_CONFIRM_HITS,
    "same_zone_weak_pitch_diff_male": SAME_ZONE_WEAK_PITCH_DIFF_MALE,
    "same_zone_weak_pitch_diff_female": SAME_ZONE_WEAK_PITCH_DIFF_FEMALE,
}

_CFG_SOURCE_OVERRIDES = {
    "web": {},
    "system": {},
}


class SpeakerDiarizer:
    def __init__(self):
        self._model = None
        self._profiles = []
        self._next_id = 0
        self._model_loaded = False
        self._last_speaker_id = None
        self._last_speaker_time = 0.0
        self._pending_switch_id = None
        self._pending_switch_hits = 0
        self._pending_switch_time = 0.0
        self._pending_new_emb = None
        self._pending_new_hits = 0
        self._pending_new_time = 0.0
        self._pending_new_pitch_mean = None
        self._pending_new_pitch_count = 0
        self._lock = threading.RLock()
        self._source = "web"
        self._cfg_default = dict(_CFG_DEFAULT)
        self._cfg_source_overrides = {
            k: dict(v) for k, v in _CFG_SOURCE_OVERRIDES.items()
        }

    def set_source(self, source: str):
        """Set diarization source profile (compat API used by websocket route)."""
        src = (source or "web").strip().lower()
        if src not in self._cfg_source_overrides:
            src = "web"
        with self._lock:
            self._source = src

    def cfg(self, key: str):
        """Read current config value (compat API used by diagnostics endpoint)."""
        with self._lock:
            override = self._cfg_source_overrides.get(self._source, {}).get(key, None)
            if override is not None:
                return override
            return self._cfg_default.get(key)

    def _init_model(self):
        if self._model_loaded:
            return
        self._model_loaded = True
        try:
            # Must patch torchaudio before wespeaker model init; newer torchaudio
            # may route load() through TorchCodec and break CAM++ extraction.
            self._patch_torchaudio_load()
            import wespeaker
            model_name = os.getenv("DIARIZE_MODEL", "campplus")
            self._model = wespeaker.load_model(model_name)
            expected_dim = 512 if "campplus" in model_name else 192

            self._model.set_device('cpu')
            self._model.set_resample_rate(16000)

            # Clear profiles nếu dimension không khớp
            if self._profiles and len(self._profiles[0]["embedding"]) != expected_dim:
                print(f"[diarize] Clearing profiles (dim mismatch)")
                self._profiles = []
                self._next_id = 0
        except Exception as e:
            print(f"[diarize] Model load failed: {e}")
            self._model = None


    @staticmethod
    def _patch_torchaudio_load():
        try:
            import torchaudio
            import sys
            from types import ModuleType
        except Exception:
            return

        if getattr(torchaudio, "_voicescribe_patched", False):
            return

        # --- 0. PyInstaller JIT fix: disable TorchScript when frozen ---
        # s3prl's CMVN classes extend torch.jit.ScriptModule and use
        # @torch.jit.script_method which requires .py source access.
        # PyInstaller strips source files → JIT compilation fails.
        # Replace ScriptModule with nn.Module so CMVN works as plain module.
        if getattr(sys, 'frozen', False):
            import torch
            import torch.jit
            import torch.nn as nn
            if not getattr(torch.jit, '_voicescribe_jit_patched', False):
                torch.jit._original_ScriptModule = torch.jit.ScriptModule
                torch.jit.ScriptModule = nn.Module
                # script_method decorator: just return the function unchanged
                if hasattr(torch.jit, 'script_method'):
                    torch.jit._original_script_method = torch.jit.script_method
                torch.jit.script_method = lambda fn: fn
                torch.jit._voicescribe_jit_patched = True
                print("[diarize] PyInstaller JIT patch applied (ScriptModule → nn.Module)")

        # --- 1. Vá lỗi API bị xóa (Sửa lỗi CAM++ not available) ---
        if not hasattr(torchaudio, "set_audio_backend"):
            torchaudio.set_audio_backend = lambda x: None

        if not hasattr(torchaudio, "get_audio_backend"):
            torchaudio.get_audio_backend = lambda: "ffmpeg"

        # Giả lập module sox_effects để tránh ModuleNotFoundError
        if "torchaudio.sox_effects" not in sys.modules:
            sox_mod = ModuleType("torchaudio.sox_effects")
            # Giả lập hàm apply_effects_tensor (trả về nguyên bản nếu không có sox)
            sox_mod.apply_effects_tensor = lambda tensor, sr, effects: (tensor, sr)
            sys.modules["torchaudio.sox_effects"] = sox_mod
            torchaudio.sox_effects = sox_mod

        # --- 2. Giữ nguyên logic Fallback WAV của bạn ---
        original_load = getattr(torchaudio, "load", None)
        if callable(original_load):
            def _fallback_wav_load(path: str):
                import wave
                import torch
                import numpy as np # Đảm bảo đã import numpy

                with wave.open(str(path), "rb") as wf:
                    channels = wf.getnchannels()
                    sample_width = wf.getsampwidth()
                    sample_rate = wf.getframerate()
                    frames = wf.readframes(wf.getnframes())

                dtype = {1: np.uint8, 2: np.int16, 4: np.int32}.get(sample_width)
                if not dtype:
                    raise RuntimeError(f"Unsupported WAV width: {sample_width}")

                audio = np.frombuffer(frames, dtype=dtype).astype(np.float32)
                if sample_width == 1: audio = (audio - 128.0) / 128.0
                elif sample_width == 2: audio /= 32768.0
                elif sample_width == 4: audio /= 2147483648.0

                audio = audio.reshape(-1, channels).T if channels > 1 else audio.reshape(1, -1)
                return torch.from_numpy(audio), int(sample_rate)

            def _patched_load(path, *args, **kwargs):
                try:
                    return original_load(path, *args, **kwargs)
                except Exception as e:
                    if "TorchCodec" in str(e) or "backend" in str(e).lower():
                        return _fallback_wav_load(path)
                    raise e

            torchaudio.load = _patched_load

        torchaudio._voicescribe_patched = True

    def reset(self):
        with self._lock:
            self._profiles = []
            self._next_id = 0
            self._last_speaker_id = None
            self._last_speaker_time = 0.0
            self._pending_switch_id = None
            self._pending_switch_hits = 0
            self._pending_switch_time = 0.0
            self._pending_new_emb = None
            self._pending_new_hits = 0
            self._pending_new_time = 0.0
            self._pending_new_pitch_mean = None
            self._pending_new_pitch_count = 0
            self._source = "web"

    def _clear_pending_switch(self):
        self._pending_switch_id = None
        self._pending_switch_hits = 0
        self._pending_switch_time = 0.0

    def _clear_pending_new(self):
        self._pending_new_emb = None
        self._pending_new_hits = 0
        self._pending_new_time = 0.0
        self._pending_new_pitch_mean = None
        self._pending_new_pitch_count = 0

    def _allow_switch(self, candidate_id: int, sim: float, gap: float, now: float) -> bool:
        if self._last_speaker_id is None or candidate_id == self._last_speaker_id:
            self._clear_pending_switch()
            return True
        if sim >= INSTANT_SWITCH_SIM and gap >= INSTANT_SWITCH_GAP:
            self._clear_pending_switch()
            return True
        if sim >= SWITCH_STRONG_SIM and gap >= SWITCH_STRONG_GAP:
            self._clear_pending_switch()
            return True
        if (
                self._pending_switch_id == candidate_id
                and (now - self._pending_switch_time) <= STICKY_RECENT_SEC
        ):
            self._pending_switch_hits += 1
            self._pending_switch_time = now
            if self._pending_switch_hits >= SWITCH_CONFIRM_HITS:
                self._clear_pending_switch()
                return True
            return False
        self._pending_switch_id = candidate_id
        self._pending_switch_hits = 1
        self._pending_switch_time = now
        return False

    @staticmethod
    def _same_zone_far_pitch(f0_a, count_a, f0_b, count_b) -> bool:
        if f0_a is None or f0_b is None or count_a < MIN_PITCH_FRAMES or count_b < MIN_PITCH_FRAMES:
            return False
        zone_a = SpeakerDiarizer._pitch_zone(f0_a)
        zone_b = SpeakerDiarizer._pitch_zone(f0_b)
        if zone_a != zone_b or zone_a not in ("male", "female"):
            return False
        diff = abs(f0_a - f0_b)
        return diff >= (SAME_ZONE_WEAK_PITCH_DIFF_FEMALE if zone_a == "female" else SAME_ZONE_WEAK_PITCH_DIFF_MALE)

    @staticmethod
    def _blend_pitch_stats(old_stats, new_stats, alpha):
        if not new_stats:
            return old_stats
        if not old_stats:
            return dict(new_stats)
        merged = dict(old_stats)
        for k in ("mean", "std", "median", "p10", "p90", "delta_std", "energy", "zcr"):
            nv, ov = new_stats.get(k), old_stats.get(k)
            if nv is None and ov is None:
                continue
            merged[k] = float(nv if ov is None else (ov if nv is None else ov * (1 - alpha) + nv * alpha))
        merged["count"] = int(min(1000, old_stats.get("count", 0) + new_stats.get("count", 0)))
        return merged

    def _update_profile_features(self, profile, pitch_stats, mouth_vec, mouth_count,
                                 alpha_pitch=0.10, alpha_mouth=0.08):
        if pitch_stats and pitch_stats.get("count", 0) >= MIN_PITCH_FRAMES:
            blended = self._blend_pitch_stats(profile.get("pitch_stats"), pitch_stats, alpha_pitch)
            if blended:
                profile["pitch_stats"] = blended
                profile["pitch_mean"] = blended.get("mean")
                profile["pitch_std"] = blended.get("std")
                profile["pitch_count"] = blended.get("count", 0)
        if mouth_vec is not None and mouth_count >= MOUTHPRINT_MIN_FRAMES:
            prev = profile.get("mouth_vec")
            if prev is None:
                profile["mouth_vec"] = mouth_vec.copy()
                profile["mouth_count"] = mouth_count
            else:
                profile["mouth_vec"] = self._l2_normalize(prev * (1 - alpha_mouth) + mouth_vec * alpha_mouth)
                profile["mouth_count"] = int(min(1000, profile.get("mouth_count", 0) + mouth_count))

    def identify_speaker(self, audio_path: str, update_profiles: bool = True) -> dict:
        with self._lock:
            self._init_model()
        wav_path = audio_path + ".wav"
        try:
            import torchaudio
            import torch
            import numpy as np
            import wave
            # Try loading with torchaudio (handles wav, flac, mp3, etc.)
            try:
                waveform, sr = torchaudio.load(audio_path)
            except Exception:
                # Fallback: treat as raw PCM 16-bit 16kHz mono
                raw = open(audio_path, "rb").read()
                samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                waveform = torch.from_numpy(samples).unsqueeze(0)
                sr = 16000

            # Convert to mono if stereo
            if waveform.shape[0] > 1:
                waveform = waveform.mean(dim=0, keepdim=True)

            # Resample to 16kHz if needed
            if sr != 16000:
                resampler = torchaudio.transforms.Resample(sr, 16000)
                waveform = resampler(waveform)

            # Write WAV manually (avoids torchcodec dependency)
            pcm = (waveform.squeeze(0).numpy() * 32767).clip(-32768, 32767).astype(np.int16)
            with wave.open(wav_path, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(16000)
                wf.writeframes(pcm.tobytes())
        except Exception as e:
            print(f"[diarize] audio convert exception: {e}")
            return {"speaker": "Speaker 1", "speaker_id": 0}
        try:
            with self._lock:
                if self._model:
                    return self._identify_campplus(wav_path, update_profiles=update_profiles)
                else:
                    return self._identify_pitch(wav_path, update_profiles=update_profiles)
        finally:
            try:
                os.unlink(wav_path)
            except Exception:
                pass

    def _identify_campplus(self, wav_path: str, update_profiles: bool = True) -> dict:
        try:
            embedding = self._model.extract_embedding(wav_path)
            if embedding is None:
                return self._identify_pitch(wav_path, update_profiles=update_profiles)

            emb_np = embedding.detach().cpu().numpy().flatten()

            def _result(sid: int, is_new: bool = False) -> dict:
                out = {"speaker": f"Speaker {sid + 1}", "speaker_id": sid, "embedding": emb_np.copy()}
                if is_new:
                    out["is_new"] = True
                return out

            samples = self._load_wav_samples(wav_path)
            duration_sec = len(samples) / 16000.0 if len(samples) > 0 else 0.0
            pitch_stats = self._extract_pitch_stats(samples, 16000)
            pitch_mean  = pitch_stats["mean"]  if pitch_stats else None
            pitch_std   = pitch_stats["std"]   if pitch_stats else None
            pitch_count = pitch_stats["count"] if pitch_stats else 0
            mouth_vec, mouth_count = self._extract_mouthprint(samples, 16000)

            # ── First speaker ──────────────────────────────────────────────────
            if len(self._profiles) == 0:
                if not update_profiles:
                    return _result(0)
                sid = self._next_id; self._next_id += 1
                self._profiles.append({
                    "id": sid, "embedding": emb_np, "count": 1,
                    "pitch_mean": pitch_mean, "pitch_std": pitch_std,
                    "pitch_count": pitch_count, "pitch_stats": pitch_stats,
                    "mouth_vec": mouth_vec, "mouth_count": mouth_count,
                    "created_at": time.time(),
                })
                print(f"[diarize] → Speaker {sid + 1} (first speaker)")
                self._last_speaker_id = sid
                self._last_speaker_time = time.time()
                self._clear_pending_switch(); self._clear_pending_new()
                return _result(sid, is_new=True)

            # ── Score all profiles ─────────────────────────────────────────────
            best_sim = -1.0; best_idx = -1; second_best_sim = -1.0
            last_speaker_sim = None; last_speaker_idx = -1
            best_tone_penalty = 0.0; best_same_zone = False
            sim_debug = []

            for i, p in enumerate(self._profiles):
                raw_sim = self._cosine_sim(emb_np, p["embedding"])
                adj_sim = raw_sim
                profile_pitch_mean  = p.get("pitch_mean")
                profile_pitch_count = p.get("pitch_count", 0)
                curr_zone    = self._pitch_zone(pitch_mean)
                profile_zone = self._pitch_zone(profile_pitch_mean)
                same_zone     = curr_zone == profile_zone and curr_zone in ("male", "female")
                is_cross_gender = (
                        pitch_mean is not None and profile_pitch_mean is not None
                        and pitch_count >= MIN_PITCH_FRAMES and profile_pitch_count >= MIN_PITCH_FRAMES
                        and self._is_cross_gender(pitch_mean, profile_pitch_mean)
                )
                dbg = ""

                if (pitch_mean is not None and profile_pitch_mean is not None
                        and pitch_count >= MIN_PITCH_FRAMES and profile_pitch_count >= MIN_PITCH_FRAMES):
                    pitch_diff = abs(pitch_mean - profile_pitch_mean)
                    penalty = (pitch_diff / max(PITCH_DIFF_DENOM, 1.0)) * PITCH_PENALTY_FACTOR
                    if pitch_mean >= FEMALE_F0_HZ and profile_pitch_mean >= FEMALE_F0_HZ:
                        penalty *= 1.8
                    if is_cross_gender:
                        penalty += CROSS_GENDER_PENALTY
                    else:
                        penalty += self._soft_cross_gender_penalty(pitch_mean, profile_pitch_mean)
                    penalty = min(penalty, 0.22)
                    adj_sim -= penalty
                    dbg = f"pd={pitch_diff:.0f}{',cg' if is_cross_gender else ''}"

                tone_penalty = 0.0
                if same_zone and not is_cross_gender:
                    tone_penalty = self._vi_tone_penalty(pitch_stats, p.get("pitch_stats"))
                    if curr_zone == "male":
                        tone_penalty *= 1.15
                    adj_sim -= tone_penalty
                    if tone_penalty > 0:
                        dbg = f"{dbg},tp={tone_penalty:.3f}" if dbg else f"tp={tone_penalty:.3f}"

                profile_mouth_vec   = p.get("mouth_vec")
                profile_mouth_count = p.get("mouth_count", 0)
                if (mouth_vec is not None and profile_mouth_vec is not None
                        and mouth_count >= MOUTHPRINT_MIN_FRAMES and profile_mouth_count >= MOUTHPRINT_MIN_FRAMES):
                    mouth_dist = float(np.linalg.norm(mouth_vec - profile_mouth_vec))
                    if mouth_dist <= MOUTHPRINT_CLOSE_DIST:
                        boost = MOUTHPRINT_CLOSE_BOOST * (1.2 if p["id"] == self._last_speaker_id else 1.0)
                        adj_sim += boost
                        dbg = f"{dbg},mb=+{boost:.3f}" if dbg else f"mb=+{boost:.3f}"
                    elif mouth_dist >= MOUTHPRINT_FAR_DIST:
                        mp = (mouth_dist - MOUTHPRINT_FAR_DIST) * MOUTHPRINT_PENALTY_SCALE
                        if same_zone and curr_zone == "male":   mp *= 1.60
                        elif same_zone and curr_zone == "female": mp *= 1.40
                        if p["id"] == self._last_speaker_id:    mp *= 0.80
                        mp = min(mp, MOUTHPRINT_MAX_PENALTY)
                        adj_sim -= mp
                        dbg = f"{dbg},md={mouth_dist:.2f},mp={mp:.3f}" if dbg else f"md={mouth_dist:.2f},mp={mp:.3f}"

                sim_debug.append(f"S{p['id']+1}:{raw_sim:.3f}->{adj_sim:.3f}({dbg})" if dbg else f"S{p['id']+1}:{raw_sim:.3f}->{adj_sim:.3f}")
                if self._last_speaker_id is not None and p["id"] == self._last_speaker_id:
                    last_speaker_sim = adj_sim; last_speaker_idx = i
                if adj_sim > best_sim:
                    second_best_sim = best_sim; best_sim = adj_sim; best_idx = i
                    best_tone_penalty = tone_penalty; best_same_zone = same_zone
                elif adj_sim > second_best_sim:
                    second_best_sim = adj_sim

            best_profile = self._profiles[best_idx] if best_idx >= 0 else None
            best_count   = best_profile["count"] if best_profile else 0
            now          = time.time()

            # ── Adaptive threshold ─────────────────────────────────────────────
            adaptive_threshold = MATCH_THRESHOLD
            if best_count >= 6:
                adaptive_threshold -= 0.02
            elif best_count < 4 and best_profile is not None:
                # New profile: embedding noisy, lower threshold for convergence
                adaptive_threshold -= 0.06
            if (best_profile is not None and self._last_speaker_id == best_profile["id"]
                    and (now - self._last_speaker_time) <= STICKY_RECENT_SEC):
                bonus = STABLE_LAST_SPEAKER_BONUS
                # Extra sticky for very new profiles to let them converge
                if best_count < 4:
                    bonus += 0.03
                adaptive_threshold -= bonus


            best_cross_gender = (
                    best_profile is not None and pitch_mean is not None
                    and best_profile.get("pitch_mean") is not None
                    and pitch_count >= MIN_PITCH_FRAMES and best_profile.get("pitch_count", 0) >= MIN_PITCH_FRAMES
                    and self._is_cross_gender(pitch_mean, best_profile.get("pitch_mean"))
            )

            if (best_profile is not None and pitch_mean is not None
                    and best_profile.get("pitch_mean") is not None
                    and pitch_mean < FEMALE_F0_HZ and best_profile.get("pitch_mean") < FEMALE_F0_HZ):
                male_reduction = 0.03  # conservative — prevents merging different male voices
                if pitch_mean <= 130.0 and best_profile.get("pitch_mean", 999) <= 130.0:
                    male_reduction += 0.01  # small extra for genuinely bass voices ≤130 Hz
                adaptive_threshold -= male_reduction

            if best_cross_gender:
                adaptive_threshold += CROSS_GENDER_EXTRA_THRESHOLD

            # ── Split-signal flags ─────────────────────────────────────────────
            best_same_zone_far_pitch = False; best_mouth_dist = None; best_same_zone_far_mouth = False
            if (best_profile is not None and pitch_mean is not None
                    and best_profile.get("pitch_mean") is not None
                    and pitch_count >= MIN_PITCH_FRAMES and best_profile.get("pitch_count", 0) >= MIN_PITCH_FRAMES):
                best_same_zone_far_pitch = self._same_zone_far_pitch(
                    pitch_mean, pitch_count, best_profile.get("pitch_mean"), best_profile.get("pitch_count", 0))
            if (best_profile is not None and mouth_vec is not None
                    and best_profile.get("mouth_vec") is not None
                    and mouth_count >= MOUTHPRINT_MIN_FRAMES and best_profile.get("mouth_count", 0) >= MOUTHPRINT_MIN_FRAMES):
                best_mouth_dist = float(np.linalg.norm(mouth_vec - best_profile.get("mouth_vec")))
                if (self._pitch_zone(pitch_mean) == self._pitch_zone(best_profile.get("pitch_mean"))
                        and self._pitch_zone(pitch_mean) in ("male", "female")):
                    best_same_zone_far_mouth = best_mouth_dist >= MOUTHPRINT_FAR_DIST

            best_split_signal = (
                    best_same_zone and not best_cross_gender
                    and (best_same_zone_far_pitch or best_same_zone_far_mouth or best_tone_penalty >= SPLIT_TONE_PENALTY)
            )
            if best_same_zone_far_mouth and not best_cross_gender: adaptive_threshold += 0.05
            if best_split_signal: adaptive_threshold += 0.03

            similarity_gap = best_sim - second_best_sim if second_best_sim >= 0 else 1.0
            hard_cross_gender_block = best_cross_gender and best_sim < CROSS_GENDER_STRONG_MATCH_THRESHOLD

            print(
                f"[diarize] sims=[{', '.join(sim_debug)}] best={best_sim:.3f} second={second_best_sim:.3f} "
                f"gap={similarity_gap:.3f} threshold={adaptive_threshold:.3f}"
                f"{f' md={best_mouth_dist:.2f}' if best_mouth_dist is not None else ''}"
                f"{' [split]' if best_split_signal else ''}{' [cg-block]' if hard_cross_gender_block else ''}"
            )

            # Count how many split sub-signals fired for proportional blocking
            split_sub_count = sum([best_same_zone_far_pitch, best_same_zone_far_mouth,
                                   best_tone_penalty >= SPLIT_TONE_PENALTY]) if best_split_signal else 0

            if not best_split_signal:
                split_confident_override = True
            elif split_sub_count >= 2:
                split_confident_override = (
                        best_sim >= (STRONG_MATCH_THRESHOLD + 0.10)
                        and similarity_gap >= (AMBIGUOUS_GAP + 0.12)
                )
            else:
                split_confident_override = (
                        best_sim >= (STRONG_MATCH_THRESHOLD + 0.04)
                        and similarity_gap >= (AMBIGUOUS_GAP + 0.06)
                )
            is_confident_match = (
                    best_sim >= adaptive_threshold
                    and (similarity_gap >= AMBIGUOUS_GAP or best_sim >= STRONG_MATCH_THRESHOLD)
                    and not hard_cross_gender_block
                    and split_confident_override
            )

            def _ema_update(profile, alpha_emb, alpha_pitch=0.10, alpha_mouth=0.08):
                if best_sim >= EMA_UPDATE_MIN_SIM:
                    profile["embedding"] = profile["embedding"] * (1 - alpha_emb) + emb_np * alpha_emb
                    self._update_profile_features(profile, pitch_stats, mouth_vec, mouth_count, alpha_pitch, alpha_mouth)
                profile["count"] += 1

            # ── Read-only path ─────────────────────────────────────────────────
            if not update_profiles:
                if is_confident_match and best_profile is not None:
                    return _result(best_profile["id"])
                if (self._last_speaker_id is not None and last_speaker_sim is not None
                        and (now - self._last_speaker_time) <= STICKY_RECENT_SEC
                        and last_speaker_sim >= (adaptive_threshold - WEAK_MATCH_MARGIN)):
                    return _result(self._last_speaker_id)
                sid = best_profile["id"] if best_profile is not None else (self._last_speaker_id or 0)
                return _result(sid)

            # ── Confident match ────────────────────────────────────────────────
            if is_confident_match and best_profile is not None:
                if (not best_split_signal) and not self._allow_switch(best_profile["id"], best_sim, similarity_gap, now):
                    sid = self._last_speaker_id if self._last_speaker_id is not None else best_profile["id"]
                    print(f"[diarize] hold Speaker {sid+1} (candidate={best_profile['id']+1}, sim={best_sim:.3f})")
                    return _result(sid)
                _ema_update(best_profile, 0.10, 0.12, 0.10)
                print(f"[diarize] → Speaker {best_profile['id']+1} (sim={best_sim:.3f}, gap={similarity_gap:.3f}, f0={pitch_mean or 0:.0f})")
                self._last_speaker_id = best_profile["id"]; self._last_speaker_time = now
                self._clear_pending_switch(); self._clear_pending_new()
                return _result(best_profile["id"])

            # ── Sticky fallback ────────────────────────────────────────────────
            if (self._last_speaker_id is not None and last_speaker_sim is not None
                    and last_speaker_idx >= 0
                    and (now - self._last_speaker_time) <= STICKY_RECENT_SEC
                    and not best_split_signal):
                sticky_threshold = adaptive_threshold - WEAK_MATCH_MARGIN
                last_profile = self._profiles[last_speaker_idx]
                last_cross_gender = (
                        pitch_mean is not None and last_profile.get("pitch_mean") is not None
                        and pitch_count >= MIN_PITCH_FRAMES and last_profile.get("pitch_count", 0) >= MIN_PITCH_FRAMES
                        and self._is_cross_gender(pitch_mean, last_profile.get("pitch_mean"))
                )
                last_far_pitch = self._same_zone_far_pitch(
                    pitch_mean, pitch_count, last_profile.get("pitch_mean"), last_profile.get("pitch_count", 0))
                last_far_mouth = False
                if (mouth_vec is not None and last_profile.get("mouth_vec") is not None
                        and mouth_count >= MOUTHPRINT_MIN_FRAMES and last_profile.get("mouth_count", 0) >= MOUTHPRINT_MIN_FRAMES):
                    md = float(np.linalg.norm(mouth_vec - last_profile.get("mouth_vec")))
                    lz = self._pitch_zone(last_profile.get("pitch_mean"))
                    last_far_mouth = (self._pitch_zone(pitch_mean) == lz and lz in ("male", "female") and md >= MOUTHPRINT_FAR_DIST)

                is_male_sticky = (pitch_mean is not None and pitch_mean < FEMALE_F0_HZ
                                  and last_profile.get("pitch_mean") is not None and last_profile.get("pitch_mean") < FEMALE_F0_HZ)
                is_female_sticky = (pitch_mean is not None and pitch_mean >= FEMALE_F0_HZ
                                    and last_profile.get("pitch_mean") is not None and last_profile.get("pitch_mean") >= FEMALE_F0_HZ)
                eff_margin = STICKY_SIM_MARGIN + (0.02 if is_male_sticky else 0.0)
                sticky_threshold = adaptive_threshold - WEAK_MATCH_MARGIN

                if (not last_cross_gender and not last_far_pitch and not last_far_mouth
                        and last_speaker_sim >= sticky_threshold
                        and (best_sim - last_speaker_sim) <= eff_margin):
                    _ema_update(last_profile, 0.08, 0.10, 0.08)
                    print(f"[diarize] → Speaker {last_profile['id']+1} (sticky sim={last_speaker_sim:.3f}, best={best_sim:.3f})")
                    self._last_speaker_time = now
                    self._clear_pending_switch(); self._clear_pending_new()
                    return _result(last_profile["id"])

            # ── Weak fallback ──────────────────────────────────────────────────
            if (best_profile is not None and not best_cross_gender
                    and not best_same_zone_far_pitch and not best_same_zone_far_mouth and not best_split_signal
                    and best_sim >= (adaptive_threshold - WEAK_MATCH_MARGIN)):
                _ema_update(best_profile, 0.08, 0.10, 0.08)
                print(f"[diarize] → Speaker {best_profile['id']+1} (weak sim={best_sim:.3f})")
                self._last_speaker_id = best_profile["id"]; self._last_speaker_time = now
                self._clear_pending_switch(); self._clear_pending_new()
                return _result(best_profile["id"])

            # ── Max speakers cap ───────────────────────────────────────────────
            if len(self._profiles) >= MAX_SPEAKERS and best_profile is not None:
                _ema_update(best_profile, 0.08, 0.08, 0.06)
                print(f"[diarize] → Speaker {best_profile['id']+1} (max-cap, sim={best_sim:.3f})")
                self._last_speaker_id = best_profile["id"]; self._last_speaker_time = now
                self._clear_pending_switch(); self._clear_pending_new()
                return _result(best_profile["id"])

            # ── Short chunk guard ──────────────────────────────────────────────
            if (duration_sec < NEW_SPEAKER_MIN_SECONDS and self._last_speaker_id is not None
                    and (now - self._last_speaker_time) <= STICKY_RECENT_SEC):
                print(f"[diarize] short chunk {duration_sec:.2f}s → keep Speaker {self._last_speaker_id+1}")
                return _result(self._last_speaker_id)

            # ── New speaker debounce ───────────────────────────────────────────
            if len(self._profiles) > 0 and self._last_speaker_id is not None:
                required_new_hits = NEW_SPEAKER_CONFIRM_HITS
                if self._source == "system":
                    # System-audio WS segments are noisier / mixed; allow quicker split.
                    required_new_hits = max(1, NEW_SPEAKER_CONFIRM_HITS - 1)
                if best_split_signal:
                    required_new_hits = 1
                elif best_same_zone_far_pitch or best_same_zone_far_mouth:
                    required_new_hits = max(2, NEW_SPEAKER_CONFIRM_HITS - 1)
                if best_sim < (adaptive_threshold - 0.12) and similarity_gap >= max(AMBIGUOUS_GAP, 0.09):
                    required_new_hits = 1

                if (self._pending_new_emb is None
                        or (now - self._pending_new_time) > NEW_SPEAKER_CONFIRM_WINDOW_SEC):
                    self._pending_new_emb = emb_np.copy()
                    self._pending_new_hits = 1; self._pending_new_time = now
                    self._pending_new_pitch_mean = pitch_mean; self._pending_new_pitch_count = pitch_count
                    print(f"[diarize] pending NEW speaker 1/{required_new_hits}")
                    return _result(self._last_speaker_id)

                pending_sim = self._cosine_sim(emb_np, self._pending_new_emb)
                pending_thr = NEW_SPEAKER_SELF_SIM - (0.04 if best_same_zone_far_mouth else 0.0)
                if pending_sim >= pending_thr:
                    self._pending_new_hits += 1; self._pending_new_time = now
                    self._pending_new_emb = self._pending_new_emb * 0.85 + emb_np * 0.15
                    if pitch_mean is not None and pitch_count >= MIN_PITCH_FRAMES:
                        pf0 = self._pending_new_pitch_mean if self._pending_new_pitch_mean is not None else pitch_mean
                        self._pending_new_pitch_mean = pf0 * 0.85 + pitch_mean * 0.15
                        self._pending_new_pitch_count = int(min(1000, max(self._pending_new_pitch_count, 0) + pitch_count))
                else:
                    self._pending_new_hits = 1; self._pending_new_time = now
                    self._pending_new_emb = emb_np.copy()
                    self._pending_new_pitch_mean = pitch_mean; self._pending_new_pitch_count = pitch_count

                if self._pending_new_hits < required_new_hits:
                    print(f"[diarize] pending NEW {self._pending_new_hits}/{required_new_hits} (psim={pending_sim:.3f})")
                    return _result(self._last_speaker_id)

            # ── Register new speaker ───────────────────────────────────────────
            sid = self._next_id; self._next_id += 1
            self._profiles.append({
                "id": sid, "embedding": emb_np, "count": 1,
                "pitch_mean": pitch_mean, "pitch_std": pitch_std,
                "pitch_count": pitch_count, "pitch_stats": pitch_stats,
                "mouth_vec": mouth_vec, "mouth_count": mouth_count,
                "created_at": time.time(),
            })
            print(f"[diarize] → Speaker {sid+1} NEW (best_sim={best_sim:.3f}, gap={similarity_gap:.3f}, f0={pitch_mean or 0:.0f})")
            self._last_speaker_id = sid; self._last_speaker_time = now
            self._clear_pending_switch(); self._clear_pending_new()
            return _result(sid, is_new=True)

        except Exception as e:
            print(f"[diarize] CAM++ error: {e}, falling back to pitch")
            return self._identify_pitch(wav_path, update_profiles=update_profiles)

    # ── Static helpers ─────────────────────────────────────────────────────────

    @staticmethod
    def _cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
        dot = np.dot(a, b)
        norm = np.linalg.norm(a) * np.linalg.norm(b)
        return float(dot / norm) if norm >= 1e-8 else 0.0

    @staticmethod
    def _pitch_zone(f0_hz) -> str:
        if f0_hz is None: return "unknown"
        if f0_hz <= MALE_F0_HZ: return "male"
        if f0_hz >= FEMALE_F0_HZ: return "female"
        return "neutral"

    @classmethod
    def _is_cross_gender(cls, f0_a, f0_b) -> bool:
        if f0_a is None or f0_b is None: return False
        za, zb = cls._pitch_zone(f0_a), cls._pitch_zone(f0_b)
        if "unknown" in (za, zb) or "neutral" in (za, zb) or za == zb: return False
        return abs(f0_a - f0_b) >= CROSS_GENDER_MIN_DIFF

    @staticmethod
    def _soft_cross_gender_penalty(f0_a, f0_b) -> float:
        if f0_a is None or f0_b is None: return 0.0
        za, zb = SpeakerDiarizer._pitch_zone(f0_a), SpeakerDiarizer._pitch_zone(f0_b)
        if za == zb or "neutral" not in (za, zb): return 0.0
        return min(abs(f0_a - f0_b) * SOFT_CROSS_GENDER_FACTOR, 0.06)

    @staticmethod
    def _load_wav_samples(wav_path: str) -> np.ndarray:
        import wave
        with wave.open(wav_path, "rb") as wf:
            frames = wf.readframes(wf.getnframes())
            return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

    @staticmethod
    def _extract_pitch_stats(samples: np.ndarray, sr: int = 16000):
        f0s, energies = [], []
        frame_size = 2048
        for offset in range(0, len(samples) - frame_size, 1024):
            frame = samples[offset: offset + frame_size]
            rms = np.sqrt(np.mean(frame ** 2))
            if rms < 0.02: continue
            energies.append(rms)
            corr = np.correlate(frame, frame, mode="full")[len(frame)-1:]
            min_lag, max_lag = sr // 500, min(sr // 60, len(corr))
            if min_lag >= max_lag: continue
            peak = np.argmax(corr[min_lag:max_lag]) + min_lag
            if peak > 0: f0s.append(sr / peak)
        if len(f0s) < MIN_PITCH_FRAMES: return None
        zcr = np.mean(np.abs(np.diff(np.sign(samples))) > 0)
        f0_arr = np.array(f0s, dtype=np.float32)
        f0_deltas = np.diff(f0_arr) if len(f0_arr) > 1 else np.array([0.0])
        return {
            "mean": float(np.mean(f0_arr)), "std": float(np.std(f0_arr)),
            "median": float(np.median(f0_arr)),
            "p10": float(np.percentile(f0_arr, 10)), "p90": float(np.percentile(f0_arr, 90)),
            "delta_std": float(np.std(f0_deltas)), "count": len(f0s),
            "energy": float(np.mean(energies)) if energies else 0.0,
            "zcr": float(zcr),
        }

    @staticmethod
    def _l2_normalize(vec: np.ndarray) -> np.ndarray:
        norm = float(np.linalg.norm(vec))
        return vec / norm if norm >= 1e-8 else vec

    @staticmethod
    def _extract_mouthprint(samples: np.ndarray, sr: int = 16000):
        frame_size = MOUTHPRINT_FRAME_SIZE
        hop = frame_size // 2
        if len(samples) < frame_size: return None, 0
        bands = [(80,200),(200,350),(350,550),(550,800),(800,1150),(1150,1600),(1600,2200),(2200,3000),(3000,4000),(4000,5500)]
        freqs = np.fft.rfftfreq(frame_size, 1.0 / sr)
        band_idx = [np.where((freqs >= lo) & (freqs < hi))[0] for lo, hi in bands]
        window = np.hanning(frame_size).astype(np.float32)
        band_acc = np.zeros(len(bands), dtype=np.float64)
        cent_acc = bw_acc = flat_acc = 0.0; valid = 0
        for offset in range(0, len(samples) - frame_size, hop):
            frame = samples[offset: offset + frame_size]
            if float(np.sqrt(np.mean(frame**2))) < 0.015: continue
            mag = np.abs(np.fft.rfft(frame * window))
            power = mag**2 + 1e-9; total = float(np.sum(power))
            if total <= 1e-8: continue
            for bi, idx in enumerate(band_idx):
                if len(idx): band_acc[bi] += float(np.log1p(np.mean(power[idx])))
            centroid = float(np.sum(freqs * power) / total)
            bw = float(np.sqrt(np.sum(((freqs - centroid)**2) * power) / total))
            geo = float(np.exp(np.mean(np.log(power))))
            cent_acc += centroid / 4000.0; bw_acc += bw / 4000.0
            flat_acc += geo / max(float(np.mean(power)), 1e-9); valid += 1
        if valid < MOUTHPRINT_MIN_FRAMES: return None, valid
        vec = np.concatenate([
            (band_acc / valid).astype(np.float32),
            np.array([cent_acc/valid, bw_acc/valid, flat_acc/valid], dtype=np.float32),
        ])
        return SpeakerDiarizer._l2_normalize(vec), valid

    @staticmethod
    def _vi_tone_penalty(curr_stats, profile_stats) -> float:
        if not curr_stats or not profile_stats: return 0.0
        if curr_stats.get("count", 0) < MIN_PITCH_FRAMES or profile_stats.get("count", 0) < MIN_PITCH_FRAMES: return 0.0
        median_diff = abs(float(curr_stats.get("median", 0)) - float(profile_stats.get("median", 0)))
        span_diff   = abs((float(curr_stats.get("p90",0)) - float(curr_stats.get("p10",0))) -
                          (float(profile_stats.get("p90",0)) - float(profile_stats.get("p10",0))))
        dstd_diff   = abs(float(curr_stats.get("delta_std",0)) - float(profile_stats.get("delta_std",0)))
        score = median_diff / max(VI_TONE_DIFF_DENOM, 1) + span_diff / 120.0 + dstd_diff / 80.0
        return min(score * VI_TONE_PENALTY_FACTOR, 0.08)

    def _identify_pitch(self, wav_path: str, update_profiles: bool = True) -> dict:
        try:
            samples = self._load_wav_samples(wav_path)
            stats = self._extract_pitch_stats(samples, 16000)
            if not stats: return {"speaker": "Speaker 1", "speaker_id": 0}
            features = np.array([stats["mean"]/100, stats["std"]/50,
                                 (stats["energy"] or 0)*10, stats["zcr"]*5])

            def _r(sid, is_new=False):
                out = {"speaker": f"Speaker {sid+1}", "speaker_id": sid, "embedding": features.copy()}
                if is_new: out["is_new"] = True
                return out

            if len(self._profiles) == 0:
                if not update_profiles: return _r(0)
                sid = self._next_id; self._next_id += 1
                self._profiles.append({"id": sid, "embedding": features, "count": 1})
                self._last_speaker_id = sid; self._last_speaker_time = time.time()
                return _r(sid, is_new=True)

            dists = [(i, np.linalg.norm(features - p["embedding"][:len(features)])) for i, p in enumerate(self._profiles)]
            best_idx, best_dist = min(dists, key=lambda x: x[1])
            if not update_profiles:
                sid = self._profiles[best_idx]["id"] if best_dist < 1.2 else (self._last_speaker_id or 0)
                return _r(sid)
            if best_dist < 1.2:
                p = self._profiles[best_idx]
                p["embedding"] = p["embedding"] * 0.85 + features * 0.15; p["count"] += 1
                self._last_speaker_id = p["id"]; self._last_speaker_time = time.time()
                return _r(p["id"])
            sid = self._next_id; self._next_id += 1
            self._profiles.append({"id": sid, "embedding": features, "count": 1})
            self._last_speaker_id = sid; self._last_speaker_time = time.time()
            return _r(sid, is_new=True)
        except Exception as e:
            print(f"[diarize:pitch] error: {e}")
            return {"speaker": "Speaker 1", "speaker_id": 0}


# ══════════════════════════════════════════════════════════════════════════════
# Background Reconciler
# ══════════════════════════════════════════════════════════════════════════════
# Chạy mỗi RECONCILE_INTERVAL_SEC, nhìn lại PATCH_WINDOW_SEC gần nhất.
#
# CHỈ làm một việc an toàn: phát hiện 2 profile thực ra là cùng 1 người
# (bị fragmented) và merge lại. KHÔNG reassign orphan (tắt mặc định).
#
# Guard chống false-merge (tất cả phải thoả mãn đồng thời):
#   1. cosine sim >= MERGE_SIM_THRESHOLD (0.94 — rất cao)
#   2. pitch compatible: không cross-gender, diff <= MERGE_MAX_PITCH_DIFF_HZ
#   3. Xuất hiện trong MERGE_CONFIRM_HITS passes liên tiếp (không phải 1 lần)
#   4. Cả 2 profile có >= MERGE_MIN_PROFILE_HITS hits tổng cộng
#   5. Số patch trong 1 pass <= MAX_PATCHES_PER_PASS và tỉ lệ <= MAX_PATCH_RATIO
#
# Dùng:
#   reconciler = BackgroundReconciler(diarizer, on_correction=my_callback)
#   reconciler.start()
#   # sau mỗi identify_speaker():
#   reconciler.record_chunk(chunk_id, speaker_id, timestamp, embedding)
#   # patch callback: on_correction(patches: list[dict])
#   # patch keys: chunk_id, old_speaker_id, new_speaker_id, old_speaker, new_speaker, timestamp
# ══════════════════════════════════════════════════════════════════════════════

class BackgroundReconciler:
    def __init__(self, diarizer: SpeakerDiarizer, on_correction=None,
                 interval_sec: float = RECONCILE_INTERVAL_SEC,
                 patch_window_sec: float = PATCH_WINDOW_SEC):
        self._diarizer        = diarizer
        self._on_correction   = on_correction
        self._interval        = interval_sec
        self._patch_window    = patch_window_sec
        self._chunks: list[dict] = []
        self._chunks_lock     = threading.Lock()
        # merge confirmation counter: pair_key → consecutive passes above threshold
        self._merge_hits: dict[tuple[int,int], int] = {}
        self._thread: threading.Thread | None = None
        self._stop_event      = threading.Event()

    def start(self):
        if self._thread and self._thread.is_alive(): return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="diarize-reconciler")
        self._thread.start()
        print("[reconciler] started")

    def stop(self):
        self._stop_event.set()
        if self._thread: self._thread.join(timeout=self._interval + 2)
        print("[reconciler] stopped")

    def reset(self):
        with self._chunks_lock: self._chunks = []
        self._merge_hits = {}

    def record_chunk(self, chunk_id: str, speaker_id: int,
                     timestamp: float | None = None,
                     embedding: "np.ndarray | None" = None):
        emb = None
        if embedding is not None:
            try: emb = np.asarray(embedding, dtype=np.float32).flatten()
            except Exception: pass
        with self._chunks_lock:
            self._chunks.append({
                "chunk_id": chunk_id, "speaker_id": speaker_id,
                "timestamp": timestamp if timestamp is not None else time.time(),
                "embedding": emb,
            })
            cutoff = time.time() - self._patch_window - 5.0
            self._chunks = [c for c in self._chunks if c["timestamp"] >= cutoff]

    # ── internal ───────────────────────────────────────────────────────────────

    def _run(self):
        while not self._stop_event.wait(self._interval):
            try: self._reconcile()
            except Exception as e: print(f"[reconciler] error: {e}")

    @staticmethod
    def _pair_key(a: int, b: int) -> tuple[int, int]:
        return (a, b) if a < b else (b, a)

    @staticmethod
    def _pitch_merge_safe(pa: dict, pb: dict) -> bool:
        """Return True if pitch evidence does NOT contradict a merge."""
        fa, fb = pa.get("pitch_mean"), pb.get("pitch_mean")
        ca = int(pa.get("pitch_count") or 0)
        cb = int(pb.get("pitch_count") or 0)
        if fa is None or fb is None or ca < MIN_PITCH_FRAMES or cb < MIN_PITCH_FRAMES:
            return True   # no pitch data → don't block on pitch
        if SpeakerDiarizer._is_cross_gender(fa, fb):
            return False
        za, zb = SpeakerDiarizer._pitch_zone(fa), SpeakerDiarizer._pitch_zone(fb)
        if za == zb and za in ("male", "female"):
            return abs(float(fa) - float(fb)) <= MERGE_MAX_PITCH_DIFF_HZ
        return True

    def _reconcile(self):
        now    = time.time()
        cutoff = now - self._patch_window

        with self._chunks_lock:
            window_chunks = [c for c in self._chunks if c["timestamp"] >= cutoff]
        if not window_chunks:
            self._merge_hits = {}
            return

        with self._diarizer._lock:
            profiles = list(self._diarizer._profiles)
        if len(profiles) < 2:
            self._merge_hits = {}
            return

        # ── Evaluate every profile pair ────────────────────────────────────────
        merge_map: dict[int, int] = {}
        next_hits: dict[tuple[int,int], int] = {}
        live_ids  = {p["id"] for p in profiles}

        for i in range(len(profiles)):
            for j in range(i + 1, len(profiles)):
                pa, pb = profiles[i], profiles[j]
                key = self._pair_key(pa["id"], pb["id"])

                # Basic guards
                if len(pa["embedding"]) != len(pb["embedding"]):
                    continue
                if int(pa.get("count") or 0) < MERGE_MIN_PROFILE_HITS:
                    continue
                if int(pb.get("count") or 0) < MERGE_MIN_PROFILE_HITS:
                    continue
                if not self._pitch_merge_safe(pa, pb):
                    continue

                sim = SpeakerDiarizer._cosine_sim(pa["embedding"], pb["embedding"])
                if sim < MERGE_SIM_THRESHOLD:
                    # Reset counter — evidence dropped below threshold
                    continue

                # Accumulate confirmation hits
                hits = self._merge_hits.get(key, 0) + 1
                next_hits[key] = hits

                if hits < MERGE_CONFIRM_HITS:
                    print(f"[reconciler] merge candidate S{pa['id']+1}↔S{pb['id']+1} "
                          f"sim={sim:.3f} hit {hits}/{MERGE_CONFIRM_HITS}")
                    continue

                # All guards passed — commit merge
                keep, drop = (pa, pb) if pa["count"] >= pb["count"] else (pb, pa)
                print(f"[reconciler] MERGE S{drop['id']+1} → S{keep['id']+1} "
                      f"(sim={sim:.3f}, hits={hits}, counts={pa['count']}/{pb['count']})")

                with self._diarizer._lock:
                    lk = next((p for p in self._diarizer._profiles if p["id"] == keep["id"]), None)
                    ld = next((p for p in self._diarizer._profiles if p["id"] == drop["id"]), None)
                    if lk is None or ld is None:
                        continue
                    total = lk["count"] + ld["count"]
                    wk, wd = lk["count"] / max(total, 1), ld["count"] / max(total, 1)
                    lk["embedding"] = SpeakerDiarizer._l2_normalize(
                        lk["embedding"] * wk + ld["embedding"] * wd)
                    lk["count"] = total
                    if lk.get("pitch_mean") and ld.get("pitch_mean"):
                        lk["pitch_mean"] = lk["pitch_mean"] * wk + ld["pitch_mean"] * wd
                    self._diarizer._profiles = [p for p in self._diarizer._profiles if p["id"] != drop["id"]]
                    if self._diarizer._last_speaker_id == drop["id"]:
                        self._diarizer._last_speaker_id = keep["id"]

                merge_map[drop["id"]] = keep["id"]
                next_hits.pop(key, None)   # reset counter after successful merge

        # Clean up stale counters for profiles that no longer exist
        self._merge_hits = {k: v for k, v in next_hits.items()
                            if k[0] in live_ids and k[1] in live_ids}

        if not merge_map:
            return

        # ── Build patch list ───────────────────────────────────────────────────
        patches = []
        chunk_updates = []
        for c in window_chunks:
            old_sid = c["speaker_id"]
            new_sid = old_sid
            seen = set()
            while new_sid in merge_map and new_sid not in seen:
                seen.add(new_sid); new_sid = merge_map[new_sid]
            if new_sid == old_sid: continue
            patches.append({
                "chunk_id": c["chunk_id"],
                "old_speaker_id": old_sid, "new_speaker_id": new_sid,
                "old_speaker": f"Speaker {old_sid+1}", "new_speaker": f"Speaker {new_sid+1}",
                "timestamp": c["timestamp"],
            })
            chunk_updates.append((c, new_sid))

        if not patches:
            return

        # Safety gates: don't mass-rewrite transcript in one pass
        if len(patches) > MAX_PATCHES_PER_PASS:
            print(f"[reconciler] skip: too many patches ({len(patches)} > {MAX_PATCHES_PER_PASS})")
            return
        if len(window_chunks) > 0 and len(patches) / len(window_chunks) > MAX_PATCH_RATIO:
            print(f"[reconciler] skip: patch ratio {len(patches)}/{len(window_chunks)} > {MAX_PATCH_RATIO}")
            return

        for c, new_sid in chunk_updates:
            c["speaker_id"] = new_sid

        print(f"[reconciler] emitting {len(patches)} patch(es)")
        if self._on_correction:
            try: self._on_correction(patches)
            except Exception as e: print(f"[reconciler] callback error: {e}")
