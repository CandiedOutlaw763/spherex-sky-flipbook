import { formatDate, formatDec, formatRA, mjdToYear, parseCoords, propagate } from "./coords.js";
import { DETECTORS, badMaskFromPlanes, buildFrames, displayRanges, prepareCutout, subtract } from "./frames.js";
import { PRESETS } from "./presets.js";
import { drawFrame } from "./render.js";

const API = window.SPHEREX_API || "";
const GRID_EPOCH = 2026.0; // fields are centred on where the target is in 2026

const $ = (id) => document.getElementById(id);
const els = {
  form: $("search"), q: $("q"), fov: $("fov"), presets: $("presets"),
  name: $("target-name"), coords: $("target-coords"), status: $("status"),
  viewer: $("viewer"), image: $("image"), overlay: $("overlay"), empty: $("empty"),
  scalebar: $("scalebar"), progress: $("progress"),
  prev: $("prev"), play: $("play"), next: $("next"), timeline: $("timeline"), fps: $("fps"), fpsOut: $("fps-out"),
  frameLabel: $("frame-label"), hover: $("hover"),
  detectors: $("detectors"), diff: $("diff"), stretch: $("stretch"), clip: $("clip"),
  mask: $("mask"), invert: $("invert"), track: $("track"),
  flagSummary: $("flag-summary"), exposureList: $("exposure-list"), copyLink: $("copy-link"),
};

const state = {
  target: null, // { label, sub, ra, dec, pmRa, pmDec, presetId }
  fov: 4,
  mode: "visit",
  view: "colour",
  detectors: new Set([1, 2, 3, 4, 5, 6]),
  diff: "none",
  stretch: "asinh",
  clip: 99.5,
  mask: true,
  invert: false,
  track: true,
  fps: 3,
  index: 0,
  playing: false,
};

const data = { grid: null, cutouts: [], planes: null, badMask: 0, total: 0, frames: [], shown: [], ranges: {} };
window.flipbook = { state, data }; // handy for poking at frames from the devtools console
let loadController = null;

// ---------- setup ----------

function buildPresets() {
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.title = p.kind;
    b.dataset.id = p.id;
    b.addEventListener("click", () => { state.fov = p.fov; els.fov.value = String(p.fov); load(presetTarget(p)); });
    els.presets.append(b);
  }
}

function buildDetectors() {
  for (const d of DETECTORS) {
    const label = document.createElement("label");
    label.style.setProperty("--d", d.colour);
    label.innerHTML = `<input type="checkbox" value="${d.id}" checked><b>D${d.id}</b><small>${d.range}</small>`;
    label.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? state.detectors.add(d.id) : state.detectors.delete(d.id);
      if (!state.detectors.size) { state.detectors.add(d.id); e.target.checked = true; }
      rebuild();
    });
    els.detectors.append(label);
  }
}

function presetTarget(p) {
  const pos = propagate(p.ra, p.dec, p.pmRa, p.pmDec, GRID_EPOCH - p.epoch);
  return { label: p.label, sub: p.kind, ra: pos.ra, dec: pos.dec, pmRa: p.pmRa, pmDec: p.pmDec, presetId: p.id };
}

function syncControls() {
  document.querySelector(`input[name=mode][value=${state.mode}]`).checked = true;
  document.querySelector(`input[name=view][value=${state.view}]`).checked = true;
  for (const input of els.detectors.querySelectorAll("input")) input.checked = state.detectors.has(Number(input.value));
  els.diff.value = state.diff;
  els.stretch.value = state.stretch;
  els.clip.value = String(state.clip);
  els.mask.checked = state.mask;
  els.invert.checked = state.invert;
  els.track.checked = state.track;
  els.fps.value = String(state.fps);
  els.fpsOut.textContent = String(state.fps);
  els.fov.value = String(state.fov);
}

// ---------- URL state (so views can be shared and embedded) ----------

function readUrl() {
  const u = new URLSearchParams(location.search);
  const num = (k) => (u.has(k) && Number.isFinite(Number(u.get(k))) ? Number(u.get(k)) : null);
  if (num("fov")) state.fov = Math.min(30, Math.max(1, num("fov")));
  if (["visit", "exposure"].includes(u.get("mode"))) state.mode = u.get("mode");
  if (["colour", "mono"].includes(u.get("view"))) state.view = u.get("view");
  if (["none", "median", "first", "previous"].includes(u.get("diff"))) state.diff = u.get("diff");
  if (u.get("det")) {
    const dets = [...u.get("det")].map(Number).filter((d) => d >= 1 && d <= 6);
    if (dets.length) state.detectors = new Set(dets);
  }
  if (num("fps")) state.fps = Math.min(12, Math.max(1, num("fps")));
  if (u.get("embed") === "1") document.body.classList.add("embed");

  const preset = PRESETS.find((p) => p.id === u.get("target"));
  if (preset) {
    if (!u.has("fov")) state.fov = preset.fov;
    return presetTarget(preset);
  }
  if (num("ra") !== null && num("dec") !== null) {
    return {
      label: u.get("name") || `${formatRA(num("ra"))} ${formatDec(num("dec"))}`,
      sub: "Custom position", ra: num("ra"), dec: num("dec"),
      pmRa: num("pmra") || 0, pmDec: num("pmdec") || 0,
    };
  }
  return null;
}

function viewUrl() {
  const u = new URLSearchParams();
  const t = state.target;
  if (t?.presetId) u.set("target", t.presetId);
  else if (t) {
    u.set("ra", t.ra.toFixed(6));
    u.set("dec", t.dec.toFixed(6));
    if (t.label) u.set("name", t.label);
    if (t.pmRa || t.pmDec) { u.set("pmra", String(t.pmRa)); u.set("pmdec", String(t.pmDec)); }
  }
  u.set("fov", String(state.fov));
  if (state.mode !== "visit") u.set("mode", state.mode);
  if (state.view !== "colour") u.set("view", state.view);
  if (state.diff !== "none") u.set("diff", state.diff);
  if (state.detectors.size < 6) u.set("det", [...state.detectors].sort().join(""));
  return `${location.origin}${location.pathname}?${u}`;
}

function writeUrl() {
  history.replaceState(null, "", viewUrl());
}

// ---------- loading ----------

async function submitSearch(text) {
  const q = text.trim();
  if (!q) return;
  const coords = parseCoords(q);
  if (coords) {
    load({ label: `${formatRA(coords.ra)} ${formatDec(coords.dec)}`, sub: "Custom position", ...coords, pmRa: 0, pmDec: 0 });
    return;
  }
  const lower = q.toLowerCase().replace(/[^a-z0-9]/g, "");
  const preset = PRESETS.find((p) => p.label.toLowerCase().replace(/[^a-z0-9]/g, "").includes(lower) || p.id === lower);
  if (preset) { load(presetTarget(preset)); return; }

  setStatus(`Looking up “${q}”…`);
  try {
    const r = await fetch(`${API}/api/resolve?${new URLSearchParams({ name: q, epoch: String(GRID_EPOCH) })}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `lookup failed (${r.status})`);
    const t = await r.json();
    load({ label: t.name, sub: `Resolved by ${t.resolver.replace(/^.=/, "")}`, ra: t.ra, dec: t.dec, pmRa: t.pm_ra_mas_yr, pmDec: t.pm_dec_mas_yr });
  } catch (e) {
    setStatus(`Couldn't find “${q}”: ${e.message}. Try coordinates instead, like 269.45 4.77.`, true);
  }
}

async function load(target) {
  loadController?.abort();
  const controller = (loadController = new AbortController());
  stop();
  state.target = target;
  state.index = 0;
  Object.assign(data, { grid: null, cutouts: [], planes: null, badMask: badMaskFromPlanes(null), total: 0, frames: [], shown: [], ranges: {} });
  for (const b of els.presets.children) b.setAttribute("aria-pressed", String(b.dataset.id === target.presetId));
  els.name.textContent = target.label;
  const pm = target.pmRa || target.pmDec ? ` · proper motion ${(Math.hypot(target.pmRa, target.pmDec) / 1000).toFixed(2)}″/yr` : "";
  els.coords.textContent = `${formatRA(target.ra)} ${formatDec(target.dec)}${pm}`;
  els.empty.hidden = true;
  writeUrl();
  setProgress(0);
  setStatus("Searching the SPHEREx archive… (first look at a new field can take up to a minute)");

  const params = new URLSearchParams({ ra: target.ra.toFixed(6), dec: target.dec.toFixed(6), fov: String(state.fov) });
  // Re-stacking everything is the expensive step, so refresh the preview at most every 1.5 s while streaming.
  let rebuildTimer = null;
  const scheduleRebuild = () => { rebuildTimer ??= setTimeout(() => { rebuildTimer = null; rebuild(); }, 1500); };

  try {
    const r = await fetch(`${API}/api/cutouts?${params}`, { signal: controller.signal });
    if (!r.ok) throw new Error(`server returned ${r.status}`);
    let failed = 0, received = 0;
    for await (const msg of ndjson(r)) {
      if (msg.type === "fatal") throw new Error(msg.message);
      if (msg.type === "meta") {
        data.grid = msg.grid;
        data.total = msg.count;
        if (!msg.count) { setStatus("SPHEREx has not imaged this position yet in the released data.", true); showEmpty("No SPHEREx images cover this position yet."); return; }
        setStatus(`Fetching ${msg.count} exposures…`);
        drawScalebar();
      } else if (msg.type === "flag_planes") {
        data.planes = msg.planes;
        data.badMask = badMaskFromPlanes(msg.planes);
      } else if (msg.type === "cutout") {
        data.cutouts.push(prepareCutout(msg));
        received++;
        scheduleRebuild();
      } else if (msg.type === "error") {
        failed++;
        received++;
      } else if (msg.type === "skip") {
        received++;
      }
      if (data.total) {
        setProgress(received / data.total);
        if (msg.type !== "meta") setStatus(`Fetched ${received} of ${data.total} exposures${failed ? ` (${failed} failed)` : ""}`);
      }
    }
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
    rebuild();
    setProgress(null);
    const releases = new Set(data.cutouts.map((c) => c.collection.replace(/^spherex_|_deep$/g, "").toUpperCase()));
    setStatus(`${data.cutouts.length} exposures · ${[...releases].sort().join(", ")}${failed ? ` · ${failed} failed` : ""}`);
    if (data.shown.length > 1 && !state.playing) play();
  } catch (e) {
    if (controller.signal.aborted) return;
    setProgress(null);
    setStatus(`Something went wrong: ${e.message}`, true);
  }
}

async function* ndjson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

// ---------- frames ----------

function rebuild() {
  if (!data.grid) return;
  const size = data.grid.size;
  data.frames = buildFrames(data.cutouts, {
    mode: state.mode, view: state.view, detectors: state.detectors, mask: state.mask, badMask: data.badMask, size,
  });
  data.shown = subtract(data.frames, state.diff);
  data.ranges = displayRanges(data.shown, state.clip, state.diff !== "none");
  state.index = Math.min(state.index, Math.max(0, data.shown.length - 1));
  renderTimeline();
  draw();
}

function draw() {
  const frame = data.shown[state.index];
  if (!frame) { clearOverlay(); els.frameLabel.textContent = ""; return; }
  drawFrame(els.image, frame, data.grid.size, data.ranges, { stretch: state.stretch, invert: state.invert });
  drawOverlay(frame);
  updateTimelineCursor();
  updateFrameInfo(frame);
}

function updateFrameInfo(frame) {
  const n = data.shown.length;
  const kind = state.mode === "visit" ? "Visit" : "Exposure";
  const dates = frame.mjdMax - frame.mjdMin > 1 ? `${formatDate(frame.mjdMin)} → ${formatDate(frame.mjdMax)}` : formatDate(frame.mjd);
  const dets = [...new Set(frame.cutouts.map((c) => c.detector))].sort();
  els.frameLabel.textContent = `${kind} ${state.index + 1}/${n} · ${dates} · ${frame.cutouts.length} image${frame.cutouts.length === 1 ? "" : "s"} · D${dets.join(",")}`;
  if (els.flagSummary.closest("details").open) renderFrameDetails(frame);
}

function renderFrameDetails(frame) {
  const counts = new Map();
  let total = 0;
  for (const c of frame.cutouts) {
    for (let i = 0; i < c.flags.length; i++) {
      if (!Number.isFinite(c.image[i])) continue;
      total++;
      const f = c.flags[i];
      if (!f) continue;
      for (let bit = 0; bit < 31; bit++) if (f & (1 << bit)) counts.set(bit, (counts.get(bit) || 0) + 1);
    }
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([bit, k]) => {
    const p = data.planes?.[bit];
    const pct = (100 * k) / Math.max(1, total);
    const bad = data.badMask & (1 << bit);
    return `<div class="bar" title="${p?.description || ""}"><span>${p?.name || `bit ${bit}`}${bad ? "" : " ⓘ"}</span><i style="width:${Math.max(2, pct)}%;${bad ? "" : "background:var(--cool)"}"></i><span>${pct.toFixed(1)}%</span></div>`;
  });
  els.flagSummary.innerHTML = rows.length
    ? `<p class="dim">Share of pixels carrying each quality flag. Red flags are hidden when “Hide flagged pixels” is on; ⓘ flags are informational.</p>${rows.join("")}`
    : `<p class="dim">No quality flags in this frame.</p>`;
  els.exposureList.innerHTML = frame.cutouts
    .slice()
    .sort((a, b) => a.mjd - b.mjd)
    .slice(0, 200)
    .map((c) => `<li>${formatDate(c.mjd)} D${c.detector} ${c.wave_min_um.toFixed(2)}–${c.wave_max_um.toFixed(2)}µm <a href="${c.irsa_url}" rel="noopener" target="_blank">FITS</a></li>`)
    .join("");
}

// ---------- overlay ----------

function sizeOverlay() {
  const rect = els.viewer.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  els.overlay.width = Math.round(rect.width * dpr);
  els.overlay.height = Math.round(rect.height * dpr);
}

function clearOverlay() {
  els.overlay.getContext("2d").clearRect(0, 0, els.overlay.width, els.overlay.height);
}

function drawOverlay(frame) {
  const ctx = els.overlay.getContext("2d");
  const W = els.overlay.width;
  ctx.clearRect(0, 0, W, W);
  if (!data.grid) return;
  const cell = W / data.grid.size;
  const c = W / 2;
  const dpr = W / els.viewer.getBoundingClientRect().width || 1;

  // A reticle that leaves its centre clear. For a target with known proper motion it follows the
  // position expected at this frame's date, so a moving star should stay locked inside it.
  const t = state.target;
  let x = c, y = c, colour = "rgba(255,255,255,0.55)";
  if (state.track && t && (t.pmRa || t.pmDec)) {
    const years = mjdToYear(frame.mjd) - GRID_EPOCH;
    x = c - ((t.pmRa * years) / 1000 / data.grid.scale_arcsec) * cell;
    y = c - ((t.pmDec * years) / 1000 / data.grid.scale_arcsec) * cell;
    colour = "rgba(255,181,71,0.95)";
  }
  const gap = Math.max(3 * cell, 12 * dpr), len = Math.max(3 * cell, 12 * dpr);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(x + dx * gap, y + dy * gap);
    ctx.lineTo(x + dx * (gap + len), y + dy * (gap + len));
  }
  ctx.stroke();
}

function drawScalebar() {
  if (!data.grid) return;
  const arcmin = state.fov >= 10 ? 2 : state.fov >= 4 ? 1 : 0.5;
  const fraction = (arcmin * 60) / (data.grid.size * data.grid.scale_arcsec);
  els.scalebar.style.setProperty("--bar", `${(fraction * 100).toFixed(1)}%`);
  els.scalebar.style.width = "40%";
  els.scalebar.textContent = `${arcmin}′`;
}

// ---------- timeline & playback ----------

function renderTimeline() {
  els.timeline.innerHTML = "";
  const frames = data.shown;
  if (!frames.length) return;
  const lo = frames[0].mjd, hi = frames[frames.length - 1].mjd;
  const span = Math.max(1, hi - lo);
  const pos = (mjd) => (frames.length === 1 ? 50 : 3 + (94 * (mjd - lo)) / span);
  frames.forEach((f, i) => {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.style.left = `${pos(f.mjd)}%`;
    tick.dataset.i = String(i);
    els.timeline.append(tick);
  });
  for (let year = Math.ceil(mjdToYear(lo) * 2) / 2; year <= mjdToYear(hi); year += 0.5) {
    const mjd = 51544.5 + (year - 2000) * 365.25;
    const label = document.createElement("span");
    label.className = "yr";
    label.style.left = `${pos(mjd)}%`;
    label.textContent = Number.isInteger(year) ? String(year) : "";
    if (label.textContent) els.timeline.append(label);
  }
}

function updateTimelineCursor() {
  for (const tick of els.timeline.querySelectorAll(".tick")) tick.classList.toggle("on", Number(tick.dataset.i) === state.index);
}

function seekFromPointer(e) {
  const ticks = [...els.timeline.querySelectorAll(".tick")];
  if (!ticks.length) return;
  const x = e.clientX;
  let best = 0, bestD = Infinity;
  ticks.forEach((t, i) => {
    const r = t.getBoundingClientRect();
    const d = Math.abs(r.left + r.width / 2 - x);
    if (d < bestD) { bestD = d; best = i; }
  });
  stop();
  go(best);
}

function go(i) {
  const n = data.shown.length;
  if (!n) return;
  state.index = ((i % n) + n) % n;
  draw();
}

let timer = null;
function play() {
  if (data.shown.length < 2) return;
  state.playing = true;
  els.play.textContent = "❚❚";
  els.play.setAttribute("aria-label", "Pause");
  clearInterval(timer);
  timer = setInterval(() => go(state.index + 1), 1000 / state.fps);
}
function stop() {
  state.playing = false;
  els.play.textContent = "▶";
  els.play.setAttribute("aria-label", "Play");
  clearInterval(timer);
}

// ---------- status ----------

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

function setProgress(fraction) {
  els.progress.hidden = fraction === null;
  if (fraction !== null) els.progress.firstElementChild.style.width = `${(fraction * 100).toFixed(1)}%`;
}

function showEmpty(text) {
  els.empty.hidden = false;
  els.empty.innerHTML = `<p>${text}</p>`;
  clearOverlay();
  els.image.getContext("2d").clearRect(0, 0, els.image.width, els.image.height);
}

// ---------- events ----------

function wire() {
  els.form.addEventListener("submit", (e) => { e.preventDefault(); state.fov = Number(els.fov.value); submitSearch(els.q.value); });
  els.fov.addEventListener("change", () => { state.fov = Number(els.fov.value); if (state.target) load(state.target); });
  for (const input of document.querySelectorAll("input[name=mode], input[name=view]")) {
    input.addEventListener("change", () => { state[input.name] = input.value; writeUrl(); rebuild(); });
  }
  els.diff.addEventListener("change", () => { state.diff = els.diff.value; writeUrl(); rebuild(); });
  els.stretch.addEventListener("change", () => { state.stretch = els.stretch.value; draw(); });
  els.clip.addEventListener("input", () => { state.clip = Number(els.clip.value); data.ranges = displayRanges(data.shown, state.clip, state.diff !== "none"); draw(); });
  els.mask.addEventListener("change", () => { state.mask = els.mask.checked; rebuild(); });
  els.invert.addEventListener("change", () => { state.invert = els.invert.checked; draw(); });
  els.track.addEventListener("change", () => { state.track = els.track.checked; draw(); });
  els.fps.addEventListener("input", () => { state.fps = Number(els.fps.value); els.fpsOut.textContent = String(state.fps); if (state.playing) play(); });
  els.play.addEventListener("click", () => (state.playing ? stop() : play()));
  els.prev.addEventListener("click", () => { stop(); go(state.index - 1); });
  els.next.addEventListener("click", () => { stop(); go(state.index + 1); });
  els.timeline.addEventListener("pointerdown", (e) => { els.timeline.setPointerCapture(e.pointerId); seekFromPointer(e); });
  els.timeline.addEventListener("pointermove", (e) => { if (e.buttons) seekFromPointer(e); });
  els.flagSummary.closest("details").addEventListener("toggle", () => { const f = data.shown[state.index]; if (f) renderFrameDetails(f); });
  els.copyLink.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(viewUrl()); els.copyLink.textContent = "Link copied"; }
    catch { prompt("Copy this link:", viewUrl()); }
    setTimeout(() => (els.copyLink.textContent = "Copy link to this view"), 1800);
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input[type=text], select, textarea")) return;
    if (e.key === " ") { e.preventDefault(); state.playing ? stop() : play(); }
    if (e.key === "ArrowRight") { stop(); go(state.index + 1); }
    if (e.key === "ArrowLeft") { stop(); go(state.index - 1); }
  });

  els.viewer.addEventListener("pointermove", (e) => {
    const frame = data.shown[state.index];
    if (!frame || !data.grid) return;
    const r = els.viewer.getBoundingClientRect();
    const n = data.grid.size;
    const x = Math.floor(((e.clientX - r.left) / r.width) * n);
    const yScreen = Math.floor(((e.clientY - r.top) / r.height) * n);
    if (x < 0 || x >= n || yScreen < 0 || yScreen >= n) return;
    const y = n - 1 - yScreen;
    const c = (n - 1) / 2;
    const s = data.grid.scale_arcsec / 3600;
    const dec = data.grid.dec + (y - c) * s;
    const ra = data.grid.ra - ((x - c) * s) / Math.cos((data.grid.dec * Math.PI) / 180);
    const i = y * n + x;
    const vals = Object.entries(frame.layers).map(([k, a]) => `${k === "mono" ? "" : k + " "}${Number.isFinite(a[i]) ? a[i].toFixed(3) : "—"}`);
    els.hover.textContent = `${formatRA(ra)} ${formatDec(dec)} · ${vals.join(" ")} MJy/sr`;
  });
  els.viewer.addEventListener("pointerleave", () => (els.hover.textContent = ""));

  new ResizeObserver(() => { sizeOverlay(); const f = data.shown[state.index]; if (f) drawOverlay(f); }).observe(els.viewer);
}

buildPresets();
buildDetectors();
const initial = readUrl();
syncControls();
wire();
sizeOverlay();
if (initial) load(initial);
