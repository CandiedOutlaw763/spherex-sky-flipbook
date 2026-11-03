// Point photometry across every exposure: the raw material for spectra and light curves.

// A pixel is 6.15" square; surface brightness in MJy/sr times its solid angle gives flux.
const PIXEL_SR = (6.15 / 206264.806) ** 2;
const MJY_SR_TO_MJY_PER_PIXEL = PIXEL_SR * 1e9;

export const GROUPS = [
  { id: "short", label: "0.75–1.6 µm (D1–D2)", short: "<1.6µm", detectors: [1, 2], colour: "#3987e5" },
  { id: "mid", label: "1.6–3.8 µm (D3–D4)", short: "1.6–3.8", detectors: [3, 4], colour: "#199e70" },
  { id: "long", label: "3.8–5.0 µm (D5–D6)", short: ">3.8µm", detectors: [5, 6], colour: "#d95926" },
];

export function groupOf(detector) {
  return GROUPS.find((g) => g.detectors.includes(detector));
}

/**
 * Sum a 3x3-pixel aperture (background already removed) in every cutout.
 * positionAt(cutout) gives the grid (x, y) to measure, so a moving target can be followed.
 * Returns { points, skipped } where each point is { mjd, um, bw, flux (mJy), detector, cutout } and
 * skipped counts why exposures were left out: off the image, blank (saturated), or flagged.
 */
export function measure(cutouts, size, positionAt, { mask, badMask }) {
  const centre = (size - 1) / 2;
  const points = [];
  const skipped = { offImage: 0, blank: 0, flagged: 0 };
  for (const c of cutouts) {
    const p = positionAt(c);
    const xi = Math.round(p.x), yi = Math.round(p.y);
    if (xi < 1 || yi < 1 || xi > size - 2 || yi > size - 2) { skipped.offImage++; continue; }
    let sum = 0, blank = false, flagged = false;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = (yi + dy) * size + xi + dx;
        const v = c.image[j];
        if (!Number.isFinite(v)) blank = true;
        else if (mask && c.flags[j] & badMask) flagged = true;
        else sum += v;
      }
    }
    if (blank) { skipped.blank++; continue; }
    if (flagged) { skipped.flagged++; continue; }
    const um = c.wave
      ? c.wave.um + c.wave.dx * (p.x - centre) + c.wave.dy * (p.y - centre)
      : (c.wave_min_um + c.wave_max_um) / 2;
    points.push({ mjd: c.mjd, um, bw: c.wave?.bw ?? null, flux: sum * MJY_SR_TO_MJY_PER_PIXEL, detector: c.detector, cutout: c });
  }
  return { points, skipped };
}

/** Median flux in bins of constant spectral resolution (R ~ 40, close to SPHEREx's own). */
export function medianSpectrum(points, resolution = 40) {
  const bins = new Map();
  for (const p of points) {
    const k = Math.round(Math.log(p.um) * resolution);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(p.flux);
  }
  return [...bins.entries()]
    .filter(([, v]) => v.length >= 2)
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => ({ um: Math.exp(k / resolution), flux: median(v), n: v.length }));
}

/**
 * Brightness relative to the source's own typical spectrum. Each exposure samples a different
 * wavelength, so dividing by the median spectrum there removes the colour and leaves the change in time.
 */
export function relativeFlux(points, spectrum) {
  if (!spectrum.length) return [];
  const ums = spectrum.map((s) => s.um);
  return points.map((p) => {
    const ref = interpolate(ums, spectrum.map((s) => s.flux), p.um);
    return { ...p, relative: ref > 0 ? p.flux / ref : NaN };
  }).filter((p) => Number.isFinite(p.relative));
}

export function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function interpolate(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 1;
  while (xs[i] < x) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + t * (ys[i] - ys[i - 1]);
}

export function toCsv(rows, columns) {
  const esc = (v) => (v === null || v === undefined ? "" : String(v));
  return [columns.join(","), ...rows.map((r) => columns.map((c) => esc(r[c])).join(","))].join("\n");
}
