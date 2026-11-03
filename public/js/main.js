import { GROUPS, measure, median, medianSpectrum, relativeFlux, toCsv } from "./analysis.js";
import { renderChart, robustRange } from "./charts.js";
import { CATALOGS, SURVEYS, aladinView, drawSources, fetchCatalog, placeSources } from "./context.js";
import { formatDate, formatDec, formatRA, mjdToDate, mjdToYear, parseCoords, propagate } from "./coords.js";
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
  analysis: $("analysis"), probeTitle: $("probe-title"), probeSub: $("probe-sub"), probeReset: $("probe-reset"),
  spectrumChart: $("spectrum-chart"), spectrumLegend: $("spectrum-legend"),
  lightcurveChart: $("lightcurve-chart"), lightcurveLegend: $("lightcurve-legend"),
  context: $("context"), survey: $("survey"), contextStatus: $("context-status"),
  catalogToggles: $("catalog-toggles"), catalogStatus: $("catalog-status"),
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
  probe: null, // null = follow the target; else a grid position {x, y} the user clicked
  catalogs: new Set(),
  survey: SURVEYS[0].id,
};

const data = { grid: null, cutouts: [], planes: null, badMask: 0, total: 0, frames: [], shown: [], ranges: {}, catalogs: {} };
const measured = { points: [], spectrum: [], relative: [] };
let placedSources = {}; // catalogue name -> sources placed for the frame on screen, for hover lookups
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

function buildCatalogToggles() {
  for (const [name, c] of Object.entries(CATALOGS)) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${name}"><span class="swatch ${c.shape}" style="--c:${c.colour}"></span>${c.label}`;
    label.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? state.catalogs.add(name) : state.catalogs.delete(name);
      writeUrl();
      ensureCatalogs();
      draw();
    });
    els.catalogToggles.append(label);
  }
  for (const s of SURVEYS) els.survey.add(new Option(s.label, s.id));
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
  for (const input of els.catalogToggles.querySelectorAll("input")) input.checked = state.catalogs.has(input.value);
  els.survey.value = state.survey;
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
  for (const name of (u.get("cat") || "").split(",")) if (CATALOGS[name]) state.catalogs.add(name);

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
  if (state.catalogs.size) u.set("cat", [...state.catalogs].sort().join(","));
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

  setStatus(`Looking up “${q}”… (this can take up to a minute)`);
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
  state.probe = null;
  Object.assign(data, { grid: null, cutouts: [], planes: null, badMask: badMaskFromPlanes(null), total: 0, frames: [], shown: [], ranges: {}, catalogs: {} });
  els.analysis.hidden = true;
  els.catalogStatus.textContent = "";
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
    // A very large field can outlast one server request; the server then sends "partial" and we ask
    // again. Everything already cut out is cached server-side, so each round gets further.
    const seen = new Set();
    let failed = 0, finished = false;
    for (let round = 0; round < 5 && !finished; round++) {
      const r = await fetch(`${API}/api/cutouts?${params}`, { signal: controller.signal });
      if (!r.ok) throw new Error(`server returned ${r.status}`);
      for await (const msg of ndjson(r)) {
        if (msg.type === "fatal") throw new Error(msg.message);
        if (msg.type === "meta") {
          if (!data.grid) {
            data.grid = msg.grid;
            drawScalebar();
            ensureCatalogs();
            if (els.context.open) openContext();
          }
          data.total = msg.count;
          if (!msg.count) { setStatus("SPHEREx has not imaged this position yet in the released data.", true); showEmpty("No SPHEREx images cover this position yet."); return; }
          setStatus(round ? `Still fetching (part ${round + 1})… ${seen.size} of ${msg.count} so far` : `Fetching ${msg.count} exposures…`);
        } else if (msg.type === "flag_planes") {
          data.planes = msg.planes;
          data.badMask = badMaskFromPlanes(msg.planes);
        } else if (msg.type === "cutout" || msg.type === "error" || msg.type === "skip") {
          if (seen.has(msg.key)) continue;
          seen.add(msg.key);
          if (msg.type === "cutout") { data.cutouts.push(prepareCutout(msg)); scheduleRebuild(); }
          if (msg.type === "error") failed++;
        } else if (msg.type === "done") {
          finished = true;
          console.info("field timings", msg);
        } else if (msg.type === "partial") {
          console.info("field partial, resuming", msg);
        }
        if (data.total && msg.type !== "meta") {
          setProgress(seen.size / data.total);
          setStatus(`Fetched ${seen.size} of ${data.total} exposures${failed ? ` (${failed} failed)` : ""}`);
        }
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
  updateAnalysis();
  draw();
}

let shownIndex = -1;
function draw() {
  const frame = data.shown[state.index];
  if (!frame) { clearOverlay(); els.frameLabel.textContent = ""; return; }
  drawFrame(els.image, frame, data.grid.size, data.ranges, { stretch: state.stretch, invert: state.invert });
  drawOverlay(frame);
  updateTimelineCursor();
  updateFrameInfo(frame);
  if (shownIndex !== state.index) { shownIndex = state.index; renderSpectrum(); } // re-ring this frame's points
}

// ---------- measurements ----------

// Molecular bands that shape near-infrared spectra of cool stars, brown dwarfs and ices.
const BANDS = [
  { x: 1.4, label: "H₂O" }, { x: 1.9, label: "H₂O" }, { x: 2.3, label: "CO" }, { x: 3.05, label: "H₂O ice" },
  { x: 3.3, label: "CH₄" }, { x: 4.27, label: "CO₂" }, { x: 4.67, label: "CO" },
];
// Sequential blue ramp for exposure date, dark steps (old) to light (recent) on the dark surface.
const DATE_RAMP = ["#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Grid position to measure in a cutout: the clicked spot, or the target along its expected track. */
function probePosition(c) {
  const centre = (data.grid.size - 1) / 2;
  if (state.probe) return state.probe;
  const t = state.target;
  if (!t || !(t.pmRa || t.pmDec)) return { x: centre, y: centre };
  const years = mjdToYear(c.mjd) - GRID_EPOCH;
  return {
    x: centre - (t.pmRa * years) / 1000 / data.grid.scale_arcsec,
    y: centre + (t.pmDec * years) / 1000 / data.grid.scale_arcsec,
  };
}

function gridToSky(x, y) {
  const c = (data.grid.size - 1) / 2;
  const s = data.grid.scale_arcsec / 3600;
  return {
    ra: data.grid.ra - ((x - c) * s) / Math.cos((data.grid.dec * Math.PI) / 180),
    dec: data.grid.dec + (y - c) * s,
  };
}

function updateAnalysis() {
  if (!data.grid || !data.cutouts.length) { els.analysis.hidden = true; return; }
  els.analysis.hidden = false;
  const { points, skipped } = measure(data.cutouts, data.grid.size, probePosition, { mask: state.mask, badMask: data.badMask });
  measured.points = points;
  measured.skipped = skipped;
  measured.spectrum = medianSpectrum(points);
  measured.relative = relativeFlux(points, measured.spectrum);

  const t = state.target;
  if (state.probe) {
    const sky = gridToSky(state.probe.x, state.probe.y);
    els.probeTitle.textContent = `Measuring ${formatRA(sky.ra)} ${formatDec(sky.dec)}`;
    els.probeSub.textContent = "A fixed spot on the sky you clicked. Click elsewhere to move it.";
  } else {
    const moving = t && (t.pmRa || t.pmDec);
    els.probeTitle.textContent = `Measuring ${t?.label || "the field centre"}`;
    els.probeSub.textContent = moving
      ? "Following its expected track, so the aperture moves with it. Click the image to measure another spot."
      : "At the field centre. Click the image to measure another spot.";
  }
  els.probeReset.hidden = !state.probe;
  const total = data.cutouts.length;
  if (skipped.blank > total * 0.3) {
    els.probeSub.textContent += ` This spot is saturated (blank) in ${skipped.blank} of ${total} exposures, so its spectrum is incomplete; click just beside a bright star to measure its unsaturated glow.`;
  } else if (skipped.flagged > total * 0.3) {
    els.probeSub.textContent += ` ${skipped.flagged} exposures are flagged here; untick “Hide flagged pixels” to include them anyway.`;
  }
  renderSpectrum();
  renderLightCurve();
}

function emptyReason() {
  const s = measured.skipped || {};
  if (s.blank >= Math.max(s.flagged, s.offImage)) return "Saturated: the detector is blank here in every exposure. Try clicking just beside the star.";
  if (s.flagged >= s.offImage) return "Flagged in every exposure. Untick “Hide flagged pixels” to see the measurements anyway.";
  return "This spot is off the image in every exposure.";
}

function fmtFlux(v) {
  const a = Math.abs(v);
  if (a < 1e-9) return "0";
  return a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
}

function renderSpectrum() {
  if (els.analysis.hidden) return;
  const pts = measured.points;
  const [lo, hi] = robustRange([...pts.map((p) => p.flux), ...measured.spectrum.map((s) => s.flux)]);
  const t0 = Math.min(...pts.map((p) => p.mjd)), t1 = Math.max(...pts.map((p) => p.mjd));
  const colourOf = (pt) => DATE_RAMP[Math.min(DATE_RAMP.length - 1, Math.floor(((pt.p.mjd - t0) / (t1 - t0 || 1)) * DATE_RAMP.length))];
  const current = new Set((data.shown[state.index]?.cutouts || []).map((c) => c.key));
  renderChart(els.spectrumChart, {
    ariaLabel: "Spectrum: flux against wavelength for every exposure",
    x: { label: "Wavelength (µm)", min: 0.7, max: 5.05, ticks: [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5], format: (v) => String(v) },
    y: { label: "Flux (mJy)", min: lo, max: hi, format: fmtFlux },
    series: [{
      name: "Exposures", colour: DATE_RAMP[5], dot: 2.5,
      points: pts.map((p) => ({ x: p.um, y: p.flux, p })),
      line: measured.spectrum.map((s) => ({ x: s.um, y: s.flux })), lineColour: "var(--text)",
    }],
    colourOf, highlight: (pt) => current.has(pt.p.cutout.key), verticals: BANDS,
    tooltip: (pt) => `${formatDate(pt.p.mjd)} · D${pt.p.detector}<br>${pt.p.um.toFixed(3)} µm · ${fmtFlux(pt.p.flux)} mJy`,
    empty: emptyReason(),
  });
  els.spectrumLegend.innerHTML = pts.length
    ? `<span>${formatDate(t0)}<i class="ramp"></i>${formatDate(t1)}</span>`
      + `<span><i class="line" style="background:var(--text)"></i>median spectrum</span>`
      + `<span><i class="ring"></i>this frame</span>`
    : "";
}

function monthTicks(min, max, maxTicks) {
  const start = mjdToDate(min);
  for (const step of [1, 2, 3, 4, 6, 12, 24]) {
    const ticks = [];
    let y = start.getUTCFullYear(), m = start.getUTCMonth() + 1;
    for (;;) {
      if (m > 11) { y += Math.floor(m / 12); m %= 12; }
      const mjd = (Date.UTC(y, m, 1) - Date.UTC(1858, 10, 17)) / 86400000;
      if (mjd > max) break;
      if (m % step === 0) ticks.push(mjd);
      m += 1;
    }
    if (ticks.length <= maxTicks) return ticks;
  }
  return [min, max];
}

function renderLightCurve() {
  const rel = measured.relative;
  const windows = data.frames.map((f) => [f.mjdMin - 0.01, f.mjdMax + 0.01, f.mjd]);
  const series = GROUPS.map((g) => {
    const pts = rel.filter((p) => g.detectors.includes(p.detector));
    // One median per flipbook frame, so the line steps through the same visits you blink through.
    const line = windows.map(([a, b, mjd]) => {
      const v = pts.filter((p) => p.mjd >= a && p.mjd <= b).map((p) => p.relative);
      return v.length ? { x: mjd, y: median(v) } : null;
    }).filter(Boolean);
    return {
      name: g.label, colour: g.colour, dot: 2, dotOpacity: 0.35, lineMarkers: true,
      directLabel: g.short, points: pts.map((p) => ({ x: p.mjd, y: p.relative, p })), line,
    };
  }).filter((s) => s.points.length);

  const all = rel.map((p) => p.relative);
  let [lo, hi] = robustRange([...all, 1]);
  lo = Math.min(lo, 0.9); hi = Math.max(hi, 1.1);
  const mjds = rel.map((p) => p.mjd);
  const pad = Math.max(5, (Math.max(...mjds) - Math.min(...mjds)) * 0.03);
  const xmin = Math.min(...mjds) - pad, xmax = Math.max(...mjds) + pad;
  renderChart(els.lightcurveChart, {
    ariaLabel: "Brightness over time in three wavelength groups",
    x: {
      label: "Date", min: xmin, max: xmax, ticks: rel.length ? monthTicks(xmin, xmax, 5) : [],
      format: (v) => { const d = mjdToDate(v); return `${MONTHS[d.getUTCMonth()]} ’${String(d.getUTCFullYear()).slice(2)}`; },
    },
    y: { label: "Brightness (× typical)", min: lo, max: hi, format: (v) => v.toFixed(2) },
    series, hline: 1,
    tooltip: (pt) => `${formatDate(pt.p.mjd)} · D${pt.p.detector} · ${pt.p.um.toFixed(2)} µm<br>${pt.p.relative.toFixed(3)}× typical · ${fmtFlux(pt.p.flux)} mJy`,
    empty: measured.points.length ? "Not enough measurements to compare over time." : emptyReason(),
  });
  els.lightcurveLegend.innerHTML = series.map((s) => `<span><i style="background:${s.colour}"></i>${s.name}</span>`).join("")
    + (series.length ? `<span><i class="line" style="background:var(--dim)"></i>line: median per frame</span>` : "");
}

function downloadCsv(kind) {
  const name = (state.target?.label || "field").replace(/[^a-z0-9]+/gi, "_");
  const rows = (kind === "spectrum" ? measured.points : measured.relative).map((p) => ({
    date: formatDate(p.mjd), mjd: p.mjd.toFixed(5), detector: p.detector, wavelength_um: p.um.toFixed(4),
    bandwidth_um: p.bw?.toFixed(4), flux_mjy: p.flux.toFixed(4), relative: p.relative?.toFixed(4), obs_id: p.cutout.obs_id,
  }));
  const columns = ["date", "mjd", "detector", "wavelength_um", "bandwidth_um", "flux_mjy", ...(kind === "spectrum" ? [] : ["relative"]), "obs_id"];
  const blob = new Blob([toCsv(rows, columns)], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `spherex_${name}_${kind}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- other telescopes ----------

function ensureCatalogs() {
  if (!data.grid) return;
  const grid = data.grid;
  for (const name of state.catalogs) {
    if (data.catalogs[name]) continue;
    data.catalogs[name] = "loading";
    els.catalogStatus.textContent = `Loading ${CATALOGS[name].label}…`;
    fetchCatalog(name, grid, state.fov)
      .then((cat) => {
        if (data.grid !== grid) return; // a new field was loaded meanwhile
        data.catalogs[name] = cat;
        els.catalogStatus.textContent = Object.values(data.catalogs).filter((c) => c.sources)
          .map((c) => `${c.label}: ${c.sources.length} sources`).join(" · ");
        draw();
      })
      .catch((e) => {
        if (data.grid !== grid) return;
        delete data.catalogs[name];
        els.catalogStatus.textContent = `${CATALOGS[name].label} unavailable: ${e.message}`;
      });
  }
}

function openContext() {
  const t = state.target;
  if (!t) { els.contextStatus.textContent = "Load a target first."; return; }
  els.contextStatus.textContent = "Loading Aladin Lite…";
  aladinView("#aladin", { ra: t.ra, dec: t.dec, fovDeg: Math.max(0.05, (state.fov / 60) * 1.6), survey: state.survey })
    .then(() => { els.contextStatus.textContent = "Drag to pan, scroll to zoom. Centred on the same position."; })
    .catch((e) => { els.contextStatus.textContent = `Couldn't load Aladin Lite (${e.message}).`; });
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

  // Catalogue sources from other telescopes, placed at this frame's date.
  placedSources = {};
  for (const name of state.catalogs) {
    const cat = data.catalogs[name];
    if (!cat?.sources) continue;
    placedSources[name] = placeSources(cat, data.grid, frame.mjd);
    drawSources(ctx, placedSources[name], CATALOGS[name], cell, data.grid.size, dpr);
  }

  // The spot being measured, when the user picked one: a 3x3-pixel box like the aperture.
  if (state.probe) {
    const px = (state.probe.x + 0.5) * cell, py = (data.grid.size - 0.5 - state.probe.y) * cell;
    ctx.strokeStyle = "rgba(111,211,255,0.95)";
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect(px - 1.5 * cell, py - 1.5 * cell, 3 * cell, 3 * cell);
  }
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

  const gridAt = (e) => {
    const r = els.viewer.getBoundingClientRect();
    const n = data.grid.size;
    const x = Math.floor(((e.clientX - r.left) / r.width) * n);
    const yScreen = Math.floor(((e.clientY - r.top) / r.height) * n);
    if (x < 0 || x >= n || yScreen < 0 || yScreen >= n) return null;
    return { x, y: n - 1 - yScreen };
  };
  els.viewer.addEventListener("pointermove", (e) => {
    const frame = data.shown[state.index];
    if (!frame || !data.grid) return;
    const at = gridAt(e);
    if (!at) return;
    const { ra, dec } = gridToSky(at.x, at.y);
    const i = at.y * data.grid.size + at.x;
    const vals = Object.entries(frame.layers).map(([k, a]) => `${k === "mono" ? "" : k + " "}${Number.isFinite(a[i]) ? a[i].toFixed(3) : "—"}`);
    let source = "";
    for (const [name, placed] of Object.entries(placedSources)) {
      const near = placed.find((s) => Math.hypot(s.x - at.x, s.y - at.y) < 1.2);
      if (near) {
        const pm = Math.hypot(near.pmra, near.pmdec) / 1000;
        source = ` · ${CATALOGS[name].label} ${data.catalogs[name].band}=${near.mag ?? "?"}${pm > 0.05 ? `, moves ${pm.toFixed(2)}″/yr` : ""}`;
        break;
      }
    }
    els.hover.textContent = `${formatRA(ra)} ${formatDec(dec)} · ${vals.join(" ")} MJy/sr${source}`;
  });
  els.viewer.addEventListener("pointerleave", () => (els.hover.textContent = ""));
  els.viewer.addEventListener("click", (e) => {
    if (!data.grid || !data.cutouts.length) return;
    const at = gridAt(e);
    if (!at) return;
    state.probe = at;
    updateAnalysis();
    draw();
  });
  els.probeReset.addEventListener("click", () => { state.probe = null; updateAnalysis(); draw(); });
  for (const b of document.querySelectorAll("button.csv")) b.addEventListener("click", () => downloadCsv(b.dataset.chart));
  els.context.addEventListener("toggle", () => { if (els.context.open) openContext(); });
  els.survey.addEventListener("change", () => { state.survey = els.survey.value; if (els.context.open) openContext(); });
  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderSpectrum(); if (!els.analysis.hidden) renderLightCurve(); }, 150);
  }).observe(els.analysis);

  new ResizeObserver(() => { sizeOverlay(); const f = data.shown[state.index]; if (f) drawOverlay(f); }).observe(els.viewer);
}

buildPresets();
buildDetectors();
buildCatalogToggles();
const initial = readUrl();
syncControls();
wire();
sizeOverlay();
if (initial) load(initial);
