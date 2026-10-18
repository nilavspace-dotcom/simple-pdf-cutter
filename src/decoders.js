/*!
 * Simple PDF Cutter - decoders for the image formats that need more than
 * plain JavaScript: JBIG2 and CCITT fax (black-and-white scans), JPEG 2000,
 * and JPEG when its pixels are needed. The decoders come from PDF.js and
 * jpeg-js (see the vendor folder) and are loaded only when a PDF uses them.
 *
 * In a browser this file defines `window.PdfCutterDecoders`; in Node.js it
 * can be loaded with `require()`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory((file) => Promise.resolve(require(`../vendor/${file}`)));
  } else {
    // Vendor files are found relative to this script, wherever the page is.
    const base = new URL('../vendor/', document.currentScript.src);
    root.PdfCutterDecoders = factory(
      (file, globalName) =>
        new Promise((resolve, reject) => {
          if (root[globalName]) return resolve(root[globalName]);
          const script = document.createElement('script');
          script.src = new URL(file, base).href;
          script.onload = () => resolve(root[globalName]);
          script.onerror = () => reject(new Error(`Could not load ${script.src}`));
          document.head.append(script);
        }),
    );
  }
})(globalThis, function (loadLibrary) {
  'use strict';

  const LIBRARIES = {
    jbig2: ['pdfjs/jbig2.js', 'PdfjsJbig2'],
    jbig2Fallback: ['pdfjs/jbig2-fallback.js', 'PdfjsJbig2Fallback'],
    openjpeg: ['pdfjs/openjpeg.js', 'PdfjsOpenJpeg'],
    openjpegFallback: ['pdfjs/openjpeg-fallback.js', 'PdfjsOpenJpegFallback'],
    jpeg: ['jpeg-js/decoder.js', 'JpegJs'],
  };

  const settings = { useWasm: typeof WebAssembly === 'object' };
  const modules = new Map();

  /**
   * @param {{useWasm?: boolean}} options  `useWasm: false` uses the slower
   *   plain-JavaScript decoders, as when WebAssembly is unavailable.
   */
  function configure(options) {
    Object.assign(settings, options);
    modules.clear();
  }

  function load(name) {
    return loadLibrary(...LIBRARIES[name]);
  }

  /** Starts a decoder, with WebAssembly if possible and plain JavaScript if not. */
  function getModule(name) {
    if (!modules.has(name)) {
      const promise = (settings.useWasm ? startWithWasm(name) : Promise.reject())
        .catch(() => load(`${name}Fallback`).then((library) => library.factory({ warn() {} })))
        .catch((error) => {
          modules.delete(name);
          throw error;
        });
      modules.set(name, promise);
    }
    return modules.get(name);
  }

  async function startWithWasm(name) {
    const library = await load(name);
    const wasm = base64ToBytes(library.wasm);
    return new Promise((resolve, reject) => {
      library
        .factory({
          warn() {},
          instantiateWasm(imports, done) {
            WebAssembly.instantiate(wasm, imports).then((result) => done(result.instance), reject);
            return {};
          },
        })
        .then(resolve, reject);
    });
  }

  /** Runs a decoder on bytes copied into its memory and returns its output. */
  function run(module, decode, ...inputs) {
    const pointers = inputs.map((bytes) => {
      if (!bytes || bytes.length === 0) return 0;
      const pointer = module._malloc(bytes.length);
      module.writeArrayToMemory(bytes, pointer);
      return pointer;
    });
    try {
      const status = decode(...pointers);
      const output = module.imageData;
      module.imageData = null;
      if (status || !output) {
        const reason = module.errorMessages;
        delete module.errorMessages;
        throw new Error(reason || 'The image data could not be decoded');
      }
      return output;
    } finally {
      for (const pointer of pointers) if (pointer) module._free(pointer);
    }
  }

  /**
   * Decodes a JBIG2 image as found in a PDF.
   *
   * @returns {Promise<Uint8Array>} Rows of 1-bit samples, 0 for black.
   */
  async function decodeJbig2(data, width, height, globals) {
    const module = await getModule('jbig2');
    const page = stripJbig2FileHeader(data);
    const shared = globals && globals.length > 0 ? stripJbig2FileHeader(globals) : null;
    return run(
      module,
      (pagePointer, sharedPointer) =>
        module._jbig2_decode(
          pagePointer,
          page.length,
          width,
          height,
          sharedPointer,
          shared ? shared.length : 0,
        ),
      page,
      shared,
    );
  }

  /**
   * Decodes CCITT fax data.
   *
   * @param {{K: number, EndOfLine: boolean, EncodedByteAlign: boolean,
   *   BlackIs1: boolean, Columns: number, Rows: number}} params
   * @returns {Promise<Uint8Array>} Rows of 1-bit samples as the PDF defines them.
   */
  async function decodeCcitt(data, width, height, params) {
    const module = await getModule('jbig2'); // the same library decodes both
    return run(
      module,
      (pointer) =>
        module._ccitt_decode(
          pointer,
          data.length,
          width,
          height,
          params.K,
          params.EndOfLine ? 1 : 0,
          params.EncodedByteAlign ? 1 : 0,
          params.BlackIs1 ? 1 : 0,
          params.Columns,
          params.Rows,
        ),
      data,
    );
  }

  /**
   * Decodes JPEG 2000 data.
   *
   * @param {{components?: number, alphaInData?: boolean}} [options]
   *   `components` asks for 1 (gray), 3 (RGB) or 4 channels; 0 keeps the
   *   image's own channels, adding alpha.
   * @returns {Promise<Uint8ClampedArray>} 8-bit samples, channel after channel.
   */
  async function decodeJpx(data, { components = 0, alphaInData = false } = {}) {
    const module = await getModule('openjpeg');
    return run(
      module,
      (pointer) => module._jp2_decode(pointer, data.length, components, false, alphaInData, 0),
      data,
    );
  }

  /**
   * Decodes a JPEG file to RGB pixels.
   *
   * @returns {Promise<{width: number, height: number, data: Uint8Array}>}
   */
  async function decodeJpeg(data) {
    const { decode } = await load('jpeg');
    const image = decode(data, { useTArray: true, formatAsRGBA: false });
    return { width: image.width, height: image.height, data: image.data };
  }

  // The JBIG2 file header (ITU-T T.88 annex D.4) is not part of PDF data, but
  // some PDF writers include it.
  function stripJbig2FileHeader(bytes) {
    const signature = [0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length >= 9 && signature.every((byte, i) => bytes[i] === byte)) {
      return bytes.subarray((bytes[8] & 2) === 0 ? 13 : 9);
    }
    return bytes;
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  return { configure, decodeJbig2, decodeCcitt, decodeJpx, decodeJpeg };
});
