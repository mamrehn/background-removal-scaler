# Background Removal Scaler

Background-removal services often return only a small preview cutout. This tool takes that
low-resolution cutout's transparency and applies it to your **full-resolution original**, saving a
lossless PNG. It comes as a web app (runs entirely in the browser, nothing is uploaded) and as a
Python script; both produce bit-identical pixels.

## Web app

Open the GitHub Pages site, drop the original photo and the cutout (in either order, or both at
once), adjust, then **Download PNG**. Hold <kbd>Space</kbd> to compare with the original, press
<kbd>?</kbd> for all shortcuts.

Run it locally with any static server (module workers don't run from `file://`):

```sh
python3 -m http.server   # then open http://localhost:8000
```

## Command line

```sh
uv run apply_mask.py photo.jpg cutout.png [BG_ALPHA] [-o out.png|.jpg|.webp|.avif]
    [--resample nearest|bilinear|refine] [--radius PX] [--eps EPS]
    [--clear-transparent] [--optimize off|0-6|max] [--zopfli]
    [--flatten COLOR] [--quality Q]
```

`uv` installs the dependencies (numpy, Pillow, pyoxipng) from the script header.
The web app's *Details → Same result with apply_mask.py* shows the matching command.

## How it works

- **Edges.** `nearest` and `bilinear` simply scale the cutout's alpha. `refine` (default) runs a
  colour guided filter (He et al.) guided by the full-resolution photo, so the edge snaps to the
  photo's real edges. It runs on a subsampled grid ("fast guided filter") and only inside a band
  around the original mask edge, so the background can't leak into the alpha.
- **Background opacity.** `alpha = m + (255 − m) · BG_ALPHA`; 0 gives a clean cutout.
- **Lossless.** The photo's RGB values are kept exactly, including behind transparent pixels; the ICC
  profile and EXIF rotation are honoured. *Clear hidden pixels* (`--clear-transparent`) zeroes the
  colours behind fully transparent pixels, which often makes the file 3× smaller. This only
  applies at 0 % background opacity.
- **Compression.** OxiPNG `max` (default) is lossless and typically 10–15 % smaller than a standard
  PNG. In the browser it runs as WebAssembly. `--zopfli` in the script gains ~0.2 % more at ~30×
  the time.
- **Without transparency.** JPEG (MozJPEG), WebP (libwebp) and AVIF (libaom) place the cutout on a
  matte color. In the browser these are Squoosh's encoders; the script uses Pillow's and keeps the
  ICC profile, while the browser converts colour-managed photos to sRGB first.
- **Threads.** `coi-sw.js` is a tiny service worker that adds the COOP/COEP headers GitHub Pages
  can't send. That enables multi-threaded OxiPNG and AVIF; without it they run single-threaded.

## Deployment

`.github/workflows/pages.yml` deploys the web app with GitHub Actions on every push to `main`.
Once, set *Settings → Pages → Source* to **GitHub Actions**.

## Third-party code

`vendor/` holds WebAssembly builds of OxiPNG, MozJPEG, libwebp and libavif from
[jSquash](https://github.com/jamsinclair/jSquash) (Apache-2.0); see `vendor/README.md` for
versions and the codecs' own licences.
