# SPHEREx Sky Flipbook: user guide

Live at **<https://spherex-sky-flipbook.vercel.app>**

The tool plays every NASA SPHEREx infrared image of a patch of sky as a little video, so anything that
moves or changes brightness stands out. It can also measure a spectrum and a brightness history for any
spot.

## 1. Pick a patch of sky

**The quickest start** is the **Try** buttons for the challenge's five test targets: Barnard's Star,
Epsilon Indi B, WISE 0855, RW Aurigae and R Draconis. They load in a second or two.

**The search box** accepts:

- an object name, such as `M31` or `RW Aur`
- decimal degrees, such as `269.45 4.77`
- hours/degrees, such as `08h55m10.8s -07d14m42s` or `17:57:48 +04:41:36`

**The field-of-view menu** (2′–15′) next to it sets how much sky you see. A bigger field lets you
follow faster-moving objects, but the first load takes longer.

Things to know about loading:

- **A new field takes 30 s to a few minutes the first time**, mostly because NASA's archive search is
  slow. After that it's cached and loads in seconds. The progress bar and status line show how far it
  has got.
- **Name lookups can take up to a minute.** The tool also works out how far the object has moved since
  2000 and centres the view on where it is now. Barnard's Star, for example, has moved 4.5′.

## 2. Watch it change: the flipbook

It starts playing automatically once loaded.

- **Play/pause:** the button or the space bar.
- **Step:** ◀ and ▶ or the arrow keys.
- **Jump:** click or drag on the timeline, where each tick is a frame placed by its date.
- **Speed:** the slider, 1–12 frames per second.
- **Reading the image:**
  - North is up and east is left, and the scale bar shows arcminutes.
  - Hovering shows the sky coordinates and pixel brightness.
  - The line under the image says which frame you're on, its dates, how many images it combines and
    which detectors it uses.
- **The amber cross-hair** marks where the target should be on that frame's date, based on its known
  motion. A star moving as expected stays inside it. "Show expected position" turns it off.

## 3. Sidebar controls

### Frames

- **Survey visits** (default): stacks all images from one pass of the survey, about every 6 months.
  That gives cleaner images and shows slow movers like nearby stars and brown dwarfs. In fields covered
  continuously, such as R Draconis, frames are about a month each instead.
- **Single exposures:** one frame per individual snapshot. Use it for fast movers like asteroids and
  comets.

### Colour

- **False colour** (default): short wavelengths show as blue and long as red. Cool brown dwarfs glow
  red, while ordinary stars look white or blue.
- **Mono:** greyscale.
- **D1–D6:** the six detectors, each covering one wavelength range from 0.75 to 5 µm. Untick some to
  use only those wavelengths.

### Compare: the main tool for spotting movers

- **Subtract the median of all frames:** anything that stays put disappears. What's left moved or
  changed brightness.
- **Subtract the first frame**, or **Subtract the previous frame**, which shows step-by-step change.
- In these views a moving star shows up as a bright/dark pair that flips from frame to frame. Barnard's
  Star is a good example.

### Other telescopes

- **Gaia DR3** (circles) and **CatWISE2020** (diamonds) mark known stars from those catalogues. Each is
  moved to the frame's date using its measured motion. Very crowded fields show only the brightest 200.
- Hovering on a marker shows its brightness and how fast it moves.
- A SPHEREx source with no marker, or one that doesn't line up with its marker, is worth a closer look.

### Display

- **Stretch** (asinh, linear or log) and **Contrast** change how faint detail is shown.
- **Hide flagged pixels** (on by default) hides pixels the data marks as unreliable.
- **Invert** gives dark stars on a white background.

### This frame's data

Expand it to see:

- what share of pixels carries each quality flag
- a list of every image in the frame, with a link to download the original file from NASA's archive

### Copy link to this view

Copies a URL that reopens exactly what you see: target, field size and settings. Adding `&embed=1` to
a link gives just the viewer, for embedding in other websites.

## 4. Measurements under the image

By default these follow the target along its expected path. **Click anywhere on the image** to measure
that spot instead; a cyan box marks it, and "Follow the target again" switches back.

### Spectrum

- Brightness against wavelength from 0.75 to 5 µm, with one dot per image, coloured from earliest to
  latest.
- The white line is the typical (median) spectrum.
- Dashed lines mark water, methane, CO and CO₂ features.
- Dots ringed in white belong to the frame currently showing.
- Try Epsilon Indi B: deep methane dips are the signature of a brown dwarf.

### Brightness over time

- Brightness compared with the object's own typical spectrum, in three wavelength groups (blue, green
  and orange).
- A value of 1.0 means normal for it, so variable stars rise and fall around that line.

### For both charts

- Hovering a point shows its date, wavelength and brightness.
- **CSV** downloads the measurements.
- If the charts are empty or incomplete, the page explains why. A very bright star can saturate the
  detector; clicking just beside it measures its outer glow instead.

## 5. Same field in other surveys

The panel at the bottom opens an interactive sky map of the same position in AllWISE, 2MASS,
Pan-STARRS or DSS, for comparison. You can drag and zoom it. It uses Aladin Lite, whose images come
from servers in Strasbourg (CDS); if those are unreachable the map stays grey.

## Suggested demo path

1. **Barnard's Star:** set Compare to *Subtract the median of all frames* and press play. Its motion
   shows as a bright/dark pair flipping across visits.
2. **Epsilon Indi B:** show the red dot in false colour, turn on Gaia, then scroll to its brown-dwarf
   spectrum.
3. **WISE 0855:** watch the reticle carry the faint red dot across the field. Its spectrum peaks near
   4.5 µm.
4. **R Draconis:** play its monthly frames to show it changing, then click just beside the star to see
   its brightness curve.

## Where the data comes from, and its limits

**All data is real.** Every image, spectrum point, brightness point and catalogue marker comes from
NASA/ESA archives, fetched live or from cached copies of those fetches:

- SPHEREx quick-release images: NASA/IPAC IRSA and its AWS Open Data mirror
- Gaia DR3 and CatWISE2020: via IRSA
- Name lookup: CDS Sesame, NASA MAST and NASA NED

**Hand-entered values** are the five presets' coordinates and proper motions, checked against Gaia and
CatWISE to within 2″. Everything else hand-entered is a label or display choice: the molecule
wavelengths on the spectrum, the rounded D1–D6 wavelength ranges, which quality flags count as "bad",
and the colour stretches.

**How measurements are made:**

- Brightness is measured in a 3×3-pixel box with the local sky level subtracted. The mJy values are
  fine for comparing points with each other, but they understate a star's true total brightness.
- Images are resampled onto a common north-up grid, so each pixel's value is slightly blended with its
  neighbours.

**Known limits:**

- Very bright stars (Barnard's Star, RW Aurigae, R Draconis) saturate the detector and can't be measured
  at their core.
- Name lookups for objects outside the presets can take 20–45 s.
- Epsilon Indi B reads about 7% fainter in its last visit. This hasn't been explained, so don't
  treat it as a discovery.
- WISE 0855 shows short-wavelength light that is probably a neighbouring star blended into the measuring
  box.
