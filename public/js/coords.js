// Coordinate parsing, formatting and proper-motion propagation.

const SEXAGESIMAL = /^(\d{1,2})[h:\s]\s*(\d{1,2})[m:\s]\s*(\d{1,2}(?:\.\d*)?)s?\s*[,\s]\s*([+\-−]?)\s*(\d{1,2})[d°:\s]\s*(\d{1,2})['′m:\s]\s*(\d{1,2}(?:\.\d*)?)["″s]?$/i;
const DECIMAL = /^([+-]?\d+(?:\.\d*)?)\s*[,\s]\s*([+\-−]?\d+(?:\.\d*)?)$/;

/** Parse "ra dec" in decimal degrees or sexagesimal; returns {ra, dec} in degrees or null. */
export function parseCoords(text) {
  const s = text.trim().replace(/\s+/g, " ");
  let m = s.match(DECIMAL);
  if (m) {
    const ra = Number(m[1]), dec = Number(m[2].replace("−", "-"));
    return valid(ra, dec);
  }
  m = s.match(SEXAGESIMAL);
  if (m) {
    const ra = 15 * (Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600);
    const sign = m[4] === "-" || m[4] === "−" ? -1 : 1;
    const dec = sign * (Number(m[5]) + Number(m[6]) / 60 + Number(m[7]) / 3600);
    return valid(ra, dec);
  }
  return null;
}

function valid(ra, dec) {
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) return null;
  return { ra: ((ra % 360) + 360) % 360, dec };
}

function pad(n, width, digits = 0) {
  return n.toFixed(digits).padStart(width + (digits ? digits + 1 : 0), "0");
}

export function formatRA(deg) {
  let s = (((deg % 360) + 360) % 360) / 15 * 3600;
  s = Math.round(s * 100) / 100;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${pad(h, 2)}h${pad(m, 2)}m${pad(sec, 2, 2)}s`;
}

export function formatDec(deg) {
  const sign = deg < 0 ? "−" : "+";
  let s = Math.round(Math.abs(deg) * 3600 * 10) / 10;
  const d = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${sign}${pad(d, 2)}°${pad(m, 2)}′${pad(sec, 2, 1)}″`;
}

/** Shift a position along its proper motion (mas/yr, RA component includes cos dec). */
export function propagate(ra, dec, pmRa, pmDec, years) {
  const decNew = dec + (pmDec * years) / 3.6e6;
  const raNew = ra + (pmRa * years) / 3.6e6 / Math.max(Math.cos((dec * Math.PI) / 180), 1e-6);
  return { ra: ((raNew % 360) + 360) % 360, dec: Math.max(-90, Math.min(90, decNew)) };
}

export function mjdToDate(mjd) {
  return new Date(Date.UTC(1858, 10, 17) + mjd * 86400000);
}

export function mjdToYear(mjd) {
  return 2000 + (mjd - 51544.5) / 365.25;
}

export function formatDate(mjd) {
  return mjdToDate(mjd).toISOString().slice(0, 10);
}
