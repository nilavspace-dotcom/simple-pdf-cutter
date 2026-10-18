# JPEG decoder

`decoder.js` is the JPEG decoder of [jpeg-js](https://github.com/jpeg-js/jpeg-js), written in
plain JavaScript. Photos are normally saved exactly as they are stored in the PDF, without being
decoded; this is only used when a photo has to be turned into pixels, such as a JPEG with a
transparency mask, which is then saved as a PNG file.

`scripts/vendor-decoders.js` wraps `lib/decoder.js` so that it loads as a classic script in the
browser (global `JpegJs`) and with `require()` in Node.js. The decoding code itself is unchanged.

- **Source:** `lib/decoder.js` from the npm package `jpeg-js` 0.4.4.
- **License:** BSD 3-clause, see [LICENSE](LICENSE). The decoder began as part of PDF.js, and its
  file keeps that Apache-2.0 notice.
- **SHA-256:** `42920d82e6e04667fa65943210ff0dcb48e904dd717617fabf728576a7f783c7`

The same script regenerates this folder and `vendor/pdfjs/`; see
[updating](../pdfjs/README.md#updating) there.
