"""HTTP API for the SPHEREx sky flipbook, plus the static frontend.

Run locally:  .venv/Scripts/python -m uvicorn backend.app:app --port 8000
"""

import asyncio
import base64
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from .spherex import archive, cache, cutout, resolve

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per S3 range read is too much
log = logging.getLogger("spherex")

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    limits = httpx.Limits(max_connections=64, max_keepalive_connections=64)
    async with httpx.AsyncClient(limits=limits, follow_redirects=True) as client:
        app.state.http = client
        yield


app = FastAPI(title="SPHEREx Sky Flipbook", lifespan=lifespan)


def _b64(a: np.ndarray, dtype: str) -> str:
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode()


def _line(obj: dict) -> bytes:
    return (json.dumps(obj, separators=(",", ":")) + "\n").encode()


@app.get("/api/resolve")
async def api_resolve(name: str = Query(min_length=1, max_length=200), epoch: float = 2026.0):
    try:
        return await resolve.resolve(app.state.http, name.strip(), epoch)
    except resolve.NotFound:
        raise HTTPException(404, f"No object named {name!r} was found")
    except RuntimeError as e:
        raise HTTPException(502, str(e))


@app.get("/api/images")
async def api_images(ra: float = Query(ge=0, lt=360), dec: float = Query(ge=-90, le=90)):
    try:
        images = await archive.search(app.state.http, ra, dec)
    except RuntimeError as e:
        raise HTTPException(502, str(e))
    return {"count": len(images), "images": [i.to_json() for i in images]}


@app.get("/api/cutouts")
async def api_cutouts(
    ra: float = Query(ge=0, lt=360),
    dec: float = Query(ge=-90, le=90),
    fov: float = Query(4.0, ge=1.0, le=30.0, description="field of view, arcmin"),
    detectors: str = Query("123456", pattern="^[1-6]{1,6}$"),
):
    """Newline-delimited JSON: one `meta` line, then a `cutout` line per exposure as each finishes."""
    client = app.state.http
    wanted = {int(d) for d in detectors}
    grid = cutout.Grid.for_fov(ra, dec, fov)

    async def one(rec):
        try:
            return rec, await cutout.make_cutout(client, rec, grid), None
        except Exception as e:  # one bad file should not end the stream
            log.warning("cutout of %s failed: %r", rec.key, e)
            return rec, None, e

    async def stream():
        try:
            images = [i for i in await archive.search(client, ra, dec) if i.detector in wanted]
        except RuntimeError as e:
            yield _line({"type": "fatal", "message": str(e)})
            return
        yield _line({"type": "meta", "grid": grid.to_json(), "count": len(images)})

        # A field whose every exposure was cut out before replays from one file; the key covers the
        # exact image list, so a new release (more images) misses and rebuilds.
        field_key = json.dumps([grid.to_json(), sorted(i.key for i in images)])
        if (replay := cache.get_blob("field", field_key)) is not None:
            yield replay
            yield _line({"type": "done"})
            return

        planes: dict[int, tuple[str, str]] = {}
        recorded: list[bytes] = []
        failed = False
        tasks = [asyncio.create_task(one(rec)) for rec in images]
        try:
            for done in asyncio.as_completed(tasks):
                rec, cut, err = await done
                if err is not None:
                    failed = True
                    line = _line({"type": "error", "key": rec.key, "message": repr(err)})
                elif cut is None:
                    line = _line({"type": "skip", "key": rec.key})
                else:
                    if set(cut.flag_planes) - set(planes):
                        planes.update(cut.flag_planes)
                        planes_line = _line({"type": "flag_planes", "planes": {
                            str(bit): {"name": n, "description": d} for bit, (n, d) in sorted(planes.items())}})
                        recorded.append(planes_line)
                        yield planes_line
                    line = _line({"type": "cutout", **rec.to_json(),
                                  "image": _b64(cut.image, "<f4"), "flags": _b64(cut.flags, "<i4")})
                recorded.append(line)
                yield line
        finally:
            for t in tasks:
                t.cancel()  # the browser went away or asked for a new field
        if not failed:
            await asyncio.to_thread(cache.put_blob, "field", field_key, b"".join(recorded))
        yield _line({"type": "done"})

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.middleware("http")
async def revalidate_static(request, call_next):
    # Without this, browsers heuristically cache the ES modules and keep running stale code.
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


if FRONTEND.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
