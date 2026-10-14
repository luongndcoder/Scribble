"""Convert PyTorch speaker-embedding checkpoints to ONNX for the Rust diarizer.

Run with the project venv:

    src-python/.venv/bin/python src-python/convert_spk_embedding_onnx.py <which>

`which` is one of:
  * `wavlm-pro`  — Orange/Speaker-wavLM-pro (cc-by-sa-3.0)   -> raw waveform input
  * `pyannote-wespeaker` — pyannote/wespeaker-voxceleb-resnet34-LM (cc-by-4.0)

The exported graph is written to `src-tauri/models/`. Both exports take a
*batched* input so the Rust side can feed one window per call:

  * wavlm-pro:          `input_values` float32 [B, T]   -> `embedding` float32 [B, 250]
  * pyannote-wespeaker: `feats`        float32 [B, T, 80] -> `embs` float32 [B, 256]

The WavLM graph deliberately *includes* the per-utterance MVN normalisation and
the stats pooling from the reference `spk_embeddings.py`, so the Rust call site
only has to hand over raw `[-1, 1]` 16 kHz samples. Keeping the normalisation
inside the graph is what makes the ONNX and the PyTorch reference agree.

Reference: https://huggingface.co/Orange/Speaker-wavLM-pro/blob/main/spk_embeddings.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import torch

REPO = Path(__file__).resolve().parent.parent
MODELS = REPO / "src-tauri" / "models"
MODELS.mkdir(parents=True, exist_ok=True)


def load_state_dict(path: Path):
    """Load a `.safetensors` checkpoint, or a torch pickle as a fallback."""
    if path.suffix == ".safetensors":
        from safetensors.torch import load_file

        return load_file(str(path))
    return torch.load(path, map_location="cpu", weights_only=False)


# ── WavLM-pro ────────────────────────────────────────────────────────────────


def export_wavlm_pro(ckpt: Path, out: Path, sample_len: int = 32000) -> None:
    """Export Orange/Speaker-wavLM-pro with MVN + stats pooling baked in."""
    from transformers.models.wavlm.modeling_wavlm import (
        WavLMModel,
        WavLMPreTrainedModel,
    )
    import torch.nn as nn

    class TopLayers(nn.Module):
        def __init__(self, embd_size=250, top_interm_size=512):
            super().__init__()
            self.affine1 = nn.Conv1d(2048, top_interm_size, kernel_size=1)
            self.batchnorm1 = nn.BatchNorm1d(top_interm_size, affine=False, eps=1e-03)
            self.affine2 = nn.Conv1d(top_interm_size, embd_size, kernel_size=1)
            self.batchnorm2 = nn.BatchNorm1d(embd_size, affine=False, eps=1e-03)
            self.activation = nn.ReLU(inplace=True)

        def forward(self, x):
            out = self.batchnorm1(self.activation(self.affine1(x)))
            out = self.batchnorm2(self.activation(self.affine2(out)))
            return nn.functional.normalize(out[:, :, 0])

    class EmbeddingsModel(WavLMPreTrainedModel):
        def __init__(self, config):
            super().__init__(config)
            self.wavlm = WavLMModel(config)
            self.top_layers = TopLayers(config.embd_size, config.top_interm_size)

        def forward(self, input_values):
            # MVN normalisation, verbatim from the reference script.
            x_norm = (input_values - input_values.mean(dim=1).unsqueeze(1)) / (
                input_values.std(dim=1).unsqueeze(1)
            )
            base_out = self.wavlm(input_values=x_norm).last_hidden_state
            v = base_out.var(dim=1).clamp(min=1e-10)
            x_stats = torch.cat((base_out.mean(dim=1), v.pow(0.5)), dim=1).unsqueeze(dim=2)
            return self.top_layers(x_stats)

    from transformers import AutoConfig

    cfg = AutoConfig.from_pretrained(str(ckpt.parent), trust_remote_code=True)
    cfg.embd_size = getattr(cfg, "embd_size", 250)
    cfg.top_interm_size = getattr(cfg, "top_interm_size", 512)
    model = EmbeddingsModel(cfg)
    state = load_state_dict(ckpt)
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        print(f"  [warn] missing keys: {len(missing)} (first: {missing[:3]})")
    if unexpected:
        print(f"  [warn] unexpected keys: {len(unexpected)} (first: {unexpected[:3]})")
    model.eval()

    dummy = torch.randn(1, sample_len)
    with torch.no_grad():
        ref = model(dummy)
    print(f"  torch reference embedding: {tuple(ref.shape)}")

    torch.onnx.export(
        model,
        (dummy,),
        str(out),
        input_names=["input_values"],
        output_names=["embedding"],
        dynamic_axes={"input_values": {0: "B", 1: "T"}, "embedding": {0: "B"}},
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    print(f"  wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")

    # Numeric parity check against the PyTorch reference.
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    got = sess.run(None, {"input_values": dummy.numpy()})[0]
    diff = float(np.abs(got - ref.numpy()).max())
    print(f"  ONNX vs torch max abs diff: {diff:.3e}")
    if diff > 1e-3:
        print("  [ERROR] parity above tolerance — do not ship this export")
        sys.exit(1)


# ── pyannote WeSpeaker ResNet34 ──────────────────────────────────────────────


def export_pyannote_wespeaker(ckpt: Path, out: Path, frames: int = 200) -> None:
    """Export pyannote/wespeaker-voxceleb-resnet34-LM to a `feats`/`embs` ONNX."""
    from pyannote.audio.models.embedding import WeSpeakerResNet34

    model = WeSpeakerResNet34(
        sample_rate=16000,
        num_channels=1,
        num_mel_bins=80,
        frame_length=25,
        frame_shift=10,
        dither=0.0,
        window_type="hamming",
        use_energy=False,
    )
    state = torch.load(ckpt, map_location="cpu", weights_only=False)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    state = {k.replace("model.", "", 1): v for k, v in state.items() if hasattr(v, "shape")}
    model.load_state_dict(state, strict=False)
    model.eval()

    dummy = torch.randn(1, frames, 80)
    with torch.no_grad():
        ref = model(dummy)
    print(f"  torch reference embedding: {tuple(ref.shape)}")

    class Wrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, feats):
            return self.m(feats)

    torch.onnx.export(
        Wrapper(model),
        (dummy,),
        str(out),
        input_names=["feats"],
        output_names=["embs"],
        dynamic_axes={"feats": {0: "B", 1: "T"}, "embs": {0: "B"}},
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    print(f"  wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")

    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    got = sess.run(None, {"feats": dummy.numpy()})[0]
    diff = float(np.abs(np.asarray(got).reshape(ref.shape) - ref.numpy()).max())
    print(f"  ONNX vs torch max abs diff: {diff:.3e}")


def main() -> None:
    which = sys.argv[1] if len(sys.argv) > 1 else "wavlm-pro"
    scratch = Path("/tmp/spkmodels")
    if which == "wavlm-pro":
        # The checkpoint must sit next to its config.json for AutoConfig to
        # resolve `model_type: wavlm`; stage the HF repo layout first.
        export_wavlm_pro(scratch / "orange" / "model.safetensors", MODELS / "speaker_wavlm_pro.onnx")
    elif which == "pyannote-wespeaker":
        export_pyannote_wespeaker(
            scratch / "pyannote_wespeaker_resnet34.bin",
            MODELS / "speaker_wespeaker_resnet34_lm.onnx",
        )
    else:
        raise SystemExit(f"unknown target {which!r}")


if __name__ == "__main__":
    main()
