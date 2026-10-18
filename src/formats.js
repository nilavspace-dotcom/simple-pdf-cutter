/*!
 * Simple PDF Cutter - writers for the file formats used when saving images:
 * PNG, ZIP, and colour profiles in JPEG files.
 *
 * In a browser this file defines `window.PdfCutterFormats`; in Node.js it can
 * be loaded with `require()`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    const zlib = require('node:zlib');
    module.exports = factory(async (bytes) => new Uint8Array(zlib.deflateSync(bytes)));
  } else {
    root.PdfCutterFormats = factory(async (bytes) => {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
  }
})(globalThis, function (deflate) {
  'use strict';

  // --------------------------------------------------------------------------
  // CRC-32, as used by PNG and ZIP
  // --------------------------------------------------------------------------

  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c;
  }

  /**
   * @param {Uint8Array} bytes
   * @param {number} [crc]  The CRC of the data before `bytes`, to continue it.
   * @returns {number}
   */
  function crc32(bytes, crc = 0) {
    let c = ~crc;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // --------------------------------------------------------------------------
  // PNG
  // --------------------------------------------------------------------------

  const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const PNG_COLOR_TYPES = {
    gray: { code: 0, channels: 1 },
    rgb: { code: 2, channels: 3 },
    palette: { code: 3, channels: 1 },
    grayAlpha: { code: 4, channels: 2 },
    rgba: { code: 6, channels: 4 },
  };

  /**
   * Encodes an image as a PNG file, without losing any detail.
   *
   * @param {object} image
   * @param {number} image.width
   * @param {number} image.height
   * @param {'gray'|'rgb'|'palette'|'grayAlpha'|'rgba'} image.colorType
   * @param {1|2|4|8|16} image.bitDepth  Bits per sample, as PNG allows for the colour type.
   * @param {Uint8Array} image.data  The samples row by row; every row starts on a
   *   new byte, and 16-bit samples are big-endian.
   * @param {Uint8Array} [image.palette]  RGB triples, for the 'palette' colour type.
   * @param {Uint8Array} [image.iccProfile]  A colour profile for the image's colours.
   * @returns {Promise<Uint8Array>}
   */
  async function encodePng(image) {
    const { width, height, bitDepth, data, palette, iccProfile } = image;
    const colorType = PNG_COLOR_TYPES[image.colorType];
    if (!colorType) throw new TypeError(`Unknown PNG colour type: ${image.colorType}`);
    const rowBytes = Math.ceil((width * colorType.channels * bitDepth) / 8);
    if (!(width > 0 && height > 0) || data.length < rowBytes * height) {
      throw new RangeError('The image data does not match its size');
    }

    const header = new DataView(new ArrayBuffer(13));
    header.setUint32(0, width);
    header.setUint32(4, height);
    header.setUint8(8, bitDepth);
    header.setUint8(9, colorType.code);
    const chunks = [pngChunk('IHDR', new Uint8Array(header.buffer))];
    if (iccProfile) {
      // Profile name, a zero byte, compression method 0, compressed profile.
      chunks.push(
        pngChunk('iCCP', concat([ascii('ICC profile'), [0, 0], await deflate(iccProfile)])),
      );
    }
    if (palette) chunks.push(pngChunk('PLTE', palette));
    // Row filters help photos compress; palette and sub-byte images do best
    // without them (as the PNG specification recommends).
    const bytesPerPixel =
      colorType.code === 3 || bitDepth < 8 ? 0 : (colorType.channels * bitDepth) / 8;
    chunks.push(pngChunk('IDAT', await deflate(filterRows(data, rowBytes, height, bytesPerPixel))));
    chunks.push(pngChunk('IEND', new Uint8Array(0)));
    return concat([PNG_SIGNATURE, ...chunks]);
  }

  function pngChunk(type, data) {
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    chunk.set(ascii(type), 4);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
  }

  /**
   * Prefixes every row with a PNG filter type. With `bytesPerPixel` 0 no
   * filter is used; otherwise each row gets the filter that leaves the
   * smallest values (the heuristic recommended by the PNG specification).
   */
  function filterRows(data, rowBytes, height, bytesPerPixel) {
    const out = new Uint8Array((rowBytes + 1) * height);
    if (!bytesPerPixel) {
      for (let y = 0; y < height; y++) {
        out.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1);
      }
      return out;
    }

    const bpp = bytesPerPixel;
    const zeroRow = new Uint8Array(rowBytes);
    const costs = new Float64Array(5);
    for (let y = 0; y < height; y++) {
      const row = data.subarray(y * rowBytes, (y + 1) * rowBytes);
      const above = y > 0 ? data.subarray((y - 1) * rowBytes, y * rowBytes) : zeroRow;
      // First pass: score every filter for this row.
      let none = 0;
      let sub = 0;
      let up = 0;
      let average = 0;
      let paethSum = 0;
      for (let i = 0; i < rowBytes; i++) {
        const value = row[i];
        const left = i >= bpp ? row[i - bpp] : 0;
        const upper = above[i];
        const upperLeft = i >= bpp ? above[i - bpp] : 0;
        none += cost(value);
        sub += cost(value - left);
        up += cost(value - upper);
        average += cost(value - ((left + upper) >> 1));
        paethSum += cost(value - paeth(left, upper, upperLeft));
      }
      costs[0] = none;
      costs[1] = sub;
      costs[2] = up;
      costs[3] = average;
      costs[4] = paethSum;
      let best = 0;
      for (let type = 1; type < 5; type++) if (costs[type] < costs[best]) best = type;
      // Second pass: write the row with the best filter.
      const start = y * (rowBytes + 1);
      out[start] = best;
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const upper = above[i];
        let predicted = 0;
        if (best === 1) predicted = left;
        else if (best === 2) predicted = upper;
        else if (best === 3) predicted = (left + upper) >> 1;
        else if (best === 4) predicted = paeth(left, upper, i >= bpp ? above[i - bpp] : 0);
        out[start + 1 + i] = row[i] - predicted;
      }
    }
    return out;
  }

  /** How far a filtered byte is from zero, read as a signed value. */
  function cost(difference) {
    const v = difference & 0xff;
    return v < 128 ? v : 256 - v;
  }

  function paeth(left, upper, upperLeft) {
    const pa = upper > upperLeft ? upper - upperLeft : upperLeft - upper; // |p - left|
    const pb = left > upperLeft ? left - upperLeft : upperLeft - left; // |p - upper|
    const pc = Math.abs(left + upper - 2 * upperLeft); // |p - upperLeft|
    return pa <= pb && pa <= pc ? left : pb <= pc ? upper : upperLeft;
  }

  // --------------------------------------------------------------------------
  // JPEG colour profiles
  // --------------------------------------------------------------------------

  const ICC_MARKER = ascii('ICC_PROFILE\0');

  /**
   * Adds a colour profile to a JPEG file, unless it already has one.
   *
   * @param {Uint8Array} jpeg
   * @param {Uint8Array} profile  An ICC profile.
   * @returns {Uint8Array}
   */
  function addJpegIccProfile(jpeg, profile) {
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
    // Walk the segments before the image data. JFIF and Exif segments must
    // stay first, so the profile goes after them.
    let insertAt = 2;
    let offset = 2;
    while (offset + 4 <= jpeg.length && jpeg[offset] === 0xff) {
      const marker = jpeg[offset + 1];
      if (marker === 0xff) {
        offset += 1; // fill byte
        continue;
      }
      if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
      const length = (jpeg[offset + 2] << 8) | jpeg[offset + 3];
      if (marker === 0xe2 && startsWith(jpeg, offset + 4, ICC_MARKER)) return jpeg;
      if (marker === 0xe0 || marker === 0xe1) insertAt = offset + 2 + length;
      offset += 2 + length;
    }

    const chunkSize = 65535 - 2 - ICC_MARKER.length - 2;
    const count = Math.ceil(profile.length / chunkSize);
    if (count === 0 || count > 255) return jpeg;
    const segments = [];
    for (let i = 0; i < count; i++) {
      const chunk = profile.subarray(i * chunkSize, (i + 1) * chunkSize);
      const length = 2 + ICC_MARKER.length + 2 + chunk.length;
      segments.push([0xff, 0xe2, length >> 8, length & 0xff], ICC_MARKER, [i + 1, count], chunk);
    }
    return concat([jpeg.subarray(0, insertAt), ...segments, jpeg.subarray(insertAt)]);
  }

  // --------------------------------------------------------------------------
  // ZIP
  // --------------------------------------------------------------------------

  /**
   * Builds a ZIP file. Files are stored as they are, without compressing them
   * again, which suits images: they are compressed already.
   *
   * @param {Array<{name: string, data: Blob|Uint8Array, size: number, crc32: number}>} files
   * @param {Date} [date]  Modification time recorded for every file.
   * @returns {Blob}
   */
  function createZip(files, date = new Date()) {
    if (files.length > 0xffff) {
      throw new RangeError('Too many files for one ZIP file; choose fewer.');
    }
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day =
      (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

    const parts = [];
    const directory = [];
    let offset = 0;
    for (const file of files) {
      const name = new TextEncoder().encode(file.name);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); // local file header
      local.setUint16(4, 20, true); // version needed to extract
      local.setUint16(6, 0x0800, true); // file name is UTF-8
      local.setUint16(8, 0, true); // stored, not compressed
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, file.crc32, true);
      local.setUint32(18, file.size, true);
      local.setUint32(22, file.size, true);
      local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, file.data);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true); // central directory header
      central.setUint16(4, 20, true); // version made by
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, time, true);
      central.setUint16(14, day, true);
      central.setUint32(16, file.crc32, true);
      central.setUint32(20, file.size, true);
      central.setUint32(24, file.size, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      directory.push(new Uint8Array(central.buffer), name);

      offset += 30 + name.length + file.size;
      if (offset > 0xffffffff) {
        throw new RangeError('The images are too large for one ZIP file; choose fewer.');
      }
    }

    const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); // end of central directory
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, new Uint8Array(end.buffer)], {
      type: 'application/zip',
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  function ascii(text) {
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
  }

  function startsWith(bytes, offset, prefix) {
    for (let i = 0; i < prefix.length; i++) if (bytes[offset + i] !== prefix[i]) return false;
    return true;
  }

  function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  return { crc32, encodePng, addJpegIccProfile, createZip };
});
