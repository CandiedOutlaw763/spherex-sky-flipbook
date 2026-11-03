"""Turn an object name into coordinates for the SPHEREx era, via CDS Sesame (SIMBAD/NED/VizieR).

Catalogue positions are for epoch J2000. Nearby stars and brown dwarfs have moved a lot since
then (Barnard's Star by ~4.5 arcmin), so the position is advanced along its proper motion.
"""

import math
import xml.etree.ElementTree as ET

import httpx

SESAME_URLS = [
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV",
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV",
]


class NotFound(Exception):
    pass


def _float(el, path):
    node = el.find(path)
    return float(node.text) if node is not None and node.text else None


async def resolve(client: httpx.AsyncClient, name: str, epoch: float) -> dict:
    last_error: Exception | None = None
    for base in SESAME_URLS:
        try:
            r = await client.get(f"{base}?{httpx.QueryParams({name: ''})}".rstrip("="), timeout=20)
            r.raise_for_status()
            break
        except httpx.HTTPError as e:
            last_error = e
    else:
        raise RuntimeError(f"name resolver unreachable: {last_error!r}")

    root = ET.fromstring(r.text)
    for resolver in root.iter("Resolver"):
        ra, dec = _float(resolver, "jradeg"), _float(resolver, "jdedeg")
        if ra is None or dec is None:
            continue
        pm_ra = _float(resolver, "pm/pmRA") or 0.0  # mas/yr, already multiplied by cos(dec)
        pm_dec = _float(resolver, "pm/pmDE") or 0.0
        oname = resolver.findtext("oname") or name
        return {
            "name": oname,
            "resolver": resolver.get("name", ""),
            "ra_j2000": ra,
            "dec_j2000": dec,
            "pm_ra_mas_yr": pm_ra,
            "pm_dec_mas_yr": pm_dec,
            "epoch": epoch,
            **dict(zip(("ra", "dec"), propagate(ra, dec, pm_ra, pm_dec, epoch - 2000.0))),
        }
    raise NotFound(name)


def propagate(ra: float, dec: float, pm_ra: float, pm_dec: float, years: float) -> tuple[float, float]:
    """Linear proper-motion shift, ample for the few-arcminute offsets involved here."""
    dec_new = dec + pm_dec * years / 3.6e6
    ra_new = ra + pm_ra * years / 3.6e6 / max(math.cos(math.radians(dec)), 1e-6)
    return ra_new % 360.0, max(-90.0, min(90.0, dec_new))
