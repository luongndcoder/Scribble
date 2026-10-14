"""Guard the PyInstaller excludes list in scribble-sidecar.spec.

Background (2026-10-09): 'scipy.ndimage' was added to excludes because an
import-hook simulation suggested scipy.signal resolves without it. The built
bundle then crashed at diarizer warmup (`No module named 'scipy.ndimage'`) —
scipy.signal imports it unconditionally. The simulation methodology was
wrong; booting the built binary is the authoritative gate.

This test pins the PROVEN-required module set: spec excludes must never
contain any of them (nor any parent that would imply them).
"""

import ast
import os

import pytest

SPEC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "scribble-sidecar.spec",
)

# Modules the sidecar MUST keep — proven by booting the built bundle, not by
# simulation. scipy is deliberately NOT here: it was removed from the app on
# 2026-10-09 (see the module docstring) and is now excluded on purpose.
REQUIRED = {
    "numpy",
    "uvicorn",
    "onnxruntime",
    "sherpa_onnx",
}

# Modules that must NOT be excluded because a runtime import site needs them.
# Kept separate from REQUIRED so a future re-add of scipy is still caught.
FORBIDDEN_EXCLUDES = REQUIRED | {
    "numpy.core",
    "onnxruntime.capi",
}


def _spec_excludes() -> list:
    src = open(SPEC, encoding="utf-8").read()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "excludes":
            return list(ast.literal_eval(node.value))
    raise AssertionError("excludes list not found in spec")


def test_excludes_never_cover_required_modules():
    excludes = _spec_excludes()
    assert isinstance(excludes, list) and excludes, "spec excludes list empty?"
    violations = [e for e in excludes if e in FORBIDDEN_EXCLUDES]
    assert not violations, (
        f"spec excludes required runtime modules {violations} — "
        "this crashed the built bundle before (scipy.ndimage, 2026-10-09)"
    )


def test_scipy_stays_excluded_and_never_imported():
    """scipy removal is intentional: excluded in spec AND unused in source.

    If someone re-introduces a `from scipy import ...` in src-python, the
    bundled app would crash at that call site (the package is excluded), so
    this test fails loudly at development time instead.
    """
    assert "scipy" in _spec_excludes(), "scipy should stay excluded for bundle size"
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    offenders = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in {".venv", "dist", "build", "__pycache__"}]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            path = os.path.join(dirpath, fn)
            with open(path, encoding="utf-8") as fh:
                for lineno, line in enumerate(fh, 1):
                    stripped = line.strip()
                    if stripped.startswith(("import scipy", "from scipy")):
                        offenders.append(f"{os.path.relpath(path, root)}:{lineno}")
    assert not offenders, f"scipy import found but scipy is excluded from the bundle: {offenders}"


def test_excludes_are_compactable_names():
    """Every entry must be a dotted module path (PyInstaller semantics)."""
    for e in _spec_excludes():
        assert isinstance(e, str) and e and " " not in e, e


def test_runtime_diarizer_callsites_resolve():
    """The diarizer/batch call sites import cleanly WITHOUT scipy.

    scipy was removed from the sidecar (numpy reimplementation of the 3 call
    sites — see tests/test_diarizer_clustering.py for the parity tests).
    """
    from diarize import resample_fft  # noqa: F401
    from services.batch_diarizer import (  # noqa: F401
        _average_linkage,
        _cosine_distance_matrix,
        _fcluster_distance,
    )
