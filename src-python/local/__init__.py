"""Local/offline STT support (device detection, model registry, engines).

Phase 1 (Tier C) introduces:
  - device_detect: pick runtime tier (A=MLX / B=CUDA-ONNX / C=CPU-ONNX)
  - model_registry: tier → model artifact spec + local cache resolution
"""
