// Data from other telescopes: Gaia/CatWISE sources drawn over the SPHEREx frame, and an
// Aladin Lite view of the same field in other surveys.

import { mjdToYear } from "./coords.js";

const API = window.SPHEREX_API || "";

export const CATALOGS = {
  gaia: { label: "Gaia DR3", colour: "#86b6ef", shape: "circle" },
  catwise: { label: "CatWISE2020", colour: "#e87ba4", shape: "diamond" },
};

const cache = new Map();

/** Sources around the field, fetched once per field and catalogue. */
export async function fetchCatalog(name, grid, fovArcmin) {
  const radius = ((fovArcmin / 60) * 0.75).toFixed(4); // covers the corners of the square field
  const key = `${name}|${grid.ra.toFixed(5)}|${grid.dec.toFixed(5)}|${radius}`;
  if (!cache.has(key)) {
    const params = new URLSearchParams({ name, ra: grid.ra.toFixed(5), dec: grid.dec.toFixed(5), radius });
    cache.set(key, fetch(`${API}/api/catalog?${params}`).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `catalogue query failed (${r.status})`);
      return r.json();
    }));
    cache.get(key).catch(() => cache.delete(key));
  }
  return cache.get(key);
}

/**
 * Grid position (x right = west, y up = north, in pixels) of each source at `mjd`,
 * moved along its proper motion from the catalogue epoch.
 */
export function placeSources(catalog, grid, mjd) {
  const years = mjdToYear(mjd) - catalog.epoch;
  const c = (grid.size - 1) / 2;
  const cosDec = Math.cos((grid.dec * Math.PI) / 180);
  return catalog.sources.map(([ra, dec, pmra = 0, pmdec = 0, mag]) => {
    pmra ??= 0; // null: proper motion not measured; draw at the catalogue position
    pmdec ??= 0;
    let dra = ra - grid.ra;
    if (dra > 180) dra -= 360;
    if (dra < -180) dra += 360;
    const east = dra * cosDec * 3600 + (pmra * years) / 1000;
    const north = (dec - grid.dec) * 3600 + (pmdec * years) / 1000;
    return { x: c - east / grid.scale_arcsec, y: c + north / grid.scale_arcsec, mag, pmra, pmdec };
  });
}

const MAX_DRAWN = 200; // deep catalogues bury the image; draw the brightest, hover still finds all

export function drawSources(ctx, placed, style, cell, size, dpr) {
  ctx.strokeStyle = style.colour;
  ctx.lineWidth = 1.5 * dpr;
  const r = Math.max(cell * 0.9, 4 * dpr);
  const inView = placed.filter((s) => s.x >= -1 && s.y >= -1 && s.x <= size && s.y <= size);
  const drawn = inView.length > MAX_DRAWN
    ? [...inView].sort((a, b) => (a.mag ?? 99) - (b.mag ?? 99)).slice(0, MAX_DRAWN)
    : inView;
  ctx.beginPath();
  for (const s of drawn) {
    if (s.x < -1 || s.y < -1 || s.x > size || s.y > size) continue;
    const px = (s.x + 0.5) * cell, py = (size - 0.5 - s.y) * cell;
    if (style.shape === "diamond") {
      ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath();
    } else {
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, Math.PI * 2);
    }
  }
  ctx.stroke();
}

// ---------- Aladin Lite ----------

const ALADIN_SRC = "https://cdn.jsdelivr.net/npm/aladin-lite@3.8.2/dist/aladin.js";
// Each survey's HiPS mirrors (from the CDS MocServer), tried in order. Full URLs rather than CDS
// IDs, so the panel doesn't depend on ID resolution; IRSA's mirrors are left out because they
// send no CORS headers, which browsers need.
export const SURVEYS = [
  { id: "allwise", label: "AllWISE (3.4–22 µm)",
    urls: ["https://alasky.cds.unistra.fr/AllWISE/RGB-W4-W2-W1", "https://alaskybis.cds.unistra.fr/AllWISE/RGB-W4-W2-W1"] },
  { id: "2mass", label: "2MASS (1.2–2.2 µm)",
    urls: ["https://alasky.cds.unistra.fr/2MASS/Color", "https://alaskybis.cds.unistra.fr/2MASS/Color"] },
  { id: "panstarrs", label: "Pan-STARRS (optical)",
    urls: ["https://alasky.cds.unistra.fr/Pan-STARRS/DR1/color-z-zg-g", "https://alaskybis.cds.unistra.fr/Pan-STARRS/DR1/color-z-zg-g"] },
  { id: "dss2", label: "DSS2 (optical)",
    urls: ["https://alasky.cds.unistra.fr/DSS/DSSColor", "https://alaskybis.cds.unistra.fr/DSS/DSSColor", "https://casda.csiro.au/hips/DSS2/color"] },
];

/** First mirror whose HiPS description answers, so an outage at one host doesn't leave a grey map. */
async function reachableMirror(urls) {
  for (const url of urls) {
    try {
      const r = await fetch(`${url}/properties`, { signal: AbortSignal.timeout(6000) });
      if (r.ok && /hips_|obs_title/.test(await r.text())) return url;
    } catch { /* unreachable or blocked; try the next mirror */ }
  }
  return null;
}

let aladinPromise = null;
let A = null;

/** Show the field in a survey; resolves to the mirror's host, rejects if no mirror answers. */
export async function aladinView(selector, { ra, dec, fovDeg, survey }) {
  const spec = SURVEYS.find((s) => s.id === survey) || SURVEYS[0];
  const url = await reachableMirror(spec.urls);
  if (!url) throw new Error(`${spec.label} images are unavailable right now (survey servers not responding); try another survey or come back later`);
  // The npm build is an ES module exporting A (it does not set window.A); load it on first use.
  aladinPromise ??= import(ALADIN_SRC).then(async (mod) => {
    A = mod.default;
    await A.init;
    return A.aladin(selector, {
      survey: url, fov: fovDeg, target: `${ra} ${dec}`, cooFrame: "ICRS",
      showReticle: true, showZoomControl: true, showLayersControl: false, showGotoControl: false,
      showFullscreenControl: true, showProjectionControl: false, showCooGridControl: false,
      showSimbadPointerControl: false, showShareControl: false, showFrame: false, showCooLocation: true,
    });
  });
  aladinPromise.catch(() => { aladinPromise = null; });
  const aladin = await aladinPromise;
  aladin.gotoRaDec(ra, dec);
  aladin.setFoV(fovDeg);
  aladin.setBaseImageLayer(A.imageHiPS(url, { name: spec.label }));
  return new URL(url).host;
}
