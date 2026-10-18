# Decoders for scanned images

These files decode the image formats that scanners and scanning software put in PDFs:

| File                   | Decodes                                     | Browser global          |
| ---------------------- | ------------------------------------------- | ----------------------- |
| `jbig2.js`             | JBIG2 and CCITT fax (black-and-white scans) | `PdfjsJbig2`            |
| `openjpeg.js`          | JPEG 2000                                   | `PdfjsOpenJpeg`         |
| `jbig2-fallback.js`    | the same, without WebAssembly               | `PdfjsJbig2Fallback`    |
| `openjpeg-fallback.js` | the same, without WebAssembly               | `PdfjsOpenJpegFallback` |

They come from [PDF.js](https://github.com/mozilla/pdf.js), the PDF viewer built into Firefox,
which compiles [PDFium](https://pdfium.googlesource.com/pdfium/)'s JBIG2 and CCITT decoders and
[OpenJPEG](https://www.openjpeg.org/) to WebAssembly. `src/decoders.js` loads them only when a PDF
contains such images, and uses the plain-JavaScript fallbacks where WebAssembly is unavailable.

PDF.js ships the decoders as ES modules that fetch their `.wasm` file, which does not work in a
page opened straight from disk. `scripts/vendor-decoders.js` therefore turns them into classic
scripts with the WebAssembly embedded as base64. The decoding code itself is unchanged.

- **Source:** `external/jbig2/` and `external/openjpeg/` in PDF.js `v6.4.299`
  (commit `d0991a0d53f3bb3a7307e3b83f279c1d117aafb3`).
- **Licenses:** Apache-2.0 for PDF.js and its JBIG2 build, with PDFium's BSD-style license;
  BSD 2-clause for OpenJPEG and its PDF.js build. See the `LICENSE*` files.
- **SHA-256** of the generated files:

  ```
  c93dabfca9945847b27f738ec700638b9106801ef0d890457377170ac7e9051e  jbig2.js
  12dea8078c8ba134f9ff87d5ff696ec2a833c0f7755dbbef44474ae6e2bee452  jbig2-fallback.js
  4cc23c5c67326eab58c20da15f3afa24585d0219d16f94e2be4de6fa1b8003b9  openjpeg.js
  000ec671e9a8deacfda100f638a210ee608ecfb02b7586eb11991bd20ff94c2b  openjpeg-fallback.js
  ```

## Updating

```sh
git clone --depth 1 --branch <tag> https://github.com/mozilla/pdf.js
npm pack jpeg-js@0.4.4 && tar -xzf jpeg-js-0.4.4.tgz   # vendor/jpeg-js is regenerated too
node scripts/vendor-decoders.js pdf.js <tag> package    # prints the new checksums
npm test && npm run test:e2e
```

`src/decoders.js` calls the decoders' exported functions (`_jbig2_decode`, `_ccitt_decode` and
`_jp2_decode`) directly, so check that the tests for scanned images still pass after an update.
