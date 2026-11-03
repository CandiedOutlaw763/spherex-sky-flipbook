"""Small on-disk cache for searches, file layouts, cutouts and whole fields.

Writes go to ./.cache locally and /tmp on Vercel (the only writable place there); set
SPHEREX_CACHE_DIR to override. Reads fall back to the read-only ./seed directory, which ships
with the deployment so the challenge's test targets load instantly on a cold server
(see scripts/build_seed.py).
"""

import gzip
import hashlib
import json
import os
from pathlib import Path

import numpy as np

_PROJECT = Path(__file__).resolve().parents[2]
_DEFAULT = Path("/tmp/spherex-cache") if os.environ.get("VERCEL") else _PROJECT / ".cache"
ROOT = Path(os.environ.get("SPHEREX_CACHE_DIR", _DEFAULT))
SEED = _PROJECT / "seed"


def _relative(kind: str, key: str, suffix: str) -> Path:
    digest = hashlib.sha1(key.encode()).hexdigest()
    return Path(kind) / digest[:2] / f"{digest}{suffix}"


def _find(kind: str, key: str, suffix: str) -> Path | None:
    rel = _relative(kind, key, suffix)
    for base in (ROOT, SEED):
        if (base / rel).is_file():
            return base / rel
    return None


def _write(kind: str, key: str, suffix: str, write) -> None:
    path = ROOT / _relative(kind, key, suffix)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        write(tmp)
        tmp.replace(path)
    except OSError:
        pass  # caching is best effort; a read-only disk just means no cache


def get_json(kind: str, key: str) -> dict | None:
    try:
        path = _find(kind, key, ".json")
        return json.loads(path.read_text()) if path else None
    except (OSError, ValueError):
        return None


def put_json(kind: str, key: str, value: dict) -> None:
    _write(kind, key, ".json", lambda p: p.write_text(json.dumps(value)))


def get_blob(kind: str, key: str) -> bytes | None:
    try:
        path = _find(kind, key, ".gz")
        return gzip.decompress(path.read_bytes()) if path else None
    except (OSError, EOFError, gzip.BadGzipFile):
        return None


def put_blob(kind: str, key: str, data: bytes) -> None:
    _write(kind, key, ".gz", lambda p: p.write_bytes(gzip.compress(data, compresslevel=5)))


def get_arrays(kind: str, key: str) -> dict[str, np.ndarray] | None:
    try:
        path = _find(kind, key, ".npz")
        if not path:
            return None
        with np.load(path) as f:
            return {name: f[name] for name in f.files}
    except (OSError, ValueError):
        return None


def put_arrays(kind: str, key: str, **arrays: np.ndarray) -> None:
    def write(p: Path) -> None:
        with open(p, "wb") as f:
            np.savez_compressed(f, **arrays)
    _write(kind, key, ".npz", write)
