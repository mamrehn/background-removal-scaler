// WebAssembly codecs (from jSquash / Squoosh), in their own worker so the page can
// cancel a long run (terminate) while the processing worker stays responsive.
// Uses the multi-threaded builds when the page is cross-origin isolated (see coi-sw.js).
const threads = self.crossOriginIsolated && navigator.hardwareConcurrency > 1;

// Encoder defaults copied from jSquash's meta.js files; the Emscripten encoders expect every field.
const DEFAULTS = {
  jpeg: {
    quality: 75, baseline: false, arithmetic: false, progressive: true, optimize_coding: true, smoothing: 0,
    color_space: 3, quant_table: 3, trellis_multipass: false, trellis_opt_zero: false, trellis_opt_table: false,
    trellis_loops: 1, auto_subsample: true, chroma_subsample: 2, separate_chroma_quality: false, chroma_quality: 75,
  },
  webp: {
    quality: 75, target_size: 0, target_PSNR: 0, method: 4, sns_strength: 50, filter_strength: 60, filter_sharpness: 0,
    filter_type: 1, partitions: 0, segments: 4, pass: 1, show_compressed: 0, preprocessing: 0, autofilter: 0,
    partition_limit: 0, alpha_compression: 1, alpha_filtering: 1, alpha_quality: 100, lossless: 0, exact: 0,
    image_hint: 0, emulate_jpeg_size: 0, thread_level: 0, low_memory: 0, near_lossless: 100, use_delta_palette: 0,
    use_sharp_yuv: 0,
  },
  avif: {
    quality: 50, qualityAlpha: -1, denoiseLevel: 0, tileColsLog2: 0, tileRowsLog2: 0, speed: 6, subsample: 1,
    chromaDeltaQ: false, sharpness: 0, tune: 0, enableSharpYUV: false, bitDepth: 8, lossless: false,
  },
};
// "High effort" settings on top of the defaults.
const TUNING = {
  jpeg: (q) => ({ quality: q, chroma_quality: q, trellis_multipass: true }),
  webp: (q) => ({ quality: q, method: 6, use_sharp_yuv: 1 }),
  avif: (q) => ({ quality: q, speed: 4, enableSharpYUV: true }),
};

const cache = {};
const once = (key, fn) => (cache[key] ??= fn());

const oxipng = () => once("oxipng", async () => {
  if (threads) {
    try {
      const m = await import("./vendor/oxipng-mt/squoosh_oxipng.js");
      await m.default();
      await m.initThreadPool(navigator.hardwareConcurrency);
      return { optimise: m.optimise, threads: navigator.hardwareConcurrency };
    } catch (err) { console.warn("multi-threaded OxiPNG unavailable, using single thread", err); }
  }
  const m = await import("./vendor/oxipng/squoosh_oxipng.js");
  await m.default();
  return { optimise: m.optimise, threads: 1 };
});

async function emscripten(urls) {
  let lastErr;
  for (const url of urls) {
    try { return await (await import(url)).default({ noInitialRun: true }); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}
const encoder = (format) => once(format, () => emscripten({
  jpeg: ["./vendor/mozjpeg/mozjpeg_enc.js"],
  webp: ["./vendor/webp/webp_enc_simd.js", "./vendor/webp/webp_enc.js"],
  avif: threads ? ["./vendor/avif/avif_enc_mt.js", "./vendor/avif/avif_enc.js"] : ["./vendor/avif/avif_enc.js"],
}[format]));

self.onmessage = async ({ data: msg }) => {
  try {
    const t0 = performance.now();
    let out, info = "";
    if (msg.op === "oxipng") {
      const { optimise, threads: n } = await oxipng();
      out = optimise(new Uint8Array(await msg.blob.arrayBuffer()), msg.level, false, false);
      info = n > 1 ? `${n} threads` : "1 thread";
    } else {
      const { data, width, height } = msg.image;
      const m = await encoder(msg.format);
      const opts = { ...DEFAULTS[msg.format], ...TUNING[msg.format](msg.quality) };
      const pixels = msg.format === "avif" ? new Uint8Array(data.buffer) : data;
      out = m.encode(pixels, width, height, opts);
      if (!out) throw new Error("encoding failed");
      out = new Uint8Array(out);                       // copy out of (possibly shared) wasm memory
    }
    const type = { oxipng: "image/png", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif" }[msg.op === "oxipng" ? "oxipng" : msg.format];
    self.postMessage({ type: "done", blob: new Blob([out], { type }), ms: performance.now() - t0, info });
  } catch (err) {
    self.postMessage({ type: "error", message: String((err && err.message) || err) });
  }
};
