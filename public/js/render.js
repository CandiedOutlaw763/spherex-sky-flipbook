// Paint a frame's layers into a canvas, north up and east left.

function stretchFn(kind, lo, hi) {
  const span = hi - lo || 1;
  if (kind === "linear") return (v) => (v - lo) / span;
  if (kind === "log") return (v) => Math.log10(1 + 999 * Math.max(0, (v - lo) / span)) / 3;
  const a = 12; // asinh softening: bright cores compressed, faint detail lifted
  const norm = Math.asinh(a);
  return (v) => Math.asinh(a * Math.max(0, (v - lo) / span)) / norm;
}

/** Differences use a symmetric linear map: zero is mid grey, brighter now is white, dimmer now is black. */
function diffFn(lo, hi) {
  return (v) => 0.5 + (0.5 * v) / (hi || 1);
}

export function drawFrame(canvas, frame, size, ranges, opts) {
  if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const px = img.data;
  const fns = {};
  for (const [name, [lo, hi]] of Object.entries(ranges)) {
    fns[name] = frame.difference ? diffFn(lo, hi) : stretchFn(opts.stretch, lo, hi);
  }
  const { mono, r, g, b } = frame.layers;
  const nanGrey = frame.difference ? 128 : 0;

  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // grid row 0 is the southern edge
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const o = (row * size + x) * 4;
      let R, G, B;
      if (mono) {
        const v = mono[i];
        R = G = B = Number.isFinite(v) ? clamp(fns.mono(v)) * 255 : nanGrey;
      } else {
        R = chan(r[i], fns.r, -1);
        G = chan(g[i], fns.g, -1);
        B = chan(b[i], fns.b, -1);
        // A channel can be blank where the others are not (typically a saturated star core that
        // the pipeline set to NaN); borrow the brightest neighbour channel instead of tinting.
        if (R < 0 || G < 0 || B < 0) {
          const best = Math.max(R, G, B);
          const fill = best < 0 ? nanGrey : best;
          if (R < 0) R = fill;
          if (G < 0) G = fill;
          if (B < 0) B = fill;
        }
      }
      if (opts.invert) { R = 255 - R; G = 255 - G; B = 255 - B; }
      px[o] = R; px[o + 1] = G; px[o + 2] = B; px[o + 3] = 255;
    }
  }
  if (!frame.difference) fillSaturatedCores(px, frame.layers, size, opts.invert);
  ctx.putImageData(img, 0, 0);
}

/** The pipeline blanks saturated pixels, which would draw bright star cores as black holes. */
function fillSaturatedCores(px, layers, size, invert) {
  const any = Object.values(layers);
  const blank = (i) => any.every((a) => !Number.isFinite(a[i]));
  const lum = (row, x) => {
    const o = (row * size + x) * 4;
    return invert ? 255 - Math.min(px[o], px[o + 1], px[o + 2]) : Math.max(px[o], px[o + 1], px[o + 2]);
  };
  const white = invert ? 0 : 255;
  const filled = new Uint8Array(size * size);
  // Grow inward from the bright rim so cores several pixels wide fill too.
  for (let pass = 0, changed = true; changed && pass < 6; pass++) {
    changed = false;
    for (let y = 1; y < size - 1; y++) {
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        if (filled[i] || !blank(i)) continue;
        const row = size - 1 - y;
        let bright = 0, seen = 0;
        for (const [dx, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = (y - dr) * size + x + dx;
          if (blank(j) && !filled[j]) continue;
          seen++;
          if (filled[j] || lum(row + dr, x + dx) > 140) bright++;
        }
        if (seen && bright === seen) {
          const o = (row * size + x) * 4;
          px[o] = px[o + 1] = px[o + 2] = white;
          filled[i] = 1;
          changed = true;
        }
      }
    }
  }
}

function chan(v, fn, fallback) {
  return Number.isFinite(v) ? clamp(fn(v)) * 255 : fallback;
}

function clamp(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
