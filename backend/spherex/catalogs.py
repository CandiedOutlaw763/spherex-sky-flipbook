"""Gaia DR3 and CatWISE2020 sources around a position, from IRSA's TAP service.

Both catalogues carry proper motions, so the browser can place each source where it was on
the date of every SPHEREx frame rather than at the catalogue epoch.
"""

import csv
import io

import httpx

from . import cache
from .archive import IRSA

# epoch is a decimal year; pm in mas/yr with the RA component including cos(dec)
CATALOGS = {
    "gaia": {
        "label": "Gaia DR3",
        "epoch": 2016.0,
        "query": "SELECT ra, dec, pmra, pmdec, phot_g_mean_mag AS mag FROM gaia_dr3_source "
                 "WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius})) = 1",
        "pm_scale": 1.0,
        "band": "G",
    },
    "catwise": {
        "label": "CatWISE2020",
        "epoch": 2015.4,  # reference epoch MJD 57170
        "query": "SELECT ra_pm AS ra, dec_pm AS dec, pmra, pmdec, w2mpro_pm AS mag FROM catwise_2020 "
                 "WHERE CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra}, {dec}, {radius})) = 1",
        "pm_scale": 1000.0,  # catalogue gives arcsec/yr
        "band": "W2",
    },
}
MAX_SOURCES = 3000


def _num(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def cache_key(name: str, ra: float, dec: float, radius_deg: float) -> str:
    return f"2|{name}|{ra:.5f}|{dec:.5f}|{radius_deg:.4f}"  # leading number: cache format version


async def cone(client: httpx.AsyncClient, name: str, ra: float, dec: float, radius_deg: float) -> dict:
    spec = CATALOGS[name]
    key = cache_key(name, ra, dec, radius_deg)
    if cached := cache.get_json("catalog", key):
        return cached
    query = spec["query"].format(ra=ra, dec=dec, radius=radius_deg)
    r = await client.get(f"{IRSA}/TAP/sync", params={"QUERY": query, "FORMAT": "csv", "MAXREC": MAX_SOURCES}, timeout=120)
    r.raise_for_status()
    sources = []
    for row in csv.DictReader(io.StringIO(r.text)):
        sra, sdec = _num(row["ra"]), _num(row["dec"])
        if sra is None or sdec is None:
            continue
        pmra, pmdec = _num(row["pmra"]), _num(row["pmdec"])
        has_pm = pmra is not None and pmdec is not None
        sources.append([
            round(sra, 7), round(sdec, 7),
            round(pmra * spec["pm_scale"], 2) if has_pm else None,  # None: not measured (not "still")
            round(pmdec * spec["pm_scale"], 2) if has_pm else None,
            round(m, 2) if (m := _num(row["mag"])) is not None else None,
        ])
    result = {"catalog": name, "label": spec["label"], "epoch": spec["epoch"], "band": spec["band"],
              "columns": ["ra", "dec", "pmra", "pmdec", "mag"], "sources": sources}
    cache.put_json("catalog", key, result)
    return result
