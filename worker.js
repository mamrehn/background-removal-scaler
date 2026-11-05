// Decoding, mask upscaling / edge refinement and lossless PNG encoding, off the main thread.
// The arithmetic mirrors apply_mask.py operation by operation, so both produce identical pixels.

let orig = null;   // { w, h, px: Uint8ClampedArray RGBA, icc: Uint8Array|null, notes }
let cut = null;    // { w, h, alpha: Uint8Array, notes }
let params = { method: "refine", radius: 0, eps: 1e-4, bgAlpha: 0, clear: false, view: "result" };
let cache = {};    // upscaled masks by key
let mask = null;   // current full-res mask (before background opacity)
let viewBuf = null, previewCtx = null;
let exporting = false, previewPending = false;
const loadSeq = { original: 0, cutout: 0 };

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const ready = () => orig && cut;

// Every message may carry params; every message is answered (preview / idle / png / error)
// so the page can keep a single preview request in flight.
self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.params) params = { ...params, ...msg.params };
    if (msg.type === "load") {
      const seq = ++loadSeq[msg.slot];
      const img = await (msg.slot === "original" ? loadOriginal : loadCutout)(msg.file);
      if (seq !== loadSeq[msg.slot]) return;      // superseded by a newer file
      if (msg.slot === "original") orig = img; else cut = img;
      cache = {};
      let bitmap;
      if (msg.slot === "original") {                // opaque copy for the "Original" view
        const c = new OffscreenCanvas(img.w, img.h).getContext("2d");
        c.putImageData(new ImageData(img.px, img.w, img.h), 0, 0);
        bitmap = c.canvas.transferToImageBitmap();
      }
      post({ type: "loaded", slot: msg.slot, bitmap, info: { w: img.w, h: img.h, notes: img.notes, icc: !!img.icc } },
        bitmap ? [bitmap] : []);
    } else if (msg.type === "unload") {
      if (msg.slot === "original") orig = null; else cut = null;
      cache = {};
    } else if (msg.type === "flatten" && ready()) {
      exporting = true;
      try {
        const img = await flatten(msg.matte);
        post({ type: "flat", image: img }, [img.data.buffer]);
      } finally {
        exporting = false;
      }
      if (!previewPending) return;
      previewPending = false;
    } else if (msg.type === "export" && ready()) {
      exporting = true;                            // orig.px must not change while encoding
      try {
        const t0 = performance.now();
        computeAlpha();
        const blob = await encodePng(orig.px, orig.w, orig.h, orig.icc, params.clear && params.bgAlpha === 0,
          (f) => post({ type: "progress", value: f }));
        post({ type: "png", blob, ms: performance.now() - t0 });
      } finally {
        exporting = false;
      }
      if (!previewPending) return;
      previewPending = false;
    }
    if (!ready()) post({ type: "idle" });
    else if (exporting) { previewPending = true; post({ type: "idle" }); }
    else renderPreview();
  } catch (err) {
    post({ type: "error", op: msg.type, slot: msg.type === "load" ? msg.slot : undefined,
      message: String((err && err.message) || err) });
  }
};

// ---------- decoding ----------

let cscSupport; // does createImageBitmap understand {colorSpaceConversion}?
async function supportsColorSpaceConversion() {
  if (cscSupport === undefined) {
    cscSupport = false;
    const opts = { get colorSpaceConversion() { cscSupport = true; return "default"; } };
    try { (await createImageBitmap(new ImageData(1, 1), opts)).close(); } catch { }
  }
  return cscSupport;
}

async function decodeToRGBA(blob, raw) {
  const bmp = await createImageBitmap(blob, {
    imageOrientation: "from-image",                 // apply EXIF rotation like ImageOps.exif_transpose
    premultiplyAlpha: "none",
    colorSpaceConversion: raw ? "none" : "default", // "none": keep the file's pixel values untouched
  });
  const { width: w, height: h } = bmp;
  const ctx = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return { w, h, px: ctx.getImageData(0, 0, w, h).data };
}

async function loadOriginal(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const notes = [];
  let icc = jpegIccProfile(bytes);
  if (icc && ascii(icc, 16, 4) !== "RGB ") {
    notes.push({ warn: true, text: `Ignored a non-RGB color profile (${ascii(icc, 16, 4).trim()}).` });
    icc = null;
  }
  if (icc && !(await supportsColorSpaceConversion())) {
    notes.push({ warn: true, text: "This browser can't decode without color conversion, so colors were " +
      "converted to sRGB. Use Chrome, Edge or Firefox for a bit-exact result." });
    icc = null;
  }
  // Raw decode when the ICC profile is carried over; otherwise let the browser convert to sRGB
  // (a no-op for untagged JPEGs, correct for profiles we can't read, e.g. in PNG/WebP).
  const img = await decodeToRGBA(new Blob([bytes], { type: file.type }), !!icc);
  for (let j = 3; j < img.px.length; j += 4) img.px[j] = 255;   // treated as opaque RGB, like the script
  return { ...img, icc, notes, file };
}

async function loadCutout(file) {
  const { w, h, px } = await decodeToRGBA(file, true);
  const alpha = new Uint8Array(w * h);
  let transparent = 0;
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = px[i * 4 + 3];
    if (alpha[i] < 255) transparent++;
  }
  const notes = transparent ? [] :
    [{ warn: true, text: "The cutout has no transparent pixels — did you swap the two images?" }];
  return { w, h, alpha, notes };
}

// JPEG APP2 "ICC_PROFILE" segments, possibly split over several markers.
function jpegIccProfile(u8) {
  if (u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  const parts = [];
  let p = 2;
  while (p + 4 <= u8.length && u8[p] === 0xff) {
    const m = u8[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { p += 2; continue; }
    if (m === 0xda || m === 0xd9) break;            // start of scan: no more headers
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (m === 0xe2 && len > 16 && ascii(u8, p + 4, 12) === "ICC_PROFILE\0")
      parts.push({ seq: u8[p + 16], data: u8.subarray(p + 18, p + 2 + len) });
    p += 2 + len;
  }
  if (!parts.length) return null;
  parts.sort((a, b) => a.seq - b.seq);
  return concat(parts.map((x) => x.data));
}

// ---------- mask upscaling ----------

const rnd = (x) => Math.floor(x + 0.5);
const defaultRadius = (W, sw) => Math.max(2, rnd(2 * W / sw));

// pixel-centre aligned, edge-clamped; num/den = input pixels per output pixel
function coords(nOut, nIn, num, den) {
  const i0 = new Int32Array(nOut), i1 = new Int32Array(nOut), f = new Float64Array(nOut);
  for (let i = 0; i < nOut; i++) {
    const s = Math.min(Math.max((i + 0.5) * num / den - 0.5, 0), nIn - 1);
    i0[i] = Math.floor(s); i1[i] = Math.min(i0[i] + 1, nIn - 1); f[i] = s - i0[i];
  }
  return [i0, i1, f];
}

function upscaleNearest(src, sw, sh, w, h) {
  const out = new Uint8Array(w * h);
  const xs = new Int32Array(w);
  for (let x = 0; x < w; x++) xs[x] = Math.min(Math.floor((x + 0.5) * sw / w), sw - 1);
  for (let y = 0; y < h; y++) {
    const row = Math.min(Math.floor((y + 0.5) * sh / h), sh - 1) * sw, o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = src[row + xs[x]];
  }
  return out;
}

function upscaleBilinear(src, sw, sh, w, h) {   // horizontal pass, then vertical
  const out = new Uint8Array(w * h);
  const [x0, x1, fx] = coords(w, sw, sw, w);
  const [y0, y1, fy] = coords(h, sh, sh, h);
  const rows = new Float64Array(sh * w);
  for (let y = 0; y < sh; y++)
    for (let x = 0, r = y * sw, o = y * w; x < w; x++)
      rows[o + x] = src[r + x0[x]] * (1 - fx[x]) + src[r + x1[x]] * fx[x];
  for (let y = 0; y < h; y++) {
    const a = y0[y] * w, b = y1[y] * w, f = fy[y], o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = Math.floor(rows[a + x] * (1 - f) + rows[b + x] * f + 0.5);
  }
  return out;
}

// ---------- edge-aware refinement: fast colour guided filter (He et al.) ----------

const CLEAN = 0.03;   // refined alpha below 3 % -> 0, above 97 % -> 1, linear in between
const bandPx = (radius, s) => Math.max(1, rnd(radius / (2 * s)));

// Sum over a (2r+1)^2 window clipped at the borders (vertical, then horizontal).
function boxSum(src, w, h, r) {
  const c = new Float64Array((h + 1) * w);
  for (let y = 0; y < h; y++)
    for (let x = 0, o = y * w; x < w; x++) c[o + w + x] = c[o + x] + src[o + x];
  const t = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const hi = (Math.min(y + r, h - 1) + 1) * w, lo = Math.max(y - r, 0) * w, o = y * w;
    for (let x = 0; x < w; x++) t[o + x] = c[hi + x] - c[lo + x];
  }
  const out = new Float64Array(w * h), cs = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) cs[x + 1] = cs[x] + t[o + x];
    for (let x = 0; x < w; x++) out[o + x] = cs[Math.min(x + r, w - 1) + 1] - cs[Math.max(x - r, 0)];
  }
  return out;
}

function refineMask(px, bil, W, H, radius, eps) {
  const s = Math.max(1, rnd(radius / 4));         // subsampling factor
  const r = Math.max(1, rnd(radius / s));         // radius on the subsampled grid
  const hl = Math.ceil(H / s), wl = Math.ceil(W / s), n = hl * wl;

  // exact integer s*s block sums
  const sR = new Float64Array(n), sG = new Float64Array(n), sB = new Float64Array(n);
  const psum = new Float64Array(n), cnt = new Float64Array(n);
  const bx = new Int32Array(W);
  for (let x = 0; x < W; x++) bx[x] = Math.floor(x / s);
  for (let y = 0; y < H; y++) {
    const ro = Math.floor(y / s) * wl;
    for (let x = 0, i = y * W; x < W; x++, i++) {
      const bi = ro + bx[x], j = i * 4;
      sR[bi] += px[j]; sG[bi] += px[j + 1]; sB[bi] += px[j + 2]; psum[bi] += bil[i]; cnt[bi] += 1;
    }
  }
  const Ir = new Float64Array(n), Ig = new Float64Array(n), Ib = new Float64Array(n), p = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    cnt[i] = cnt[i] * 255;
    Ir[i] = sR[i] / cnt[i]; Ig[i] = sG[i] / cnt[i]; Ib[i] = sB[i] / cnt[i]; p[i] = psum[i] / cnt[i];
  }

  const counts = (len, rr) => {
    const c = new Float64Array(len);
    for (let i = 0; i < len; i++) c[i] = Math.min(i + rr, len - 1) - Math.max(i - rr, 0) + 1;
    return c;
  };
  const meanR = (x, rr) => {
    const out = boxSum(x, wl, hl, rr), cy = counts(hl, rr), cx = counts(wl, rr);
    for (let y = 0; y < hl; y++) for (let x2 = 0, o = y * wl; x2 < wl; x2++) out[o + x2] = out[o + x2] / (cy[y] * cx[x2]);
    return out;
  };
  const mean = (x) => meanR(x, r);
  const mul = (a, b) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = a[i] * b[i]; return o; };

  const mr = mean(Ir), mg = mean(Ig), mb = mean(Ib), mp = mean(p);
  const eIp_r = mean(mul(Ir, p)), eIp_g = mean(mul(Ig, p)), eIp_b = mean(mul(Ib, p));
  const err = mean(mul(Ir, Ir)), erg = mean(mul(Ir, Ig)), erb = mean(mul(Ir, Ib));
  const egg = mean(mul(Ig, Ig)), egb = mean(mul(Ig, Ib)), ebb = mean(mul(Ib, Ib));
  const ar = new Float64Array(n), ag = new Float64Array(n), ab = new Float64Array(n), b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const cr = eIp_r[i] - mr[i] * mp[i], cg = eIp_g[i] - mg[i] * mp[i], cb = eIp_b[i] - mb[i] * mp[i];
    const vrr = err[i] - mr[i] * mr[i] + eps, vrg = erg[i] - mr[i] * mg[i], vrb = erb[i] - mr[i] * mb[i];
    const vgg = egg[i] - mg[i] * mg[i] + eps, vgb = egb[i] - mg[i] * mb[i], vbb = ebb[i] - mb[i] * mb[i] + eps;
    const irr = vgg * vbb - vgb * vgb, irg = vgb * vrb - vrg * vbb, irb = vrg * vgb - vgg * vrb;
    const igg = vrr * vbb - vrb * vrb, igb = vrb * vrg - vrr * vgb, ibb = vrr * vgg - vrg * vrg;
    const det = vrr * irr + vrg * irg + vrb * irb;
    ar[i] = (irr * cr + irg * cg + irb * cb) / det;
    ag[i] = (irg * cr + igg * cg + igb * cb) / det;
    ab[i] = (irb * cr + igb * cg + ibb * cb) / det;
    b[i] = mp[i] - ar[i] * mr[i] - ag[i] * mg[i] - ab[i] * mb[i];
  }
  // Only trust the filter in a band around the original mask edge.
  const nb = bandPx(radius, s);
  const S = boxSum(psum, wl, hl, nb), C = boxSum(cnt, wl, hl, nb);   // integer-valued, hence exact
  const unknown = new Float64Array(n);
  for (let i = 0; i < n; i++) unknown[i] = S[i] > 0 && S[i] < C[i] ? 1 : 0;
  const F = [mean(ar), mean(ag), mean(ab), mean(b), meanR(unknown, nb)];

  // q = a·I + b at full resolution, coefficients bilinearly upsampled (vertical, then horizontal)
  const [x0, x1, fx] = coords(W, wl, 1, s);
  const [y0, y1, fy] = coords(H, hl, 1, s);
  const out = new Uint8Array(W * H);
  const t = F.map(() => new Float64Array(wl));
  for (let y = 0; y < H; y++) {
    const a = y0[y] * wl, c = y1[y] * wl, f = fy[y];
    for (let k = 0; k < 5; k++) {
      const Fk = F[k], tk = t[k];
      for (let x = 0; x < wl; x++) tk[x] = Fk[a + x] * (1 - f) + Fk[c + x] * f;
    }
    const [t0, t1, t2, t3, t4] = t;
    for (let x = 0, i = y * W; x < W; x++, i++) {
      const u0 = x0[x], u1 = x1[x], g = fx[x], j = i * 4;
      const A0 = t0[u0] * (1 - g) + t0[u1] * g, A1 = t1[u0] * (1 - g) + t1[u1] * g;
      const A2 = t2[u0] * (1 - g) + t2[u1] * g, A3 = t3[u0] * (1 - g) + t3[u1] * g;
      const A4 = t4[u0] * (1 - g) + t4[u1] * g;
      let q = A0 * (px[j] / 255) + A1 * (px[j + 1] / 255) + A2 * (px[j + 2] / 255) + A3;
      q = (q - CLEAN) / (1 - 2 * CLEAN);
      const m = bil[i] / 255;
      q = m + A4 * (q - m);
      const v = Math.floor(q * 255 + 0.5);
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return out;
}

function getMask() {
  const { w, h } = orig, key = (k) => `${k}|${w}x${h}|${cut.w}x${cut.h}`;
  const nearest = () => cache[key("n")] ??= upscaleNearest(cut.alpha, cut.w, cut.h, w, h);
  const bilinear = () => cache[key("b")] ??= upscaleBilinear(cut.alpha, cut.w, cut.h, w, h);
  if (params.method === "nearest") return nearest();
  if (params.method === "bilinear") return bilinear();
  const radius = params.radius || defaultRadius(w, cut.w);
  const k = key(`r${radius}e${params.eps}`);
  if (!cache[k]) {
    for (const old of Object.keys(cache)) if (old.startsWith("r")) delete cache[old]; // keep one refined mask
    post({ type: "busy", text: "Refining edges…" });
    cache[k] = refineMask(orig.px, bilinear(), w, h, radius, params.eps);
  }
  return cache[k];
}

// Writes the final alpha into orig.px; returns stats for the UI.
function computeAlpha() {
  mask = getMask();
  const lut = new Uint8Array(256);
  for (let k = 0; k < 256; k++) lut[k] = k + Math.floor((255 - k) * params.bgAlpha + 0.5);
  const px = orig.px;
  let zero = 0;
  for (let i = 0, j = 3; i < mask.length; i++, j += 4) { const a = lut[mask[i]]; px[j] = a; if (!a) zero++; }
  return { transparent: zero / mask.length };
}

// Composite onto a solid matte for formats without alpha: c' = round((c·a + m·(255 − a)) / 255).
// Lossy encoders can't embed an ICC profile, so a tagged photo is first converted to sRGB.
async function flatten(matte) {
  computeAlpha();
  const { w, h, px } = orig;
  const src = orig.icc ? (await decodeToRGBA(orig.file, false)).px : px;
  const out = new Uint8ClampedArray(w * h * 4);
  const [mr, mg, mb] = matte;
  for (let j = 0; j < out.length; j += 4) {
    const a = px[j + 3], ia = 255 - a;
    out[j] = Math.floor((src[j] * a + mr * ia) / 255 + 0.5);
    out[j + 1] = Math.floor((src[j + 1] * a + mg * ia) / 255 + 0.5);
    out[j + 2] = Math.floor((src[j + 2] * a + mb * ia) / 255 + 0.5);
    out[j + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

function renderPreview() {
  const t0 = performance.now();
  const stats = computeAlpha();
  const { w, h, px } = orig;
  let data = px;
  if (params.view !== "result") {
    if (!viewBuf || viewBuf.length !== px.length) viewBuf = new Uint8ClampedArray(px.length);
    data = viewBuf;
    if (params.view === "alpha")
      for (let j = 0; j < px.length; j += 4) { const a = px[j + 3]; data[j] = data[j + 1] = data[j + 2] = a; data[j + 3] = 255; }
    else
      for (let j = 0; j < px.length; j += 4) { data[j] = px[j]; data[j + 1] = px[j + 1]; data[j + 2] = px[j + 2]; data[j + 3] = 255; }
  }
  if (!previewCtx || previewCtx.canvas.width !== w || previewCtx.canvas.height !== h)
    previewCtx = new OffscreenCanvas(w, h).getContext("2d");
  previewCtx.putImageData(new ImageData(data, w, h), 0, 0);
  const bitmap = previewCtx.canvas.transferToImageBitmap();
  post({
    type: "preview", bitmap, ms: performance.now() - t0,
    stats: { ...stats, radius: params.radius || defaultRadius(w, cut.w), autoRadius: defaultRadius(w, cut.w) },
  }, [bitmap]);
}

// ---------- PNG encoder (RGBA8, adaptive per-row filters, zlib via CompressionStream) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type, data) {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  let c = 0xffffffff;
  for (let i = 4; i < 8; i++) c = CRC_TABLE[(c ^ head[i]) & 255] ^ (c >>> 8);
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  const tail = new Uint8Array(4);
  new DataView(tail.buffer).setUint32(0, (c ^ 0xffffffff) >>> 0);
  return [head, data, tail];
}

async function zlib(stream) {
  const reader = stream.pipeThrough(new CompressionStream("deflate")).getReader(); // "deflate" = zlib format
  const out = [];
  for (let r; !(r = await reader.read()).done;) out.push(r.value);
  return out;
}

async function encodePng(px, w, h, icc, clear, onProgress) {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bit, RGBA, deflate, adaptive filtering, no interlace
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunk("IHDR", ihdr)];
  if (icc) {
    const z = concat(await zlib(new Blob([icc]).stream()));
    parts.push(...chunk("iCCP", concat([new TextEncoder().encode("ICC Profile\0\0"), z])));
  }

  const data = new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
  const stride = w * 4;
  const f = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  const rowBufs = [new Uint8Array(stride), new Uint8Array(stride)];  // for clearing hidden pixels
  let prev = new Uint8Array(stride);
  const rowsPerPull = Math.max(1, Math.floor((1 << 20) / (stride + 1)));
  let y = 0;
  const rows = new ReadableStream({
    pull(ctrl) {
      if (y >= h) { ctrl.close(); return; }
      const n = Math.min(rowsPerPull, h - y);
      const out = new Uint8Array(n * (stride + 1));
      for (let r = 0; r < n; r++, y++) {
        let cur = data.subarray(y * stride, (y + 1) * stride);
        if (clear) {                                 // RGB := 0 where alpha == 0
          const buf = rowBufs[y & 1];
          buf.set(cur);
          for (let i = 3; i < stride; i += 4) if (buf[i] === 0) buf[i - 3] = buf[i - 2] = buf[i - 1] = 0;
          cur = buf;
        }
        const best = filterRow(cur, prev, f, stride);
        out[r * (stride + 1)] = best;
        out.set(f[best], r * (stride + 1) + 1);
        prev = cur;
      }
      ctrl.enqueue(out);
      onProgress(y / h);
    },
  });
  for (const z of await zlib(rows)) parts.push(...chunk("IDAT", z));
  parts.push(...chunk("IEND", new Uint8Array(0)));
  return new Blob(parts, { type: "image/png" });
}

// Writes all five PNG filters of one row into f[0..4]; returns the one with the
// smallest sum of absolute signed bytes (the usual libpng/Pillow heuristic).
function filterRow(cur, prev, f, stride) {
  const [f0, f1, f2, f3, f4] = f;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  for (let i = 0; i < stride; i++) {
    const x = cur[i], b = prev[i];
    const a = i >= 4 ? cur[i - 4] : 0;
    const c = i >= 4 ? prev[i - 4] : 0;
    const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - c - c);
    const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    const v0 = x, v1 = (x - a) & 255, v2 = (x - b) & 255, v3 = (x - ((a + b) >> 1)) & 255, v4 = (x - pr) & 255;
    f0[i] = v0; f1[i] = v1; f2[i] = v2; f3[i] = v3; f4[i] = v4;
    s0 += v0 < 128 ? v0 : 256 - v0;
    s1 += v1 < 128 ? v1 : 256 - v1;
    s2 += v2 < 128 ? v2 : 256 - v2;
    s3 += v3 < 128 ? v3 : 256 - v3;
    s4 += v4 < 128 ? v4 : 256 - v4;
  }
  let best = 0, min = s0;
  if (s1 < min) { min = s1; best = 1; }
  if (s2 < min) { min = s2; best = 2; }
  if (s3 < min) { min = s3; best = 3; }
  if (s4 < min) { best = 4; }
  return best;
}

// ---------- utils ----------

function concat(arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function ascii(u8, off, n) {
  return String.fromCharCode(...u8.subarray(off, off + n));
}
