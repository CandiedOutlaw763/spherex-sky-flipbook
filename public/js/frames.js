// Turn the stream of per-exposure cutouts into flipbook frames: group, stack, subtract.

export const DETECTORS = [
  { id: 1, range: "0.75–1.1 µm", colour: "#6f8bff" },
  { id: 2, range: "1.1–1.6 µm", colour: "#6fc7ff" },
  { id: 3, range: "1.6–2.4 µm", colour: "#8dffb0" },
  { id: 4, range: "2.4–3.8 µm", colour: "#ffe27a" },
  { id: 5, range: "3.8–4.4 µm", colour: "#ff9a3d" },
  { id: 6, range: "4.4–5.0 µm", colour: "#ff5a6e" },
];

// False-colour channels: long wavelengths red, short blue.
const CHANNELS = { r: [5, 6], g: [3, 4], b: [1, 2] };

// Flag planes that mean "do not trust this pixel" (names from the FLAGS header).
const BAD_FLAGS = new Set([
  "TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "COLD",
  "NONLINEAR", "PERSIST", "OUTLIER",
]);
const DEFAULT_BAD_BITS = [0, 1, 2, 6, 9, 10, 11, 15, 17, 19];

// The survey revisits each spot every ~6 months, observing it over ~3 weeks each time, with a
// few stray exposures up to a month either side. Gaps longer than this start a new visit.
const VISIT_GAP_DAYS = 45;
// Near the ecliptic poles (the deep fields) coverage is continuous, so long runs are cut into
// frames of about a month instead.
const MAX_VISIT_DAYS = 60;
const SPLIT_DAYS = 30;

export function badMaskFromPlanes(planes) {
  const bits = planes
    ? Object.entries(planes).filter(([, p]) => BAD_FLAGS.has(p.name)).map(([b]) => Number(b))
    : DEFAULT_BAD_BITS;
  return (bits.length ? bits : DEFAULT_BAD_BITS).reduce((m, b) => m | (1 << b), 0);
}

function decode(b64, Type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

function median(values) {
  if (!values.length) return NaN;
  const a = Float32Array.from(values).sort();
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Decode one streamed cutout and remove its sky background (zodiacal light changes by epoch). */
export function prepareCutout(msg) {
  const image = decode(msg.image, Float32Array);
  const flags = decode(msg.flags, Int32Array);
  const finite = [];
  for (let i = 0; i < image.length; i++) if (Number.isFinite(image[i])) finite.push(image[i]);
  const background = median(finite);
  for (let i = 0; i < image.length; i++) image[i] -= background;
  return { ...msg, image, flags, background, coverage: finite.length / image.length };
}

/** Median-combine cutouts pixel by pixel, skipping NaNs and (optionally) flagged pixels. */
function stack(cutouts, size, badMask) {
  const n = size * size;
  const out = new Float32Array(n).fill(NaN);
  if (!cutouts.length) return out;
  const buf = new Float32Array(cutouts.length);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (const c of cutouts) {
      const v = c.image[i];
      if (Number.isFinite(v) && !(c.flags[i] & badMask)) buf[k++] = v;
    }
    if (k === 1) out[i] = buf[0];
    else if (k > 1) {
      const s = buf.subarray(0, k).sort();
      out[i] = k % 2 ? s[k >> 1] : (s[(k >> 1) - 1] + s[k >> 1]) / 2;
    }
  }
  return out;
}

function groupBy(items, keyOf) {
  const groups = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  return [...groups.values()];
}

/** Split time-sorted cutouts wherever the gap between exposures exceeds VISIT_GAP_DAYS. */
function visits(cutouts) {
  const sorted = [...cutouts].sort((a, b) => a.mjd - b.mjd);
  const out = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.mjd - last[last.length - 1].mjd <= VISIT_GAP_DAYS) last.push(c);
    else out.push([c]);
  }
  return out.flatMap((run) => {
    const span = run[run.length - 1].mjd - run[0].mjd;
    if (span <= MAX_VISIT_DAYS) return [run];
    const bins = Math.ceil(span / SPLIT_DAYS);
    const width = span / bins;
    const split = Array.from({ length: bins }, () => []);
    for (const c of run) split[Math.min(bins - 1, Math.floor((c.mjd - run[0].mjd) / width))].push(c);
    return split.filter((b) => b.length);
  });
}

/**
 * Build frames from cutouts.
 * opts: { mode: "visit"|"exposure", view: "colour"|"mono", detectors: Set<number>, mask: bool, badMask, size }
 * Each frame: { mjd, mjdMin, mjdMax, cutouts, layers: {mono} or {r, g, b} }
 */
export function buildFrames(cutouts, opts) {
  const { size, detectors } = opts;
  const badMask = opts.mask ? opts.badMask : 0;
  const chosen = cutouts.filter((c) => detectors.has(c.detector) && c.coverage > 0.2);
  // An exposure is one pointing seen by all six detectors at once, so it can be false-coloured too.
  const groups = opts.mode === "visit" ? visits(chosen) : groupBy(chosen, (c) => c.obs_id).sort((a, b) => a[0].mjd - b[0].mjd);

  return groups.map((group) => {
    const mjds = group.map((c) => c.mjd);
    const frame = {
      mjd: mjds.reduce((s, v) => s + v, 0) / mjds.length,
      mjdMin: Math.min(...mjds),
      mjdMax: Math.max(...mjds),
      cutouts: group,
      layers: {},
    };
    if (opts.view === "colour") {
      const present = [];
      for (const [ch, dets] of Object.entries(CHANNELS)) {
        const members = group.filter((c) => dets.includes(c.detector));
        frame.layers[ch] = stack(members, size, badMask);
        if (members.length) present.push(ch);
      }
      // A channel with no exposures (e.g. user unticked D1 and D2) borrows the mean of the others
      // so the frame reads as neutral grey rather than tinted.
      for (const ch of Object.keys(CHANNELS)) {
        if (present.includes(ch) || !present.length) continue;
        const fill = frame.layers[ch];
        for (let i = 0; i < fill.length; i++) {
          let s = 0, k = 0;
          for (const p of present) if (Number.isFinite(frame.layers[p][i])) { s += frame.layers[p][i]; k++; }
          fill[i] = k ? s / k : NaN;
        }
      }
      frame.missing = Object.keys(CHANNELS).filter((ch) => !present.includes(ch));
    } else {
      frame.layers.mono = stack(group, size, badMask);
    }
    return frame;
  });
}

/** Apply the "Compare" setting, returning new frames whose layers are differences. */
export function subtract(frames, how) {
  if (how === "none" || frames.length < 2) return frames;
  const names = Object.keys(frames[0].layers);
  let reference = null;
  if (how === "first") reference = frames[0].layers;
  if (how === "median") {
    reference = {};
    for (const name of names) reference[name] = pixelMedian(frames.map((f) => f.layers[name]));
  }
  return frames.map((f, i) => {
    const ref = how === "previous" ? frames[Math.max(0, i - 1)].layers : reference;
    const layers = {};
    for (const name of names) {
      const a = f.layers[name], b = ref[name], d = new Float32Array(a.length);
      for (let p = 0; p < a.length; p++) d[p] = a[p] - b[p];
      layers[name] = d;
    }
    return { ...f, layers, difference: true };
  });
}

function pixelMedian(arrays) {
  const n = arrays[0].length;
  const out = new Float32Array(n);
  const buf = new Float32Array(arrays.length);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (const a of arrays) if (Number.isFinite(a[i])) buf[k++] = a[i];
    if (!k) { out[i] = NaN; continue; }
    const s = buf.subarray(0, k).sort();
    out[i] = k % 2 ? s[k >> 1] : (s[(k >> 1) - 1] + s[k >> 1]) / 2;
  }
  return out;
}

/** Display range per layer, shared by every frame so real brightness changes stay visible. */
export function displayRanges(frames, clipPercent, difference) {
  const ranges = {};
  if (!frames.length) return ranges;
  for (const name of Object.keys(frames[0].layers)) {
    const sample = [];
    for (const f of frames) {
      const a = f.layers[name];
      const step = Math.max(1, Math.floor((a.length * frames.length) / 200000));
      for (let i = 0; i < a.length; i += step) if (Number.isFinite(a[i])) sample.push(difference ? Math.abs(a[i]) : a[i]);
    }
    if (!sample.length) { ranges[name] = [0, 1]; continue; }
    const s = Float32Array.from(sample).sort();
    const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))))];
    if (difference) {
      const hi = at(clipPercent) || 1;
      ranges[name] = [-hi, hi];
    } else {
      const lo = at(35); // just below the sky level, so noise in the noisier red channel stays dark
      const hi = at(clipPercent);
      ranges[name] = [lo, hi > lo ? hi : lo + 1];
    }
  }
  return ranges;
}
