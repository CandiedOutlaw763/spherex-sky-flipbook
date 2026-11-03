"""Small on-disk cache for file layouts and finished cutouts.

Defaults to ./.cache; set SPHEREX_CACHE_DIR (e.g. /tmp on serverless hosts) to move it.
"""

import gzip
import hashlib
import json
import os
from pathlib import Path

import numpy as np

ROOT = Path(os.environ.get("SPHEREX_CACHE_DIR", Path(__file__).resolve().parents[2] / ".cache"))


def _path(kind: str, key: str, suffix: str) -> Path:
    digest = hashlib.sha1(key.encode()).hexdigest()
    return ROOT / kind / digest[:2] / f"{digest}{suffix}"


def _write(path: Path, write) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        write(tmp)
        tmp.replace(path)
    except OSError:
        pass  # caching is best effort; a read-only disk just means no cache


def get_json(kind: str, key: str) -> dict | None:
    try:
        return json.loads(_path(kind, key, ".json").read_text())
    except (OSError, ValueError):
        return None


def put_json(kind: str, key: str, value: dict) -> None:
    _write(_path(kind, key, ".json"), lambda p: p.write_text(json.dumps(value)))


def get_blob(kind: str, key: str) -> bytes | None:
    try:
        return gzip.decompress(_path(kind, key, ".gz").read_bytes())
    except (OSError, EOFError, gzip.BadGzipFile):
        return None


def put_blob(kind: str, key: str, data: bytes) -> None:
    _write(_path(kind, key, ".gz"), lambda p: p.write_bytes(gzip.compress(data, compresslevel=5)))


def get_arrays(kind: str, key: str) -> dict[str, np.ndarray] | None:
    try:
        with np.load(_path(kind, key, ".npz")) as f:
            return {name: f[name] for name in f.files}
    except (OSError, ValueError):
        return None


def put_arrays(kind: str, key: str, **arrays: np.ndarray) -> None:
    def write(p: Path) -> None:
        with open(p, "wb") as f:
            np.savez_compressed(f, **arrays)
    _write(_path(kind, key, ".npz"), write)
