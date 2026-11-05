# Vendored WebAssembly codecs

All from [jSquash](https://github.com/jamsinclair/jSquash) (Squoosh's codecs, Apache-2.0,
see `LICENSE-jsquash-apache-2.0.txt`), copied unmodified except where noted.

| folder        | package                 | codec                                   | licence of the codec |
|---------------|-------------------------|-----------------------------------------|----------------------|
| `oxipng/`     | @jsquash/oxipng 2.3.0   | OxiPNG 9.1.1, single-threaded (`codec/pkg`) | MIT |
| `oxipng-mt/`  | @jsquash/oxipng 2.3.0   | OxiPNG 9.1.1, multi-threaded (`codec/pkg-parallel`) | MIT |
| `mozjpeg/`    | @jsquash/jpeg 1.6.0     | MozJPEG encoder                         | IJG / BSD-3 (see file) |
| `webp/`       | @jsquash/webp 1.5.0     | libwebp encoder (+ SIMD build)          | BSD-3 (see file) |
| `avif/`       | @jsquash/avif 2.1.1     | libavif + libaom encoder (+ threaded build) | BSD-2 |

Patch: `oxipng-mt/snippets/.../workerHelpers.worker.js` imports `../../../squoosh_oxipng.js`
instead of the bundler-only directory import `../../../`.
