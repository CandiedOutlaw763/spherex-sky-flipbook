"""Copy the cached data for the challenge's test targets into seed/, which ships with the deployment.

With the seed, the five preset fields (search results, every cutout, and the Gaia/CatWISE
overlays) load instantly on a cold Vercel instance instead of taking minutes.

Usage, with the local server running on :8000 so every field is fully cached first:
    .venv/Scripts/python scripts/build_seed.py
"""

import asyncio
import json
import math
import re
import shutil
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app import field_cache_key  # noqa: E402
from backend.spherex import archive, cache, catalogs, cutout  # noqa: E402

LOCAL = "http://localhost:8000"
GRID_EPOCH = 2026.0  # must match public/js/main.js


def presets() -> list[dict]:
    """Parse public/js/presets.js so the seed always matches the buttons in the UI."""
    text = (ROOT / "public/js/presets.js").read_text(encoding="utf-8")
    found = []
    for block in re.findall(r"\{[^{}]*id:[^{}]*\}", text):
        get = lambda k: re.search(rf"\b{k}:\s*([-\d.]+)", block).group(1)  # noqa: E731
        found.append({"id": re.search(r'id:\s*"([^"]+)"', block).group(1), **{k: float(get(k)) for k in
                      ("ra", "dec", "epoch", "pmRa", "pmDec", "fov")}})
    return found


def propagate(p: dict) -> tuple[float, float]:
    # Same arithmetic as coords.js propagate(), so the 6-decimal coordinates match exactly.
    years = GRID_EPOCH - p["epoch"]
    dec = p["dec"] + p["pmDec"] * years / 3.6e6
    ra = p["ra"] + p["pmRa"] * years / 3.6e6 / max(math.cos(math.radians(p["dec"])), 1e-6)
    return float(f"{ra % 360:.6f}"), float(f"{max(-90, min(90, dec)):.6f}")


def copy(kind: str, key: str, suffix: str) -> int:
    rel = cache._relative(kind, key, suffix)
    src, dst = cache.ROOT / rel, cache.SEED / rel
    if not src.is_file():
        raise SystemExit(f"missing {kind} cache for {key[:80]}; load it in the app first")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    return src.stat().st_size


async def main() -> None:
    if cache.SEED.exists():
        shutil.rmtree(cache.SEED)
    total = 0
    async with httpx.AsyncClient(timeout=900) as client:
        for p in presets():
            ra, dec = propagate(p)
            fov = p["fov"]
            # Run the field through the server so the replay file and catalogues are complete.
            r = await client.get(f"{LOCAL}/api/cutouts", params={"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "fov": fov})
            r.raise_for_status()
            errors = sum(1 for line in r.text.splitlines() if '"type":"error"' in line)
            radius = f"{fov / 60 * 0.75:.4f}"
            for name in ("gaia", "catwise"):
                q = {"name": name, "ra": f"{ra:.5f}", "dec": f"{dec:.5f}", "radius": radius}
                (await client.get(f"{LOCAL}/api/catalog", params=q)).raise_for_status()

            images = await archive.search(client, ra, dec)
            grid = cutout.Grid.for_fov(ra, dec, fov)
            size = copy("search", f"{ra:.4f}|{dec:.4f}", ".json")
            size += copy("field", field_cache_key(grid, images), ".gz")
            for name in ("gaia", "catwise"):
                size += copy("catalog", catalogs.cache_key(name, float(f"{ra:.5f}"), float(f"{dec:.5f}"), float(radius)), ".json")
            total += size
            print(f"{p['id']:10s} {len(images):5d} images  {size / 1e6:6.1f} MB  {errors} errors")
    copy("collections", "all", ".json")
    print(f"seed/ total {total / 1e6:.1f} MB")


if __name__ == "__main__":
    asyncio.run(main())
