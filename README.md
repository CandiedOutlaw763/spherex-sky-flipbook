# SPHEREx Sky Flipbook

**Blink NASA's infrared all-sky survey to find what moves.**

A public web tool for the 2026 NASA Space Apps Challenge **"Planet X and SPHEREx."** Enter the name or
coordinates of any patch of sky, and it plays every image NASA's SPHEREx telescope has taken of that spot
as a short movie, so anything that moves or changes brightness stands out. It also measures spectra and
brightness histories on the fly and overlays stars from the Gaia and WISE missions for comparison.

| | |
|---|---|
| **Live prototype** | <https://spherex-sky-flipbook.vercel.app> |
| **Source code** | <https://github.com/CandiedOutlaw763/spherex-sky-flipbook> |
| **Full user guide** | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |

## Contents

1. [The challenge](#the-challenge)
2. [Features](#features)
3. [How to use the tool](#how-to-use-the-tool)
4. [The five test targets](#the-five-test-targets)
5. [Where the data comes from](#where-the-data-comes-from)
6. [How it works](#how-it-works)
7. [Run it locally](#run-it-locally)
8. [Deploy on Vercel from GitHub](#deploy-on-vercel-from-github)
9. [API](#api)
10. [Project layout](#project-layout)
11. [Known limitations](#known-limitations)
12. [Credits](#credits)

## The challenge

Since 2025, NASA's SPHEREx mission has mapped the entire sky every six months in 102 bands of
near-infrared light, recording more than a billion objects. Comets, asteroids, nearby stars and brown
dwarfs give themselves away by shifting position between images, the same way Pluto was found in 1930.
The challenge asks for a public web tool that shows SPHEREx images of any patch of sky over time, so
anyone can quickly see how it changes.

## Features

- **Any position on the sky.** Search by object name, or by right ascension and declination in decimal
  degrees or hours/degrees. Fields of view run from 2′ to 15′.
- **A flipbook of real SPHEREx images.** Frames can be whole *survey visits* (all exposures from one pass,
  stacked for a clean image) or *single exposures* (full time resolution for fast movers such as asteroids).
- **False colour from the 102 bands.** The six detector arrays are combined into three channels
  (0.75–1.6 µm blue, 1.6–3.8 µm green, 3.8–5 µm red), so cold brown dwarfs glow red. Mono mode uses any
  chosen set of detectors.
- **Add and subtract images taken at different times.** Subtracting the median of all frames, the first
  frame or the previous frame removes everything that stays still, so moving objects leave a bright/dark
  pair and variable stars flash.
- **Expected-position reticle.** For targets with known proper motion, a cross-hair follows where the
  object should be on each frame's date.
- **Spectra on the fly.** SPHEREx's filters vary across each detector, so every exposure sees a slightly
  different wavelength. The tool reads each file's wavelength table and plots brightness against
  wavelength for every exposure, with the typical spectrum and water, methane, CO and CO₂ bands marked.
- **Brightness over time.** The same measurements, divided by the object's own typical spectrum, show
  whether it is brightening or fading.
- **Overlays from other telescopes.** Gaia DR3 and CatWISE2020 stars can be drawn on each frame, moved to
  that frame's date using their measured motions. An Aladin Lite panel shows the same field in AllWISE,
  2MASS, Pan-STARRS or DSS.
- **Quality flags shown.** Pixels the pipeline marks as unreliable are hidden by default, and each frame
  lists its flag statistics with download links to the original files.
- **Shareable and embeddable.** The page address holds the full view, so any view can be shared;
  `&embed=1` gives a bare viewer for other websites. Both charts download as CSV.
- **Keeps up with new data.** Data releases are discovered from NASA's archive at run time, so new ones
  (the tool already picked up Data Release 1 alongside Quick Release 3) appear without code changes.

## How to use the tool

### 1. Choose a patch of sky

- Click one of the **Try** buttons for the challenge's five test targets. These load in a second or two.
- Or type into the search box and press **Show sky**. It accepts:
  - an object name, such as `M31` or `RW Aur`
  - decimal degrees, such as `269.45 4.77`
  - hours/degrees, such as `08h55m10.8s -07d14m42s` or `17:57:48 +04:41:36`
- Pick the field of view (2′–15′) in the menu next to the box. A bigger field can follow faster movers
  but takes longer to load the first time.

A field nobody has looked at before takes from 30 seconds to a few minutes, mostly because NASA's
archive search is slow; after that it is cached and opens in seconds. Name lookups can take up to a
minute, because the tool also works out how far the object has moved since 2000.

### 2. Watch the flipbook

- **Play/pause:** the play button or the space bar. It starts playing automatically once loaded.
- **Step:** the ◀ / ▶ buttons or the arrow keys.
- **Jump:** click or drag along the timeline; each tick is one frame, placed by date.
- **Speed:** the slider sets 1–12 frames per second.
- North is up and east is left. Hovering over the image shows sky coordinates and brightness.

### 3. Use the controls in the sidebar

| Control | What it does |
|---|---|
| **Frames** | *Survey visits* stacks each six-monthly pass; *Single exposures* shows every snapshot. |
| **Colour** | *False colour* or *Mono*; the D1–D6 buttons choose which detectors (wavelengths) to use. |
| **Compare** | Subtract the median of all frames, the first frame or the previous frame to reveal change. |
| **Other telescopes** | Tick *Gaia DR3* (circles) or *CatWISE2020* (diamonds) to mark known stars. |
| **Display** | Stretch, contrast, hiding flagged pixels, inverted colours, and the expected-position reticle. |
| **This frame's data** | Flag statistics and links to download every original image in the frame. |
| **Copy link to this view** | Copies a link that reopens exactly the current view. |

### 4. Measure spectra and brightness

The two charts below the image measure the target along its expected path. Click anywhere on the image to
measure that spot instead (a cyan box marks it); *Follow the target again* switches back. Hover over a
point for its date, wavelength and brightness, and use **CSV** to download the numbers.

### 5. Compare with other surveys

Open **Same field in other surveys** at the bottom of the page for an interactive map of the same position
in AllWISE, 2MASS, Pan-STARRS or DSS.

The [user guide](docs/USER_GUIDE.md) describes every control in more detail.

## The five test targets

| Target | What to look for |
|---|---|
| **Barnard's Star** | The fastest-moving star in our sky (10.4″ a year). Set *Compare* to *Subtract the median of all frames*: it leaves a bright/dark pair that moves north from visit to visit. |
| **Epsilon Indi B** | A pair of brown dwarfs. They glow red in false colour, and their spectrum shows deep methane absorption near 3.3 µm. |
| **WISE 0855** | The coldest known brown dwarf. A faint red dot moves across the field inside the reticle; its spectrum peaks near 4.5 µm. |
| **RW Aurigae** | A young variable star whose colour changes between visits. |
| **R Draconis** | A pulsating Mira variable in a continuously observed region, so it gets about monthly frames. Click just beside the star to see its brightness change. |

## Where the data comes from

All data is real and fetched from public archives when you look; nothing is simulated.

| Data | Source |
|---|---|
| SPHEREx Level 2 images (Quick Release 3 and Data Release 1) | NASA/IPAC Infrared Science Archive (IRSA) and its AWS Open Data copy |
| Gaia DR3 and CatWISE2020 star positions and motions | IRSA |
| Object names | CDS Sesame, falling back to NASA MAST and NASA NED |
| Comparison survey images | Aladin Lite (CDS, Strasbourg) |

The only hand-entered values are the five test targets' coordinates and proper motions, checked against
Gaia and CatWISE to within 2″.

## How it works

```
browser ──/api/cutouts (streamed)──► FastAPI on Vercel ──search──► IRSA: which images cover this point?
   ▲                                       │
   │ aligned cutouts + quality flags       └──byte-range reads──► SPHEREx files on AWS S3
   │ + wavelength of every exposure
   └── stacking, subtraction, colour, spectra and charts all happen in the browser
```

### Technology

| Part | Technology |
|---|---|
| Backend | Python 3.12+, FastAPI, httpx (async), NumPy, Astropy |
| Frontend | Plain HTML, CSS and JavaScript ES modules (no build step), Canvas and SVG |
| Sky viewer | Aladin Lite 3 |
| Hosting | Vercel: static files on its CDN, the API as one Python function in `iad1` (US East) |
| Data | IRSA SIA and TAP services, the public `nasa-irsa-spherex` S3 bucket |

### The interesting parts

- **Reading only what is needed.** Each SPHEREx file is about 65 MB. The server reads just the headers,
  a band of image rows and the matching quality-flag rows with HTTP range requests, decompressing
  Rice-compressed flag rows as needed. A cutout costs a few hundred kilobytes instead of 65 MB.
- **Lining every frame up.** Each exposure is resampled through its own distortion-corrected (TAN-SIP)
  coordinate system onto one shared north-up grid at SPHEREx's native 6.15″ pixels, so frames from
  different days and detectors match pixel for pixel.
- **Spectra.** The wavelength table at the end of each file is read once per detector and pipeline
  version. Each cutout carries its wavelength at the field centre plus the gradient across it, so the
  browser can work out the wavelength of any pixel.
- **Proper motion.** Catalogue positions are for the year 2000. The tool moves each target, and each
  overlaid star, along its proper motion to the date of every frame.
- **Caching and time limits.** Searches, cutouts and whole fields are cached. On Vercel, streams stop
  cleanly at 270 s, inside the 300 s function limit, and the browser resumes them. The five test targets
  ship pre-cached in `seed/` so they open instantly on a cold server.

## Run it locally

Requires Python 3.12 or newer.

```bash
git clone https://github.com/CandiedOutlaw763/spherex-sky-flipbook.git
cd spherex-sky-flipbook
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt     # macOS/Linux: .venv/bin/python
.venv/Scripts/python -m uvicorn backend.app:app --port 8000
```

Then open <http://localhost:8000/?target=barnard>. Results are cached in `.cache/`; set
`SPHEREX_CACHE_DIR` to put the cache somewhere else.

## Deploy on Vercel from GitHub

The repository deploys to Vercel with no changes.

1. Fork or push this repository to your GitHub account.
2. In Vercel, choose **Add New → Project**, then **Import** the repository.
3. Leave the settings at their defaults. `vercel.json` already sets the FastAPI framework, the `iad1`
   region (same AWS region as the SPHEREx data) and a 300 s function limit.
4. Click **Deploy**. Every push to `main` then redeploys automatically.

No environment variables or API keys are needed.

The pieces Vercel uses:

| File | Role |
|---|---|
| `app.py` | Entry point; re-exports the FastAPI app from `backend/app.py` |
| `public/` | The website, served from Vercel's CDN |
| `vercel.json` | Framework, region, function time limit, files left out of the function |
| `pyproject.toml` / `requirements.txt` | Python dependencies |
| `seed/` | Pre-cached data for the five test targets |

To refresh `seed/` after a new data release, run the local server and then:

```bash
.venv/Scripts/python scripts/build_seed.py
```

## API

| Endpoint | Returns |
|---|---|
| `GET /api/cutouts?ra=&dec=&fov=&detectors=123456` | Newline-delimited JSON: a `meta` line (the grid), one `cutout` line per exposure (base64 float32 image in MJy/sr, int32 quality flags, wavelength model), `flag_planes`, then `done` (or `partial` if the time limit was reached) |
| `GET /api/catalog?name=gaia\|catwise&ra=&dec=&radius=` | Catalogue stars with proper motions and the catalogue epoch |
| `GET /api/images?ra=&dec=` | Metadata for every SPHEREx exposure covering the point |
| `GET /api/resolve?name=` | Coordinates (year 2000 and moved to 2026) and proper motion |

## Project layout

```
app.py                     Vercel entry point
backend/app.py             FastAPI routes and the streaming cutout endpoint
backend/spherex/
  archive.py               finds data releases and the images covering a position
  remote_fits.py           byte-range reading of SPHEREx files, flags and wavelength tables
  cutout.py                resampling onto the shared grid, wavelength model
  catalogs.py              Gaia DR3 and CatWISE2020 queries
  resolve.py               name lookup and proper-motion correction
  cache.py                 disk cache plus the read-only seed/
public/                    the website (index.html, style.css, js/)
scripts/build_seed.py      rebuilds seed/ for the test targets
docs/USER_GUIDE.md         full user guide
```

## Known limitations

- **Very bright stars saturate SPHEREx.** Barnard's Star, RW Aurigae and R Draconis can't be measured at
  their cores; the page says so, and clicking just beside them measures their unsaturated glow.
- **Brightness is measured in a 3×3-pixel box** with the local sky subtracted. It is good for comparing
  points with each other, but it understates a star's total brightness.
- **First looks are slow.** NASA's archive search takes 30–60 s, and very large fields can take a few
  minutes the first time.
- **Some services are outside our control.** Name lookup and the comparison-survey images come mostly
  from CDS in Strasbourg. Names fall back to NASA MAST and NED. The survey panel tries each mirror in
  turn and, if the chosen survey is down, switches to one that works (DSS2 also has a mirror at CSIRO)
  and says so.

## Credits

SPHEREx data: NASA/JPL-Caltech and NASA/IPAC IRSA. Gaia DR3: ESA/Gaia/DPAC. CatWISE2020: the CatWISE
team, via IRSA. Name resolution: CDS Sesame (SIMBAD/NED/VizieR), NASA MAST, NASA NED. Aladin Lite: CDS,
Strasbourg. Built for the 2026 NASA Space Apps Challenge.
