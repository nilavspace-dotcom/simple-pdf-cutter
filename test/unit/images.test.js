'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { after, before, describe, test } = require('node:test');
const { openPdf } = require('../../src/pdf-cutter.js');
const { findImages, exportImage, suggestImagesName } = require('../../src/pdf-images.js');
const Decoders = require('../../src/decoders.js');
const JpegJs = require('../../vendor/jpeg-js/decoder.js');
const { PDFLib, readPng, decodePng, jpegIccProfile, fixturePath } = require('../helpers.js');

const { PDFDocument, PDFName, PDFHexString } = PDFLib;

const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);
const fixture = (name) => new Uint8Array(fs.readFileSync(fixturePath(name)));

// ---- Making test PDFs ---------------------------------------------------------

const DRAW_IM0 = 'q 100 0 0 100 50 50 cm /Im0 Do Q';

/**
 * Makes a PDF and opens it the way the app does. Each argument describes a
 * page: a function that receives the document's context (to create objects
 * with) and returns the page's `resources`, and optionally its `content`
 * (text or bytes, or a list of them; by default it draws /Im0) and `annots`.
 */
async function makePdf(...pages) {
  const doc = await PDFDocument.create();
  const { context } = doc;
  for (const describePage of pages) {
    const { resources = {}, content = DRAW_IM0, annots } = describePage(context);
    const page = doc.addPage([200, 200]);
    page.node.set(PDFName.of('Resources'), context.obj(resources));
    const streams = (Array.isArray(content) ? content : [content]).map((part) =>
      context.register(context.stream(part)),
    );
    page.node.set(PDFName.of('Contents'), streams.length === 1 ? streams[0] : context.obj(streams));
    if (annots) page.node.set(PDFName.of('Annots'), context.obj(annots));
  }
  return openPdf(await doc.save());
}

/** Registers an image XObject with the given data and dictionary entries. */
function image(context, data, entries) {
  return context.register(context.stream(data, { Type: 'XObject', Subtype: 'Image', ...entries }));
}

/** A small gray image whose pixels depend on `seed`, so every one is different. */
function grayImage(context, seed, width = 20, height = 20) {
  const data = Uint8Array.from({ length: width * height }, (_, i) => (i * 7 + seed * 31) % 256);
  return image(context, data, {
    Width: width,
    Height: height,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 8,
  });
}

/** Registers a form XObject; without `resources` it uses those of the page. */
function form(context, content, resources) {
  const entries = { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1] };
  if (resources) entries.Resources = resources;
  return context.register(context.stream(content, entries));
}

/** Converts the one image of a one-page PDF; `makeImage(context)` creates it. */
async function convert(makeImage, pageResources = {}) {
  const pdf = await makePdf((context) => ({
    resources: { ...pageResources, XObject: { Im0: makeImage(context) } },
  }));
  const images = await findImages(pdf, [1]);
  assert.equal(images.length, 1, 'expected one image');
  return { info: images[0], ...(await exportImage(images[0])) };
}

/** Like convert(), for images saved as PNG: returns the file as stored and as decoded. */
async function convertToPng(makeImage, pageResources) {
  const { info, bytes, mimeType } = await convert(makeImage, pageResources);
  assert.equal(mimeType, 'image/png');
  assert.equal(info.format, 'png');
  return { png: readPng(bytes), ...(await decodePng(bytes)) };
}

/** Packs sample values into rows of `bits`-bit samples, each row starting on a new byte. */
function pack(values, bits, perRow) {
  const rowBytes = Math.ceil((perRow * bits) / 8);
  const out = new Uint8Array(rowBytes * Math.ceil(values.length / perRow));
  values.forEach((value, i) => {
    const offset = Math.floor(i / perRow) * rowBytes;
    const column = i % perRow;
    if (bits === 16) {
      out[offset + 2 * column] = value >> 8;
      out[offset + 2 * column + 1] = value & 0xff;
    } else {
      const bit = column * bits;
      out[offset + (bit >> 3)] |= value << (8 - bits - (bit & 7));
    }
  });
  return out;
}

/** Repeatable pseudo-random sample values below 2^bits. */
function samples(count, bits, seed = 1) {
  return Array.from({ length: count }, (_, i) => {
    const hash = Math.imul(i + seed, 2654435761) >>> 0;
    return Math.floor((hash / 2 ** 32) * 2 ** bits);
  });
}

/** The RGB values of decoded pixels, without alpha. */
function rgbOf({ rgba }) {
  return [...rgba].filter((_, i) => i % 4 !== 3);
}

function alphaOf({ rgba }) {
  return [...rgba].filter((_, i) => i % 4 === 3);
}

function assertClose(actual, expected, tolerance, message) {
  assert.equal(actual.length, expected.length, `${message}: length`);
  const index = actual.findIndex((value, i) => Math.abs(value - expected[i]) > tolerance);
  if (index >= 0) {
    assert.fail(
      `${message}: value ${index} is ${actual[index]}, expected ${expected[index]} (±${tolerance})`,
    );
  }
}

function assertSamePixels(actual, expected) {
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], 'size');
  const index = actual.rgba.findIndex((value, i) => value !== expected.rgba[i]);
  if (index >= 0) {
    const pixel = index >> 2;
    const at = (pixels) => [...pixels.rgba.subarray(pixel * 4, pixel * 4 + 4)].join(', ');
    assert.fail(
      `pixel (${pixel % actual.width}, ${Math.floor(pixel / actual.width)}) is ` +
        `(${at(actual)}) instead of (${at(expected)})`,
    );
  }
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'PdfCutterError');
    assert.equal(error.code, code, error.message);
    return true;
  });
}

/** Bytes from text, with every character as one byte. */
const bytes = (text) => Buffer.from(text, 'latin1');

/** The shape of an ImageInfo, without the internals in `source`. */
const summary = ({ pages, index, width, height, format, small, inline, fileName }) => ({
  pages,
  index,
  width,
  height,
  format,
  small,
  inline,
  fileName,
});

// ---- Finding images ---------------------------------------------------------------

describe('findImages', () => {
  test('lists each image drawn on the chosen pages once, with the pages it is on', async () => {
    const pdf = await makePdf(
      (context) => {
        const logo = grayImage(context, 1);
        return {
          resources: { XObject: { Logo: logo, Photo: grayImage(context, 2, 30, 20) } },
          content: '/Logo Do /Photo Do /Logo Do',
        };
      },
      () => ({ resources: {}, content: 'BT ET' }),
      (context) => ({
        resources: {
          XObject: { Photo: grayImage(context, 3, 40, 30), Unused: grayImage(context, 4) },
        },
        content: '/Photo Do',
      }),
    );
    // Use the same logo object on page 2.
    const logoRef = pdf
      .getPage(0)
      .node.Resources()
      .lookup(PDFName.of('XObject'))
      .get(PDFName.of('Logo'));
    pdf.getPage(1).node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: { L: logoRef } }));
    const contents = pdf.context.lookup(pdf.getPage(1).node.get(PDFName.of('Contents')));
    contents.contents = bytes('q 5 0 0 5 0 0 cm /L Do Q');

    const all = await findImages(pdf, [1, 2, 3]);
    assert.deepEqual(all.map(summary), [
      {
        pages: [1, 2],
        index: 1,
        width: 20,
        height: 20,
        format: 'png',
        small: false,
        inline: false,
        fileName: 'page-1_image-1.png',
      },
      {
        pages: [1],
        index: 2,
        width: 30,
        height: 20,
        format: 'png',
        small: false,
        inline: false,
        fileName: 'page-1_image-2.png',
      },
      {
        pages: [3],
        index: 1,
        width: 40,
        height: 30,
        format: 'png',
        small: false,
        inline: false,
        fileName: 'page-3_image-1.png',
      },
    ]);

    const some = await findImages(pdf, [2, 3]);
    assert.deepEqual(
      some.map(({ pages, fileName }) => [pages, fileName]),
      [
        [[2], 'page-2_image-1.png'],
        [[3], 'page-3_image-1.png'],
      ],
    );
  });

  test('numbers the files with as many digits as the last page needs', async () => {
    const pages = range(1, 12).map(
      (n) => (context) =>
        n === 3 || n === 12
          ? { resources: { XObject: { Im0: grayImage(context, n) } } }
          : { content: '' },
    );
    const images = await findImages(await makePdf(...pages), range(1, 12));
    assert.deepEqual(
      images.map((info) => info.fileName),
      ['page-03_image-1.png', 'page-12_image-1.png'],
    );
  });

  test('finds images in forms, tiling patterns and annotations', async () => {
    const pdf = await makePdf(
      (context) => {
        const inner = form(context, '/Img Do', { XObject: { Img: grayImage(context, 1) } });
        const outer = form(context, '/Inner Do', { XObject: { Inner: inner } });
        // The form is drawn twice; its image is still listed once.
        return {
          resources: { XObject: { Fm0: outer } },
          content: '/Fm0 Do q 1 0 0 1 50 50 cm /Fm0 Do Q',
        };
      },
      (context) => {
        const tile = context.register(
          context.stream('/T Do', {
            Type: 'Pattern',
            PatternType: 1,
            PaintType: 1,
            TilingType: 1,
            BBox: [0, 0, 10, 10],
            XStep: 10,
            YStep: 10,
            Resources: { XObject: { T: grayImage(context, 2) } },
          }),
        );
        const shading = context.obj({ PatternType: 2, Shading: { ShadingType: 2 } });
        return {
          resources: { Pattern: { P0: tile, P1: shading } },
          content: '/Pattern cs /P0 scn 0 0 100 100 re f /Pattern CS /P1 SCN 0 0 m 9 9 l S',
        };
      },
      (context) => {
        const appearance = (seed) =>
          form(context, '/S Do', { XObject: { S: grayImage(context, seed) } });
        return {
          resources: {},
          content: '',
          annots: [
            context.obj({
              Type: 'Annot',
              Subtype: 'Stamp',
              Rect: [0, 0, 50, 50],
              AP: { N: appearance(3) },
            }),
            // Hidden annotations are not shown, so their images are not listed.
            context.obj({
              Type: 'Annot',
              Subtype: 'Stamp',
              Rect: [0, 0, 50, 50],
              F: 2,
              AP: { N: appearance(4) },
            }),
            // A checkbox shows the appearance of its current state.
            context.obj({
              Type: 'Annot',
              Subtype: 'Widget',
              Rect: [0, 0, 50, 50],
              AS: 'On',
              AP: { N: { On: appearance(5), Off: appearance(6) } },
            }),
            context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50] }),
          ],
        };
      },
    );

    const images = await findImages(pdf, [1, 2, 3]);
    assert.deepEqual(
      images.map(({ pages, fileName }) => [pages, fileName]),
      [
        [[1], 'page-1_image-1.png'],
        [[2], 'page-2_image-1.png'],
        [[3], 'page-3_image-1.png'],
        [[3], 'page-3_image-2.png'],
      ],
    );
    // The images of the stamp and of the checkbox's "On" state.
    const shown = await Promise.all(
      images.slice(2).map(async (info) => (await exportImage(info)).bytes),
    );
    const expected = await Promise.all(
      [3, 5].map(async (seed) => {
        const { bytes: png } = await convert((context) => grayImage(context, seed));
        return png;
      }),
    );
    assert.deepEqual(shown, expected);
  });

  test("uses the page's resources for forms that have none of their own", async () => {
    const pdf = await makePdf((context) => ({
      resources: { XObject: { Im0: grayImage(context, 1), Fm0: form(context, '/Im0 Do') } },
      content: '/Fm0 Do',
    }));
    // The same form on a second page, where /Im0 is another image.
    const formRef = pdf
      .getPage(0)
      .node.Resources()
      .lookup(PDFName.of('XObject'))
      .get(PDFName.of('Fm0'));
    const page2 = pdf.addPage([200, 200]);
    page2.node.set(
      PDFName.of('Resources'),
      pdf.context.obj({ XObject: { Im0: grayImage(pdf.context, 2, 25, 25), Fm0: formRef } }),
    );
    page2.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.stream('/Fm0 Do')));

    const images = await findImages(pdf, [1, 2]);
    assert.deepEqual(
      images.map(({ pages, width }) => [pages, width]),
      [
        [[1], 20],
        [[2], 25],
      ],
    );
  });

  test('copes with forms that draw themselves', async () => {
    const pdf = await makePdf((context) => {
      const looping = form(context, '/Self Do /Img Do');
      context
        .lookup(looping)
        .dict.set(
          PDFName.of('Resources'),
          context.obj({ XObject: { Self: looping, Img: grayImage(context, 1) } }),
        );
      return { resources: { XObject: { Fm0: looping } }, content: '/Fm0 Do' };
    });
    assert.equal((await findImages(pdf, [1])).length, 1);
  });

  test('reads drawing instructions split over several streams, and names with special characters', async () => {
    const pdf = await makePdf((context) => ({
      resources: { XObject: { Im0: grayImage(context, 1), 'Im 1': grayImage(context, 2) } },
      content: [
        'q 10 0 0 10 0 0 cm /Im0',
        'Do Q (a string with /Im9 Do in it) Tj % /Im9 Do\n/Im#201 Do',
      ],
    }));
    assert.equal((await findImages(pdf, [1])).length, 2);
  });

  test('finds images drawn inline in the drawing instructions', async () => {
    const pdf = await makePdf((context) => ({
      resources: {
        XObject: { Fm0: form(context, 'BI /W 2 /H 1 /BPC 8 /CS /G ID \x00\xff EI', {}) },
      },
      content:
        'BI /W 1 /H 1 /BPC 8 /CS /G ID \x80 EI /Fm0 Do q BI /W 3 /H 1 /BPC 8 /CS /G ID abc EI Q',
    }));
    const images = await findImages(pdf, [1]);
    assert.deepEqual(
      images.map(({ inline, width, fileName }) => [inline, width, fileName]),
      [
        [true, 1, 'page-1_image-1.png'],
        [true, 2, 'page-1_image-2.png'],
        [true, 3, 'page-1_image-3.png'],
      ],
    );
  });

  test('marks tiny images as small', async () => {
    const pdf = await makePdf((context) => ({
      resources: {
        XObject: {
          A: grayImage(context, 1, 15, 40),
          B: grayImage(context, 2, 40, 15),
          C: grayImage(context, 3, 16, 16),
        },
      },
      content: '/A Do /B Do /C Do',
    }));
    assert.deepEqual(
      (await findImages(pdf, [1])).map((info) => info.small),
      [true, true, false],
    );
  });

  test('reports its progress', async () => {
    const pdf = await makePdf(
      () => ({ content: '' }),
      () => ({ content: '' }),
      () => ({ content: '' }),
    );
    const calls = [];
    await findImages(pdf, [3, 1, 2], { onProgress: (...args) => calls.push(args) });
    assert.deepEqual(calls, [
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  test('skips pages it cannot read and images without a size', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const pdf = await makePdf(
      (context) => ({ resources: { XObject: { Im0: grayImage(context, 1) } } }),
      (context) => ({
        resources: {
          XObject: {
            Im0: image(context, new Uint8Array(4), {
              Width: 0,
              Height: 2,
              ColorSpace: 'DeviceGray',
              BitsPerComponent: 8,
            }),
          },
        },
      }),
      (context) => ({ resources: { XObject: { Im0: grayImage(context, 3) } } }),
    );
    // Damage the drawing instructions of page 1.
    const contents = pdf.context.lookup(pdf.getPage(0).node.get(PDFName.of('Contents')));
    contents.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    contents.contents = bytes('this is not compressed data');

    const images = await findImages(pdf, [1, 2, 3]);
    assert.deepEqual(
      images.map((info) => info.pages),
      [[3]],
    );
    assert.ok(warn.mock.callCount() <= 1);
  });
});

// ---- Converting images ------------------------------------------------------------

describe('exportImage', () => {
  const W = 13; // odd, so rows of small samples end part-way through a byte
  const H = 5;

  describe('gray and RGB images', () => {
    for (const bits of [1, 2, 4, 8, 16]) {
      test(`keeps ${bits}-bit gray images exactly`, async () => {
        const values = samples(W * H, bits, bits);
        let data = pack(values, bits, W);
        const entries = { Width: W, Height: H, ColorSpace: 'DeviceGray', BitsPerComponent: bits };
        if (bits === 16) {
          data = zlib.deflateSync(data);
          entries.Filter = 'FlateDecode';
        }
        const { png } = await convertToPng((context) => image(context, data, entries));
        assert.deepEqual([png.colorType, png.bitDepth], ['gray', bits]);
        assert.deepEqual(png.samples, values);
      });
    }

    test('inverts gray images whose Decode array says so', async () => {
      for (const bits of [1, 8]) {
        const values = samples(W * H, bits);
        const { png } = await convertToPng((context) =>
          image(context, pack(values, bits, W), {
            Width: W,
            Height: H,
            ColorSpace: 'DeviceGray',
            BitsPerComponent: bits,
            Decode: [1, 0],
          }),
        );
        assert.deepEqual([png.colorType, png.bitDepth], ['gray', bits]);
        assert.deepEqual(
          png.samples,
          values.map((value) => 2 ** bits - 1 - value),
        );
      }
    });

    for (const bits of [8, 16]) {
      test(`keeps ${bits}-bit RGB images exactly`, async () => {
        const values = samples(W * H * 3, bits);
        const { png } = await convertToPng((context) =>
          image(context, pack(values, bits, W * 3), {
            Width: W,
            Height: H,
            ColorSpace: 'DeviceRGB',
            BitsPerComponent: bits,
          }),
        );
        assert.deepEqual([png.colorType, png.bitDepth], ['rgb', bits]);
        assert.deepEqual(png.samples, values);
      });
    }

    test('undoes PNG predictors', async () => {
      const values = samples(W * H * 3, 8);
      const rows = pack(values, 8, W * 3);
      // Each row with another of the five PNG filter types.
      const rowBytes = W * 3;
      const predicted = [];
      for (let y = 0; y < H; y++) {
        const type = y % 5;
        predicted.push(type);
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= 3 ? rows[y * rowBytes + i - 3] : 0;
          const b = y > 0 ? rows[(y - 1) * rowBytes + i] : 0;
          const c = y > 0 && i >= 3 ? rows[(y - 1) * rowBytes + i - 3] : 0;
          const p = a + b - c;
          const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
          const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          predicted.push((rows[y * rowBytes + i] - [0, a, b, (a + b) >> 1, paeth][type]) & 0xff);
        }
      }
      const { png } = await convertToPng((context) =>
        image(context, zlib.deflateSync(Uint8Array.from(predicted)), {
          Width: W,
          Height: H,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Filter: 'FlateDecode',
          DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: W },
        }),
      );
      assert.deepEqual(png.samples, values);
    });

    for (const [space, colors, bits] of [
      ['DeviceRGB', 3, 8],
      ['DeviceRGB', 3, 16],
      ['DeviceGray', 1, 4],
    ]) {
      test(`undoes the TIFF predictor (${colors} × ${bits} bits)`, async () => {
        const values = samples(W * H * colors, bits);
        // Store each sample as the difference from the same colour of the pixel before.
        const differences = values.map((value, i) => {
          const column = i % (W * colors);
          const before = column >= colors ? values[i - colors] : 0;
          return (value - before + 2 ** bits) % 2 ** bits;
        });
        const { png } = await convertToPng((context) =>
          image(context, zlib.deflateSync(pack(differences, bits, W * colors)), {
            Width: W,
            Height: H,
            ColorSpace: space,
            BitsPerComponent: bits,
            Filter: 'FlateDecode',
            DecodeParms: { Predictor: 2, Colors: colors, BitsPerComponent: bits, Columns: W },
          }),
        );
        assert.deepEqual(png.samples, values);
      });
    }

    test('decodes chains of filters', async () => {
      const values = [...samples(30, 8), ...new Array(40).fill(7), ...samples(8, 8, 5)];
      // Run-length encoding: a literal run, a repeated byte, a literal run, end of data.
      const runLength = [29, ...values.slice(0, 30), 257 - 40, 7, 7, ...values.slice(70), 128];
      const hex =
        Buffer.from(runLength)
          .toString('hex')
          .replace(/(.{20})/g, '$1\n') + '>';
      const { png } = await convertToPng((context) =>
        image(context, hex, {
          Width: 26,
          Height: 1,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Filter: ['ASCIIHexDecode', 'RunLengthDecode'],
        }),
      );
      assert.deepEqual(png.samples, values);
    });

    test('applies Decode arrays that change the colours', async () => {
      const values = samples(W * 3, 8);
      const { png } = await convertToPng((context) =>
        image(context, Uint8Array.from(values), {
          Width: W,
          Height: 1,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          Decode: [1, 0, 0, 0.5, 0.2, 1],
        }),
      );
      const expected = values.map((value, i) => {
        const t = value / 255;
        return Math.round(255 * [1 - t, 0.5 * t, 0.2 + 0.8 * t][i % 3]);
      });
      assertClose(png.samples, expected, 1, 'colours');
    });

    test('fills in image data that ends early, as PDF viewers do', async () => {
      const { png } = await convertToPng((context) =>
        image(context, Uint8Array.of(10, 20, 30, 40, 50, 60), {
          Width: 4,
          Height: 3,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8,
        }),
      );
      assert.deepEqual(png.samples, [10, 20, 30, 40, 50, 60, 0, 0, 0, 0, 0, 0]);
    });
  });

  describe('other colour spaces', () => {
    test('converts CMYK to RGB the way PDF.js does', async () => {
      const inks = [
        [0, 0, 0, 0],
        [255, 0, 0, 0],
        [0, 255, 0, 0],
        [0, 0, 255, 0],
        [0, 0, 0, 255],
      ];
      const pixels = await convertToPng((context) =>
        image(context, Uint8Array.from(inks.flat()), {
          Width: 5,
          Height: 1,
          ColorSpace: 'DeviceCMYK',
          BitsPerComponent: 8,
        }),
      );
      assert.deepEqual(pixels.png.colorType, 'rgb');
      assert.deepEqual(rgbOf(pixels), [
        ...[255, 255, 255], // paper
        ...[0, 185, 242], // cyan
        ...[251, 49, 153], // magenta
        ...[255, 235, 61], // yellow
        ...[44, 46, 53], // black
      ]);
    });

    test('converts Lab colours to sRGB as colour management does', async () => {
      // L* 0 to 100 and a*, b* -128 to 127, as bytes.
      const colors = [
        [255, 128, 128], // white
        [0, 128, 128], // black
        [128, 128, 128], // middle gray
        [136, 208, 195], // red
        [150, 160, 90],
        [200, 100, 180],
        [90, 170, 200],
        [60, 110, 60],
      ];
      const labImage = (whitePoint) => (context) =>
        image(context, Uint8Array.from(colors.flat()), {
          Width: colors.length,
          Height: 1,
          ColorSpace: ['Lab', { WhitePoint: whitePoint, Range: [-128, 127, -128, 127] }],
          BitsPerComponent: 8,
        });

      // With the usual white point (D50), the colours LittleCMS 2 gives.
      const d50 = await convertToPng(labImage([0.9642, 1, 0.8249]));
      assertClose(
        rgbOf(d50),
        [
          254, 255, 254, 1, 0, 1, 119, 119, 119, 250, 3, 11, 171, 122, 209, 164, 207, 91, 150, 46,
          0, 0, 68, 161,
        ],
        3,
        'colours',
      );
      // Whatever the white point, white stays white.
      const tungsten = await convertToPng(labImage([1.0985, 1, 0.35585]));
      assert.deepEqual(rgbOf(tungsten).slice(0, 9), [255, 255, 255, 0, 0, 0, 119, 119, 119]);
    });

    test('keeps colour profiles that PNG files can carry', async () => {
      const profile = (colorSpace) => {
        const bytes = Uint8Array.from({ length: 400 }, (_, i) => i % 256);
        bytes.set(Buffer.from(colorSpace, 'latin1'), 16);
        return bytes;
      };
      const iccBased = (context, n, colorSpace) => [
        'ICCBased',
        context.register(context.flateStream(profile(colorSpace), { N: n })),
      ];
      const cases = [
        [1, 'GRAY', 'gray', true],
        [3, 'RGB ', 'rgb', true],
        [4, 'CMYK', 'rgb', false], // converted to RGB, so the CMYK profile no longer fits
        [3, 'CMYK', 'rgb', false], // a profile that does not match the image
      ];
      for (const [n, colorSpace, colorType, kept] of cases) {
        const values = samples(W * H * n, 8);
        const { png } = await convertToPng((context) =>
          image(context, Uint8Array.from(values), {
            Width: W,
            Height: H,
            ColorSpace: iccBased(context, n, colorSpace),
            BitsPerComponent: 8,
          }),
        );
        assert.equal(png.colorType, colorType, `N ${n} ${colorSpace}`);
        assert.deepEqual(png.iccProfile, kept ? profile(colorSpace) : null, `N ${n} ${colorSpace}`);
        if (n !== 4) assert.deepEqual(png.samples, values);
      }
    });

    test('keeps palettes, with RGB colours', async () => {
      const lookup = Uint8Array.from(samples(10 * 3, 8)); // 10 colours
      const indexes = samples(W * H, 4).map((value) => value % 10);
      const { png, ...pixels } = await convertToPng((context) =>
        image(context, pack(indexes, 4, W), {
          Width: W,
          Height: H,
          ColorSpace: [
            'Indexed',
            'DeviceRGB',
            9,
            PDFHexString.of(Buffer.from(lookup).toString('hex')),
          ],
          BitsPerComponent: 4,
        }),
      );
      assert.deepEqual([png.colorType, png.bitDepth], ['palette', 4]);
      assert.deepEqual(png.samples, indexes);
      assert.deepEqual(png.palette.subarray(0, 30), lookup);
      assert.deepEqual(
        rgbOf(pixels),
        indexes.flatMap((index) => [...lookup.subarray(index * 3, index * 3 + 3)]),
      );
    });

    test('keeps palettes of other colours, converted to RGB', async () => {
      // A CMYK palette in a stream; the same colours as a CMYK image show what to expect.
      const cmyk = Uint8Array.from(samples(256 * 4, 8));
      const indexes = samples(64, 8);
      const { png } = await convertToPng((context) =>
        image(context, Uint8Array.from(indexes), {
          Width: 8,
          Height: 8,
          ColorSpace: ['Indexed', 'DeviceCMYK', 255, context.register(context.flateStream(cmyk))],
          BitsPerComponent: 8,
        }),
      );
      const reference = await convertToPng((context) =>
        image(context, cmyk, {
          Width: 256,
          Height: 1,
          ColorSpace: 'DeviceCMYK',
          BitsPerComponent: 8,
        }),
      );
      assert.equal(png.colorType, 'palette');
      assert.deepEqual(png.samples, indexes);
      assert.deepEqual([...png.palette], reference.png.samples);
    });
  });

  describe('spot colours', () => {
    const tints = [...range(0, 15).map((i) => i * 16), 255];

    /** Converts a one-row image of `values` in the given colour space. */
    async function spotImage(makeColorSpace, values, components = 1, pageResources) {
      return convertToPng(
        (context) =>
          image(context, Uint8Array.from(values), {
            Width: values.length / components,
            Height: 1,
            ColorSpace: makeColorSpace(context),
            BitsPerComponent: 8,
          }),
        pageResources && ((context) => pageResources(context)),
      );
    }

    test('uses exponential functions (type 2), also from a named colour space', async () => {
      const gold = (context) => [
        'Separation',
        'Gold',
        'DeviceRGB',
        context.obj({ FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [1, 0, 0], N: 1 }),
      ];
      const direct = await spotImage(gold, tints);
      assertClose(
        rgbOf(direct),
        tints.flatMap((v) => [255, 255 - v, 255 - v]),
        0,
        'colours',
      );

      // The colour space is a resource of the page, and the function curved.
      const pdf = await makePdf((context) => ({
        resources: {
          ColorSpace: {
            CS0: [
              'Separation',
              'Gold',
              'DeviceRGB',
              context.obj({ FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [1, 0, 0], N: 2 }),
            ],
          },
          XObject: {
            Im0: image(context, Uint8Array.from(tints), {
              Width: tints.length,
              Height: 1,
              ColorSpace: 'CS0',
              BitsPerComponent: 8,
            }),
          },
        },
      }));
      const [info] = await findImages(pdf, [1]);
      const curved = await decodePng((await exportImage(info)).bytes);
      const g = (v) => Math.round(255 * (1 - (v / 255) ** 2));
      assertClose(
        rgbOf(curved),
        tints.flatMap((v) => [255, g(v), g(v)]),
        1,
        'colours',
      );
    });

    test('uses stitching functions (type 3)', async () => {
      const pixels = await spotImage(
        (context) => [
          'Separation',
          'Fire',
          'DeviceRGB',
          context.obj({
            FunctionType: 3,
            Domain: [0, 1],
            Functions: [
              { FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0], C1: [1, 0, 0], N: 1 },
              { FunctionType: 2, Domain: [0, 1], C0: [1, 0, 0], C1: [1, 1, 1], N: 1 },
            ],
            Bounds: [0.5],
            Encode: [0, 1, 0, 1],
          }),
        ],
        tints,
      );
      // Black to red for the first half of the tints, red to white for the second.
      const expected = tints.flatMap((v) =>
        v < 128 ? [2 * v, 0, 0] : [255, 2 * v - 255, 2 * v - 255],
      );
      assertClose(rgbOf(pixels), expected, 1, 'colours');
    });

    test('uses calculator functions (type 4)', async () => {
      const program = (context, code, domain, range) =>
        context.register(context.stream(code, { FunctionType: 4, Domain: domain, Range: range }));
      // One ink: (t, t/2, 1 - t).
      const separation = await spotImage(
        (context) => [
          'Separation',
          'Spot',
          'DeviceRGB',
          program(context, '{ dup dup 0.5 mul exch 1 exch sub }', [0, 1], [0, 1, 0, 1, 0, 1]),
        ],
        tints,
      );
      assertClose(
        rgbOf(separation),
        tints.flatMap((v) => [v, v / 2, 255 - v]),
        1,
        'Separation',
      );

      // Two inks a and b: (min, max, average), with conditions and stack operators.
      const pairs = [0, 0, 255, 0, 0, 255, 100, 200, 200, 100, 50, 50, 30, 220];
      const deviceN = await spotImage(
        (context) => [
          'DeviceN',
          ['A', 'B'],
          'DeviceRGB',
          program(
            context,
            '{ 2 copy add 2 div 3 1 roll 2 copy gt { exch } if 3 -1 roll }',
            [0, 1, 0, 1],
            [0, 1, 0, 1, 0, 1],
          ),
        ],
        pairs,
        2,
      );
      const expected = [];
      for (let i = 0; i < pairs.length; i += 2) {
        const [a, b] = [pairs[i], pairs[i + 1]];
        expected.push(Math.min(a, b), Math.max(a, b), (a + b) / 2);
      }
      assertClose(rgbOf(deviceN), expected, 1, 'DeviceN');
    });

    test('uses sampled functions (type 0) with one or more inputs', async () => {
      const sampled = (context, size, domain, samplesOut) =>
        context.register(
          context.stream(Uint8Array.from(samplesOut), {
            FunctionType: 0,
            Domain: domain,
            Range: [0, 1, 0, 1, 0, 1],
            Size: size,
            BitsPerSample: 8,
          }),
        );
      // White to blue.
      const separation = await spotImage(
        (context) => [
          'Separation',
          'Blue',
          'DeviceRGB',
          sampled(context, [2], [0, 1], [255, 255, 255, 0, 0, 255]),
        ],
        tints,
      );
      assertClose(
        rgbOf(separation),
        tints.flatMap((v) => [255 - v, 255 - v, 255]),
        1,
        'Separation',
      );

      // Two inks a and b, sampled at 3 × 2 points (a changing fastest): (254a, 255b, 0).
      const grid = [0, 1].flatMap((b) => [0, 1, 2].flatMap((a) => [a * 127, b * 255, 0]));
      const pairs = [0, 0, 255, 0, 0, 255, 255, 255, 64, 192, 128, 32];
      const deviceN = await spotImage(
        (context) => [
          'DeviceN',
          ['R', 'G'],
          'DeviceRGB',
          sampled(context, [3, 2], [0, 1, 0, 1], grid),
        ],
        pairs,
        2,
      );
      const expected = [];
      for (let i = 0; i < pairs.length; i += 2) {
        expected.push((pairs[i] * 254) / 255, pairs[i + 1], 0);
      }
      assertClose(rgbOf(deviceN), expected, 1, 'DeviceN');
    });
  });

  describe('transparency', () => {
    const rgb = samples(4 * 2 * 3, 8);
    const rgbImage = (context, entries) =>
      image(context, Uint8Array.from(rgb), {
        Width: 4,
        Height: 2,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        ...entries,
      });
    const stencilBits = [0, 1, 1, 0, 1, 0, 0, 1]; // 4 × 2 pixels

    test('saves stencil masks as black where they paint and transparent elsewhere', async () => {
      for (const [decode, paints] of [
        [undefined, 0],
        [[1, 0], 1],
      ]) {
        const entries = { Width: 4, Height: 2, ImageMask: true };
        if (decode) entries.Decode = decode;
        const { png, ...pixels } = await convertToPng((context) =>
          image(context, pack(stencilBits, 1, 4), entries),
        );
        assert.equal(png.colorType, 'grayAlpha');
        assert.deepEqual(rgbOf(pixels), new Array(24).fill(0));
        assert.deepEqual(
          alphaOf(pixels),
          stencilBits.map((bit) => (bit === paints ? 255 : 0)),
        );
      }
    });

    test('applies soft masks', async () => {
      const alpha = [0, 40, 80, 120, 160, 200, 240, 255];
      const pixels = await convertToPng((context) =>
        rgbImage(context, {
          SMask: image(context, Uint8Array.from(alpha), {
            Width: 4,
            Height: 2,
            ColorSpace: 'DeviceGray',
            BitsPerComponent: 8,
          }),
        }),
      );
      assert.equal(pixels.png.colorType, 'rgba');
      assert.deepEqual(rgbOf(pixels), rgb);
      assert.deepEqual(alphaOf(pixels), alpha);
    });

    test('stretches soft masks of another size over the image', async () => {
      const pixels = await convertToPng((context) =>
        image(context, new Uint8Array(4 * 4 * 3), {
          Width: 4,
          Height: 4,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          SMask: image(context, Uint8Array.of(0, 50, 100, 150), {
            Width: 2,
            Height: 2,
            ColorSpace: 'DeviceGray',
            BitsPerComponent: 8,
          }),
        }),
      );
      assert.deepEqual(alphaOf(pixels), [
        ...[0, 0, 50, 50],
        ...[0, 0, 50, 50],
        ...[100, 100, 150, 150],
        ...[100, 100, 150, 150],
      ]);
    });

    test('undoes colours that were mixed with a matte colour', async () => {
      const original = [200, 100, 50];
      const alpha = [255, 128, 64, 0];
      // Each colour stored mixed with white in proportion to its transparency.
      const stored = alpha.flatMap((a) =>
        original.map((c) => Math.round((c * a) / 255 + 255 * (1 - a / 255))),
      );
      const pixels = await convertToPng((context) =>
        image(context, Uint8Array.from(stored), {
          Width: 4,
          Height: 1,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
          SMask: image(context, Uint8Array.from(alpha), {
            Width: 4,
            Height: 1,
            ColorSpace: 'DeviceGray',
            BitsPerComponent: 8,
            Matte: [1, 1, 1],
          }),
        }),
      );
      assert.deepEqual(alphaOf(pixels), alpha);
      assertClose(rgbOf(pixels).slice(0, 9), [...original, ...original, ...original], 2, 'colours');
    });

    test('applies mask images and colour key masks', async () => {
      const masked = await convertToPng((context) =>
        rgbImage(context, {
          Mask: image(context, pack(stencilBits, 1, 4), { Width: 4, Height: 2, ImageMask: true }),
        }),
      );
      assert.deepEqual(rgbOf(masked), rgb);
      // Where the mask is 1, the image is hidden.
      assert.deepEqual(
        alphaOf(masked),
        stencilBits.map((bit) => (bit ? 0 : 255)),
      );

      const grays = [0, 9, 10, 25, 40, 41, 200, 255];
      const keyed = await convertToPng((context) =>
        image(context, Uint8Array.from(grays), {
          Width: 8,
          Height: 1,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8,
          Mask: [10, 40],
        }),
      );
      assert.equal(keyed.png.colorType, 'grayAlpha');
      assert.deepEqual(
        keyed.png.samples,
        grays.flatMap((gray) => [gray, gray >= 10 && gray <= 40 ? 0 : 255]),
      );
    });
  });

  describe('JPEG images', () => {
    const photo = fixture('photo.jpg'); // 64 × 48
    const photoEntries = {
      Width: 64,
      Height: 48,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'DCTDecode',
    };
    const decodeJpeg = (jpeg) => JpegJs.decode(jpeg, { useTArray: true, formatAsRGBA: false }).data;

    test('saves JPEG photos exactly as they are stored', async () => {
      const {
        info,
        bytes: file,
        mimeType,
      } = await convert((context) => image(context, photo, photoEntries));
      assert.deepEqual(summary(info), {
        pages: [1],
        index: 1,
        width: 64,
        height: 48,
        format: 'jpg',
        small: false,
        inline: false,
        fileName: 'page-1_image-1.jpg',
      });
      assert.equal(mimeType, 'image/jpeg');
      assert.deepEqual(file, photo);

      // Also when the JPEG data is compressed once more.
      const wrapped = await convert((context) =>
        image(context, zlib.deflateSync(photo), {
          ...photoEntries,
          Filter: ['FlateDecode', 'DCTDecode'],
        }),
      );
      assert.equal(wrapped.info.format, 'jpg');
      assert.deepEqual(wrapped.bytes, photo);
    });

    test('adds the colour profile from the PDF to the JPEG file', async () => {
      const profile = Uint8Array.from({ length: 500 }, (_, i) => (i * 3) % 256);
      profile.set(Buffer.from('RGB ', 'latin1'), 16);
      const { bytes: file } = await convert((context) =>
        image(context, photo, {
          ...photoEntries,
          ColorSpace: ['ICCBased', context.register(context.stream(profile, { N: 3 }))],
        }),
      );
      assert.deepEqual(jpegIccProfile(file), profile);
      assert.deepEqual(decodeJpeg(file), decodeJpeg(photo));
    });

    test('saves JPEG photos with transparency as PNG files', async () => {
      const alpha = Uint8Array.from({ length: 64 * 48 }, (_, i) => i % 256);
      const pixels = await convertToPng((context) =>
        image(context, photo, {
          ...photoEntries,
          SMask: image(context, alpha, {
            Width: 64,
            Height: 48,
            ColorSpace: 'DeviceGray',
            BitsPerComponent: 8,
          }),
        }),
      );
      assert.deepEqual(rgbOf(pixels), [...decodeJpeg(photo)]);
      assert.deepEqual(alphaOf(pixels), [...alpha]);
    });
  });

  describe('inline images', () => {
    async function convertInline(content) {
      const pdf = await makePdf(() => ({
        content: Buffer.concat(content.map((part) => Buffer.from(part, 'latin1'))),
      }));
      const images = await findImages(pdf, [1]);
      assert.equal(images.length, 1, 'expected one image');
      assert.ok(images[0].inline);
      const { bytes: png } = await exportImage(images[0]);
      return { png: readPng(png), ...(await decodePng(png)) };
    }

    test('reads uncompressed data, even when it contains "EI"', async () => {
      const data = '\x20EI\x20\nEI\n';
      const { png } = await convertInline(['q BI /W 4 /H 2 /BPC 8 /CS /G ID ', data, '\nEI Q']);
      assert.deepEqual(png.samples, [...Buffer.from(data, 'latin1')]);
    });

    test('reads hexadecimal and compressed data, and abbreviated names', async () => {
      const hex = await convertInline([
        'BI /W 2 /H 2 /BPC 8 /CS /RGB /F /AHx ID ff000000ff00\n0000ffffffff> EI',
      ]);
      assert.deepEqual(rgbOf(hex), [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);

      const values = samples(8 * 6 * 3, 8);
      const compressed = zlib.deflateSync(Uint8Array.from(values)).toString('latin1');
      const flate = await convertInline([
        'BI /W 8 /H 6 /BPC 8 /CS /RGB /F /Fl ID ',
        compressed,
        '\nEI',
      ]);
      assert.deepEqual(flate.png.samples, values);
      const withLength = await convertInline([
        `BI /W 8 /H 6 /BPC 8 /CS /RGB /F [/Fl] /L ${compressed.length} ID `,
        compressed,
        ' EI',
      ]);
      assert.deepEqual(withLength.png.samples, values);
    });

    test('reads palettes and stencil masks', async () => {
      const palette = await convertInline([
        'BI /W 4 /H 1 /BPC 2 /CS [/I /RGB 3 <ff000000ff000000ffffffff>] ID \x1b EI',
      ]);
      assert.deepEqual([palette.png.colorType, palette.png.bitDepth], ['palette', 2]);
      assert.deepEqual(palette.png.samples, [0, 1, 2, 3]);
      assert.deepEqual(rgbOf(palette), [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);

      const stencil = await convertInline(['BI /IM true /W 10 /H 2 ID \xf0\x00\x0f\xc0 EI']);
      assert.deepEqual(alphaOf(stencil), [
        ...[0, 0, 0, 0, 255, 255, 255, 255, 255, 255],
        ...[255, 255, 255, 255, 0, 0, 0, 0, 0, 0],
      ]);
    });
  });

  describe('problems', () => {
    const gray = { Width: 4, Height: 4, ColorSpace: 'DeviceGray', BitsPerComponent: 8 };

    async function exportOnly(makeImage) {
      const pdf = await makePdf((context) => ({
        resources: { XObject: { Im0: makeImage(context) } },
      }));
      const [info] = await findImages(pdf, [1]);
      return exportImage(info);
    }

    test('says which features it cannot convert', async () => {
      await assert.rejects(
        exportOnly((context) =>
          image(context, new Uint8Array(16), { ...gray, Filter: 'MysteryDecode' }),
        ),
        {
          code: 'IMAGE_UNSUPPORTED',
          message:
            'This image uses the "MysteryDecode" compression, which this tool can\'t convert.',
        },
      );
      await rejectsWith(
        exportOnly((context) =>
          image(context, new Uint8Array(16), { ...gray, ColorSpace: 'Pattern' }),
        ),
        'IMAGE_UNSUPPORTED',
      );
      await rejectsWith(
        exportOnly((context) =>
          image(context, new Uint8Array(4), { ...gray, Width: 100_000, Height: 100_000 }),
        ),
        'IMAGE_UNSUPPORTED',
      );
    });

    test('reports damaged images', async () => {
      const damaged = [
        (context) => image(context, bytes('not compressed'), { ...gray, Filter: 'FlateDecode' }),
        (context) => image(context, bytes('not JPEG 2000'), { ...gray, Filter: 'JPXDecode' }),
        (context) => image(context, new Uint8Array(16), { ...gray, BitsPerComponent: 3 }),
        (context) =>
          image(context, new Uint8Array(16), { Width: 4, Height: 4, BitsPerComponent: 8 }),
        // JPEG data has to be decoded to apply a soft mask.
        (context) =>
          image(context, bytes('not a JPEG'), {
            ...gray,
            Filter: 'DCTDecode',
            SMask: grayImage(context, 1, 4, 4),
          }),
        (context) =>
          image(context, fixture('photo.jpg'), {
            ...gray,
            Filter: 'DCTDecode',
            SMask: grayImage(context, 1, 4, 4),
          }),
      ];
      for (const makeImage of damaged) await rejectsWith(exportOnly(makeImage), 'IMAGE_DAMAGED');
    });
  });
});

// ---- Scans: JBIG2, CCITT fax and JPEG 2000 ------------------------------------

// scans.pdf was made with jbig2enc, libtiff, OpenJPEG and img2pdf (see
// test/fixtures/make_fixtures.py); each page shows one of these images.
const SCANS = [
  [1, 'JBIG2', 'bitmap.png', 1],
  [2, 'JBIG2 with a shared symbol dictionary', 'bitmap-jbig2-symbols.png', 1],
  [3, 'CCITT fax', 'bitmap.png', 1],
  [4, 'JPEG 2000 colour', 'photo.png', 8],
  [5, 'JPEG 2000 gray', 'photo-gray.png', 8],
  [6, 'JPEG 2000 with transparency', 'photo-alpha.png', 8],
];

for (const useWasm of [true, false]) {
  describe(`scanned images, with the ${useWasm ? 'WebAssembly' : 'plain JavaScript'} decoders`, () => {
    let pdf;
    before(async () => {
      Decoders.configure({ useWasm });
      pdf = await openPdf(fixture('scans.pdf'));
    });
    after(() => Decoders.configure({ useWasm: true }));

    for (const [page, kind, expected, bitDepth] of SCANS) {
      test(`decodes ${kind} images exactly`, async () => {
        const [info] = await findImages(pdf, [page]);
        const { bytes: png } = await exportImage(info);
        assert.equal(readPng(png).bitDepth, bitDepth);
        assertSamePixels(await decodePng(png), await decodePng(fixture(expected)));
      });
    }

    test('decodes JBIG2 data that starts with a JBIG2 file header', async () => {
      const [info] = await findImages(pdf, [1]);
      const header = [0x97, 0x4a, 0x42, 0x32, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0, 0, 0, 1];
      const { bytes: png } = await convert((context) =>
        image(context, Uint8Array.from([...header, ...info.source.data]), {
          Width: 203,
          Height: 61,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 1,
          Filter: 'JBIG2Decode',
        }),
      );
      assertSamePixels(await decodePng(png), await decodePng(fixture('bitmap.png')));
    });
  });
}

describe('suggestImagesName', () => {
  test('names the folder or ZIP file after the PDF and the pages', () => {
    assert.equal(suggestImagesName('book.pdf'), 'book_images');
    assert.equal(suggestImagesName('/home/me/My Book.PDF', '12-27'), 'My Book_images_pages_12-27');
    assert.equal(suggestImagesName('C:\\docs\\book.pdf', '7'), 'book_images_page_7');
    assert.equal(suggestImagesName('book.pdf', '1-3,8'), 'book_images_pages_1-3,8');
    assert.equal(
      suggestImagesName(
        'book.pdf',
        range(1, 30)
          .map((n) => n * 2)
          .join(','),
      ),
      'book_images_selected_pages',
    );
    assert.equal(suggestImagesName('.pdf'), 'document_images');
  });
});
