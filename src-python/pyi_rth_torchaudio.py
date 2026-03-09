# PyInstaller runtime hook — patches torchaudio BEFORE wespeaker/s3prl import.
# s3prl calls torchaudio.set_audio_backend("sox_io") at module level which
# doesn't exist in newer torchaudio versions.
import sys
from types import ModuleType

try:
    import torchaudio
except ImportError:
    pass
else:
    # 1. Stub removed APIs
    if not hasattr(torchaudio, "set_audio_backend"):
        torchaudio.set_audio_backend = lambda x: None
    if not hasattr(torchaudio, "get_audio_backend"):
        torchaudio.get_audio_backend = lambda: "ffmpeg"

    # 2. Mock sox_effects module
    if "torchaudio.sox_effects" not in sys.modules:
        sox_mod = ModuleType("torchaudio.sox_effects")
        sox_mod.apply_effects_tensor = lambda tensor, sr, effects: (tensor, sr)
        sys.modules["torchaudio.sox_effects"] = sox_mod
        torchaudio.sox_effects = sox_mod

    # 3. Disable TorchScript JIT (PyInstaller strips .py source files)
    if getattr(sys, 'frozen', False):
        import torch
        import torch.jit
        import torch.nn as nn
        if not getattr(torch.jit, '_voicescribe_jit_patched', False):
            torch.jit._original_ScriptModule = torch.jit.ScriptModule
            torch.jit.ScriptModule = nn.Module
            if hasattr(torch.jit, 'script_method'):
                torch.jit._original_script_method = torch.jit.script_method
            torch.jit.script_method = lambda fn: fn
            torch.jit._voicescribe_jit_patched = True
