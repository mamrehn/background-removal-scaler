#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy", "pillow"]
# ///
"""Transfer the alpha mask of a low-res cutout onto the full-resolution original.

    apply_mask.py LARGE SMALL [BG_ALPHA] [-o OUT.png] [--resample nearest|bilinear|refine]
                  [--radius PX] [--eps EPS] [--clear-transparent]

LARGE     full-resolution original (e.g. JPEG)
SMALL     low-res cutout of the same framing with a transparent background (PNG)
BG_ALPHA  opacity of the background, 0..1 (default 0 = fully transparent)

Per pixel:  alpha_out = m + round((255 - m) * BG_ALPHA),  m = upscaled cutout alpha.

--resample refine (default) snaps the upscaled mask to the edges of the full-res
photo with a colour guided filter (He et al.), computed on a subsampled grid.

RGB values of LARGE are copied unchanged (also under transparent pixels) and its
ICC profile is embedded, so the conversion is lossless. --clear-transparent sets
RGB to 0 where alpha is 0 (only possible at BG_ALPHA 0) for a smaller file.

All arithmetic mirrors worker.js, so the web app produces identical pixels.
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps


# ---------- resampling ----------

def _coords(n_out: int, n_in: int, num: float, den: float):
    # pixel-centre aligned, edge-clamped; num/den = input pixels per output pixel
    s = np.clip((np.arange(n_out) + 0.5) * num / den - 0.5, 0, n_in - 1)
    i0 = np.floor(s).astype(np.intp)
    return i0, np.minimum(i0 + 1, n_in - 1), s - i0


def upscale_mask(mask: np.ndarray, w: int, h: int, method: str) -> np.ndarray:
    sh, sw = mask.shape
    if method == "nearest":
        xs = np.minimum(((np.arange(w) + 0.5) * sw / w).astype(np.intp), sw - 1)
        ys = np.minimum(((np.arange(h) + 0.5) * sh / h).astype(np.intp), sh - 1)
        return mask[ys[:, None], xs[None, :]]

    x0, x1, fx = _coords(w, sw, sw, w)
    y0, y1, fy = _coords(h, sh, sh, h)
    m = mask.astype(np.float64)
    rows = m[:, x0] * (1 - fx) + m[:, x1] * fx          # (sh, w): horizontal pass
    out = np.empty((h, w), np.uint8)
    for a in range(0, h, 512):                          # vertical pass in blocks
        b = min(a + 512, h)
        f = fy[a:b, None]
        v = rows[y0[a:b]] * (1 - f) + rows[y1[a:b]] * f
        out[a:b] = np.floor(v + 0.5)
    return out


# ---------- edge-aware refinement (fast colour guided filter) ----------

def default_radius(W: int, sw: int) -> int:
    return max(2, round(2 * W / sw))


def band_px(radius: int, s: int) -> int:
    # half-width of the refinement band on the subsampled grid (~ radius / 2 full-res px)
    return max(1, round(radius / (2 * s)))


def _box_sum(x: np.ndarray, r: int) -> np.ndarray:
    """Sum over a (2r+1)^2 window clipped at the borders (vertical, then horizontal)."""
    h, w = x.shape
    c = np.zeros((h + 1, w))
    np.cumsum(x, axis=0, out=c[1:])
    i = np.arange(h)
    t = c[np.minimum(i + r, h - 1) + 1] - c[np.maximum(i - r, 0)]
    c = np.zeros((h, w + 1))
    np.cumsum(t, axis=1, out=c[:, 1:])
    i = np.arange(w)
    return c[:, np.minimum(i + r, w - 1) + 1] - c[:, np.maximum(i - r, 0)]


def refine_mask(rgb: np.ndarray, mask: np.ndarray, radius: int, eps: float) -> np.ndarray:
    """rgb: HxWx3 uint8 guide, mask: HxW uint8 (bilinear-upscaled cutout alpha)."""
    H, W = mask.shape
    s = max(1, round(radius / 4))                       # subsampling factor
    r = max(1, round(radius / s))                       # radius on the subsampled grid
    hl, wl = -(-H // s), -(-W // s)

    def block_sum(ch):                                  # exact integer s*s block sums
        pad = np.zeros((hl * s, wl * s), np.int64)
        pad[:H, :W] = ch
        return pad.reshape(hl, s, wl, s).sum(axis=(1, 3)).astype(np.float64)

    cnt = block_sum(np.ones((H, W), np.uint8)) * 255
    Ir, Ig, Ib = (block_sum(rgb[..., c]) / cnt for c in range(3))
    psum = block_sum(mask)
    p = psum / cnt

    def mean_r(x, rr):
        cy = np.minimum(np.arange(hl) + rr, hl - 1) - np.maximum(np.arange(hl) - rr, 0) + 1
        cx = np.minimum(np.arange(wl) + rr, wl - 1) - np.maximum(np.arange(wl) - rr, 0) + 1
        return _box_sum(x, rr) / (cy[:, None] * cx[None, :]).astype(np.float64)

    def mean(x):
        return mean_r(x, r)

    mr, mg, mb, mp = mean(Ir), mean(Ig), mean(Ib), mean(p)
    cr = mean(Ir * p) - mr * mp
    cg = mean(Ig * p) - mg * mp
    cb = mean(Ib * p) - mb * mp
    vrr = mean(Ir * Ir) - mr * mr + eps
    vrg = mean(Ir * Ig) - mr * mg
    vrb = mean(Ir * Ib) - mr * mb
    vgg = mean(Ig * Ig) - mg * mg + eps
    vgb = mean(Ig * Ib) - mg * mb
    vbb = mean(Ib * Ib) - mb * mb + eps
    irr = vgg * vbb - vgb * vgb
    irg = vgb * vrb - vrg * vbb
    irb = vrg * vgb - vgg * vrb
    igg = vrr * vbb - vrb * vrb
    igb = vrb * vrg - vrr * vgb
    ibb = vrr * vgg - vrg * vrg
    det = vrr * irr + vrg * irg + vrb * irb
    ar = (irr * cr + irg * cg + irb * cb) / det
    ag = (irg * cr + igg * cg + igb * cb) / det
    ab = (irb * cr + igb * cg + ibb * cb) / det
    b = mp - ar * mr - ag * mg - ab * mb
    # Only trust the filter in a band around the original mask edge: far from it the
    # windows still reach the edge and would copy background texture into the alpha.
    nb = band_px(radius, s)
    S, C = _box_sum(psum, nb), _box_sum(cnt, nb)        # integer-valued, hence exact
    unknown = (S > 0) & (S < C)
    fields = [mean(ar), mean(ag), mean(ab), mean(b), mean_r(unknown.astype(np.float64), nb)]

    # q = a·I + b at full resolution, coefficients bilinearly upsampled (vertical, then horizontal)
    x0, x1, fx = _coords(W, wl, 1, s)
    y0, y1, fy = _coords(H, hl, 1, s)
    out = np.empty((H, W), np.uint8)
    for a in range(0, H, 256):
        e = min(a + 256, H)
        f = fy[a:e, None]
        A = []
        for F in fields:
            t = F[y0[a:e]] * (1 - f) + F[y1[a:e]] * f
            A.append(t[:, x0] * (1 - fx) + t[:, x1] * fx)
        px = rgb[a:e]
        q = A[0] * (px[..., 0] / 255) + A[1] * (px[..., 1] / 255) + A[2] * (px[..., 2] / 255) + A[3]
        m = mask[a:e] / 255
        q = m + A[4] * (q - m)                          # blend: filter inside the band, mask outside
        out[a:e] = np.clip(np.floor(q * 255 + 0.5), 0, 255)
    return out


# ---------- main ----------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("large", type=Path)
    ap.add_argument("small", type=Path)
    ap.add_argument("bg_alpha", type=float, nargs="?", default=0.0)
    ap.add_argument("-o", "--output", type=Path)
    ap.add_argument("--resample", choices=("nearest", "bilinear", "refine"), default="refine",
                    help="mask upscaling method (default: refine)")
    ap.add_argument("--radius", type=int, help="refine: edge search radius in full-res pixels "
                    "(default: 2 x upscale factor)")
    ap.add_argument("--eps", type=float, default=1e-3,
                    help="refine: regularisation; smaller = follows image edges more closely (default 1e-3)")
    ap.add_argument("--clear-transparent", action="store_true",
                    help="set RGB to 0 where alpha is 0 (smaller file, no longer lossless there)")
    args = ap.parse_args()
    if not 0.0 <= args.bg_alpha <= 1.0:
        ap.error("BG_ALPHA must be between 0 and 1")
    out_path = args.output or args.large.with_name(args.large.stem + "_masked.png")

    large = Image.open(args.large)
    icc = large.info.get("icc_profile")
    large = ImageOps.exif_transpose(large)              # bake EXIF rotation into pixels
    if large.mode != "RGB":
        large = large.convert("RGB")
    if icc and icc[16:20] != b"RGB ":                   # e.g. CMYK/gray profile: not valid for RGB
        print(f"note: dropping non-RGB ICC profile ({icc[16:20]!r})", file=sys.stderr)
        icc = None

    small = ImageOps.exif_transpose(Image.open(args.small))
    if "A" not in small.mode and "transparency" not in small.info:
        sys.exit(f"error: {args.small} has no alpha channel")
    mask = np.asarray(small.convert("RGBA").getchannel("A"))

    W, H = large.size
    sw, sh = small.size
    if abs((W / H) / (sw / sh) - 1) > 0.01:
        print(f"warning: aspect ratios differ ({W}x{H} vs {sw}x{sh}); mask will be stretched"
              + (" - looks like a 90° rotation mismatch" if abs((W / H) / (sh / sw) - 1) < 0.01 else ""),
              file=sys.stderr)

    rgba = np.empty((H, W, 4), np.uint8)
    rgba[..., :3] = np.asarray(large)
    if args.resample == "refine":
        radius = args.radius or default_radius(W, sw)
        m = refine_mask(rgba[..., :3], upscale_mask(mask, W, H, "bilinear"), radius, args.eps)
        method = f"refine r={radius} eps={args.eps:g}"
    else:
        m = upscale_mask(mask, W, H, args.resample)
        method = args.resample
    k = np.arange(256)
    lut = (k + np.floor((255 - k) * args.bg_alpha + 0.5)).astype(np.uint8)
    rgba[..., 3] = lut[m]
    if args.clear_transparent:
        rgba[rgba[..., 3] == 0] = 0

    Image.fromarray(rgba).save(out_path, "PNG", **({"icc_profile": icc} if icc else {}))
    print(f"{W}x{H} <- mask {sw}x{sh} (x{W / sw:.2f}, {method}), bg alpha {args.bg_alpha:g}"
          f"{', cleared' if args.clear_transparent else ''}{', ICC kept' if icc else ''} -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
