/*!
 * Simple PDF Cutter - finds the images shown on PDF pages and saves them as
 * image files: JPEG photos exactly as they are stored in the PDF, everything
 * else as lossless PNG.
 *
 * In a browser this file defines `window.PdfImages` and expects pdf-lib,
 * pdf-cutter.js, formats.js and decoders.js to be loaded first. In Node.js it
 * can be loaded with `require()`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../vendor/pdf-lib/pdf-lib.min.js'),
      require('./pdf-cutter.js'),
      require('./formats.js'),
      require('./decoders.js'),
    );
  } else {
    root.PdfImages = factory(
      root.PDFLib,
      root.PdfCutter,
      root.PdfCutterFormats,
      root.PdfCutterDecoders,
    );
  }
})(globalThis, function (PDFLib, PdfCutter, Formats, Decoders) {
  'use strict';

  const {
    PDFArray,
    PDFBool,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNull,
    PDFNumber,
    PDFRawStream,
    PDFRef,
    PDFString,
  } = PDFLib;
  const { PdfCutterError } = PdfCutter;

  const name = (text) => PDFName.of(text);
  const NAMES = {
    AP: name('AP'),
    AS: name('AS'),
    Annots: name('Annots'),
    BitsPerComponent: name('BitsPerComponent'),
    ColorSpace: name('ColorSpace'),
    Decode: name('Decode'),
    DecodeParms: name('DecodeParms'),
    F: name('F'),
    Filter: name('Filter'),
    Form: name('Form'),
    Height: name('Height'),
    Image: name('Image'),
    ImageMask: name('ImageMask'),
    JBIG2Globals: name('JBIG2Globals'),
    Length: name('Length'),
    Mask: name('Mask'),
    Matte: name('Matte'),
    N: name('N'),
    Pattern: name('Pattern'),
    PatternType: name('PatternType'),
    Resources: name('Resources'),
    SMask: name('SMask'),
    SMaskInData: name('SMaskInData'),
    Subtype: name('Subtype'),
    Width: name('Width'),
    XObject: name('XObject'),
  };

  // Images smaller than this on either side (spacers, rules, bullets) are
  // marked as small, so they can be hidden.
  const SMALL_IMAGE_SIZE = 16;
  // Refuse to convert images whose pixels would need more memory than this.
  const MAX_IMAGE_BYTES = 1024 * 1024 * 1024;

  const GENERAL_FILTERS = new Set([
    'FlateDecode',
    'LZWDecode',
    'ASCII85Decode',
    'ASCIIHexDecode',
    'RunLengthDecode',
  ]);
  const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode']);

  // ==========================================================================
  // Finding images
  // ==========================================================================

  /**
   * @typedef {object} ImageInfo
   * @property {number[]} pages  The pages (1-based) that show the image.
   * @property {number} index  Its position among the new images on its first page.
   * @property {number} width
   * @property {number} height
   * @property {'jpg'|'png'} format  The file type it will be saved as.
   * @property {boolean} small  Whether it is tiny (a spacer, a rule, ...).
   * @property {string} fileName  For example "page-012_image-1.jpg".
   */

  /**
   * Lists the images shown on the given pages. An image shown several times,
   * such as a logo on every page, is listed once.
   *
   * @param {PDFLib.PDFDocument} pdf  A document returned by PdfCutter.openPdf().
   * @param {number[]} pageNumbers  1-based page numbers.
   * @param {{onProgress?: (done: number, total: number) => void}} [options]
   * @returns {Promise<ImageInfo[]>}
   */
  async function findImages(pdf, pageNumbers, options = {}) {
    const context = pdf.context;
    const pages = pdf.getPages();
    const digits = String(pages.length).length;
    const images = [];
    const byKey = new Map();
    const formCache = new Map();

    for (let i = 0; i < pageNumbers.length; i++) {
      const pageNumber = pageNumbers[i];
      const keysOnPage = new Set();
      let newOnPage = 0;
      const add = (key, source) => {
        if (keysOnPage.has(key)) return;
        keysOnPage.add(key);
        const known = byKey.get(key);
        if (known) {
          known.pages.push(pageNumber);
          return;
        }
        const info = describeImage(source, context);
        if (!info) return;
        newOnPage += 1;
        info.pages = [pageNumber];
        info.index = newOnPage;
        info.fileName = `page-${String(pageNumber).padStart(digits, '0')}_image-${newOnPage}.${info.format}`;
        byKey.set(key, info);
        images.push(info);
      };

      const page = pages[pageNumber - 1];
      const scanner = new PageScanner(context, add, formCache);
      try {
        scanner.scanPage(page);
      } catch (error) {
        // A page whose content cannot be read shows no images we could save.
        if (!(error instanceof PdfCutterError)) console.warn(error);
      }

      if (options.onProgress) options.onProgress(i + 1, pageNumbers.length);
      if (i % 8 === 7) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return images;
  }

  /** Reads a page's drawing instructions to find the images it shows. */
  class PageScanner {
    constructor(context, add, formCache) {
      this.context = context;
      this.add = add;
      // Images found in forms with their own resources, which are the same
      // wherever the form is used.
      this.formCache = formCache;
    }

    scanPage(page) {
      const resources = page.node.Resources();
      const contents = page.node.Contents();
      const streams =
        contents instanceof PDFArray
          ? contents.asArray().map((ref) => this.context.lookup(ref))
          : [contents];
      const parts = streams
        .filter((stream) => stream instanceof PDFRawStream)
        .map((stream) =>
          decodeGeneralFilters(stream.contents, getFilters(stream.dict, this.context)),
        );
      this.scanContent(joinStreams(parts), resources, `page ${page.ref}`, []);

      const annotations = page.node.lookup(NAMES.Annots);
      if (annotations instanceof PDFArray) {
        for (let i = 0; i < annotations.size(); i++) {
          const appearance = this.annotationAppearance(this.context.lookup(annotations.get(i)));
          if (appearance) this.scanForm(appearance.ref, appearance.stream, resources, []);
        }
      }
    }

    annotationAppearance(annotation) {
      if (!(annotation instanceof PDFDict)) return null;
      const flags = annotation.lookup(NAMES.F);
      if (flags instanceof PDFNumber && flags.asNumber() & 2) return null; // hidden
      const appearances = annotation.lookup(NAMES.AP);
      if (!(appearances instanceof PDFDict)) return null;
      let ref = appearances.get(name('N'));
      let normal = this.context.lookup(ref);
      if (normal instanceof PDFDict) {
        // One appearance per state, e.g. a checkbox; use the current one.
        const state = annotation.lookup(NAMES.AS);
        ref = state instanceof PDFName ? normal.get(state) : undefined;
        normal = this.context.lookup(ref);
      }
      return normal instanceof PDFRawStream ? { ref, stream: normal } : null;
    }

    scanContent(bytes, resources, containerKey, ancestors) {
      scanContentStream(bytes, this.context, {
        xobject: (xobjectName) => {
          const ref = lookupResource(resources, NAMES.XObject, xobjectName, this.context, true);
          const xobject = this.context.lookup(ref);
          if (!(xobject instanceof PDFRawStream)) return;
          const subtype = xobject.dict.lookup(NAMES.Subtype);
          if (subtype === NAMES.Image) {
            this.add(objectKey(ref, xobject), {
              dict: xobject.dict,
              data: xobject.contents,
              resources,
            });
          } else if (subtype === NAMES.Form) {
            this.scanForm(ref, xobject, resources, ancestors);
          }
        },
        pattern: (patternName) => {
          const ref = lookupResource(resources, NAMES.Pattern, patternName, this.context, true);
          const pattern = this.context.lookup(ref);
          // Tiling patterns draw like forms; shading patterns have no images.
          if (pattern instanceof PDFRawStream) this.scanForm(ref, pattern, resources, ancestors);
        },
        inlineImage: ({ dict, data, offset }) => {
          this.add(`${containerKey} @${offset}`, { dict, data, resources, inline: true });
        },
      });
    }

    scanForm(ref, form, parentResources, ancestors) {
      const key = objectKey(ref, form);
      if (ancestors.includes(key) || ancestors.length > 20) return; // a loop, or absurdly deep
      const ownResources = form.dict.lookup(NAMES.Resources);
      const cacheable = ownResources instanceof PDFDict;
      if (cacheable && this.formCache.has(key)) {
        for (const [imageKey, source] of this.formCache.get(key)) this.add(imageKey, source);
        return;
      }

      const found = [];
      const add = this.add;
      this.add = (imageKey, source) => {
        found.push([imageKey, source]);
        add(imageKey, source);
      };
      try {
        const bytes = decodeGeneralFilters(form.contents, getFilters(form.dict, this.context));
        this.scanContent(bytes, cacheable ? ownResources : parentResources, key, [
          ...ancestors,
          key,
        ]);
      } finally {
        this.add = add;
      }
      if (cacheable) this.formCache.set(key, found);
    }
  }

  /** Basic facts about an image, read from its dictionary without decoding it. */
  function describeImage({ dict, data, resources, inline }, context) {
    const width = numberValue(dict.lookup(NAMES.Width));
    const height = numberValue(dict.lookup(NAMES.Height));
    if (!(width >= 1 && height >= 1)) return null;
    return {
      width,
      height,
      format: keepsOriginalJpeg(dict, context) ? 'jpg' : 'png',
      small: width < SMALL_IMAGE_SIZE || height < SMALL_IMAGE_SIZE,
      inline: Boolean(inline),
      source: { dict, data, resources, context },
    };
  }

  /** Whether the image is a plain JPEG that can be saved exactly as stored. */
  function keepsOriginalJpeg(dict, context) {
    const filters = getFilters(dict, context);
    if (filters.length === 0 || filters[filters.length - 1].name !== 'DCTDecode') return false;
    if (!filters.slice(0, -1).every((filter) => GENERAL_FILTERS.has(filter.name))) return false;
    // Transparency has to be combined with the photo, which needs a PNG.
    if (dict.lookup(NAMES.SMask) || dict.lookup(NAMES.Mask)) return false;
    return !isTrue(dict.lookup(NAMES.ImageMask));
  }

  function objectKey(ref, object) {
    if (ref instanceof PDFRef) return `object ${ref.objectNumber} ${ref.generationNumber}`;
    if (!directObjectKeys.has(object)) {
      directObjectKeys.set(object, `direct ${++directObjectCount}`);
    }
    return directObjectKeys.get(object);
  }
  const directObjectKeys = new WeakMap();
  let directObjectCount = 0;

  function joinStreams(parts) {
    if (parts.length === 1) return parts[0];
    // Content streams of a page are read as one; keep tokens apart.
    const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      joined[offset + part.length] = 0x0a;
      offset += part.length + 1;
    }
    return joined;
  }

  // ---- Content streams -------------------------------------------------------

  const WHITESPACE = new Uint8Array(256);
  for (const code of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WHITESPACE[code] = 1;
  const DELIMITER = new Uint8Array(256);
  for (const char of '()<>[]{}/%') DELIMITER[char.charCodeAt(0)] = 1;

  /**
   * Reads a content stream and reports the operators that can show images:
   * `Do` (with the XObject's name), `scn`/`SCN` (with a pattern's name) and
   * inline images (`BI ... ID ... EI`).
   */
  function scanContentStream(bytes, context, visit) {
    const end = bytes.length;
    let pos = 0;
    let lastName = null;
    while (pos < end) {
      const c = bytes[pos];
      if (WHITESPACE[c]) {
        pos++;
        continue;
      }
      if (c === 0x2f) {
        // A name, e.g. /Im1
        const start = ++pos;
        while (pos < end && !WHITESPACE[bytes[pos]] && !DELIMITER[bytes[pos]]) pos++;
        lastName = decodeNameBytes(bytes, start, pos);
        continue;
      }
      const operand = lastName;
      lastName = null;
      if (c === 0x25) pos = skipComment(bytes, pos);
      else if (c === 0x28) pos = skipLiteralString(bytes, pos);
      else if (c === 0x3c && bytes[pos + 1] === 0x3c) pos = skipDictionary(bytes, pos);
      else if (c === 0x3c) pos = skipHexString(bytes, pos);
      else if (DELIMITER[c]) pos++;
      else {
        // A number, a keyword or an operator.
        const start = pos;
        while (pos < end && !WHITESPACE[bytes[pos]] && !DELIMITER[bytes[pos]]) pos++;
        const length = pos - start;
        if (length === 2 && c === 0x44 && bytes[start + 1] === 0x6f) {
          if (operand) visit.xobject(operand); // Do
        } else if (length === 3 && (isWord(bytes, start, 'scn') || isWord(bytes, start, 'SCN'))) {
          if (operand) visit.pattern(operand);
        } else if (length === 2 && c === 0x42 && bytes[start + 1] === 0x49) {
          pos = readInlineImage(bytes, pos, context, visit); // BI
        }
      }
    }
  }

  function isWord(bytes, pos, word) {
    for (let i = 0; i < word.length; i++) if (bytes[pos + i] !== word.charCodeAt(i)) return false;
    return true;
  }

  function skipComment(bytes, pos) {
    while (pos < bytes.length && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
    return pos;
  }

  function skipLiteralString(bytes, pos) {
    let depth = 0;
    for (; pos < bytes.length; pos++) {
      const c = bytes[pos];
      // A backslash escapes the next character.
      if (c === 0x5c) pos++;
      else if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) return pos + 1;
    }
    return pos;
  }

  function skipHexString(bytes, pos) {
    while (pos < bytes.length && bytes[pos] !== 0x3e) pos++;
    return pos + 1;
  }

  function skipDictionary(bytes, pos) {
    let depth = 0;
    while (pos < bytes.length) {
      const c = bytes[pos];
      if (c === 0x3c && bytes[pos + 1] === 0x3c) {
        depth++;
        pos += 2;
      } else if (c === 0x3e && bytes[pos + 1] === 0x3e) {
        pos += 2;
        if (--depth === 0) return pos;
      } else if (c === 0x28) pos = skipLiteralString(bytes, pos);
      else if (c === 0x3c) pos = skipHexString(bytes, pos);
      else if (c === 0x25) pos = skipComment(bytes, pos);
      else pos++;
    }
    return pos;
  }

  function decodeNameBytes(bytes, start, end) {
    let text = '';
    for (let i = start; i < end; i++) {
      if (bytes[i] === 0x23 && i + 2 < end && isHex(bytes[i + 1]) && isHex(bytes[i + 2])) {
        text += String.fromCharCode(parseInt(String.fromCharCode(bytes[i + 1], bytes[i + 2]), 16));
        i += 2;
      } else {
        text += String.fromCharCode(bytes[i]);
      }
    }
    return text;
  }

  function isHex(c) {
    return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
  }

  // ---- Inline images ---------------------------------------------------------

  const INLINE_KEYS = {
    BPC: 'BitsPerComponent',
    CS: 'ColorSpace',
    D: 'Decode',
    DP: 'DecodeParms',
    F: 'Filter',
    H: 'Height',
    IM: 'ImageMask',
    I: 'Interpolate',
    L: 'Length',
    W: 'Width',
  };
  const INLINE_VALUES = {
    G: 'DeviceGray',
    RGB: 'DeviceRGB',
    CMYK: 'DeviceCMYK',
    I: 'Indexed',
    AHx: 'ASCIIHexDecode',
    A85: 'ASCII85Decode',
    LZW: 'LZWDecode',
    Fl: 'FlateDecode',
    RL: 'RunLengthDecode',
    CCF: 'CCITTFaxDecode',
    DCT: 'DCTDecode',
  };

  /** Reads `<< key value ... >> ID <data> EI` after a BI operator. */
  function readInlineImage(bytes, pos, context, visit) {
    const dict = PDFDict.withContext(context);
    for (;;) {
      pos = skipSpace(bytes, pos);
      if (pos >= bytes.length) return pos;
      if (bytes[pos] === 0x49 && bytes[pos + 1] === 0x44 && isTokenEnd(bytes, pos + 2)) break; // ID
      const [key, afterKey] = parseObject(bytes, pos, context);
      if (!(key instanceof PDFName)) return afterKey; // not an inline image after all
      const [value, afterValue] = parseObject(bytes, afterKey, context);
      const keyText = key.decodeText();
      const fullKey = INLINE_KEYS[keyText] || keyText;
      dict.set(
        name(fullKey),
        fullKey === 'ColorSpace' || fullKey === 'Filter'
          ? expandInlineNames(value, context)
          : value,
      );
      pos = afterValue;
    }

    const start = pos + 3; // "ID" and the single white-space character after it
    const end = findInlineImageEnd(bytes, start, dict);
    if (end < 0) return bytes.length;
    visit.inlineImage({ dict, data: bytes.subarray(start, end), offset: start });
    // Continue after "EI".
    let after = skipSpace(bytes, end);
    if (bytes[after] === 0x45 && bytes[after + 1] === 0x49) after += 2;
    return after;
  }

  function expandInlineNames(value, context) {
    if (value instanceof PDFName) {
      const full = INLINE_VALUES[value.decodeText()];
      return full ? name(full) : value;
    }
    if (value instanceof PDFArray) {
      const array = PDFArray.withContext(context);
      for (let i = 0; i < value.size(); i++) array.push(expandInlineNames(value.get(i), context));
      return array;
    }
    return value;
  }

  /** Finds where an inline image's data stops (just before "EI"). */
  function findInlineImageEnd(bytes, start, dict) {
    const length = numberValue(dict.lookup(NAMES.Length));
    if (length > 0 && start + length <= bytes.length && endsWithEI(bytes, start + length)) {
      return start + length;
    }
    const filters = filterNames(dict.lookup(NAMES.Filter));
    if (filters.length === 0) {
      // Uncompressed: the size follows from the image's dimensions.
      const size = uncompressedSize(dict);
      if (size > 0 && endsWithEI(bytes, start + size)) return start + size;
    } else {
      const last = filters[filters.length - 1];
      if (last === 'ASCIIHexDecode' || last === 'ASCII85Decode') {
        const marker = last === 'ASCIIHexDecode' ? [0x3e] : [0x7e, 0x3e]; // > or ~>
        for (let i = start; i < bytes.length; i++) {
          if (marker.every((byte, j) => bytes[i + j] === byte)) return i + marker.length;
        }
        return -1;
      }
    }
    // Otherwise look for "EI" between white space, followed by more drawing
    // instructions rather than binary data.
    for (let i = start; i + 1 < bytes.length; i++) {
      if (
        bytes[i] === 0x45 &&
        bytes[i + 1] === 0x49 &&
        WHITESPACE[bytes[i - 1]] &&
        isTokenEnd(bytes, i + 2) &&
        looksLikeText(bytes, i + 2)
      ) {
        return i - 1;
      }
    }
    return -1;
  }

  function uncompressedSize(dict) {
    const width = numberValue(dict.lookup(NAMES.Width));
    const height = numberValue(dict.lookup(NAMES.Height));
    if (isTrue(dict.lookup(NAMES.ImageMask))) return Math.ceil(width / 8) * height;
    const bpc = numberValue(dict.lookup(NAMES.BitsPerComponent));
    const space = dict.lookup(NAMES.ColorSpace);
    const family = space instanceof PDFArray ? space.lookup(0) : space;
    const components = {
      DeviceGray: 1,
      DeviceRGB: 3,
      DeviceCMYK: 4,
      Indexed: 1,
    }[family instanceof PDFName ? family.decodeText() : ''];
    return components ? Math.ceil((width * components * bpc) / 8) * height : -1;
  }

  function endsWithEI(bytes, pos) {
    const at = skipSpace(bytes, pos);
    return bytes[at] === 0x45 && bytes[at + 1] === 0x49 && isTokenEnd(bytes, at + 2);
  }

  function isTokenEnd(bytes, pos) {
    return pos >= bytes.length || WHITESPACE[bytes[pos]] || DELIMITER[bytes[pos]];
  }

  function looksLikeText(bytes, pos) {
    const end = Math.min(bytes.length, pos + 32);
    for (let i = pos; i < end; i++) {
      const c = bytes[i];
      if (!WHITESPACE[c] && (c < 0x20 || c > 0x7e)) return false;
    }
    return true;
  }

  function skipSpace(bytes, pos) {
    while (pos < bytes.length) {
      if (WHITESPACE[bytes[pos]]) pos++;
      else if (bytes[pos] === 0x25) pos = skipComment(bytes, pos);
      else break;
    }
    return pos;
  }

  /** Parses one PDF object (as used in inline image dictionaries). */
  function parseObject(bytes, pos, context) {
    pos = skipSpace(bytes, pos);
    const c = bytes[pos];
    if (c === 0x2f) {
      const start = ++pos;
      while (pos < bytes.length && !WHITESPACE[bytes[pos]] && !DELIMITER[bytes[pos]]) pos++;
      return [name(decodeNameBytes(bytes, start, pos)), pos];
    }
    if (c === 0x28) {
      const end = skipLiteralString(bytes, pos);
      return [PDFString.of(latin1(bytes, pos + 1, end - 1)), end];
    }
    if (c === 0x3c && bytes[pos + 1] === 0x3c) {
      const dict = PDFDict.withContext(context);
      pos += 2;
      for (;;) {
        pos = skipSpace(bytes, pos);
        if (pos >= bytes.length) return [dict, pos];
        if (bytes[pos] === 0x3e && bytes[pos + 1] === 0x3e) return [dict, pos + 2];
        const [key, afterKey] = parseObject(bytes, pos, context);
        const [value, afterValue] = parseObject(bytes, afterKey, context);
        if (key instanceof PDFName) dict.set(key, value);
        pos = afterValue;
      }
    }
    if (c === 0x3c) {
      const end = skipHexString(bytes, pos);
      return [PDFHexString.of(latin1(bytes, pos + 1, end - 1).replace(/\s+/g, '')), end];
    }
    if (c === 0x5b) {
      const array = PDFArray.withContext(context);
      pos++;
      for (;;) {
        pos = skipSpace(bytes, pos);
        if (pos >= bytes.length) return [array, pos];
        if (bytes[pos] === 0x5d) return [array, pos + 1];
        const [value, after] = parseObject(bytes, pos, context);
        array.push(value);
        pos = after;
      }
    }
    const start = pos;
    while (pos < bytes.length && !WHITESPACE[bytes[pos]] && !DELIMITER[bytes[pos]]) pos++;
    if (pos === start) return [PDFNull, pos + 1];
    const word = latin1(bytes, start, pos);
    if (word === 'true') return [PDFBool.True, pos];
    if (word === 'false') return [PDFBool.False, pos];
    const number = Number(word);
    return [Number.isFinite(number) ? PDFNumber.of(number) : PDFNull, pos];
  }

  function latin1(bytes, start, end) {
    let text = '';
    for (let i = start; i < end; i++) text += String.fromCharCode(bytes[i]);
    return text;
  }

  // ==========================================================================
  // Saving images
  // ==========================================================================

  /**
   * Turns an image into a file.
   *
   * @param {ImageInfo} info  An image returned by findImages().
   * @returns {Promise<{bytes: Uint8Array, mimeType: string}>}
   * @throws {PdfCutterError} with code 'IMAGE_UNSUPPORTED' or 'IMAGE_DAMAGED'.
   */
  async function exportImage(info) {
    const { dict, data, resources, context } = info.source;
    try {
      if (info.format === 'jpg') {
        return { bytes: originalJpeg(dict, data, resources, context), mimeType: 'image/jpeg' };
      }
      const image = await readImage(dict, data, resources, context);
      const png = image.imageMask
        ? stencilToPng(image)
        : toPng(image, await readAlpha(dict, image, resources, context));
      return { bytes: await Formats.encodePng(png), mimeType: 'image/png' };
    } catch (error) {
      if (error instanceof PdfCutterError) throw error;
      throw new PdfCutterError(
        'IMAGE_DAMAGED',
        'This image could not be read. Its data may be damaged.',
        { cause: error },
      );
    }
  }

  function unsupported(what) {
    return new PdfCutterError(
      'IMAGE_UNSUPPORTED',
      `This image uses ${what}, which this tool can't convert.`,
    );
  }

  /** The JPEG file stored in the PDF, with the PDF's colour profile added. */
  function originalJpeg(dict, data, resources, context) {
    const filters = getFilters(dict, context);
    let jpeg = decodeGeneralFilters(data, filters.slice(0, -1));
    try {
      const space = resolveColorSpace(dict.lookup(NAMES.ColorSpace), resources, context);
      if (space.iccProfile) jpeg = Formats.addJpegIccProfile(jpeg, space.iccProfile);
    } catch {
      // The photo itself is fine without the colour profile.
    }
    return jpeg;
  }

  /**
   * Decodes an image into samples as the PDF defines them.
   *
   * @returns {Promise<{width: number, height: number, bitsPerComponent: number,
   *   colorSpace: object, samples: Uint8Array, decode: number[]|null,
   *   imageMask: boolean, alpha: Uint8Array|null}>}
   */
  async function readImage(dict, data, resources, context, { forceGray = false } = {}) {
    const width = numberValue(dict.lookup(NAMES.Width));
    const height = numberValue(dict.lookup(NAMES.Height));
    if (!(width >= 1 && height >= 1 && Number.isInteger(width) && Number.isInteger(height))) {
      throw new PdfCutterError('IMAGE_DAMAGED', 'This image has no valid size.');
    }
    if (width * height * 4 > MAX_IMAGE_BYTES) {
      throw new PdfCutterError(
        'IMAGE_UNSUPPORTED',
        `This image is too large to convert (${Math.round((width * height) / 1e6)} megapixels).`,
      );
    }
    const imageMask = isTrue(dict.lookup(NAMES.ImageMask));
    const decodeArray = numberArray(dict.lookup(NAMES.Decode));
    const filters = getFilters(dict, context);
    const last = filters.length > 0 ? filters[filters.length - 1].name : '';
    const image = {
      width,
      height,
      imageMask,
      decode: decodeArray,
      alpha: null,
      colorSpace: null,
      bitsPerComponent: imageMask ? 1 : numberValue(dict.lookup(NAMES.BitsPerComponent)),
      samples: null,
    };
    const colorSpace = () =>
      forceGray || imageMask
        ? GRAY
        : resolveColorSpace(dict.lookup(NAMES.ColorSpace), resources, context);

    if (!IMAGE_FILTERS.has(last)) {
      image.samples = decodeGeneralFilters(data, filters);
      image.colorSpace = colorSpace();
    } else {
      const bytes = decodeGeneralFilters(data, filters.slice(0, -1));
      const params = filters[filters.length - 1].params;
      if (last === 'DCTDecode') {
        const jpeg = await Decoders.decodeJpeg(bytes);
        if (jpeg.width !== width || jpeg.height !== height) {
          throw new PdfCutterError('IMAGE_DAMAGED', 'This image does not match its stated size.');
        }
        image.samples = jpeg.data;
        image.bitsPerComponent = 8;
        image.colorSpace = forceGray ? RGB_AS_GRAY : RGB;
        // Decode arrays are ignored for JPEG data, as when JPEG files are saved as they are.
        image.decode = null;
      } else if (last === 'JPXDecode') {
        Object.assign(
          image,
          await readJpx(dict, bytes, width, height, resources, context, forceGray),
        );
      } else {
        image.bitsPerComponent = 1;
        image.colorSpace = colorSpace();
        if (last === 'JBIG2Decode') {
          const globalsStream = params && context.lookup(params.get(NAMES.JBIG2Globals));
          const globals =
            globalsStream instanceof PDFRawStream
              ? decodeGeneralFilters(
                  globalsStream.contents,
                  getFilters(globalsStream.dict, context),
                )
              : null;
          image.samples = await Decoders.decodeJbig2(bytes, width, height, globals);
        } else {
          image.samples = await Decoders.decodeCcitt(
            bytes,
            width,
            height,
            ccittParams(params, width, height),
          );
        }
      }
    }

    const { bitsPerComponent: bpc } = image;
    if (![1, 2, 4, 8, 16].includes(bpc)) {
      throw new PdfCutterError('IMAGE_DAMAGED', `This image has an invalid bit depth (${bpc}).`);
    }
    // Pad data that ends early, as PDF viewers do.
    const components = image.colorSpace.components;
    const needed = Math.ceil((width * components * bpc) / 8) * height;
    if (image.samples.length < needed) {
      const padded = new Uint8Array(needed);
      padded.set(image.samples);
      image.samples = padded;
    }
    return image;
  }

  async function readJpx(dict, bytes, width, height, resources, context, forceGray) {
    const declared = dict.lookup(NAMES.ColorSpace);
    const colorSpace = forceGray
      ? GRAY
      : declared
        ? resolveColorSpace(declared, resources, context)
        : null;
    const smaskInData = numberValue(dict.lookup(NAMES.SMaskInData));
    const alphaInData = smaskInData > 0;
    const requested = colorSpace && colorSpace.kind !== 'indexed' ? colorSpace.components : 0;
    const pixels = await Decoders.decodeJpx(bytes, {
      components: alphaInData ? 0 : requested,
      alphaInData,
    });
    const channels = pixels.length / (width * height);
    if (!Number.isInteger(channels) || channels < 1 || channels > 4) {
      throw new PdfCutterError('IMAGE_DAMAGED', 'This image does not match its stated size.');
    }
    // Without a colour space in the PDF, or with alpha in the data, the
    // decoder gives gray, RGB or RGBA.
    let space = colorSpace;
    let samples = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.length);
    let alpha = null;
    if (!space || alphaInData || channels !== space.components) {
      if (channels === 4 && !(space && space.kind === 'cmyk')) {
        alpha = new Uint8Array(width * height);
        samples = new Uint8Array(width * height * 3);
        for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
          samples[i * 3] = pixels[j];
          samples[i * 3 + 1] = pixels[j + 1];
          samples[i * 3 + 2] = pixels[j + 2];
          alpha[i] = pixels[j + 3];
        }
        if (!alphaInData || alpha.every((value) => value === 255)) alpha = null;
        space = RGB;
      } else {
        space = channels === 1 ? GRAY : channels === 3 ? RGB : CMYK;
      }
      if (forceGray && space !== GRAY) space = channels === 1 ? GRAY : RGB_AS_GRAY;
    }
    // SMaskInData 2: the colours were pre-multiplied with the alpha, against
    // the Matte colour (black if none is given).
    const matte =
      alpha && smaskInData === 2
        ? numberArray(dict.lookup(NAMES.Matte)) || new Array(space.components).fill(0)
        : undefined;
    return { samples, alpha, matte, colorSpace: space, bitsPerComponent: 8, decode: null };
  }

  function ccittParams(params, width, height) {
    const get = (key, fallback) => {
      const value = params ? params.lookup(name(key)) : undefined;
      if (value instanceof PDFNumber) return value.asNumber();
      if (value instanceof PDFBool) return value.asBoolean();
      return fallback;
    };
    return {
      K: get('K', 0),
      EndOfLine: get('EndOfLine', false),
      EncodedByteAlign: get('EncodedByteAlign', false),
      BlackIs1: get('BlackIs1', false),
      Columns: get('Columns', width),
      Rows: get('Rows', height),
    };
  }

  // ---- Transparency ------------------------------------------------------------

  /**
   * The image's transparency as one 8-bit alpha value per pixel, or null if
   * the image is opaque.
   */
  async function readAlpha(dict, image, resources, context) {
    const { width, height } = image;
    if (image.alpha) return image.alpha;

    const softMask = context.lookup(dict.get(NAMES.SMask));
    if (softMask instanceof PDFRawStream) {
      const mask = await readImage(softMask.dict, softMask.contents, resources, context, {
        forceGray: true,
      });
      const alpha = grayValues(mask);
      const matte = numberArray(softMask.dict.lookup(NAMES.Matte));
      if (matte) image.matte = matte;
      return resize(alpha, mask.width, mask.height, width, height);
    }

    const mask = context.lookup(dict.get(NAMES.Mask));
    if (mask instanceof PDFRawStream) {
      // A stencil: where it is 0 the image shows, where it is 1 it does not.
      const stencil = await readImage(mask.dict, mask.contents, resources, context, {
        forceGray: true,
      });
      const shown = grayValues({ ...stencil, decode: stencil.decode || [0, 1] });
      for (let i = 0; i < shown.length; i++) shown[i] = shown[i] < 128 ? 255 : 0;
      return resize(shown, stencil.width, stencil.height, width, height);
    }
    if (mask instanceof PDFArray) {
      // Colour key masking: pixels whose raw values fall in these ranges are transparent.
      const ranges = numberArray(mask) || [];
      const components = image.colorSpace.components;
      if (ranges.length < components * 2) return null;
      const alpha = new Uint8Array(width * height).fill(255);
      const row = new Uint16Array(width * components);
      const rowBytes = Math.ceil((width * components * image.bitsPerComponent) / 8);
      for (let y = 0; y < height; y++) {
        unpackRow(image.samples, y * rowBytes, row.length, image.bitsPerComponent, row);
        for (let x = 0; x < width; x++) {
          let inside = true;
          for (let c = 0; c < components && inside; c++) {
            const value = row[x * components + c];
            inside = value >= ranges[c * 2] && value <= ranges[c * 2 + 1];
          }
          if (inside) alpha[y * width + x] = 0;
        }
      }
      return alpha;
    }
    return null;
  }

  /** 8-bit gray values (0-255) of a one-component image, after its Decode array. */
  function grayValues(image) {
    const { width, height, bitsPerComponent: bpc, samples, colorSpace } = image;
    const out = new Uint8Array(width * height);
    if (colorSpace === RGB_AS_GRAY) {
      // Decoded JPEG or JPEG 2000 data used as a mask: take the luminance.
      for (let i = 0; i < out.length; i++) {
        out[i] = Math.round(
          0.299 * samples[i * 3] + 0.587 * samples[i * 3 + 1] + 0.114 * samples[i * 3 + 2],
        );
      }
      return out;
    }
    const max = 2 ** bpc - 1;
    const [low, high] = image.decode || [0, 1];
    const row = new Uint16Array(width);
    const rowBytes = Math.ceil((width * bpc) / 8);
    for (let y = 0; y < height; y++) {
      unpackRow(samples, y * rowBytes, width, bpc, row);
      for (let x = 0; x < width; x++) {
        out[y * width + x] = clampByte((low + (row[x] / max) * (high - low)) * 255);
      }
    }
    return out;
  }

  function resize(values, fromWidth, fromHeight, toWidth, toHeight) {
    if (fromWidth === toWidth && fromHeight === toHeight) return values;
    const out = new Uint8Array(toWidth * toHeight);
    for (let y = 0; y < toHeight; y++) {
      const sourceRow =
        Math.min(fromHeight - 1, Math.floor((y * fromHeight) / toHeight)) * fromWidth;
      for (let x = 0; x < toWidth; x++) {
        out[y * toWidth + x] =
          values[sourceRow + Math.min(fromWidth - 1, Math.floor((x * fromWidth) / toWidth))];
      }
    }
    return out;
  }

  // ---- Building the PNG ---------------------------------------------------------

  /** A stencil mask is saved as black where it paints and transparent elsewhere. */
  function stencilToPng(image) {
    const { width, height, samples } = image;
    const paintWhen = image.decode && image.decode[0] === 1 ? 1 : 0;
    const data = new Uint8Array(width * height * 2);
    const rowBytes = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (samples[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        data[(y * width + x) * 2 + 1] = bit === paintWhen ? 255 : 0;
      }
    }
    return { width, height, colorType: 'grayAlpha', bitDepth: 8, data };
  }

  /**
   * Chooses the PNG layout for an image: its own bit depth and colours when
   * PNG can store them exactly, 8-bit gray or RGB otherwise.
   */
  function toPng(image, alpha) {
    const { width, height, bitsPerComponent: bpc, colorSpace: space, samples } = image;
    const decode = classifyDecode(image.decode, space, bpc);
    const rowBytes = Math.ceil((width * space.components * bpc) / 8);
    const exact = { width, height, bitDepth: bpc };

    if (!alpha && !image.matte) {
      if (space.kind === 'gray' && decode !== 'custom') {
        const data = samples.slice(0, rowBytes * height);
        if (decode === 'inverted') for (let i = 0; i < data.length; i++) data[i] = ~data[i];
        clearPaddingBits(data, width, height, bpc);
        return { ...exact, colorType: 'gray', data, iccProfile: space.iccProfile };
      }
      if (space.kind === 'rgb' && bpc >= 8 && decode === 'default') {
        return {
          ...exact,
          colorType: 'rgb',
          data: samples.subarray(0, rowBytes * height),
          iccProfile: space.iccProfile,
        };
      }
      if (space.kind === 'indexed' && bpc <= 8 && decode === 'default') {
        const data = samples.slice(0, rowBytes * height);
        clearPaddingBits(data, width, height, bpc);
        // PNG allows at most 2^bitDepth palette entries; unused ones are black.
        const palette = new Uint8Array(3 * 2 ** bpc);
        palette.set(space.palette.subarray(0, palette.length));
        return { ...exact, colorType: 'palette', data, palette, iccProfile: space.iccProfile };
      }
    }

    // Everything else becomes 8-bit gray or RGB, with alpha if needed.
    const gray = space.kind === 'gray';
    const colorChannels = gray ? 1 : 3;
    const channels = colorChannels + (alpha ? 1 : 0);
    const out = new Uint8Array(width * height * channels);
    const components = space.components;
    const max = 2 ** bpc - 1;
    const ranges = image.decode || defaultDecode(space, bpc);
    const lookup = Array.from({ length: components }, (_, c) => {
      const table = new Float64Array(bpc <= 8 ? max + 1 : 0);
      for (let v = 0; v < table.length; v++) {
        table[v] = ranges[c * 2] + (v / max) * (ranges[c * 2 + 1] - ranges[c * 2]);
      }
      return table;
    });
    const matte = image.matte;
    const row = new Uint16Array(width * components);
    const values = new Float64Array(components);
    const rgb = new Uint8Array(3);
    for (let y = 0; y < height; y++) {
      unpackRow(samples, y * rowBytes, row.length, bpc, row);
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < components; c++) {
          const raw = row[x * components + c];
          values[c] =
            bpc <= 8
              ? lookup[c][raw]
              : ranges[c * 2] + (raw / max) * (ranges[c * 2 + 1] - ranges[c * 2]);
        }
        const pixel = y * width + x;
        if (matte && alpha) {
          // Undo pre-multiplication with the matte colour.
          const a = alpha[pixel] / 255;
          if (a > 0) {
            for (let c = 0; c < components; c++) values[c] = matte[c] + (values[c] - matte[c]) / a;
          }
        }
        const o = pixel * channels;
        if (gray) {
          out[o] = clampByte(values[0] * 255);
        } else {
          space.toRgb(values, rgb);
          out[o] = rgb[0];
          out[o + 1] = rgb[1];
          out[o + 2] = rgb[2];
        }
        if (alpha) out[o + colorChannels] = alpha[pixel];
      }
    }
    return {
      width,
      height,
      colorType: gray ? (alpha ? 'grayAlpha' : 'gray') : alpha ? 'rgba' : 'rgb',
      bitDepth: 8,
      data: out,
      iccProfile:
        space.kind === 'gray' || space.kind === 'rgb' || space.kind === 'indexed'
          ? space.iccProfile
          : undefined,
    };
  }

  function defaultDecode(space, bpc) {
    if (space.kind === 'indexed') return [0, 2 ** bpc - 1];
    if (space.kind === 'lab') return [0, 100, ...space.range];
    return Array.from({ length: space.components * 2 }, (_, i) => i % 2);
  }

  /** 'default', 'inverted' (gray only) or 'custom'. */
  function classifyDecode(decode, space, bpc) {
    if (!decode) return 'default';
    const standard = defaultDecode(space, bpc);
    if (decode.length < standard.length) return 'default';
    if (standard.every((value, i) => decode[i] === value)) return 'default';
    if (space.kind === 'gray' && decode[0] === 1 && decode[1] === 0) return 'inverted';
    return 'custom';
  }

  /** Reads `count` samples of `bpc` bits from a row of packed samples. */
  function unpackRow(samples, offset, count, bpc, out) {
    if (bpc === 8) {
      for (let i = 0; i < count; i++) out[i] = samples[offset + i];
    } else if (bpc === 16) {
      for (let i = 0; i < count; i++) {
        out[i] = (samples[offset + 2 * i] << 8) | samples[offset + 2 * i + 1];
      }
    } else {
      const mask = (1 << bpc) - 1;
      for (let i = 0; i < count; i++) {
        const bit = i * bpc;
        out[i] = (samples[offset + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask;
      }
    }
  }

  /** Zeroes the unused bits at the end of each row, so output is identical everywhere. */
  function clearPaddingBits(data, width, height, bpc) {
    const used = (width * bpc) % 8;
    if (bpc >= 8 || used === 0) return;
    const rowBytes = Math.ceil((width * bpc) / 8);
    const mask = (0xff << (8 - used)) & 0xff;
    for (let y = 0; y < height; y++) data[y * rowBytes + rowBytes - 1] &= mask;
  }

  // ==========================================================================
  // Colour spaces
  // ==========================================================================

  const GRAY = { kind: 'gray', components: 1, toRgb: (v, out) => out.fill(clampByte(v[0] * 255)) };
  const RGB = {
    kind: 'rgb',
    components: 3,
    toRgb(v, out) {
      out[0] = clampByte(v[0] * 255);
      out[1] = clampByte(v[1] * 255);
      out[2] = clampByte(v[2] * 255);
    },
  };
  // Decoded RGB data that is used as a (gray) soft mask.
  const RGB_AS_GRAY = { ...RGB };
  const CMYK = { kind: 'cmyk', components: 4, toRgb: cmykToRgb };

  /**
   * Resolves a colour space into { kind, components, toRgb(values, out) } and,
   * where it applies, an ICC profile, palette or tint function.
   */
  function resolveColorSpace(value, resources, context, depth = 0) {
    if (depth > 10) throw unsupported('a colour space that refers to itself');
    value = context.lookup(value);
    if (value instanceof PDFName) {
      const text = INLINE_VALUES[value.decodeText()] || value.decodeText();
      const device = deviceColorSpace(text);
      if (device) return device;
      const named = lookupResource(resources, NAMES.ColorSpace, text, context, true);
      if (named !== undefined) return resolveColorSpace(named, resources, context, depth + 1);
      throw unsupported(`the colour space "${text}"`);
    }
    if (value instanceof PDFArray && value.size() > 0) {
      const family = context.lookup(value.get(0));
      const text =
        family instanceof PDFName ? INLINE_VALUES[family.decodeText()] || family.decodeText() : '';
      const device = deviceColorSpace(text);
      if (device) return device;
      if (text === 'ICCBased') {
        return iccColorSpace(context.lookup(value.get(1)), resources, context, depth);
      }
      if (text === 'Lab') return labColorSpace(context.lookup(value.get(1)));
      if (text === 'Indexed') return indexedColorSpace(value, resources, context, depth);
      if (text === 'Separation' || text === 'DeviceN') {
        return tintColorSpace(value, text, resources, context, depth);
      }
      throw unsupported(`the colour space "${text || 'unknown'}"`);
    }
    if (value === undefined) {
      throw new PdfCutterError('IMAGE_DAMAGED', 'This image has no colour space.');
    }
    throw unsupported('an unknown colour space');
  }

  function deviceColorSpace(text) {
    if (text === 'DeviceGray' || text === 'CalGray') return GRAY;
    if (text === 'DeviceRGB' || text === 'CalRGB') return RGB;
    if (text === 'DeviceCMYK') return CMYK;
    return null;
  }

  function iccColorSpace(stream, resources, context, depth) {
    if (!(stream instanceof PDFRawStream)) throw unsupported('a damaged colour profile');
    const components = numberValue(stream.dict.lookup(NAMES.N));
    const base = { 1: GRAY, 3: RGB, 4: CMYK }[components];
    if (!base) {
      const alternate = stream.dict.lookup(name('Alternate'));
      if (alternate) return resolveColorSpace(alternate, resources, context, depth + 1);
      throw unsupported(`a colour profile with ${components} components`);
    }
    let profile = null;
    try {
      profile = decodeGeneralFilters(stream.contents, getFilters(stream.dict, context));
    } catch {
      return base;
    }
    // Only gray and RGB profiles can go into PNG files, and only when they
    // describe what the PDF says (bytes 16-19 name the profile's colour space).
    const signature = profile.length >= 20 ? latin1(profile, 16, 20) : '';
    const fits =
      (components === 1 && signature === 'GRAY') || (components === 3 && signature === 'RGB ');
    const usableForJpeg = fits || (components === 4 && signature === 'CMYK');
    return { ...base, iccProfile: usableForJpeg ? profile : undefined, pngProfile: fits };
  }

  function labColorSpace(dict) {
    const entry = (key) => (dict instanceof PDFDict ? numberArray(dict.lookup(name(key))) : null);
    const range = entry('Range') || [-100, 100, -100, 100];
    const whitePoint = entry('WhitePoint');
    // The white point is required; without a usable one, assume D50, the usual one.
    const white =
      whitePoint && whitePoint.length === 3 && whitePoint.every((v) => v > 0) ? whitePoint : D50;
    const toLinearRgb = xyzToLinearSrgb(white);
    return {
      kind: 'lab',
      components: 3,
      range,
      toRgb: (v, out) => labToRgb(v, out, white, toLinearRgb),
    };
  }

  function indexedColorSpace(array, resources, context, depth) {
    const base = resolveColorSpace(array.get(1), resources, context, depth + 1);
    const highest = Math.max(
      0,
      Math.min(255, Math.floor(numberValue(context.lookup(array.get(2))))),
    );
    const lookupObject = context.lookup(array.get(3));
    let table;
    if (lookupObject instanceof PDFString || lookupObject instanceof PDFHexString) {
      table = lookupObject.asBytes();
    } else if (lookupObject instanceof PDFRawStream) {
      table = decodeGeneralFilters(lookupObject.contents, getFilters(lookupObject.dict, context));
    } else {
      throw new PdfCutterError('IMAGE_DAMAGED', 'This image has a damaged colour palette.');
    }
    const ranges = base.kind === 'lab' ? [0, 100, ...base.range] : null;
    const palette = new Uint8Array((highest + 1) * 3);
    const values = new Float64Array(base.components);
    const rgb = new Uint8Array(3);
    for (let i = 0; i <= highest; i++) {
      for (let c = 0; c < base.components; c++) {
        const byte = table[i * base.components + c] || 0;
        values[c] = ranges
          ? ranges[c * 2] + (byte / 255) * (ranges[c * 2 + 1] - ranges[c * 2])
          : byte / 255;
      }
      base.toRgb(values, rgb);
      palette.set(rgb, i * 3);
    }
    return {
      kind: 'indexed',
      components: 1,
      palette,
      // A palette PNG can carry an RGB profile.
      iccProfile: base.kind === 'rgb' && base.pngProfile ? base.iccProfile : undefined,
      toRgb(v, out) {
        const index = Math.max(0, Math.min(highest, Math.round(v[0]))) * 3;
        out[0] = palette[index];
        out[1] = palette[index + 1];
        out[2] = palette[index + 2];
      },
    };
  }

  /** Separation and DeviceN: inks turned into colours by a PDF function. */
  function tintColorSpace(array, family, resources, context, depth) {
    const components =
      family === 'Separation' ? 1 : (context.lookup(array.get(1)) || { size: () => 0 }).size();
    if (!components) throw unsupported('a damaged colour space');
    const alternate = resolveColorSpace(array.get(2), resources, context, depth + 1);
    const tint = compileFunction(array.get(3), context);
    const cache = new Map();
    const alternateValues = new Float64Array(alternate.components);
    return {
      kind: 'tint',
      components,
      toRgb(v, out) {
        const key = components === 1 ? v[0] : Array.prototype.join.call(v, ',');
        let color = cache.get(key);
        if (!color) {
          const result = tint(Array.from(v.subarray(0, components)));
          for (let c = 0; c < alternate.components; c++) alternateValues[c] = result[c] || 0;
          color = new Uint8Array(3);
          alternate.toRgb(alternateValues, color);
          if (cache.size < 65536) cache.set(key, color);
        }
        out.set(color);
      },
    };
  }

  // The coefficients below come from PDF.js (Apache-2.0): a fit of the
  // "U.S. Web Coated (SWOP)" CMYK profile, which looks far closer to print
  // than the naive formula.
  function cmykToRgb(v, out) {
    const c = clampUnit(v[0]);
    const m = clampUnit(v[1]);
    const y = clampUnit(v[2]);
    const k = clampUnit(v[3]);
    out[0] = clampByte(
      255 +
        c *
          (-4.387332384609988 * c +
            54.48615194189176 * m +
            18.82290502165302 * y +
            212.25662451639585 * k -
            285.2331026137004) +
        m *
          (1.7149763477362134 * m -
            5.6096736904047315 * y -
            17.873870861415444 * k -
            5.497006427196366) +
        y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) +
        k * (-21.86122147463605 * k - 189.48180835922747),
    );
    out[1] = clampByte(
      255 +
        c *
          (8.841041422036149 * c +
            60.118027045597366 * m +
            6.871425592049007 * y +
            31.159100130055922 * k -
            79.2970844816548) +
        m *
          (-15.310361306967817 * m +
            17.575251261109482 * y +
            131.35250912493976 * k -
            190.9453302588951) +
        y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) +
        k * (-20.737325471181034 * k - 187.80453709719578),
    );
    out[2] = clampByte(
      255 +
        c *
          (0.8842522430003296 * c +
            8.078677503112928 * m +
            30.89978309703729 * y -
            0.23883238689178934 * k -
            14.183576799673286) +
        m *
          (10.49593273432072 * m +
            63.02378494754052 * y +
            50.606957656360734 * k -
            112.23884253719248) +
        y * (0.03296041114873217 * y + 115.60384449646641 * k - 193.58209356861505) +
        k * (-22.33816807309886 * k - 180.12613974708367),
    );
  }

  /**
   * CIE L*a*b* to sRGB. The colour space's own white is mapped to sRGB's
   * white, as relative colorimetric conversion does.
   */
  function labToRgb(v, out, white, toLinearRgb) {
    const fy = (v[0] + 16) / 116;
    const fx = fy + v[1] / 500;
    const fz = fy - v[2] / 200;
    const inverse = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
    const x = inverse(fx) * white[0];
    const y = inverse(fy) * white[1];
    const z = inverse(fz) * white[2];
    for (let i = 0; i < 3; i++) {
      const m = toLinearRgb.subarray(i * 3, i * 3 + 3);
      const c = Math.max(0, m[0] * x + m[1] * y + m[2] * z);
      out[i] = clampByte(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
    }
  }

  const D50 = [0.9642, 1, 0.8249];
  const D65 = [0.95047, 1, 1.08883];
  const XYZ_TO_SRGB = [
    3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259,
    1.0572252,
  ];
  // The Bradford transform, which ICC colour management uses to adapt colours to another white.
  const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
  const BRADFORD_INVERSE = [
    0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428,
    0.9684867,
  ];

  /** The 3 × 3 matrix from XYZ colours seen under `white` to linear sRGB (seen under D65). */
  function xyzToLinearSrgb(white) {
    const product = (a, b) =>
      Float64Array.from({ length: 9 }, (_, i) => {
        const [row, column] = [Math.floor(i / 3), i % 3];
        return (
          a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column]
        );
      });
    const cone = (xyz) =>
      [0, 1, 2].map(
        (i) =>
          BRADFORD[i * 3] * xyz[0] + BRADFORD[i * 3 + 1] * xyz[1] + BRADFORD[i * 3 + 2] * xyz[2],
      );
    const [from, to] = [cone(white), cone(D65)];
    const scale = [to[0] / from[0], 0, 0, 0, to[1] / from[1], 0, 0, 0, to[2] / from[2]];
    return product(XYZ_TO_SRGB, product(BRADFORD_INVERSE, product(scale, BRADFORD)));
  }

  // ==========================================================================
  // PDF functions (used by spot-colour images)
  // ==========================================================================

  /** Turns a PDF function (types 0, 2, 3 and 4) into a JavaScript function. */
  function compileFunction(value, context, depth = 0) {
    if (depth > 10) throw unsupported('a colour function that refers to itself');
    value = context.lookup(value);
    if (value instanceof PDFArray) {
      const parts = value.asArray().map((part) => compileFunction(part, context, depth + 1));
      return (input) => parts.map((part) => part(input)[0]);
    }
    const dict = value instanceof PDFRawStream ? value.dict : value;
    if (!(dict instanceof PDFDict)) throw unsupported('a damaged colour function');
    const type = numberValue(dict.lookup(name('FunctionType')));
    const domain = numberArray(dict.lookup(name('Domain'))) || [0, 1];
    const range = numberArray(dict.lookup(name('Range')));
    let evaluate;
    if (type === 0 && value instanceof PDFRawStream) {
      evaluate = sampledFunction(value, domain, range, context);
    } else if (type === 2) {
      evaluate = exponentialFunction(dict);
    } else if (type === 3) {
      evaluate = stitchingFunction(dict, domain, context, depth);
    } else if (type === 4 && value instanceof PDFRawStream && range) {
      const program = postScriptFunction(
        decodeGeneralFilters(value.contents, getFilters(value.dict, context)),
      );
      // The results are the values left on the stack; take them from the top.
      evaluate = (input) => program(input).slice(-range.length / 2);
    } else {
      throw unsupported(`a type ${type} colour function`);
    }

    return (input) => {
      const clipped = input.map((x, i) => clamp(x, domain[i * 2] ?? 0, domain[i * 2 + 1] ?? 1));
      const output = evaluate(clipped);
      if (!range) return output;
      return output.map((y, i) => clamp(y, range[i * 2], range[i * 2 + 1]));
    };
  }

  function exponentialFunction(dict) {
    const c0 = numberArray(dict.lookup(name('C0'))) || [0];
    const c1 = numberArray(dict.lookup(name('C1'))) || [1];
    const exponent = numberValue(dict.lookup(name('N')));
    return ([x]) => c0.map((start, i) => start + x ** exponent * (c1[i] - start));
  }

  function stitchingFunction(dict, domain, context, depth) {
    const functions = context.lookup(dict.get(name('Functions')));
    const parts =
      functions instanceof PDFArray
        ? functions.asArray().map((f) => compileFunction(f, context, depth + 1))
        : [];
    const bounds = numberArray(dict.lookup(name('Bounds'))) || [];
    const encode = numberArray(dict.lookup(name('Encode'))) || [];
    if (parts.length === 0) throw unsupported('a damaged colour function');
    return ([x]) => {
      let i = 0;
      while (i < bounds.length && x >= bounds[i]) i++;
      const low = i === 0 ? domain[0] : bounds[i - 1];
      const high = i === bounds.length ? domain[1] : bounds[i];
      const t = high === low ? 0 : (x - low) / (high - low);
      return parts[i]([encode[i * 2] + t * (encode[i * 2 + 1] - encode[i * 2])]);
    };
  }

  function sampledFunction(stream, domain, range, context) {
    const dict = stream.dict;
    const size = numberArray(dict.lookup(name('Size'))) || [];
    const bits = numberValue(dict.lookup(name('BitsPerSample')));
    const inputs = size.length;
    const outputs = range ? range.length / 2 : 0;
    if (!inputs || !outputs || ![1, 2, 4, 8, 12, 16, 24, 32].includes(bits)) {
      throw unsupported('a damaged colour function');
    }
    const encode = numberArray(dict.lookup(name('Encode'))) || size.flatMap((s) => [0, s - 1]);
    const decode = numberArray(dict.lookup(name('Decode'))) || range;
    const data = decodeGeneralFilters(stream.contents, getFilters(dict, context));
    const maxSample = 2 ** bits - 1;
    const sample = (index) => {
      // Samples are packed without padding.
      let value = 0;
      for (let b = 0; b < bits; b++) {
        const bit = index * bits + b;
        value = value * 2 + ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
      }
      return value;
    };
    return (input) => {
      // Multilinear interpolation between the surrounding samples.
      const positions = input.map((x, i) => {
        const e =
          encode[i * 2] +
          ((x - domain[i * 2]) / (domain[i * 2 + 1] - domain[i * 2] || 1)) *
            (encode[i * 2 + 1] - encode[i * 2]);
        return clamp(e, 0, size[i] - 1);
      });
      const result = new Array(outputs).fill(0);
      for (let corner = 0; corner < 1 << inputs; corner++) {
        let weight = 1;
        let offset = 0;
        let stride = 1;
        for (let i = 0; i < inputs; i++) {
          const low = Math.floor(positions[i]);
          const high = Math.min(low + 1, size[i] - 1);
          const fraction = positions[i] - low;
          const useHigh = (corner >> i) & 1;
          weight *= useHigh ? fraction : 1 - fraction;
          offset += (useHigh ? high : low) * stride;
          stride *= size[i];
        }
        if (weight === 0) continue;
        for (let o = 0; o < outputs; o++) result[o] += weight * sample(offset * outputs + o);
      }
      return result.map(
        (value, o) => decode[o * 2] + (value / maxSample) * (decode[o * 2 + 1] - decode[o * 2]),
      );
    };
  }

  /** Type 4 functions: a small PostScript calculator program. */
  function postScriptFunction(codeBytes) {
    const tokens = latin1(codeBytes, 0, codeBytes.length).match(/[{}]|[^\s{}]+/g) || [];
    let index = 0;
    const parseBlock = () => {
      const block = [];
      while (index < tokens.length) {
        const token = tokens[index++];
        if (token === '{') block.push(parseBlock());
        else if (token === '}') return block;
        else block.push(Number.isNaN(Number(token)) ? token : Number(token));
      }
      return block;
    };
    while (index < tokens.length && tokens[index] !== '{') index++;
    index++;
    const program = parseBlock();

    const run = (block, stack) => {
      for (const token of block) {
        if (typeof token === 'number' || Array.isArray(token)) {
          stack.push(token);
          continue;
        }
        if (token === 'true' || token === 'false') {
          stack.push(token === 'true');
          continue;
        }
        let x;
        let y;
        // prettier-ignore
        switch (token) {
          case 'add': y = stack.pop(); stack.push(stack.pop() + y); break;
          case 'sub': y = stack.pop(); stack.push(stack.pop() - y); break;
          case 'mul': y = stack.pop(); stack.push(stack.pop() * y); break;
          case 'div': y = stack.pop(); stack.push(stack.pop() / y); break;
          case 'idiv': y = stack.pop(); stack.push(Math.trunc(stack.pop() / y)); break;
          case 'mod': y = stack.pop(); stack.push(stack.pop() % y); break;
          case 'neg': stack.push(-stack.pop()); break;
          case 'abs': stack.push(Math.abs(stack.pop())); break;
          case 'ceiling': stack.push(Math.ceil(stack.pop())); break;
          case 'floor': stack.push(Math.floor(stack.pop())); break;
          case 'round': stack.push(Math.round(stack.pop())); break;
          case 'truncate': case 'cvi': stack.push(Math.trunc(stack.pop())); break;
          case 'cvr': break;
          case 'sqrt': stack.push(Math.sqrt(stack.pop())); break;
          case 'sin': stack.push(Math.sin((stack.pop() * Math.PI) / 180)); break;
          case 'cos': stack.push(Math.cos((stack.pop() * Math.PI) / 180)); break;
          case 'atan': {
            y = stack.pop();
            const angle = (Math.atan2(stack.pop(), y) * 180) / Math.PI;
            stack.push(angle < 0 ? angle + 360 : angle);
            break;
          }
          case 'exp': y = stack.pop(); stack.push(stack.pop() ** y); break;
          case 'ln': stack.push(Math.log(stack.pop())); break;
          case 'log': stack.push(Math.log10(stack.pop())); break;
          case 'eq': y = stack.pop(); stack.push(stack.pop() === y); break;
          case 'ne': y = stack.pop(); stack.push(stack.pop() !== y); break;
          case 'gt': y = stack.pop(); stack.push(stack.pop() > y); break;
          case 'ge': y = stack.pop(); stack.push(stack.pop() >= y); break;
          case 'lt': y = stack.pop(); stack.push(stack.pop() < y); break;
          case 'le': y = stack.pop(); stack.push(stack.pop() <= y); break;
          case 'and': y = stack.pop(); x = stack.pop(); stack.push(typeof x === 'boolean' ? x && y : x & y); break;
          case 'or': y = stack.pop(); x = stack.pop(); stack.push(typeof x === 'boolean' ? x || y : x | y); break;
          case 'xor': y = stack.pop(); x = stack.pop(); stack.push(typeof x === 'boolean' ? x !== y : x ^ y); break;
          case 'not': x = stack.pop(); stack.push(typeof x === 'boolean' ? !x : ~x); break;
          case 'bitshift': y = stack.pop(); x = stack.pop(); stack.push(y >= 0 ? x << y : x >> -y); break;
          case 'dup': stack.push(stack[stack.length - 1]); break;
          case 'exch': y = stack.pop(); x = stack.pop(); stack.push(y, x); break;
          case 'pop': stack.pop(); break;
          case 'copy': { const n = stack.pop(); stack.push(...stack.slice(stack.length - n)); break; }
          case 'index': { const n = stack.pop(); stack.push(stack[stack.length - 1 - n]); break; }
          case 'roll': {
            const j = stack.pop();
            const n = stack.pop();
            if (n > 0) {
              const items = stack.splice(stack.length - n, n);
              const shift = ((j % n) + n) % n;
              stack.push(...items.slice(n - shift), ...items.slice(0, n - shift));
            }
            break;
          }
          case 'if': { const proc = stack.pop(); if (stack.pop()) run(proc, stack); break; }
          case 'ifelse': {
            const otherwise = stack.pop();
            const then = stack.pop();
            run(stack.pop() ? then : otherwise, stack);
            break;
          }
          default:
            throw unsupported(`the colour function operator "${token}"`);
        }
      }
      return stack;
    };
    return (input) => run(program, [...input]);
  }

  // ==========================================================================
  // Stream filters
  // ==========================================================================

  /** The filters of a stream (or inline image) and their parameters. */
  function getFilters(dict, context) {
    const names = filterNames(dict.lookup(NAMES.Filter), context);
    const params = context
      ? context.lookup(dict.get(NAMES.DecodeParms))
      : dict.lookup(NAMES.DecodeParms);
    return names.map((filterName, i) => {
      let filterParams = params instanceof PDFArray ? params.lookup(i) : params;
      if (context) filterParams = context.lookup(filterParams);
      return { name: filterName, params: filterParams instanceof PDFDict ? filterParams : null };
    });
  }

  function filterNames(filter, context) {
    const values = filter instanceof PDFArray ? filter.asArray() : filter ? [filter] : [];
    return values.map((value) => {
      const resolved = context ? context.lookup(value) : value;
      const text = resolved instanceof PDFName ? resolved.decodeText() : '';
      return INLINE_VALUES[text] || text;
    });
  }

  /** Applies the general-purpose filters: zip, LZW, ASCII and run-length. */
  function decodeGeneralFilters(data, filters) {
    for (const { name: filterName, params } of filters) {
      if (filterName === 'Crypt') continue; // already decrypted when the PDF was opened
      if (!GENERAL_FILTERS.has(filterName)) throw unsupported(`the "${filterName}" compression`);
      const dict = PDFDict.withContext(PDFLib.PDFContext.create());
      dict.set(NAMES.Filter, name(filterName));
      if (params) dict.set(NAMES.DecodeParms, params);
      data = PDFLib.decodePDFRawStream(PDFRawStream.of(dict, data)).decode();
      if (params) data = applyPredictor(data, params);
    }
    return data;
  }

  /** Undoes the PNG or TIFF "predictor" step that often comes with zip compression. */
  function applyPredictor(data, params) {
    const get = (key, fallback) => {
      const value = numberValue(params.lookup(name(key)));
      return Number.isFinite(value) ? value : fallback;
    };
    const predictor = get('Predictor', 1);
    if (predictor <= 1) return data;
    const colors = get('Colors', 1);
    const bits = get('BitsPerComponent', 8);
    const columns = get('Columns', 1);
    const rowBytes = Math.ceil((colors * bits * columns) / 8);
    const pixelBytes = Math.max(1, Math.ceil((colors * bits) / 8));

    if (predictor === 2) return tiffPredictor(data, rowBytes, colors, bits, columns);
    if (predictor < 10) throw unsupported(`predictor ${predictor}`);

    const rows = Math.floor(data.length / (rowBytes + 1));
    const out = new Uint8Array(rows * rowBytes);
    for (let y = 0; y < rows; y++) {
      const type = data[y * (rowBytes + 1)];
      const src = y * (rowBytes + 1) + 1;
      const dst = y * rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const raw = data[src + i];
        const left = i >= pixelBytes ? out[dst + i - pixelBytes] : 0;
        const up = y > 0 ? out[dst - rowBytes + i] : 0;
        let value;
        if (type === 0) value = raw;
        else if (type === 1) value = raw + left;
        else if (type === 2) value = raw + up;
        else if (type === 3) value = raw + ((left + up) >> 1);
        else if (type === 4) {
          const upLeft = y > 0 && i >= pixelBytes ? out[dst - rowBytes + i - pixelBytes] : 0;
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
        } else {
          throw new PdfCutterError('IMAGE_DAMAGED', 'This image data is damaged.');
        }
        out[dst + i] = value;
      }
    }
    return out;
  }

  function tiffPredictor(data, rowBytes, colors, bits, columns) {
    const rows = Math.floor(data.length / rowBytes);
    const out = new Uint8Array(rows * rowBytes);
    for (let y = 0; y < rows; y++) {
      const start = y * rowBytes;
      if (bits === 8) {
        for (let i = 0; i < rowBytes; i++) {
          out[start + i] = data[start + i] + (i >= colors ? out[start + i - colors] : 0);
        }
      } else if (bits === 16) {
        for (let i = 0; i < rowBytes; i += 2) {
          let value = (data[start + i] << 8) | data[start + i + 1];
          if (i >= colors * 2) {
            value += (out[start + i - colors * 2] << 8) | out[start + i - colors * 2 + 1];
          }
          out[start + i] = (value >> 8) & 0xff;
          out[start + i + 1] = value & 0xff;
        }
      } else {
        const mask = (1 << bits) - 1;
        const previous = new Array(colors).fill(0);
        for (let x = 0; x < columns; x++) {
          for (let c = 0; c < colors; c++) {
            const bit = (x * colors + c) * bits;
            const byte = start + (bit >> 3);
            const shift = 8 - bits - (bit & 7);
            previous[c] = (previous[c] + ((data[byte] >> shift) & mask)) & mask;
            out[byte] |= previous[c] << shift;
          }
        }
      }
    }
    return out;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Finds a named resource (an XObject, colour space, pattern, ...). Returns
   * the entry as stored (possibly a reference) when `raw` is set.
   */
  function lookupResource(resources, category, resourceName, context, raw = false) {
    const group =
      resources instanceof PDFDict ? context.lookup(resources.get(category)) : undefined;
    if (!(group instanceof PDFDict)) return undefined;
    let entry = group.get(name(resourceName));
    if (entry === undefined) {
      // Names with unusual characters may be written differently.
      for (const [key, value] of group.entries()) {
        if (key.decodeText() === resourceName) {
          entry = value;
          break;
        }
      }
    }
    return raw ? entry : context.lookup(entry);
  }

  function numberValue(value) {
    return value instanceof PDFNumber ? value.asNumber() : NaN;
  }

  function numberArray(value) {
    if (!(value instanceof PDFArray)) return null;
    const numbers = value
      .asArray()
      .map((item) => numberValue(item instanceof PDFRef ? undefined : item));
    return numbers.every(Number.isFinite) ? numbers : null;
  }

  function isTrue(value) {
    return value instanceof PDFBool && value.asBoolean();
  }

  function clamp(value, low, high) {
    return value < low ? low : value > high ? high : value;
  }

  function clampUnit(value) {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }

  function clampByte(value) {
    return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
  }

  /**
   * Suggests a name for the folder or ZIP file of images, e.g. "book_images"
   * or "book_images_pages_12-27".
   *
   * @param {string} inputName  Name (or path) of the PDF.
   * @param {string} [label]  The `label` from parsePageSelection(), if not all pages.
   */
  function suggestImagesName(inputName, label) {
    const base = PdfCutter.fileBaseName(inputName);
    if (!label) return `${base}_images`;
    if (/^\d+$/.test(label)) return `${base}_images_page_${label}`;
    return label.length <= 40 ? `${base}_images_pages_${label}` : `${base}_images_selected_pages`;
  }

  return { findImages, exportImage, suggestImagesName };
});
