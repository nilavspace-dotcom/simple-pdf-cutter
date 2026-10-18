'use strict';

// Shared by the unit tests and the browser tests.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const PDFLib = require('../vendor/pdf-lib/pdf-lib.min.js');

const { PDFDocument, PDFName, StandardFonts } = PDFLib;

const fixturePath = (name) => path.join(__dirname, 'fixtures', name);

/**
 * Makes a test PDF in which page n is (200 + n) points wide and shows
 * "Page n", so the page numbers in any excerpt can be read back with
 * originalPageNumbers().
 *
 * @param {number} pageCount
 * @param {{encrypt?: object, edit?: (doc: PDFLib.PDFDocument) => void}} [options]
 *   `encrypt` is passed to PDFDocument.encrypt(); `edit` can change the
 *   document before it is saved.
 */
async function makeNumberedPdf(pageCount, options = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pageCount; n++) {
    const page = doc.addPage([200 + n, 300]);
    page.drawText(`Page ${n}`, { x: 20, y: 150, size: 24, font });
  }
  if (options.edit) options.edit(doc);
  if (options.encrypt) doc.encrypt(options.encrypt);
  return doc.save();
}

/** Reads back which pages of a makeNumberedPdf() document a file contains. */
async function originalPageNumbers(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => Math.round(page.getWidth()) - 200);
}

/** Counts all page objects in a file, including ones not in its page list. */
async function countPageObjects(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.context
    .enumerateIndirectObjects()
    .filter(([, object]) => object instanceof PDFLib.PDFDict)
    .filter(([, object]) => object.lookup(PDFName.of('Type')) === PDFName.of('Page')).length;
}

/** The decoded content stream(s) of a page, as text. */
function pageContentText(page) {
  const contents = page.node.Contents();
  const streams =
    contents instanceof PDFLib.PDFArray
      ? contents.asArray().map((ref) => page.doc.context.lookup(ref))
      : [contents];
  return streams
    .map((stream) => Buffer.from(PDFLib.decodePDFRawStream(stream).decode()).toString('latin1'))
    .join('\n');
}

/**
 * Makes a 3-page PDF with pictures: photo.jpg on pages 1 and 3 (the same
 * image object, like a logo), and on page 2 photo.png and a tiny 8 × 8
 * gray picture whose pixels are 0, 4, 8, ... 252.
 */
async function makeImagesPdf() {
  const doc = await PDFDocument.create();
  const jpg = await doc.embedJpg(fs.readFileSync(fixturePath('photo.jpg')));
  const png = await doc.embedPng(fs.readFileSync(fixturePath('photo.png')));
  const tiny = doc.context.register(
    doc.context.flateStream(
      Uint8Array.from({ length: 64 }, (_, i) => i * 4),
      {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 8,
        Height: 8,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      },
    ),
  );
  for (let n = 1; n <= 3; n++) {
    const page = doc.addPage([200 + n, 300]);
    if (n === 2) {
      page.drawImage(png, { x: 20, y: 100, width: 120, height: 90 });
      const tinyName = page.node.newXObject('Tiny', tiny);
      page.pushOperators(
        PDFLib.pushGraphicsState(),
        PDFLib.concatTransformationMatrix(8, 0, 0, 8, 160, 250),
        PDFLib.drawObject(tinyName),
        PDFLib.popGraphicsState(),
      );
    } else {
      page.drawImage(jpg, { x: 20, y: 100, width: 128, height: 96 });
    }
  }
  return doc.save();
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_COLOR_TYPES = {
  0: ['gray', 1],
  2: ['rgb', 3],
  3: ['palette', 1],
  4: ['grayAlpha', 2],
  6: ['rgba', 4],
};

/**
 * Reads a PNG file exactly as stored, checking its structure and checksums
 * along the way. Written for the tests, independently of src/formats.js.
 *
 * @returns {{width: number, height: number, bitDepth: number, colorType: string,
 *   chunks: string[], palette: Uint8Array|null, iccProfile: Uint8Array|null,
 *   filters: number[], samples: number[]}}  `samples` are the stored values,
 *   row after row, without the padding at the end of rows.
 */
function readPng(bytes) {
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Not a PNG file');
  const chunks = [];
  const compressed = [];
  let header;
  let palette = null;
  let iccProfile = null;
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (
      zlib.crc32(buffer.subarray(offset + 4, offset + 8 + length)) !==
      buffer.readUInt32BE(offset + 8 + length)
    ) {
      throw new Error(`Wrong checksum in the ${type} chunk`);
    }
    chunks.push(type);
    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorTypeCode: data[9],
        interlaced: data[12] !== 0,
      };
    } else if (type === 'PLTE') {
      palette = new Uint8Array(data);
    } else if (type === 'iCCP') {
      const nameEnd = data.indexOf(0);
      if (data[nameEnd + 1] !== 0) throw new Error('Unknown iCCP compression');
      iccProfile = new Uint8Array(zlib.inflateSync(data.subarray(nameEnd + 2)));
    } else if (type === 'IDAT') {
      compressed.push(data);
    }
    offset += 12 + length;
  }
  if (chunks[0] !== 'IHDR' || chunks[chunks.length - 1] !== 'IEND') {
    throw new Error('Misplaced chunks');
  }
  if (header.interlaced) throw new Error('Interlaced PNG files are not expected');

  const [colorType, channels] = PNG_COLOR_TYPES[header.colorTypeCode];
  const { width, height, bitDepth } = header;
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const pixelBytes = Math.max(1, (channels * bitDepth) / 8);
  const filtered = zlib.inflateSync(Buffer.concat(compressed));
  if (filtered.length !== (rowBytes + 1) * height) throw new Error('Wrong amount of image data');

  // Undo the row filters (PNG specification, section 9).
  const rows = new Uint8Array(rowBytes * height);
  const filters = [];
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (rowBytes + 1)];
    filters.push(filter);
    for (let i = 0; i < rowBytes; i++) {
      const x = filtered[y * (rowBytes + 1) + 1 + i];
      const a = i >= pixelBytes ? rows[y * rowBytes + i - pixelBytes] : 0;
      const b = y > 0 ? rows[(y - 1) * rowBytes + i] : 0;
      const c = y > 0 && i >= pixelBytes ? rows[(y - 1) * rowBytes + i - pixelBytes] : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter];
      if (predicted === undefined) throw new Error(`Unknown filter type ${filter}`);
      rows[y * rowBytes + i] = (x + predicted) & 0xff;
    }
  }

  const samples = [];
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < width * channels; i++) {
      const row = y * rowBytes;
      if (bitDepth === 16) samples.push((rows[row + 2 * i] << 8) | rows[row + 2 * i + 1]);
      else {
        const bit = i * bitDepth;
        samples.push(
          (rows[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1),
        );
      }
    }
    // Padding bits at the end of a row should be zero.
    const usedBits = (width * channels * bitDepth) % 8;
    if (usedBits && rows[y * rowBytes + rowBytes - 1] & (0xff >> usedBits)) {
      throw new Error(`Padding bits are set in row ${y}`);
    }
  }
  return { width, height, bitDepth, colorType, chunks, palette, iccProfile, filters, samples };
}

/**
 * Decodes a PNG file into 8-bit RGBA pixels with the PNG decoder inside
 * pdf-lib (UPNG.js): a second, independent reading of the file.
 */
async function decodePng(bytes) {
  const { image } = await PDFLib.PngEmbedder.for(new Uint8Array(bytes));
  const { width, height, rgbChannel, alphaChannel } = image;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba.set(rgbChannel.subarray(i * 3, i * 3 + 3), i * 4);
    rgba[i * 4 + 3] = alphaChannel ? alphaChannel[i] : 255;
  }
  return { width, height, rgba };
}

/** The ICC colour profile stored in a JPEG file (APP2 segments), or null. */
function jpegIccProfile(bytes) {
  const buffer = Buffer.from(bytes);
  const chunks = [];
  for (let offset = 2; offset + 4 <= buffer.length && buffer[offset] === 0xff; ) {
    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break; // the image data starts
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xe2 && buffer.toString('latin1', offset + 4, offset + 16) === 'ICC_PROFILE\0') {
      const [sequence, count] = [buffer[offset + 16], buffer[offset + 17]];
      chunks.push({ sequence, count, data: buffer.subarray(offset + 18, offset + 2 + length) });
    }
    offset += 2 + length;
  }
  if (chunks.length === 0) return null;
  if (chunks.some((chunk, i) => chunk.sequence !== i + 1 || chunk.count !== chunks.length)) {
    throw new Error('Badly numbered ICC profile chunks');
  }
  return new Uint8Array(Buffer.concat(chunks.map((chunk) => chunk.data)));
}

/**
 * Reads a ZIP file of stored (uncompressed) files, checking that its two
 * directories agree and that every file matches its checksum. Written for
 * the tests, independently of src/formats.js.
 *
 * @returns {Array<{name: string, data: Uint8Array, date: Date, utf8: boolean}>}
 */
function readZip(bytes) {
  const buffer = Buffer.from(bytes);
  const end = buffer.length - 22; // the files carry no comment
  if (buffer.readUInt32LE(end) !== 0x06054b50) throw new Error('No end of central directory');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (offset + buffer.readUInt32LE(end + 12) !== end) {
    throw new Error('Wrong central directory size');
  }

  const files = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('Bad central directory entry');
    const entry = {
      flags: buffer.readUInt16LE(offset + 8),
      method: buffer.readUInt16LE(offset + 10),
      time: buffer.readUInt16LE(offset + 12),
      day: buffer.readUInt16LE(offset + 14),
      crc: buffer.readUInt32LE(offset + 16),
      compressedSize: buffer.readUInt32LE(offset + 20),
      size: buffer.readUInt32LE(offset + 24),
      name: buffer.subarray(offset + 46, offset + 46 + buffer.readUInt16LE(offset + 28)),
    };
    const local = buffer.readUInt32LE(offset + 42);
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('Bad local file header');
    const localName = buffer.subarray(local + 30, local + 30 + buffer.readUInt16LE(local + 26));
    const matches =
      buffer.readUInt16LE(local + 6) === entry.flags &&
      buffer.readUInt16LE(local + 8) === entry.method &&
      buffer.readUInt16LE(local + 10) === entry.time &&
      buffer.readUInt16LE(local + 12) === entry.day &&
      buffer.readUInt32LE(local + 14) === entry.crc &&
      buffer.readUInt32LE(local + 18) === entry.compressedSize &&
      buffer.readUInt32LE(local + 22) === entry.size &&
      localName.equals(entry.name);
    if (!matches) throw new Error(`The two headers of file ${i + 1} differ`);
    if (entry.method !== 0 || entry.size !== entry.compressedSize) {
      throw new Error('Expected stored files');
    }

    const start = local + 30 + localName.length + buffer.readUInt16LE(local + 28);
    const data = new Uint8Array(buffer.subarray(start, start + entry.size));
    const name = entry.name.toString(entry.flags & 0x800 ? 'utf8' : 'latin1');
    if (zlib.crc32(data) !== entry.crc) throw new Error(`Wrong checksum for ${name}`);
    const date = new Date(
      1980 + (entry.day >> 9),
      ((entry.day >> 5) & 15) - 1,
      entry.day & 31,
      entry.time >> 11,
      (entry.time >> 5) & 63,
      (entry.time & 31) * 2,
    );
    files.push({ name, data, date, utf8: Boolean(entry.flags & 0x800) });
    offset +=
      46 + entry.name.length + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return files;
}

const toolAvailable = new Map();

/**
 * Runs a command-line tool on a file when the tool is installed, as an
 * independent second opinion that the file is well-formed.
 *
 * @returns {{skipped: true} | {skipped: false, ok: boolean, output: string}}
 */
function checkWithTool(tool, args, bytes, fileName, isOk) {
  if (!toolAvailable.has(tool)) {
    try {
      execFileSync('sh', ['-c', 'command -v "$1"', 'sh', tool], { stdio: 'ignore' });
      toolAvailable.set(tool, true);
    } catch {
      toolAvailable.set(tool, false);
    }
  }
  if (!toolAvailable.get(tool)) return { skipped: true };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pdf-cutter-${tool}-`));
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, bytes);
  try {
    const output = execFileSync(tool, [...args, file], { encoding: 'utf8', stdio: 'pipe' });
    return { skipped: false, ok: isOk(output), output };
  } catch (error) {
    // A non-zero exit code; qpdf, for example, exits with 3 for warnings and 2 for errors.
    return { skipped: false, ok: false, output: `${error.stdout}${error.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** `qpdf --check`, when qpdf is installed. */
function checkWithQpdf(bytes) {
  return checkWithTool('qpdf', ['--check'], bytes, 'check.pdf', (output) =>
    /No syntax or stream encoding errors found/.test(output),
  );
}

/** `unzip -t`, when unzip is installed. */
function checkWithUnzip(bytes) {
  return checkWithTool('unzip', ['-t'], bytes, 'check.zip', (output) =>
    /No errors detected/.test(output),
  );
}

module.exports = {
  PDFLib,
  makeNumberedPdf,
  makeImagesPdf,
  originalPageNumbers,
  countPageObjects,
  pageContentText,
  readPng,
  decodePng,
  jpegIccProfile,
  readZip,
  checkWithQpdf,
  checkWithUnzip,
  fixturePath,
};
