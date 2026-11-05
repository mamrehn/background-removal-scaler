// Decoding, mask upscaling and lossless PNG encoding, off the main thread.
// Same arithmetic as apply_mask.py, so both produce identical pixels.

let orig = null;   // { w, h, px: Uint8ClampedArray RGBA, icc: Uint8Array|null, name }
let cut = null;    // { w, h, alpha: Uint8Array }
let params = { bgAlpha: 0, method: "nearest" };
let maskCache = null; // { key, data: Uint8Array w*h }
let previewCtx = null;
let exporting = false, previewPending = false;
const loadSeq = { original: 0, cutout: 0 };

const post = (msg, transfer) => self.postMessage(msg, transfer || []);
const ready = () => orig && cut;

// Every message may carry the current params; every message is answered
// (preview / loaded / png / idle / error) so the page can keep one request in flight.
self.onmessage = async ({ data: msg }) => {
  try {
    if (msg.params) params = { ...params, ...msg.params };
    if (msg.type === "original" || msg.type === "cutout") {
      const seq = ++loadSeq[msg.type];
      const img = await (msg.type === "original" ? loadOriginal : loadCutout)(msg.file);
      if (seq !== loadSeq[msg.type]) return;       // a newer file was picked meanwhile
      if (msg.type === "original") orig = img; else cut = img;
      maskCache = null;
      post({ type: "loaded", which: msg.type, info: { w: img.w, h: img.h, notes: img.notes } });
    } else if (msg.type === "export" && ready()) {
      exporting = true;                             // orig.px must not change while encoding
      try {
        const t0 = performance.now();
        applyAlpha();
        const blob = await encodePng(orig.px, orig.w, orig.h, orig.icc,
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
    post({ type: "error", message: String((err && err.message) || err) });
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
    notes.push(`Ignoring non-RGB ICC profile (${ascii(icc, 16, 4).trim()}).`);
    icc = null;
  }
  if (icc && !(await supportsColorSpaceConversion())) {
    notes.push("This browser cannot decode without color conversion: pixels were converted to sRGB " +
      "and the original ICC profile is not embedded. Use Chrome/Edge/Firefox for a bit-exact result.");
    icc = null;
  }
  // Raw decode when we carry the ICC profile over; otherwise let the browser convert to sRGB
  // (a no-op for untagged JPEGs, correct for profiles we could not read, e.g. in PNG/WebP).
  const img = await decodeToRGBA(new Blob([bytes], { type: file.type }), !!icc);
  if (icc) notes.push(`ICC profile embedded (${icc.length.toLocaleString()} bytes).`);
  return { ...img, icc, notes };
}

async function loadCutout(file) {
  const { w, h, px } = await decodeToRGBA(file, true);
  const alpha = new Uint8Array(w * h);
  let transparent = 0;
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = px[i * 4 + 3];
    if (alpha[i] < 255) transparent++;
  }
  const notes = transparent ? [] : ["This image has no transparent pixels — is it really the cutout?"];
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

// ---------- mask ----------

function upscaleMask(src, sw, sh, w, h, method) {
  const out = new Uint8Array(w * h);
  if (method === "nearest") {
    const xs = new Int32Array(w);
    for (let x = 0; x < w; x++) xs[x] = Math.min(Math.floor((x + 0.5) * sw / w), sw - 1);
    for (let y = 0; y < h; y++) {
      const row = Math.min(Math.floor((y + 0.5) * sh / h), sh - 1) * sw;
      const o = y * w;
      for (let x = 0; x < w; x++) out[o + x] = src[row + xs[x]];
    }
    return out;
  }
  // bilinear: pixel-centre aligned, edge-clamped, horizontal pass then vertical
  const coords = (nOut, nIn) => {
    const i0 = new Int32Array(nOut), i1 = new Int32Array(nOut), f = new Float64Array(nOut);
    for (let i = 0; i < nOut; i++) {
      const s = Math.min(Math.max((i + 0.5) * nIn / nOut - 0.5, 0), nIn - 1);
      i0[i] = Math.floor(s); i1[i] = Math.min(i0[i] + 1, nIn - 1); f[i] = s - i0[i];
    }
    return [i0, i1, f];
  };
  const [x0, x1, fx] = coords(w, sw);
  const [y0, y1, fy] = coords(h, sh);
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

function applyAlpha() {
  const key = `${params.method}|${orig.w}x${orig.h}|${cut.w}x${cut.h}`;
  if (!maskCache || maskCache.key !== key)
    maskCache = { key, data: upscaleMask(cut.alpha, cut.w, cut.h, orig.w, orig.h, params.method) };
  const lut = new Uint8Array(256);
  for (let k = 0; k < 256; k++) lut[k] = k + Math.floor((255 - k) * params.bgAlpha + 0.5);
  const m = maskCache.data, px = orig.px;
  for (let i = 0, j = 3; i < m.length; i++, j += 4) px[j] = lut[m[i]];
}

function renderPreview() {
  applyAlpha();
  const { w, h } = orig;
  if (!previewCtx || previewCtx.canvas.width !== w || previewCtx.canvas.height !== h)
    previewCtx = new OffscreenCanvas(w, h).getContext("2d");
  previewCtx.putImageData(new ImageData(orig.px, w, h), 0, 0);
  const bitmap = previewCtx.canvas.transferToImageBitmap();
  const warn = Math.abs((orig.w / orig.h) / (cut.w / cut.h) - 1) > 0.01;
  post({ type: "preview", bitmap, scale: orig.w / cut.w, aspectMismatch: warn }, [bitmap]);
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
  const dv = new DataView(head.buffer);
  dv.setUint32(0, data.length);
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

async function encodePng(px, w, h, icc, onProgress) {
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
  const zero = new Uint8Array(stride);
  const f = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  const rowsPerPull = Math.max(1, Math.floor((1 << 20) / (stride + 1)));
  let y = 0;
  const rows = new ReadableStream({
    pull(ctrl) {
      if (y >= h) { ctrl.close(); return; }
      const n = Math.min(rowsPerPull, h - y);
      const out = new Uint8Array(n * (stride + 1));
      for (let r = 0; r < n; r++, y++) {
        const cur = data.subarray(y * stride, (y + 1) * stride);
        const prev = y ? data.subarray((y - 1) * stride, y * stride) : zero;
        const best = filterRow(cur, prev, f, stride);
        out[r * (stride + 1)] = best;
        out.set(f[best], r * (stride + 1) + 1);
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
