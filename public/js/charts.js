// A small SVG scatter/line chart with a hover tooltip; no dependencies.

const NS = "http://www.w3.org/2000/svg";

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || step0;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(+v.toPrecision(12));
  return ticks;
}

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

/**
 * spec: {
 *   x: { label, min, max, ticks?, format }, y: { label, min, max, format },
 *   series: [{ name, colour, points: [{x, y, ...}], line?: [{x, y}], dot?: number, lineColour? }],
 *   colourOf?: (point) => css colour (overrides series colour per point),
 *   highlight?: (point) => bool, verticals?: [{x, label}], hline?: number,
 *   tooltip: (point, series) => html string, empty?: string
 * }
 */
export function renderChart(container, spec) {
  container.innerHTML = "";
  const width = Math.max(260, container.clientWidth);
  const height = Math.round(Math.min(300, Math.max(200, width * 0.55)));
  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": spec.ariaLabel || "" }, container);
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  container.append(tip);

  const all = spec.series.flatMap((s) => s.points);
  if (!all.length) {
    const t = el("text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "chart-empty" }, svg);
    t.textContent = spec.empty || "No data";
    return;
  }

  const PAD = {
    top: spec.verticals?.length ? 32 : 14,
    right: spec.series.some((s) => s.directLabel) ? 48 : 16,
    bottom: 38,
    left: 56,
  };
  const iw = width - PAD.left - PAD.right, ih = height - PAD.top - PAD.bottom;
  const sx = (v) => PAD.left + ((v - spec.x.min) / (spec.x.max - spec.x.min || 1)) * iw;
  const sy = (v) => PAD.top + ih - ((v - spec.y.min) / (spec.y.max - spec.y.min || 1)) * ih;
  const clampY = (v) => Math.max(spec.y.min, Math.min(spec.y.max, v));

  // Grid and axes, kept recessive.
  const grid = el("g", { class: "chart-grid" }, svg);
  for (const t of niceTicks(spec.y.min, spec.y.max)) {
    el("line", { x1: PAD.left, x2: PAD.left + iw, y1: sy(t), y2: sy(t) }, grid);
    const label = el("text", { x: PAD.left - 6, y: sy(t) + 4, "text-anchor": "end", class: "chart-tick" }, svg);
    label.textContent = spec.y.format ? spec.y.format(t) : String(t);
  }
  for (const t of spec.x.ticks || niceTicks(spec.x.min, spec.x.max, Math.max(3, Math.floor(iw / 80)))) {
    const label = el("text", { x: sx(t), y: PAD.top + ih + 16, "text-anchor": "middle", class: "chart-tick" }, svg);
    label.textContent = spec.x.format ? spec.x.format(t) : String(t);
  }
  el("line", { x1: PAD.left, x2: PAD.left + iw, y1: PAD.top + ih, y2: PAD.top + ih, class: "chart-axis" }, svg);
  const xl = el("text", { x: PAD.left + iw / 2, y: height - 4, "text-anchor": "middle", class: "chart-label" }, svg);
  xl.textContent = spec.x.label;
  const yl = el("text", { x: 12, y: PAD.top + ih / 2, "text-anchor": "middle", class: "chart-label", transform: `rotate(-90 12 ${PAD.top + ih / 2})` }, svg);
  yl.textContent = spec.y.label;

  if (spec.hline !== undefined && spec.hline >= spec.y.min && spec.hline <= spec.y.max) {
    el("line", { x1: PAD.left, x2: PAD.left + iw, y1: sy(spec.hline), y2: sy(spec.hline), class: "chart-ref" }, svg);
  }
  (spec.verticals || []).filter((v) => v.x >= spec.x.min && v.x <= spec.x.max).forEach((v, i) => {
    el("line", { x1: sx(v.x), x2: sx(v.x), y1: PAD.top, y2: PAD.top + ih, class: "chart-ref" }, svg);
    // Alternate rows so neighbouring band labels don't collide.
    const t = el("text", { x: sx(v.x), y: PAD.top - 5 - (i % 2) * 12, "text-anchor": "middle", class: "chart-ref-label" }, svg);
    t.textContent = v.label;
  });

  // Marks: points first, then lines on top, then highlighted points with a surface ring.
  const hits = [];
  const dots = el("g", {}, svg);
  for (const s of spec.series) {
    const r = s.dot ?? 2.5;
    for (const p of s.points) {
      const cx = sx(p.x), cy = sy(clampY(p.y));
      const fill = spec.colourOf ? spec.colourOf(p) : s.colour;
      el("circle", { cx, cy, r, fill, "fill-opacity": s.dotOpacity ?? 0.75 }, dots);
      hits.push({ cx, cy, p, s });
    }
  }
  for (const s of spec.series) {
    if (!s.line || s.line.length < 2) continue;
    const d = s.line.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(clampY(p.y)).toFixed(1)}`).join("");
    el("path", { d, fill: "none", stroke: s.lineColour || s.colour, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    for (const p of s.lineMarkers ? s.line : []) {
      el("circle", { cx: sx(p.x), cy: sy(clampY(p.y)), r: 4, fill: s.colour, stroke: "var(--panel)", "stroke-width": 2 }, svg);
    }
  }
  // Direct labels at line ends, nudged apart vertically; text stays in ink, not series colour.
  const ends = spec.series.filter((s) => s.directLabel && s.line?.length)
    .map((s) => ({ s, y: sy(clampY(s.line[s.line.length - 1].y)), x: sx(s.line[s.line.length - 1].x) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
  for (const e of ends) {
    const t = el("text", { x: Math.min(e.x + 8, PAD.left + iw + 6), y: e.y + 4, class: "chart-direct" }, svg);
    t.textContent = e.s.directLabel;
  }
  if (spec.highlight) {
    const top = el("g", {}, svg);
    for (const h of hits) {
      if (!spec.highlight(h.p)) continue;
      el("circle", { cx: h.cx, cy: h.cy, r: 3.5, fill: "none", stroke: "var(--text)", "stroke-width": 1 }, top);
    }
  }

  // Hover: nearest mark within reach, with a tooltip and a ring on the mark.
  const ring = el("circle", { r: 7, fill: "none", stroke: "var(--text)", "stroke-width": 1.5, visibility: "hidden" }, svg);
  const surface = el("rect", { x: PAD.left, y: PAD.top, width: iw, height: ih, fill: "transparent" }, svg);
  surface.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const mx = e.clientX - box.left, my = e.clientY - box.top;
    let best = null, bestD = 18 * 18;
    for (const h of hits) {
      const d = (h.cx - mx) ** 2 + (h.cy - my) ** 2;
      if (d < bestD) { bestD = d; best = h; }
    }
    if (!best) { tip.hidden = true; ring.setAttribute("visibility", "hidden"); return; }
    ring.setAttribute("cx", best.cx);
    ring.setAttribute("cy", best.cy);
    ring.setAttribute("visibility", "visible");
    tip.innerHTML = spec.tooltip(best.p, best.s);
    tip.hidden = false;
    const left = Math.min(best.cx + 12, width - tip.offsetWidth - 4);
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(0, best.cy - tip.offsetHeight - 10)}px`;
  });
  surface.addEventListener("pointerleave", () => { tip.hidden = true; ring.setAttribute("visibility", "hidden"); });
}

/** Robust axis range: ignore the most extreme 1% so one outlier can't flatten the chart. */
export function robustRange(values, padFraction = 0.08) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return [0, 1];
  const lo = a[Math.floor(a.length * 0.01)], hi = a[Math.ceil(a.length * 0.99) - 1];
  const pad = (hi - lo || Math.abs(hi) || 1) * padFraction;
  return [lo - pad, hi + pad];
}
