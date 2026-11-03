"""Cut a patch out of one SPHEREx exposure and resample it onto a shared north-up grid.

Every exposure lands on the same grid for a given (ra, dec, fov), so frames from different
days, detectors and releases line up pixel for pixel and can be blinked, stacked or subtracted.
"""

import asyncio
import logging
import warnings
from dataclasses import dataclass

import httpx
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from . import cache, remote_fits
from .archive import ImageRecord

log = logging.getLogger(__name__)

PIXEL_SCALE_ARCSEC = 6.15  # native SPHEREx pixel
_MARGIN = 2  # extra input rows/columns read around the footprint for interpolation


@dataclass(frozen=True)
class Grid:
    ra: float
    dec: float
    size: int  # output is size x size pixels
    scale_arcsec: float

    @classmethod
    def for_fov(cls, ra: float, dec: float, fov_arcmin: float) -> "Grid":
        size = max(8, int(round(fov_arcmin * 60 / PIXEL_SCALE_ARCSEC)))
        return cls(ra, dec, size, PIXEL_SCALE_ARCSEC)

    def wcs(self) -> WCS:
        w = WCS(naxis=2)
        w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        w.wcs.crval = [self.ra, self.dec]
        w.wcs.crpix = [(self.size + 1) / 2, (self.size + 1) / 2]
        w.wcs.cdelt = [-self.scale_arcsec / 3600, self.scale_arcsec / 3600]  # east left, north up
        return w

    def to_json(self) -> dict:
        return {"ra": self.ra, "dec": self.dec, "size": self.size, "scale_arcsec": self.scale_arcsec}


@dataclass
class Cutout:
    image: np.ndarray  # MJy/sr, NaN where the exposure has no data
    flags: np.ndarray  # int32 bitmask from the FLAGS HDU, nearest input pixel
    flag_planes: dict[int, tuple[str, str]]


def _input_wcs(header_text: str) -> WCS:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        return WCS(fits.Header.fromstring(header_text), key=" ")


def _sample_positions(grid: Grid, in_wcs: WCS) -> tuple[np.ndarray, np.ndarray]:
    """Input-pixel (x, y), 0-based, of the centre of every output pixel."""
    yy, xx = np.mgrid[0:grid.size, 0:grid.size]
    ra, dec = grid.wcs().all_pix2world(xx.ravel(), yy.ravel(), 0)
    x, y = in_wcs.all_world2pix(ra, dec, 0, quiet=True)
    return x.reshape(grid.size, grid.size), y.reshape(grid.size, grid.size)


def _bilinear(sub: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    h, w = sub.shape
    inside = (x0 >= 0) & (y0 >= 0) & (x0 + 1 < w) & (y0 + 1 < h)
    x0c, y0c = np.clip(x0, 0, w - 2), np.clip(y0, 0, h - 2)
    out = (sub[y0c, x0c] * (1 - fx) * (1 - fy) + sub[y0c, x0c + 1] * fx * (1 - fy)
           + sub[y0c + 1, x0c] * (1 - fx) * fy + sub[y0c + 1, x0c + 1] * fx * fy)
    return np.where(inside, out, np.nan).astype(np.float32)


def _nearest(sub: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    xi, yi = np.rint(x).astype(int), np.rint(y).astype(int)
    h, w = sub.shape
    inside = (xi >= 0) & (yi >= 0) & (xi < w) & (yi < h)
    return np.where(inside, sub[np.clip(yi, 0, h - 1), np.clip(xi, 0, w - 1)], 0).astype(np.int32)


async def make_cutout(client: httpx.AsyncClient, rec: ImageRecord, grid: Grid) -> Cutout | None:
    """Resampled cutout of `rec` on `grid`, or None if the exposure does not overlap it."""
    key = f"{rec.url}|{grid.ra:.6f}|{grid.dec:.6f}|{grid.size}|{grid.scale_arcsec}"
    layout = await remote_fits.read_layout(client, rec.url)
    hit = cache.get_arrays("cutout", key)
    if hit is not None:
        return Cutout(hit["image"], hit["flags"], layout.flag_planes) if hit["image"].size else None

    # WCS parsing and SIP inversion are the CPU-heavy part; keep them off the event loop.
    x, y = await asyncio.to_thread(lambda: _sample_positions(grid, _input_wcs(layout.image_header)))
    ok = np.isfinite(x) & np.isfinite(y) & (x > -1) & (y > -1) & (x < layout.nx) & (y < layout.ny)
    if not ok.any():
        cache.put_arrays("cutout", key, image=np.empty(0, np.float32), flags=np.empty(0, np.int32))
        return None
    x0 = max(0, int(np.floor(x[ok].min())) - _MARGIN)
    x1 = min(layout.nx - 1, int(np.ceil(x[ok].max())) + _MARGIN)
    y0 = max(0, int(np.floor(y[ok].min())) - _MARGIN)
    y1 = min(layout.ny - 1, int(np.ceil(y[ok].max())) + _MARGIN)

    rows, flag_rows = await asyncio.gather(
        remote_fits.read_image_rows(client, rec.url, layout, y0, y1),
        remote_fits.read_flag_rows(client, rec.url, layout, y0, y1),
    )
    sx, sy = np.where(ok, x - x0, -10), np.where(ok, y - y0, -10)
    image = _bilinear(rows[:, x0:x1 + 1], sx, sy)
    flags = _nearest(flag_rows[:, x0:x1 + 1], sx, sy)
    cache.put_arrays("cutout", key, image=image, flags=flags)
    return Cutout(image, flags, layout.flag_planes)
