"""Read only the parts of a remote SPHEREx Level 2 FITS file that a cutout needs.

A Level 2 file is ~65 MB. Its HDUs are, in order: an empty primary, IMAGE (2040x2040
float32, uncompressed), FLAGS (int32 bitmask; plain in QR2, Rice-compressed one row per
tile from QR3 on), then VARIANCE, ZODI, EPSF and WCS-WAVE. A cutout needs the IMAGE header, a band of IMAGE rows,
and the matching FLAGS rows; a spectrum also needs the small WCS-WAVE table at the very end.
All of it can be fetched with HTTP range requests.
"""

import asyncio
import logging
import re
import time
from dataclasses import asdict, dataclass

import httpx
import numpy as np
from astropy.io import fits
# Private astropy module, but it is the same C decoder astropy uses for CompImageHDU.
from astropy.io.fits.hdu.compressed._codecs import Rice1

from . import cache

log = logging.getLogger(__name__)

BLOCK = 2880
_END_CARD = b"END" + b" " * 77
_HEADER_GUESS = 12 * BLOCK  # covers the primary and IMAGE headers of current releases
_FLAGS_GUESS = 14 * BLOCK  # FLAGS header plus its 2040-row descriptor table

# Shared limit on simultaneous range requests to S3.
_requests = asyncio.Semaphore(48)

# Running totals, reported at the end of each stream so slow fields can be diagnosed in production.
stats = {"requests": 0, "bytes": 0, "seconds": 0.0}


def _padded(n: int) -> int:
    return (n + BLOCK - 1) // BLOCK * BLOCK


async def _get_range(client: httpx.AsyncClient, url: str, start: int, length: int) -> bytes:
    async with _requests:
        for attempt in range(3):
            try:
                t0 = time.perf_counter()
                r = await client.get(url, headers={"Range": f"bytes={start}-{start + length - 1}"}, timeout=60)
                r.raise_for_status()
                stats["requests"] += 1
                stats["bytes"] += len(r.content)
                stats["seconds"] += time.perf_counter() - t0
                return r.content
            except (httpx.TransportError, httpx.HTTPStatusError) as e:
                if attempt == 2 or (isinstance(e, httpx.HTTPStatusError) and e.response.status_code < 500):
                    raise
                await asyncio.sleep(0.5 * (attempt + 1))
    raise AssertionError("unreachable")


def _header_end(buf: bytes, start: int) -> int | None:
    """Offset just past the header that begins at `start`, or None if END is not in `buf`."""
    pos = start
    while pos + BLOCK <= len(buf):
        block = buf[pos:pos + BLOCK]
        pos += BLOCK
        if any(block[i:i + 80] == _END_CARD for i in range(0, BLOCK, 80)):
            return pos
    return None


async def _read_header(client, url, offset, guess, buf=b"", buf_offset=0):
    """Parse the header at `offset`, reusing `buf` (which starts at `buf_offset`) when it reaches far enough."""
    if buf_offset <= offset and (end := _header_end(buf, offset - buf_offset)) is not None:
        return fits.Header.fromstring(buf[offset - buf_offset:end].decode("ascii")), buf_offset + end, buf, buf_offset
    size = guess
    while True:
        buf = await _get_range(client, url, offset, size)
        if (end := _header_end(buf, 0)) is not None:
            return fits.Header.fromstring(buf[:end].decode("ascii")), offset + end, buf, offset
        if len(buf) < size:
            raise ValueError(f"no END card in header at {offset} of {url}")
        size *= 2


@dataclass
class Layout:
    """Where the cutout ingredients live in one file; cached so repeat visits skip a round trip."""
    image_header: str
    nx: int
    ny: int
    image_offset: int
    flags_offset: int  # start of the plain int32 array, or of the heap when compressed
    flags_tiles: list[tuple[int, int]]  # compressed only, per row: (size, offset into heap)
    flags_blocksize: int
    flag_planes: dict[int, tuple[str, str]]  # bit -> (name, description)


def _flag_planes(header: fits.Header) -> dict[int, tuple[str, str]]:
    """Bit -> (name, description). QR3+ uses MSKNnnnn/MSKDnnnn cards; QR2 used MP_<NAME> = bit."""
    planes = {}
    for key in header:
        if key.startswith("MSKN"):
            planes[int(key[4:])] = (header[key], header.get(f"MSKD{key[4:]}", ""))
        elif key.startswith("MP_"):
            planes[int(header[key])] = (key[3:], header.comments[key])
    return planes


_LAYOUT_VERSION = 3 # bump when Layout's fields change so stale cache entries are ignored


async def read_layout(client: httpx.AsyncClient, url: str) -> Layout:
    cache_key = f"{_LAYOUT_VERSION}|{url}"
    if cached := cache.get_json("layout", cache_key):
        cached["flags_tiles"] = [tuple(t) for t in cached["flags_tiles"]]
        cached["flag_planes"] = {int(k): tuple(v) for k, v in cached["flag_planes"].items()}
        return Layout(**cached)

    buf = await _get_range(client, url, 0, _HEADER_GUESS)
    _, image_header_at, buf, buf_at = await _read_header(client, url, 0, _HEADER_GUESS, buf, 0)
    image_header, image_offset, buf, buf_at = await _read_header(client, url, image_header_at, _HEADER_GUESS, buf, buf_at)
    if image_header.get("EXTNAME") != "IMAGE" or image_header["BITPIX"] != -32:
        raise ValueError(f"unexpected IMAGE HDU in {url}")
    nx, ny = image_header["NAXIS1"], image_header["NAXIS2"]

    flags_at = image_offset + _padded(nx * ny * 4)
    flags_header, data_offset, fbuf, fbuf_at = await _read_header(client, url, flags_at, _FLAGS_GUESS)
    if flags_header.get("EXTNAME") != "FLAGS":
        raise ValueError(f"no FLAGS HDU after IMAGE in {url}")

    if flags_header.get("XTENSION") == "IMAGE" and flags_header["BITPIX"] == 32:
        flags_offset, tiles, blocksize = data_offset, [], 0
    elif flags_header.get("ZCMPTYPE") == "RICE_1" and flags_header.get("ZTILE2") == 1 and flags_header.get("ZBITPIX") == 32:
        table_bytes = flags_header["NAXIS1"] * flags_header["NAXIS2"]
        start = data_offset - fbuf_at
        table = fbuf[start:start + table_bytes]
        if len(table) < table_bytes:
            table = await _get_range(client, url, data_offset, table_bytes)
        descriptors = np.frombuffer(table, dtype=">i4").reshape(-1, 2)
        tiles = [(int(n), int(off)) for n, off in descriptors]
        flags_offset = data_offset + flags_header.get("THEAP", table_bytes)
        blocksize = int(flags_header.get("ZVAL1", 32))
    else:
        raise ValueError(f"unsupported FLAGS encoding in {url}")

    layout = Layout(
        image_header=image_header.tostring(),
        nx=nx,
        ny=ny,
        image_offset=image_offset,
        flags_offset=flags_offset,
        flags_tiles=tiles,
        flags_blocksize=blocksize,
        flag_planes=_flag_planes(flags_header),
    )
    cache.put_json("layout", cache_key, asdict(layout))
    return layout


@dataclass
class WaveTable:
    """WCS-WAVE lookup: wavelength and bandwidth (um) on a grid of detector control points.

    The linear variable filter makes wavelength a smooth function of detector position;
    the file samples it on a coarse grid in 1-based FITS pixel coordinates.
    """
    x: list[float]
    y: list[float]
    wavelength: list[list[float]]  # [iy][ix]
    bandwidth: list[list[float]]

    def at(self, x0: float, y0: float) -> tuple[float, float]:
        """Bilinear lookup at 0-based pixel (x0, y0)."""
        xs, ys = np.asarray(self.x), np.asarray(self.y)
        fx, fy = x0 + 1, y0 + 1
        ix = int(np.clip(np.searchsorted(xs, fx) - 1, 0, len(xs) - 2))
        iy = int(np.clip(np.searchsorted(ys, fy) - 1, 0, len(ys) - 2))
        tx = (fx - xs[ix]) / (xs[ix + 1] - xs[ix])
        ty = (fy - ys[iy]) / (ys[iy + 1] - ys[iy])

        def interp(grid):
            g = np.asarray(grid)
            return float((g[iy, ix] * (1 - tx) + g[iy, ix + 1] * tx) * (1 - ty)
                         + (g[iy + 1, ix] * (1 - tx) + g[iy + 1, ix + 1] * tx) * ty)

        return interp(self.wavelength), interp(self.bandwidth)


_WAVE_TAIL = 14 * BLOCK  # WCS-WAVE is the last HDU: a few header blocks plus one data block
_TFORM = {"J": ">i4", "E": ">f4", "D": ">f8"}


def _wave_cache_key(url: str, detector: int) -> str:
    # The filter map is a property of the detector; key it by pipeline version so a
    # recalibration in a later release is picked up.
    version = re.search(r"l2b-v\d+", url)
    return f"{detector}|{version.group(0) if version else url}"


_wave_tables: dict[str, asyncio.Future] = {}


async def read_wave_table(client: httpx.AsyncClient, url: str, detector: int) -> WaveTable:
    """The WCS-WAVE table for this file's detector and pipeline version, fetched once and shared."""
    key = _wave_cache_key(url, detector)
    future = _wave_tables.get(key)
    if future is None:
        future = _wave_tables[key] = asyncio.ensure_future(_fetch_wave_table(client, url, key))
    try:
        # shield: one cancelled request must not cancel the fetch other cutouts are waiting on
        return await asyncio.shield(future)
    except Exception:
        _wave_tables.pop(key, None)
        raise


async def _fetch_wave_table(client: httpx.AsyncClient, url: str, key: str) -> WaveTable:
    if cached := cache.get_json("wave", key):
        return WaveTable(**cached)
    async with _requests:
        r = await client.get(url, headers={"Range": f"bytes=-{_WAVE_TAIL}"}, timeout=60)
        r.raise_for_status()
        buf = r.content

    start = buf.rfind(b"XTENSION= 'BINTABLE'")
    while start >= 0:
        end = _header_end(buf, start)
        header = fits.Header.fromstring(buf[start:end].decode("ascii")) if end else None
        if header is not None and header.get("EXTNAME") == "WCS-WAVE":
            break
        start = buf.rfind(b"XTENSION= 'BINTABLE'", 0, start)
    else:
        raise ValueError(f"no WCS-WAVE table in the last {_WAVE_TAIL} bytes of {url}")

    fields, offset = {}, end
    for i in range(1, header["TFIELDS"] + 1):
        m = re.fullmatch(r"(\d*)([JED])", header[f"TFORM{i}"].strip())
        if not m:
            raise ValueError(f"unexpected WCS-WAVE column format {header[f'TFORM{i}']!r}")
        count, dtype = int(m.group(1) or 1), np.dtype(_TFORM[m.group(2)])
        fields[header[f"TTYPE{i}"]] = np.frombuffer(buf, dtype=dtype, count=count, offset=offset)
        offset += count * dtype.itemsize
    nx, ny = len(fields["X"]), len(fields["Y"])
    values = fields["VALUES"].reshape(ny, nx, 2)  # TDIM (2, nx, ny) in FITS (Fortran) order
    table = WaveTable(
        x=fields["X"].astype(float).tolist(),
        y=fields["Y"].astype(float).tolist(),
        wavelength=values[:, :, 0].astype(float).tolist(),
        bandwidth=values[:, :, 1].astype(float).tolist(),
    )
    cache.put_json("wave", key, asdict(table))
    return table


async def read_image_rows(client, url, layout: Layout, y0: int, y1: int) -> np.ndarray:
    """IMAGE rows y0..y1 inclusive (0-based), shape (y1 - y0 + 1, nx)."""
    row_bytes = layout.nx * 4
    buf = await _get_range(client, url, layout.image_offset + y0 * row_bytes, (y1 - y0 + 1) * row_bytes)
    return np.frombuffer(buf, dtype=">f4").reshape(-1, layout.nx).astype(np.float32)


async def read_flag_rows(client, url, layout: Layout, y0: int, y1: int) -> np.ndarray:
    """FLAGS rows y0..y1 inclusive, decompressed, shape (y1 - y0 + 1, nx)."""
    if not layout.flags_tiles:
        row_bytes = layout.nx * 4
        buf = await _get_range(client, url, layout.flags_offset + y0 * row_bytes, (y1 - y0 + 1) * row_bytes)
        return np.frombuffer(buf, dtype=">i4").reshape(-1, layout.nx).astype(np.int32)
    tiles = layout.flags_tiles[y0:y1 + 1]
    lo = min(off for _, off in tiles)
    hi = max(off + n for n, off in tiles)
    heap = np.frombuffer(await _get_range(client, url, layout.flags_offset + lo, hi - lo), dtype=np.uint8)
    rice = Rice1(blocksize=layout.flags_blocksize, bytepix=4, tilesize=layout.nx)
    rows = [rice.decode(heap[off - lo:off - lo + n]) for n, off in tiles]
    return np.stack(rows).astype(np.int32)
