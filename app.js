const $ = (id) => document.getElementById(id);
const app = $("app");
const worker = new Worker(new URL("./worker.js", import.meta.url));

const EPS = [1e-2, 5e-3, 2e-3, 1e-3, 5e-4, 2e-4, 1e-4, 5e-5, 2e-5, 1e-5];
const METHOD_HINT = {
  nearest: "Blocky: every cutout pixel becomes a square.",
  bilinear: "Smooth, but the edge stays as soft as the cutout.",
  refine: "Snaps the edge to the detail of the full-resolution photo.",
};
const ZOOMS = [0.05, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

// ---------- settings (persisted) ----------
const KEY = "brs-settings-v1";
const ui = {
  method: "refine", radiusAuto: true, radius: 8, detail: 6, opacity: 0, clear: false,
  optimize: "6", bg: "checker", custom: "#3fa34d",
  format: "png", matte: "#ffffff", matteCustom: "#3fa34d", q: { jpeg: 90, webp: 90, avif: 70 },
  ...(() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })(),
};
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(ui)); } catch { } };

// ---------- state ----------
const files = { original: null, cutout: null };
const info = { original: null, cutout: null };
const loading = { original: false, cutout: false };
let stats = null, previewMs = 0;
let resultBmp = null, originalBmp = null, cutoutBmp = null, imgW = 0, imgH = 0;
let previewBusy = false, previewDirty = false, refining = false;
let exporting = false, filenameEdited = false, view = "result", peek = false;
let errorNote = null;
const ready = () => !!(info.original && info.cutout);

const params = () => ({
  method: ui.method,
  radius: ui.method === "refine" && !ui.radiusAuto ? ui.radius : 0,
  eps: EPS[ui.detail],
  bgAlpha: ui.opacity / 100,
  clear: ui.clear,
  view: view === "alpha" ? "alpha" : "result",
});

function requestPreview() {
  if (!ready()) return;
  if (previewBusy) { previewDirty = true; return; }
  previewBusy = true;
  worker.postMessage({ type: "params", params: params() });
}

// ---------- files ----------
async function sniffAlpha(file) {        // true / false / null (unknown)
  const b = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (b[0] === 0x89 && str(1, 3) === "PNG") {
    if (b[25] === 4 || b[25] === 6) return true;
    for (let p = 8; p + 8 <= b.length;) {
      const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0, type = str(p + 4, 4);
      if (type === "tRNS") return true;
      if (type === "IDAT") return false;
      p += 12 + len;
    }
    return false;
  }
  if (str(0, 4) === "RIFF" && str(8, 4) === "WEBP") {
    const fmt = str(12, 4);
    return fmt === "VP8X" ? !!(b[20] & 0x10) : fmt === "VP8L" ? !!((b[24] >> 4) & 1) : false;
  }
  if (b[0] === 0xff && b[1] === 0xd8) return false;
  return null;
}

async function addFiles(list, slot) {
  const imgs = [...list].filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(f.name));
  if (!imgs.length) { errorNote = "That doesn't look like an image."; return update(); }
  if (slot && imgs.length === 1) return load(slot, imgs[0]);
  const s = await Promise.all(imgs.slice(0, 2).map(async (f) => ({ f, alpha: await sniffAlpha(f) })));
  if (s.length === 2) {
    const cut = s[0].alpha === true && s[1].alpha !== true ? 0
      : s[1].alpha === true && s[0].alpha !== true ? 1
      : s[0].f.size <= s[1].f.size ? 0 : 1;
    load("original", s[1 - cut].f);
    load("cutout", s[cut].f);
  } else {
    const { f, alpha } = s[0];
    load(alpha === true ? "cutout" : alpha === false ? "original" : files.original ? "cutout" : "original", f);
  }
}

function load(slot, file) {
  files[slot] = file;
  info[slot] = null;
  loading[slot] = true;
  errorNote = null;
  if (slot === "original") {
    originalBmp?.close(); originalBmp = null;
    if (!filenameEdited) $("filename").value = defaultName();
  } else {
    cutoutBmp?.close(); cutoutBmp = null;
    createImageBitmap(file).then((b) => {        // shown on its own until the original arrives
      if (files.cutout === file) { cutoutBmp = b; syncView(); } else b.close();
    }, () => { });
  }
  resultBmp?.close(); resultBmp = null;
  syncView();
  const img = document.querySelector(`.slot[data-slot="${slot}"] img`);
  if (img.src) URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  worker.postMessage({ type: "load", slot, file, params: params() });
  update();
}

const ext = () => FORMATS[ui.format].ext;
const defaultName = () => `${files.original?.name.replace(/\.[^.]+$/, "") || "image"}_masked.${ext()}`;
function filename() {
  let n = $("filename").value.trim() || defaultName();
  n = n.replace(/\.(png|jpe?g|webp|avif)$/i, "") + "." + ext();
  return n.replace(/[\\/:*?"<>|]/g, "_");
}

const picker = $("file-input");
let pickerSlot = null;
function openPicker(slot = null) { pickerSlot = slot; picker.value = ""; picker.click(); }
picker.addEventListener("change", () => picker.files.length && addFiles(picker.files, pickerSlot));
for (const el of document.querySelectorAll("[data-pick]")) el.addEventListener("click", () => openPicker(el.dataset.pick));
$("banner-btn").addEventListener("click", (e) => openPicker(e.currentTarget.dataset.pick));
if (!navigator.clipboard?.read) $("paste-wrap").hidden = true;
$("paste-btn").addEventListener("click", async () => {
  try {
    const found = [];
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith("image/"));
      if (type) found.push(new File([await item.getType(type)], `pasted.${type.split("/")[1]}`, { type }));
    }
    if (found.length) addFiles(found);
    else { errorNote = "The clipboard holds no image."; update(); }
  } catch (err) { errorNote = `Couldn't read the clipboard (${err.message}). Try Ctrl+V instead.`; update(); }
});
for (const el of document.querySelectorAll(".slot")) el.addEventListener("click", () => openPicker(el.dataset.slot));
$("swap").addEventListener("click", () => {
  const { original: o, cutout: c } = files;
  if (o && c) { load("original", c); load("cutout", o); }
});

// drag & drop anywhere, paste
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
const slotUnder = (e) => e.target.closest?.(".slot");
addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth++;
  $("drop-overlay").hidden = false; app.classList.add("dragging");
});
addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  for (const s of document.querySelectorAll(".slot")) s.classList.toggle("drop-target", s === slotUnder(e));
});
const endDrag = () => {
  dragDepth = 0; $("drop-overlay").hidden = true; app.classList.remove("dragging");
  for (const s of document.querySelectorAll(".slot")) s.classList.remove("drop-target");
};
addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth <= 0) endDrag(); });
addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const slot = slotUnder(e)?.dataset.slot;
  endDrag();
  addFiles(e.dataTransfer.files, slot);
});
document.addEventListener("paste", (e) => {
  if (e.target.matches?.("input[type=text]")) return;
  const fl = e.clipboardData?.files;
  if (fl?.length) { e.preventDefault(); addFiles(fl); }
});

// ---------- theme: auto (system) / light / dark ----------
const dark = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme ?? (dark.matches ? "dark" : "light")) === "dark";
let theme = (() => { try { return localStorage.getItem("brs-theme") || "auto"; } catch { return "auto"; } })();
function setTheme(t) {
  theme = t;
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { localStorage.setItem("brs-theme", t); } catch { }
  checker = null; draw();
}
dark.addEventListener("change", () => { checker = null; draw(); });

// ---------- controls ----------
const radios = (name) => document.querySelectorAll(`input[name="${name}"]`);
function bindRadios(name, get, set) {
  for (const r of radios(name)) {
    r.checked = r.value === get();
    r.addEventListener("change", () => r.checked && set(r.value));
  }
}
bindRadios("theme", () => theme, setTheme);
bindRadios("method", () => ui.method, (v) => { ui.method = v; changed(); });
bindRadios("view", () => view, (v) => setView(v));
bindRadios("format", () => ui.format, (v) => {
  ui.format = v;
  const f = $("filename");
  if (filenameEdited) f.value = filename(); else f.value = defaultName();
  $("quality").value = ui.q[v] ?? 90;
  changed(false); draw();
});
bindRadios("matte", () => ui.matte, (v) => { ui.matte = v; if (v === "custom") $("matte-color").showPicker?.(); changed(false); draw(); });
$("matte-color").value = ui.matteCustom;
$("matte-sw").style.setProperty("--matte", ui.matteCustom);
$("matte-color").addEventListener("input", (e) => {
  ui.matteCustom = e.target.value; ui.matte = "custom";
  $("matte-sw").style.setProperty("--matte", ui.matteCustom);
  for (const r of radios("matte")) r.checked = r.value === "custom";
  changed(false); draw();
});
document.querySelector('input[name="matte"][value="custom"]').addEventListener("click", () => $("matte-color").showPicker?.());
$("quality").value = ui.q[ui.format] ?? 90;
$("quality").addEventListener("input", (e) => { if (ui.format !== "png") ui.q[ui.format] = +e.target.value; changed(false); });
bindRadios("bg", () => ui.bg, (v) => { ui.bg = v; persist(); if (v === "custom") $("custom-color").showPicker?.(); draw(); });
$("custom-color").value = ui.custom;
$("custom-sw").style.setProperty("--custom", ui.custom);
$("custom-color").addEventListener("input", (e) => {
  ui.custom = e.target.value; ui.bg = "custom";
  $("custom-sw").style.setProperty("--custom", ui.custom);
  for (const r of radios("bg")) r.checked = r.value === "custom";
  persist(); draw();
});
document.querySelector('input[name="bg"][value="custom"]').addEventListener("click", () => $("custom-color").showPicker?.());

const fill = (el) => el.style.setProperty("--p", `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
const slider = (id, key, after) => {
  const el = $(id);
  el.value = ui[key];
  el.addEventListener("input", () => { ui[key] = +el.value; after?.(); changed(); });
};
slider("radius", "radius", () => { ui.radiusAuto = false; });
slider("detail", "detail");
slider("opacity", "opacity");
$("radius-auto").addEventListener("click", () => { ui.radiusAuto = true; changed(); });
$("clear").checked = ui.clear;
$("clear").addEventListener("change", (e) => { ui.clear = e.target.checked; changed(false); });
$("optimize").value = ui.optimize;
$("optimize").addEventListener("change", (e) => { ui.optimize = e.target.value; changed(false); });
$("filename").addEventListener("input", () => { filenameEdited = $("filename").value.trim() !== ""; });

function changed(preview = true) {
  persist();
  $("result").textContent = "";
  if (preview) requestPreview();
  update();
}

function setView(v) {
  const prev = view;
  view = v;
  for (const r of radios("view")) r.checked = r.value === v;
  if ((prev === "alpha") !== (v === "alpha")) requestPreview(); // alpha is rendered by the worker
  draw();
}

// ---------- worker ----------
let pngWaiters = [], flatWaiters = [];
worker.onmessage = ({ data: m }) => {
  switch (m.type) {
    case "loaded":
      info[m.slot] = m.info;
      loading[m.slot] = false;
      if (m.bitmap) { originalBmp?.close(); originalBmp = m.bitmap; }
      syncView();
      break;
    case "busy":
      refining = true;
      break;
    case "preview":
      resultBmp?.close();
      resultBmp = m.bitmap;
      stats = m.stats; previewMs = m.ms;
      refining = false;
      syncView();
    // fall through
    case "idle":
      previewBusy = false;
      if (previewDirty) { previewDirty = false; requestPreview(); }
      break;
    case "progress":
      setProgress(`Encoding PNG… ${Math.round(m.value * 100)} %`, m.value);
      return;
    case "png":
      refining = false;
      pngWaiters.shift()?.resolve(m.blob);
      break;
    case "flat":
      refining = false;
      flatWaiters.shift()?.resolve(m.image);
      break;
    case "error":
      refining = previewBusy = false;
      if (m.slot) { loading[m.slot] = false; files[m.slot] = null; resetSlot(m.slot); syncView(); }
      if (m.op === "export") pngWaiters.shift()?.reject(new Error(m.message));
      else if (m.op === "flatten") flatWaiters.shift()?.reject(new Error(m.message));
      else errorNote = m.slot ? `Couldn't read that image: ${m.message}` : m.message;
      break;
  }
  update();
};
worker.onerror = (e) => { errorNote = `Processing failed to start: ${e.message || "unknown error"}`; update(); };

function resetSlot(slot) {
  if (slot === "original") { originalBmp?.close(); originalBmp = null; } else { cutoutBmp?.close(); cutoutBmp = null; }
  const img = document.querySelector(`.slot[data-slot="${slot}"] img`);
  if (img.src) URL.revokeObjectURL(img.src);
  img.removeAttribute("src"); img.hidden = true;
}

const requestPng = () => new Promise((resolve, reject) => {
  pngWaiters.push({ resolve, reject });
  worker.postMessage({ type: "export", params: params() });
});

// ---------- viewer: zoom / pan on a DPR-aware 2D canvas ----------
const canvas = $("view");
const ctx = canvas.getContext("2d");
const vp = { z: 1, x: 0, y: 0, fit: true };
let raf = 0, checker = null;

function draw() { if (!raf) raf = requestAnimationFrame(paint); }
// The result once both images are in; until then whichever single image is loaded.
function shownBitmap() {
  if (ready() && resultBmp) return peek || view === "original" ? originalBmp : resultBmp;
  return originalBmp || cutoutBmp;
}
function syncView() {
  const b = shownBitmap();
  app.dataset.showing = b ? "true" : "false";
  if (b && (b.width !== imgW || b.height !== imgH)) { imgW = b.width; imgH = b.height; fit(); }
  draw();
}
function paint() {
  raf = 0;
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const bmp = shownBitmap();
  if (!bmp || !imgW) return;
  const s = vp.z * dpr, x = vp.x * dpr, y = vp.y * dpr, w = imgW * s, h = imgH * s;
  ctx.save();
  ctx.shadowColor = isDark() ? "rgb(0 0 0 / .6)" : "rgb(60 50 30 / .22)"; ctx.shadowBlur = 14 * dpr;
  const lossy = ui.format !== "png" && view !== "alpha";
  if (lossy) ctx.fillStyle = matteHex();
  else if (ui.bg === "checker") {
    if (!checker) {
      const c = new OffscreenCanvas(20, 20), g = c.getContext("2d");
      g.fillStyle = isDark() ? "#262523" : "#fbfaf7"; g.fillRect(0, 0, 20, 20);
      g.fillStyle = isDark() ? "#3a3936" : "#dcd9d2"; g.fillRect(0, 0, 10, 10); g.fillRect(10, 10, 10, 10);
      checker = ctx.createPattern(c, "repeat");
    }
    checker.setTransform(new DOMMatrix([dpr * .8, 0, 0, dpr * .8, x, y]));
    ctx.fillStyle = checker;
  } else ctx.fillStyle = ui.bg === "custom" ? ui.custom : ui.bg;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  // draw only the visible part; crisp pixels once an image pixel spans ≥ 2 device pixels
  const sx0 = Math.max(0, Math.floor(-x / s)), sy0 = Math.max(0, Math.floor(-y / s));
  const sx1 = Math.min(imgW, Math.ceil((canvas.width - x) / s)), sy1 = Math.min(imgH, Math.ceil((canvas.height - y) / s));
  if (sx1 <= sx0 || sy1 <= sy0) return;
  ctx.imageSmoothingEnabled = s < 2;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, sx0, sy0, sx1 - sx0, sy1 - sy0, x + sx0 * s, y + sy0 * s, (sx1 - sx0) * s, (sy1 - sy0) * s);
}

function resize() {
  const dpr = devicePixelRatio || 1, r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  if (vp.fit) fit(); else draw();
}
new ResizeObserver(resize).observe(canvas);

function fit() {
  if (!imgW) return;
  const r = canvas.getBoundingClientRect();
  const padX = Math.min(48, r.width * 0.08), padY = Math.min(128, r.height * 0.16);   // room for the toolbars
  vp.z = Math.max(0.01, Math.min((r.width - padX) / imgW, (r.height - padY) / imgH, 1));
  vp.x = (r.width - imgW * vp.z) / 2;
  vp.y = (r.height - imgH * vp.z) / 2;
  vp.fit = true;
  zoomLabel(); draw();
}
function zoomTo(z, cx, cy) {
  const r = canvas.getBoundingClientRect();
  cx ??= r.width / 2; cy ??= r.height / 2;
  z = Math.min(64, Math.max(0.01, z));
  vp.x = cx - (cx - vp.x) * z / vp.z;
  vp.y = cy - (cy - vp.y) * z / vp.z;
  vp.z = z; vp.fit = false;
  zoomLabel(); draw();
}
const zoomStep = (dir) => zoomTo(dir > 0 ? ZOOMS.find((z) => z > vp.z * 1.001) ?? 64 : ZOOMS.findLast((z) => z < vp.z * 0.999) ?? 0.01);
const zoomLabel = () => { $("zoom-label").textContent = `${vp.z >= 0.1 ? Math.round(vp.z * 100) : (vp.z * 100).toFixed(1)} %`; };

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const k = e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.01 : 0.0025;   // lines / pinch / pixels
  zoomTo(vp.z * Math.exp(-e.deltaY * k), e.offsetX, e.offsetY);
}, { passive: false });

const pointers = new Map();
let pinch = null;
const pinchState = () => {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
};
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  canvas.classList.add("dragging");
  if (pointers.size === 2) pinch = pinchState();
});
canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) { vp.x += e.offsetX - p.x; vp.y += e.offsetY - p.y; vp.fit = false; draw(); }
  p.x = e.offsetX; p.y = e.offsetY;
  if (pointers.size === 2 && pinch) {
    const n = pinchState();
    zoomTo(vp.z * n.d / pinch.d, n.cx, n.cy);
    vp.x += n.cx - pinch.cx; vp.y += n.cy - pinch.cy;
    pinch = n;
  }
});
const pointerEnd = (e) => {
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!pointers.size) canvas.classList.remove("dragging");
};
canvas.addEventListener("pointerup", pointerEnd);
canvas.addEventListener("pointercancel", pointerEnd);
canvas.addEventListener("dblclick", (e) => (vp.fit || vp.z < 1 ? zoomTo(1, e.offsetX, e.offsetY) : fit()));
$("zoom-in").addEventListener("click", () => zoomStep(1));
$("zoom-out").addEventListener("click", () => zoomStep(-1));
$("zoom-label").addEventListener("click", () => (vp.fit ? zoomTo(1) : fit()));
$("fit").addEventListener("click", fit);
$("one").addEventListener("click", () => zoomTo(1));

// ---------- export ----------
let skip = null;
function setProgress(text, frac) {
  $("progress").hidden = false;
  $("progress-text").textContent = text;
  $("progress-bar").parentElement.classList.toggle("indeterminate", frac == null);
  if (frac != null) $("progress-bar").style.width = `${frac * 100}%`;
  $("skip").hidden = !skip;
}
$("skip").addEventListener("click", () => skip?.());

const FORMATS = {
  png: { label: "PNG", ext: "png", hint: "Lossless and keeps the transparency." },
  jpeg: { label: "JPEG", ext: "jpg", hint: "MozJPEG. No transparency — the cutout sits on the matte color. Opens everywhere." },
  webp: { label: "WebP", ext: "webp", hint: "libwebp. No transparency, on the matte. Usually smaller than JPEG." },
  avif: { label: "AVIF", ext: "avif", hint: "AV1 image. No transparency, on the matte. Smallest file, slowest to encode." },
};
const hexRGB = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const matteHex = () => (ui.matte === "custom" ? ui.matteCustom : ui.matte);

// Runs one job in a fresh codec worker; resolves null when the user skips/cancels.
function runCodec(msg, transfer, label) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./codec-worker.js", import.meta.url), { type: "module" });
    const t0 = performance.now();
    const tick = () => setProgress(`${label}… ${secs(performance.now() - t0)}`, null);
    const timer = setInterval(tick, 200);
    const done = (value, err) => { clearInterval(timer); w.terminate(); skip = null; err ? reject(err) : resolve(value); };
    skip = () => done(null);
    tick();
    w.onmessage = ({ data }) => (data.type === "done" ? done(data) : done(null, new Error(data.message)));
    w.onerror = (e) => { e.preventDefault(); done(null, new Error(e.message || "could not load the encoder")); };
    w.postMessage(msg, transfer);
  });
}

const requestFlat = (matte) => new Promise((resolve, reject) => {
  flatWaiters.push({ resolve, reject });
  worker.postMessage({ type: "flatten", matte, params: params() });
});

async function download() {
  if (exporting || !ready()) return;
  exporting = true;
  const name = filename(), t0 = performance.now(), fmt = ui.format;
  const out = $("result");
  out.className = "result"; out.textContent = "";
  update();
  try {
    let blob, note = "";
    if (fmt === "png") {
      setProgress("Encoding PNG…", 0);
      blob = await requestPng();
      const raw = blob.size;
      if (ui.optimize !== "off") {
        try {
          const r = await runCodec({ op: "oxipng", blob, level: +ui.optimize }, [], "Optimizing with OxiPNG");
          if (!r) note = " · optimization skipped";
          else if (r.blob.size < raw) { blob = r.blob; note = ` · OxiPNG −${((1 - r.blob.size / raw) * 100).toFixed(1)} % (${r.info})`; }
        } catch (err) { note = ` · OxiPNG unavailable (${err.message})`; }
      }
    } else {
      setProgress("Compositing onto the matte…", null);
      const image = await requestFlat(hexRGB(matteHex()));
      const r = await runCodec({ op: "encode", format: fmt, quality: ui.q[fmt], image }, [image.data.buffer],
        `Encoding ${FORMATS[fmt].label} at quality ${ui.q[fmt]}`);
      if (!r) { out.textContent = "Export cancelled."; return; }
      blob = r.blob;
      note = ` · q ${ui.q[fmt]} on ${matteHex()}`;
    }
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    out.className = "result ok";
    out.textContent = `${name} · ${mb(blob.size)}${note} · ${secs(performance.now() - t0)}`;
  } catch (err) {
    out.className = "result";
    out.textContent = `Export failed: ${err.message}`;
  } finally {
    exporting = false; skip = null;
    $("progress").hidden = true;
    update();
  }
}

async function copy() {
  if (!ready() || exporting) return;
  const out = $("result");
  try {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": requestPng() })]);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;           // older engines: no Promise in ClipboardItem
      await navigator.clipboard.write([new ClipboardItem({ "image/png": await requestPng() })]);
    }
    out.className = "result copied"; out.textContent = "to the clipboard (uncompressed PNG)";
  } catch (err) {
    out.className = "result"; out.textContent = `Copy failed: ${err.message}`;
  }
  $("progress").hidden = true;
}
$("download").addEventListener("click", download);
$("copy").addEventListener("click", copy);
if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") $("copy").hidden = true;

const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} kB`);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// ---------- keyboard ----------
const help = $("help");
$("show-help").addEventListener("click", () => help.showModal());
document.addEventListener("keydown", (e) => {
  const t = e.target, mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  const typing = t.matches?.("input[type=text], select, textarea");
  if (mod && k === "o") { e.preventDefault(); openPicker(); return; }
  if (mod && k === "s") { e.preventDefault(); download(); return; }
  if (mod && k === "c" && !typing && !String(getSelection())) { e.preventDefault(); copy(); return; }
  if (typing || mod || e.altKey || help.open) return;
  if (e.key === " ") {
    if (t.matches?.("button, select, summary, a, input[type=radio], input[type=checkbox]")) return;
    e.preventDefault();
    if (!e.repeat && !peek) { peek = true; draw(); }
    return;
  }
  const act = {
    f: fit, 1: () => zoomTo(1), "+": () => zoomStep(1), "=": () => zoomStep(1), "-": () => zoomStep(-1),
    v: () => setView({ result: "alpha", alpha: "original", original: "result" }[view]),
    b: () => {
      const order = ["checker", "#ffffff", "#000000", "custom"];
      ui.bg = order[(order.indexOf(ui.bg) + 1) % order.length];
      for (const r of radios("bg")) r.checked = r.value === ui.bg;
      persist(); draw();
    },
    "?": () => help.showModal(),
  }[k];
  if (act && (shownBitmap() || k === "?")) { e.preventDefault(); act(); }
});
const unpeek = () => { if (peek) { peek = false; draw(); } };
document.addEventListener("keyup", (e) => e.key === " " && unpeek());
addEventListener("blur", unpeek);

// ---------- status ----------
function update() {
  const both = ready(), anyLoading = loading.original || loading.cutout;
  app.dataset.method = ui.method;
  const showing = app.dataset.showing === "true";
  $("tb-view").hidden = !both;
  $("tb-zoom").hidden = !showing;
  $("tb-bg").hidden = !showing || ui.format !== "png";       // lossy formats preview on their matte
  app.dataset.format = ui.format;
  $("format-hint").textContent = FORMATS[ui.format].hint;
  $("download-label").textContent = `Download ${FORMATS[ui.format].label}`;
  $("matte-out").textContent = matteHex();
  $("quality-out").textContent = ui.format === "png" ? "" : String(ui.q[ui.format]);
  $("filename").placeholder = defaultName();

  for (const slot of ["original", "cutout"]) {
    const el = document.querySelector(`.slot[data-slot="${slot}"]`), i = info[slot], f = files[slot];
    el.classList.toggle("filled", !!f);
    el.classList.toggle("loading", loading[slot]);
    el.querySelector("[data-meta]").textContent = !f
      ? (slot === "original" ? "full resolution · click to choose" : "small, transparent · click to choose")
      : loading[slot] ? `${f.name} · reading…` : i ? `${i.w} × ${i.h} · ${f.name}` : f.name;
    el.title = f ? `${f.name} — click to replace` : "Click to choose, or drop a file here";
  }
  $("swap").disabled = !(files.original && files.cutout);

  // empty state
  const o = !!files.original, c = !!files.cutout;
  $("banner").hidden = o === c;
  $("banner-text").textContent = o ? "Original photo loaded. Now add the cutout." : "Cutout loaded. Now add the original photo.";
  $("banner-btn").textContent = o ? "Choose cutout" : "Choose original photo";
  $("banner-btn").dataset.pick = o ? "cutout" : "original";

  // edges
  const auto = stats?.autoRadius;
  const rEl = $("radius");
  if (auto) rEl.max = Math.max(32, auto * 4);
  if (ui.radiusAuto && auto) rEl.value = auto;
  $("radius-out").textContent = ui.radiusAuto ? (auto ? `${auto} px auto` : "auto") : `${ui.radius} px`;
  $("radius-auto").hidden = ui.radiusAuto;
  $("detail-out").textContent = `ε ${EPS[ui.detail].toExponential()}`;
  for (const id of ["radius", "detail", "opacity", "quality"]) fill($(id));
  $("method-hint").textContent = METHOD_HINT[ui.method];

  // background
  $("opacity-out").textContent = `${ui.opacity} %`;
  const clearEl = $("clear");
  clearEl.disabled = ui.opacity > 0 || ui.format !== "png";
  const pct = stats ? Math.round(stats.transparent * 100) : null;
  $("clear-hint").textContent = ui.format !== "png" ? "PNG only — the other formats have no transparency."
    : ui.opacity > 0 ? "Only applies at 0 % opacity — no pixel is fully transparent now."
    : `Discards the colors hidden behind ${pct != null ? `the ${pct} % ` : ""}fully transparent pixels. Much smaller file.`;

  // export
  $("download").disabled = !both || exporting;
  $("copy").disabled = !both || exporting;

  // busy chip
  const busy = anyLoading ? "reading image" : refining ? "refining edges" : "";
  $("status-line").hidden = !busy;
  $("busy-text").textContent = busy;

  // details
  const notes = [];
  if (errorNote) notes.push({ warn: true, text: errorNote });
  for (const s of ["original", "cutout"]) notes.push(...(info[s]?.notes ?? []));
  const dl = [];
  if (info.original) dl.push(["Original", `${info.original.w} × ${info.original.h} · ${(info.original.w * info.original.h / 1e6).toFixed(1)} MP${info.original.icc ? " · ICC profile kept" : ""}`]);
  if (info.cutout) dl.push(["Cutout", `${info.cutout.w} × ${info.cutout.h}`]);
  if (both) {
    const { original: a, cutout: b } = info;
    dl.push(["Upscale", `× ${(a.w / b.w).toFixed(2)}`]);
    if (Math.abs((a.w / a.h) / (b.w / b.h) - 1) > 0.01)
      notes.push({ warn: true, text: "The aspect ratios differ, so the mask gets stretched." +
        (Math.abs((a.w / a.h) / (b.h / b.w) - 1) < 0.01 ? " It looks like one image is rotated by 90°." : "") });
    if (stats) dl.push(["Transparent", `${(stats.transparent * 100).toFixed(1)} % of pixels`], ["Preview", `${Math.round(previewMs)} ms`]);
  }
  $("notes").replaceChildren(...notes.map((n) => Object.assign(document.createElement("li"), { textContent: n.text, className: n.warn ? "warn" : "" })));
  $("info").replaceChildren(...dl.flatMap(([k, v]) => [Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: v })]));
  $("details").hidden = !notes.length && !dl.length;
  const q = (s) => (/^[\w./-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
  $("cli").textContent = both ? [
    "uv run apply_mask.py", q(files.original.name), q(files.cutout.name), String(ui.opacity / 100),
    "--resample", ui.method,
    ...(ui.method === "refine" ? ["--radius", String(stats?.radius ?? ui.radius), "--eps", EPS[ui.detail].toExponential()] : []),
    ...(ui.format === "png" ? [
      ...(ui.clear && ui.opacity === 0 ? ["--clear-transparent"] : []),
      "--optimize", ui.optimize === "6" ? "max" : ui.optimize,
    ] : ["--flatten", q(matteHex()), "--quality", String(ui.q[ui.format])]),
    "-o", q(filename()),
  ].join(" ") : "";
  document.querySelector(".cli").hidden = !both;
}

// link to the repository when hosted on GitHub Pages
if (location.hostname.endsWith(".github.io")) {
  const repo = location.pathname.split("/")[1];
  const a = Object.assign(document.createElement("a"), { href: `https://github.com/${location.hostname.split(".")[0]}/${repo}`, textContent: "Source" });
  $("source-link").append(" · ", a);
}

update();
