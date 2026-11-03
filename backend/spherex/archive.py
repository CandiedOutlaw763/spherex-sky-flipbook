"""Find SPHEREx Level 2 images that cover a sky position, across every data release IRSA serves.

Releases are discovered from IRSA's ObsCore table rather than hard-coded, so a new
quick release (spherex_qr4, ...) shows up without code changes.
"""

import asyncio
import csv
import io
import logging
import re
import time
from dataclasses import asdict, dataclass

import httpx

from . import cache

log = logging.getLogger(__name__)

IRSA = "https://irsa.ipac.caltech.edu"
IBE_PREFIX = f"{IRSA}/ibe/data/spherex/"
S3_PREFIX = "https://nasa-irsa-spherex.s3.amazonaws.com/"

# Science collections only: spherex_qr3, spherex_qr3_deep, ... but not the *_cal products.
_SCIENCE_COLLECTION = re.compile(r"^spherex_qr\d+(_deep)?$")
_FALLBACK_COLLECTIONS = ["spherex_qr2", "spherex_qr3"]
_COLLECTIONS_TTL = 6 * 3600
_SEARCH_TTL = 6 * 3600  # IRSA searches take 20-70 s, and releases land at most weekly
_PARTIAL_SEARCH_TTL = 15 * 60  # results missing a collection are retried sooner

_collections: tuple[float, list[str]] = (0.0, [])


@dataclass(frozen=True)
class ImageRecord:
    obs_id: str
    collection: str
    detector: int
    mjd: float
    wave_min_um: float
    wave_max_um: float
    url: str  # public S3 copy, which supports byte ranges and CORS
    irsa_url: str

    @property
    def key(self) -> str:
        return f"{self.obs_id}D{self.detector}"

    def to_json(self) -> dict:
        return {
            "key": self.key,
            "obs_id": self.obs_id,
            "collection": self.collection,
            "detector": self.detector,
            "mjd": self.mjd,
            "wave_min_um": self.wave_min_um,
            "wave_max_um": self.wave_max_um,
            "irsa_url": self.irsa_url,
        }


async def list_collections(client: httpx.AsyncClient) -> list[str]:
    global _collections
    fetched_at, names = _collections
    if names and time.time() - fetched_at < _COLLECTIONS_TTL:
        return names
    query = "SELECT DISTINCT obs_collection FROM ivoa.obscore WHERE obs_collection LIKE 'spherex%'"
    try:
        r = await client.get(f"{IRSA}/TAP/sync", params={"QUERY": query, "FORMAT": "csv"}, timeout=120)
        r.raise_for_status()
        rows = csv.DictReader(io.StringIO(r.text))
        names = sorted(n for row in rows if _SCIENCE_COLLECTION.match(n := row["obs_collection"]))
        cache.put_json("collections", "all", {"names": names})
    except httpx.HTTPError as e:
        log.warning("collection discovery failed (%r); using last known list", e)
        names = names or (cache.get_json("collections", "all") or {}).get("names") or _FALLBACK_COLLECTIONS
    _collections = (time.time(), names)
    return names


def _to_s3(irsa_url: str) -> str:
    if irsa_url.startswith(IBE_PREFIX):
        return S3_PREFIX + irsa_url[len(IBE_PREFIX):]
    return irsa_url


async def _search_collection(client: httpx.AsyncClient, collection: str, ra: float, dec: float) -> list[ImageRecord]:
    params = {"COLLECTION": collection, "POS": f"circle {ra} {dec} 0.0005", "RESPONSEFORMAT": "CSV"}
    r = await client.get(f"{IRSA}/SIA", params=params, timeout=120)
    r.raise_for_status()
    records = []
    for row in csv.DictReader(io.StringIO(r.text)):
        if row.get("dataproduct_subtype") != "science":
            continue
        band = row["energy_bandpassname"]  # "SPHEREx-D1" .. "SPHEREx-D6"
        records.append(ImageRecord(
            obs_id=row["obs_id"],
            collection=collection,
            detector=int(band.rsplit("D", 1)[1]),
            mjd=(float(row["t_min"]) + float(row["t_max"])) / 2,
            wave_min_um=float(row["em_min"]) * 1e6,
            wave_max_um=float(row["em_max"]) * 1e6,
            url=_to_s3(row["access_url"]),
            irsa_url=row["access_url"],
        ))
    return records


async def search(client: httpx.AsyncClient, ra: float, dec: float) -> list[ImageRecord]:
    """All science images containing (ra, dec), oldest first, one entry per exposure and detector.

    A stale cached answer is returned at once and refreshed in the background, so a slow or
    unreachable IRSA never blocks a field that has been looked at before.
    """
    cache_key = f"{ra:.4f}|{dec:.4f}"
    hit = cache.get_json("search", cache_key)
    if hit:
        images = [ImageRecord(**r) for r in hit["images"]]
        ttl = _PARTIAL_SEARCH_TTL if hit.get("partial") else _SEARCH_TTL
        if time.time() - hit["fetched_at"] > ttl and cache_key not in _refreshing:
            _refreshing.add(cache_key)
            task = asyncio.create_task(_search_irsa(client, ra, dec, cache_key))

            _background.add(task)  # the event loop only holds weak references to tasks

            def done(t: asyncio.Task) -> None:
                _refreshing.discard(cache_key)
                _background.discard(t)
                if not t.cancelled() and t.exception():
                    log.warning("background refresh of %s failed: %r", cache_key, t.exception())

            task.add_done_callback(done)
        return images
    return await _search_irsa(client, ra, dec, cache_key)


_refreshing: set[str] = set()
_background: set[asyncio.Task] = set()


async def _search_irsa(client: httpx.AsyncClient, ra: float, dec: float, cache_key: str) -> list[ImageRecord]:
    collections = await list_collections(client)
    results = await asyncio.gather(
        *(_search_collection(client, c, ra, dec) for c in collections), return_exceptions=True
    )
    by_key: dict[str, ImageRecord] = {}
    for collection, result in zip(collections, results):
        if isinstance(result, Exception):
            log.warning("SIA search of %s failed: %s", collection, result)
            continue
        for rec in result:
            by_key.setdefault(rec.key, rec)
    if not by_key and any(isinstance(r, Exception) for r in results):
        raise RuntimeError("IRSA image search failed for every SPHEREx collection")

    images = sorted(by_key.values(), key=lambda rec: rec.mjd)
    partial = any(isinstance(r, Exception) for r in results)
    cache.put_json("search", cache_key, {"fetched_at": time.time(), "partial": partial,
                                         "images": [asdict(i) for i in images]})
    return images
