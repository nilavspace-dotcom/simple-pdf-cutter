'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { describe, test } = require('node:test');
const { crc32, encodePng, addJpegIccProfile, createZip } = require('../../src/formats.js');
const JpegJs = require('../../vendor/jpeg-js/decoder.js');
const {
  readPng,
  decodePng,
  jpegIccProfile,
  readZip,
  checkWithUnzip,
  fixturePath,
} = require('../helpers.js');

/** Repeatable pseudo-random sample values below 2^bits. */
function samples(count, bits, seed = 1) {
  return Array.from({ length: count }, (_, i) => {
    const hash = Math.imul(i + seed, 2654435761) >>> 0;
    return Math.floor((hash / 2 ** 32) * 2 ** bits);
  });
}

/** Packs sample values into rows, each row starting on a new byte. */
function pack(values, bits, perRow) {
  const rowBytes = Math.ceil((perRow * bits) / 8);
  const out = new Uint8Array(rowBytes * (values.length / perRow));
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

/** A stand-in for an ICC colour profile; only its header is looked at. */
function fakeProfile(colorSpace, size = 600) {
  const profile = Uint8Array.from({ length: size }, (_, i) => (i * 7) % 251);
  profile.set(Buffer.from(colorSpace, 'latin1'), 16);
  return profile;
}

describe('crc32', () => {
  test('gives the standard CRC-32', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
    const data = Uint8Array.from(samples(5000, 8));
    assert.equal(crc32(data), zlib.crc32(data));
  });

  test('can continue over data that comes in parts', () => {
    const data = Uint8Array.from(samples(1000, 8));
    assert.equal(crc32(data.subarray(300), crc32(data.subarray(0, 300))), crc32(data));
  });
});

describe('encodePng', () => {
  const width = 13; // odd, so rows of small samples end part-way through a byte
  const height = 6;
  const layouts = [
    ['gray', 1, [1, 2, 4, 8, 16]],
    ['rgb', 3, [8, 16]],
    ['palette', 1, [1, 2, 4, 8]],
    ['grayAlpha', 2, [8, 16]],
    ['rgba', 4, [8, 16]],
  ];

  for (const [colorType, channels, depths] of layouts) {
    for (const bitDepth of depths) {
      test(`stores ${colorType} images with ${bitDepth}-bit samples exactly`, async () => {
        const values = samples(width * height * channels, bitDepth, bitDepth);
        const palette =
          colorType === 'palette' ? Uint8Array.from(samples(3 * 2 ** bitDepth, 8, 99)) : undefined;
        const png = await encodePng({
          width,
          height,
          colorType,
          bitDepth,
          data: pack(values, bitDepth, width * channels),
          palette,
        });

        const stored = readPng(png);
        assert.deepEqual(
          [stored.width, stored.height, stored.colorType, stored.bitDepth],
          [width, height, colorType, bitDepth],
        );
        assert.deepEqual(stored.samples, values);
        if (palette) assert.deepEqual(stored.palette, palette);

        // A second, independent decoder sees the same picture.
        const { rgba } = await decodePng(png);
        const max = 2 ** bitDepth - 1;
        const to8 = (value) => (bitDepth === 16 ? value >> 8 : Math.round((value * 255) / max));
        const expected = [];
        for (let i = 0; i < width * height; i++) {
          const pixel = values.slice(i * channels, (i + 1) * channels).map(to8);
          const gray = [pixel[0], pixel[0], pixel[0]];
          expected.push(
            ...{
              palette: () => [...palette.subarray(values[i] * 3, values[i] * 3 + 3), 255],
              gray: () => [...gray, 255],
              grayAlpha: () => [...gray, pixel[1]],
              rgb: () => [...pixel, 255],
              rgba: () => pixel,
            }[colorType](),
          );
        }
        assert.deepEqual([...rgba], expected);
      });
    }
  }

  test('uses row filters for photos, which makes them smaller', async () => {
    const data = new Uint8Array(64 * 64 * 3);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) data.set([x * 4, y * 4, (x + y) * 2], (y * 64 + x) * 3);
    }
    const png = await encodePng({ width: 64, height: 64, colorType: 'rgb', bitDepth: 8, data });
    assert.ok(readPng(png).filters.some((filter) => filter !== 0));
    assert.ok(png.length < 1000, `${png.length} bytes`);
  });

  test('adds a colour profile before the image data', async () => {
    const profile = fakeProfile('RGB ');
    const png = await encodePng({
      width: 2,
      height: 1,
      colorType: 'palette',
      bitDepth: 1,
      data: Uint8Array.of(0b01000000),
      palette: Uint8Array.of(255, 0, 0, 0, 0, 255),
      iccProfile: profile,
    });
    const stored = readPng(png);
    assert.deepEqual(stored.chunks, ['IHDR', 'iCCP', 'PLTE', 'IDAT', 'IEND']);
    assert.deepEqual(stored.iccProfile, profile);
    assert.deepEqual([...(await decodePng(png)).rgba], [255, 0, 0, 255, 0, 0, 255, 255]);
  });

  test('refuses image data that does not match the size', async () => {
    const image = { width: 4, height: 4, colorType: 'gray', bitDepth: 8, data: new Uint8Array(15) };
    await assert.rejects(encodePng(image), RangeError);
    await assert.rejects(encodePng({ ...image, width: 0, data: new Uint8Array(0) }), RangeError);
    await assert.rejects(encodePng({ ...image, colorType: 'cmyk' }), TypeError);
  });
});

describe('addJpegIccProfile', () => {
  const photo = new Uint8Array(fs.readFileSync(fixturePath('photo.jpg')));
  const decode = (jpeg) => JpegJs.decode(jpeg, { useTArray: true, formatAsRGBA: false });

  test('adds the profile after the JFIF header, leaving the photo as it was', () => {
    const profile = fakeProfile('RGB ');
    const tagged = addJpegIccProfile(photo, profile);

    assert.deepEqual(jpegIccProfile(tagged), profile);
    assert.equal(jpegIccProfile(photo), null);
    assert.deepEqual([...tagged.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0]); // JFIF stays first
    assert.equal(tagged.length, photo.length + profile.length + 18);
    assert.deepEqual(decode(tagged).data, decode(photo).data);
  });

  test('splits large profiles into numbered segments', () => {
    const profile = fakeProfile('CMYK', 200_000);
    const tagged = addJpegIccProfile(photo, profile);
    assert.deepEqual(jpegIccProfile(tagged), profile);
    assert.equal(tagged.length, photo.length + profile.length + 4 * 18); // four segments
    assert.deepEqual(decode(tagged).data, decode(photo).data);
  });

  test('leaves files that have a profile already, or are not JPEG files, as they are', () => {
    const tagged = addJpegIccProfile(photo, fakeProfile('RGB '));
    assert.equal(addJpegIccProfile(tagged, fakeProfile('GRAY')), tagged);
    const notJpeg = Uint8Array.of(1, 2, 3, 4, 5);
    assert.equal(addJpegIccProfile(notJpeg, fakeProfile('RGB ')), notJpeg);
  });
});

describe('createZip', () => {
  const date = new Date(2024, 1, 29, 13, 37, 42);
  const fileFrom = (name, data) => ({ name, data, size: data.length, crc32: crc32(data) });

  test('makes ZIP files that other programs can open', async () => {
    const photo = new Uint8Array(fs.readFileSync(fixturePath('photo.jpg')));
    const pixels = Uint8Array.from(samples(3000, 8));
    const files = [
      fileFrom('page-01_image-1.jpg', photo),
      // Files can also be given as Blobs, as the web page does.
      { ...fileFrom('page-02_image-1.png', pixels), data: new Blob([pixels]) },
      fileFrom('café ünïcode.png', Uint8Array.of(1, 2, 3)),
      fileFrom('empty.png', new Uint8Array(0)),
    ];
    const zip = createZip(files, date);
    assert.equal(zip.type, 'application/zip');
    const bytes = new Uint8Array(await zip.arrayBuffer());

    const entries = readZip(bytes);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['page-01_image-1.jpg', 'page-02_image-1.png', 'café ünïcode.png', 'empty.png'],
    );
    assert.deepEqual(entries[0].data, photo);
    assert.deepEqual(entries[1].data, pixels);
    assert.ok(entries.every((entry) => entry.utf8));
    assert.deepEqual(entries[0].date, date);

    const unzip = checkWithUnzip(bytes);
    if (!unzip.skipped) assert.ok(unzip.ok, `unzip -t failed:\n${unzip.output}`);
  });

  test('makes an empty ZIP file when there is nothing to put in it', async () => {
    const bytes = new Uint8Array(await createZip([], date).arrayBuffer());
    assert.equal(bytes.length, 22);
    assert.deepEqual(readZip(bytes), []);
  });

  test('refuses more files than a ZIP file can list', () => {
    const files = Array.from({ length: 0x10000 }, (_, i) =>
      fileFrom(`${i}.png`, new Uint8Array(0)),
    );
    assert.throws(() => createZip(files, date), RangeError);
  });
});
