"""Turn an object name into coordinates for the SPHEREx era.

Catalogue positions are for epoch J2000, and nearby stars and brown dwarfs have moved a lot since
then (Barnard's Star by ~4.5 arcmin), so the position is advanced along its proper motion.

Resolvers, in order:
1. CDS Sesame, which returns proper motions directly (tried briefly: it is often unreachable).
2. NASA MAST's name lookup (SIMBAD/NED behind STScI's cache), with the proper motion taken from
   the Gaia DR3 or CatWISE2020 source at that position, both from IRSA.
3. NASA NED, position only.
"""

import asyncio
import json
import math
import urllib.parse
import xml.etree.ElementTree as ET

import httpx

from . import catalogs

SESAME_MIRRORS = [
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV",
    "https://vizier.cds.unistra.fr/viz-bin/nph-sesame/-oxp/SNV",
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-oxp/SNV",
]
NED_LOOKUP = "https://ned.ipac.caltech.edu/srs/ObjectLookup"
MAST_INVOKE = "https://mast.stsci.edu/api/v0/invoke"
_SESAME_TIMEOUT = httpx.Timeout(8, connect=4)
_PM_SEARCH_DEG = 0.05  # 3 arcmin: room for ~10"/yr of motion between J2000 and the catalogue epochs
_PM_MATCH_ARCSEC = 6.0  # catalogue proper-motion errors grow over the ~15 years wound back


class NotFound(Exception):
    pass


def _float(el, path):
    node = el.find(path)
    return float(node.text) if node is not None and node.text else None


async def _sesame(client: httpx.AsyncClient, name: str) -> dict | None:
    """First Sesame resolver hit, None if Sesame answered but knows nothing; raises if unreachable."""
    errors = []
    for base in SESAME_MIRRORS:
        try:
            r = await client.get(f"{base}?{urllib.parse.quote(name)}", timeout=_SESAME_TIMEOUT)
            r.raise_for_status()
            root = ET.fromstring(r.text)
        except (httpx.HTTPError, ET.ParseError) as e:
            errors.append(f"{urllib.parse.urlsplit(base).hostname}: {type(e).__name__}")
            continue
        for resolver in root.iter("Resolver"):
            ra, dec = _float(resolver, "jradeg"), _float(resolver, "jdedeg")
            if ra is not None and dec is not None:
                return {
                    "name": resolver.findtext("oname") or name,
                    "resolver": resolver.get("name", "Sesame"),
                    "ra_j2000": ra,
                    "dec_j2000": dec,
                    "pm_ra_mas_yr": _float(resolver, "pm/pmRA") or 0.0,  # includes cos(dec)
                    "pm_dec_mas_yr": _float(resolver, "pm/pmDE") or 0.0,
                }
        return None
    raise RuntimeError("; ".join(errors))


async def _mast(client: httpx.AsyncClient, name: str) -> dict | None:
    request = {"service": "Mast.Name.Lookup", "params": {"input": name, "format": "json"}, "format": "json"}
    r = await client.post(MAST_INVOKE, data={"request": json.dumps(request)}, timeout=30)
    r.raise_for_status()
    found = r.json().get("resolvedCoordinate") or []
    if not found:
        return None
    hit = found[0]
    ra, dec = float(hit["ra"]), float(hit["decl"])
    pm_ra, pm_dec, source = await _proper_motion(client, ra, dec)
    return {"name": hit.get("canonicalName") or name,
            "resolver": f"MAST/{hit.get('resolver', 'SIMBAD')}" + (f" + {source} proper motion" if source else ""),
            "ra_j2000": ra, "dec_j2000": dec, "pm_ra_mas_yr": pm_ra, "pm_dec_mas_yr": pm_dec}


_cone_tasks: set[asyncio.Task] = set()


async def _proper_motion(client: httpx.AsyncClient, ra: float, dec: float) -> tuple[float, float, str | None]:
    """Proper motion of the Gaia DR3 or CatWISE2020 source that sat at (ra, dec) in J2000.

    Gives the catalogue queries ~45 s; slower ones keep running so the next lookup finds them cached.
    """
    tasks = [asyncio.create_task(catalogs.cone(client, name, ra, dec, _PM_SEARCH_DEG)) for name in ("gaia", "catwise")]
    _cone_tasks.update(tasks)
    for t in tasks:
        t.add_done_callback(lambda t: (_cone_tasks.discard(t), t.cancelled() or t.exception()))
    done, _ = await asyncio.wait(tasks, timeout=45)

    cos_dec = math.cos(math.radians(dec))
    best, best_sep = None, _PM_MATCH_ARCSEC
    for task in done:
        if task.exception():
            continue
        result = task.result()
        years = 2000.0 - result["epoch"]  # wind each source back to J2000 before matching
        for s_ra, s_dec, pm_ra, pm_dec, mag in result["sources"]:
            if pm_ra is None:
                continue
            d_east = (s_ra - ra) * cos_dec * 3600 + pm_ra * years / 1000
            d_north = (s_dec - dec) * 3600 + pm_dec * years / 1000
            sep = math.hypot(d_east, d_north)
            if sep < best_sep:
                best, best_sep = (pm_ra, pm_dec, result["label"]), sep
    return best if best else (0.0, 0.0, None)


async def _ned(client: httpx.AsyncClient, name: str) -> dict | None:
    r = await client.post(NED_LOOKUP, data={"json": json.dumps({"name": {"v": name}})}, timeout=20)
    r.raise_for_status()
    body = r.json()
    if body.get("ResultCode") != 3:  # 3 = a single object was found
        return None
    pos = body["Preferred"]["Position"]
    return {"name": body["Preferred"].get("Name") or name, "resolver": "NED (no proper motion)",
            "ra_j2000": pos["RA"], "dec_j2000": pos["Dec"], "pm_ra_mas_yr": 0.0, "pm_dec_mas_yr": 0.0}


async def resolve(client: httpx.AsyncClient, name: str, epoch: float) -> dict:
    errors, hit, answered = [], None, False
    # A mirror can answer "nothing found" while the real one is down, so a miss falls through too.
    for label, lookup in (("Sesame", _sesame), ("MAST", _mast), ("NED", _ned)):
        try:
            hit = await lookup(client, name)
            answered = True
        except (RuntimeError, httpx.HTTPError, ValueError, KeyError) as e:
            errors.append(f"{label}: {e if isinstance(e, RuntimeError) else type(e).__name__}")
            continue
        if hit:
            break
    if hit is None:
        if not answered:
            raise RuntimeError(f"name resolvers unreachable ({'; '.join(errors)})")
        raise NotFound(name)
    ra, dec = propagate(hit["ra_j2000"], hit["dec_j2000"], hit["pm_ra_mas_yr"], hit["pm_dec_mas_yr"], epoch - 2000.0)
    return {**hit, "epoch": epoch, "ra": ra, "dec": dec}


def propagate(ra: float, dec: float, pm_ra: float, pm_dec: float, years: float) -> tuple[float, float]:
    """Linear proper-motion shift, ample for the few-arcminute offsets involved here."""
    dec_new = dec + pm_dec * years / 3.6e6
    ra_new = ra + pm_ra * years / 3.6e6 / max(math.cos(math.radians(dec)), 1e-6)
    return ra_new % 360.0, max(-90.0, min(90.0, dec_new))
