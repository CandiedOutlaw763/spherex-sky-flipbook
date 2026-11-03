# SPHEREx Sky Flipbook

A public web tool for the 2026 NASA Space Apps challenge **Planet X and SPHEREx**. Type a name or
coordinates, and it plays every SPHEREx image of that patch of sky as a little video so anything
that moves or changes brightness stands out.

## What it does

- **Any position.** Enter RA/Dec (decimal or sexagesimal) or an object name. Fields are 2′–15′ across.
- **Flipbook by survey visit or by exposure.** A *visit* median-stacks every exposure from one pass of
  the survey (SPHEREx re-maps the sky every ~6 months), which beats down noise. *Single exposures* keep
  the full time resolution for fast movers like asteroids.
- **False colour from the 102 bands.** The six detector arrays are stacked into three channels
  (D1+D2 blue, D3+D4 green, D5+D6 red), so cold brown dwarfs, which are bright at 4–5 µm, glow red.
  Mono mode stacks any chosen subset of detectors.
- **Add and subtract epochs.** Subtract the median of all frames, the first frame, or the previous
  frame. Static stars cancel out; movers leave a bright/dark pair and variables flash.
- **Expected-position reticle.** For targets with known proper motion, the reticle follows where the
  star should be at each frame's date.
- **Quality flags.** Pixels carrying SPHEREx's bad-data flags are hidden by default. Each frame
  lists its flag statistics and links to the original FITS files at IRSA.
- **Spectra on the fly.** SPHEREx's filters vary across each detector, so every exposure samples a
  slightly different wavelength. The tool reads each file's wavelength table, measures a 3×3-pixel
  aperture in every exposure and plots flux against wavelength from 0.75 to 5 µm, coloured by date,
  with a median spectrum and marked H₂O, CH₄, CO and CO₂ bands. It follows the target's expected track,
  or measures any spot you click.
- **Brightness over time.** The same measurements divided by the source's own median spectrum, in
  three wavelength groups, with one median per flipbook frame. This shows variables changing even
  though each exposure sees a different wavelength.
- **Other telescopes.** Gaia DR3 and CatWISE2020 sources (from IRSA) can be drawn over the SPHEREx
  frame, each moved to that frame's date along its proper motion. An Aladin Lite panel shows the same
  field in AllWISE, 2MASS, Pan-STARRS or DSS.
- **Shareable and embeddable.** The URL holds the view (`?target=barnard`, or
  `?ra=133.7599&dec=-7.2422&fov=6&diff=median&cat=gaia`), and `&embed=1` gives a bare viewer for
  iframes. Both charts download as CSV.
- **New releases show up automatically.** Collections are discovered from IRSA's ObsCore table
  (`spherex_qr2`, `spherex_qr3`, ...), so QR4 and later need no code change.

## Run it

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m uvicorn backend.app:app --port 8000
```

Then open <http://localhost:8000/?target=barnard>.

The first look at a new field takes 30–90 s, because IRSA's image search is slow and each exposure is
read from S3. Results are cached under `.cache/` (or set `SPHEREX_CACHE_DIR`), so repeat visits load in
a second or two.

## Deploy (Vercel)

Live at <https://spherex-sky-flipbook.vercel.app>.

The repo deploys to Vercel as-is: `public/` is served by the CDN, and `backend/app.py` (re-exported
by the root `app.py`) runs as one Python function in `iad1`, the same AWS region as the SPHEREx S3
bucket. Streams stop cleanly at 270 s, before the 300 s function limit, and the browser resumes
them. On Vercel the cache lives in `/tmp`. `seed/` ships read-only cached data for the five test targets so
they load instantly on a cold start; regenerate it with `scripts/build_seed.py` while the local
server runs.

```bash
vercel deploy --prod
```

## How it works

```
browser ──/api/cutouts (NDJSON stream)──► FastAPI ──SIA──► IRSA (which images cover this point?)
   ▲                                         │
   │ aligned float32 cutouts + flags         └─HTTP range reads─► s3://nasa-irsa-spherex (Level 2 FITS)
   └ stacking, differencing, colour and stretch all happen client-side
```

- `backend/spherex/archive.py` discovers releases and runs one IRSA SIA query per release.
- `backend/spherex/remote_fits.py` reads only the bytes it needs from each ~65 MB Level 2 file: headers,
  a band of IMAGE rows, and the matching FLAGS rows. FLAGS are plain in QR2 and Rice-compressed per row
  from QR3 on.
- `backend/spherex/cutout.py` resamples each exposure through its TAN-SIP WCS onto one shared north-up
  grid at the native 6.15″ pixel scale, so every frame lines up pixel for pixel.
- `backend/spherex/resolve.py` resolves names with CDS Sesame, falling back to NASA MAST plus a
  Gaia/CatWISE proper-motion match, then NED. It advances catalogue (J2000) positions along their
  proper motion to 2026, the SPHEREx era: Barnard's Star has moved 4.5′ since 2000.
- `backend/spherex/catalogs.py` queries Gaia DR3 and CatWISE2020 cones from IRSA TAP.
- `public/` is plain ES modules with no build step. `frames.js` groups, stacks and subtracts,
  `render.js` paints, `analysis.js` and `charts.js` measure and plot, `context.js` handles the
  catalogue overlays and Aladin Lite, and `main.js` runs the UI and URL state.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/cutouts?ra=&dec=&fov=&detectors=123456` | NDJSON: one `meta` line (grid), then a `cutout` line per exposure (base64 little-endian float32 image in MJy/sr, int32 flags, and `wave`: wavelength at the field centre plus its per-pixel gradient), `flag_planes`, and `done` |
| `GET /api/catalog?name=gaia\|catwise&ra=&dec=&radius=` | Catalogue sources with proper motions and the catalogue epoch |
| `GET /api/images?ra=&dec=` | Metadata for every SPHEREx exposure covering the point |
| `GET /api/resolve?name=` | Coordinates (J2000 and propagated) and proper motion |

## Data and credits

SPHEREx quick-release Level 2 spectral images come from NASA/IPAC IRSA and its AWS Open Data mirror.
Gaia DR3 (ESA/Gaia/DPAC) and CatWISE2020 come via IRSA. Names are resolved by CDS Sesame
(SIMBAD/NED/VizieR), NASA MAST and NASA NED, and survey images come via Aladin Lite (CDS, Strasbourg).
