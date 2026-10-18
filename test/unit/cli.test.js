'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const {
  PDFLib,
  makeNumberedPdf,
  makeImagesPdf,
  originalPageNumbers,
  readPng,
  decodePng,
  fixturePath,
} = require('../helpers.js');

const BIN = path.join(__dirname, '..', '..', 'bin');

/** Runs a command-line tool and resolves with its exit code and output. */
function run(tool, args, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(BIN, tool), ...args],
      { cwd },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });
}

const pdfCut = (args, cwd) => run('pdf-cut.js', args, cwd);
const pdfImages = (args, cwd) => run('pdf-images.js', args, cwd);

describe('pdf-cut command', () => {
  let dir;
  const file = (name) => path.join(dir, name);

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-cut-test-'));
    fs.writeFileSync(file('book.pdf'), await makeNumberedPdf(30));
    fs.copyFileSync(fixturePath('qpdf-aes256-password.pdf'), file('locked.pdf'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('saves the pages next to the original', async () => {
    const result = await pdfCut(['book.pdf', '12-27'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Saved 16 pages \(12-27\) to book_pages_12-27\.pdf/);
    assert.deepEqual(
      await originalPageNumbers(fs.readFileSync(file('book_pages_12-27.pdf'))),
      [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27],
    );
  });

  test('accepts a list of pages without quotes and an output name', async () => {
    const result = await pdfCut(['book.pdf', '1-3,', '8', '-o', 'picked.pdf'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await originalPageNumbers(fs.readFileSync(file('picked.pdf'))), [1, 2, 3, 8]);
  });

  test('does not overwrite files unless asked to', async () => {
    fs.writeFileSync(file('existing.pdf'), 'keep me');
    const refused = await pdfCut(['book.pdf', '5', '-o', 'existing.pdf'], dir);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already exists\. Use --force/);
    assert.equal(fs.readFileSync(file('existing.pdf'), 'utf8'), 'keep me');

    const forced = await pdfCut(['book.pdf', '5', '-o', 'existing.pdf', '--force'], dir);
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(await originalPageNumbers(fs.readFileSync(file('existing.pdf'))), [5]);
  });

  test('opens locked PDFs with --password', async () => {
    const missing = await pdfCut(['locked.pdf', '2'], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /locked with a password\. Add --password/);

    const wrong = await pdfCut(['locked.pdf', '2', '--password', 'nope'], dir);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /password is not correct/);

    const right = await pdfCut(['locked.pdf', '2', '-p', 'open-me'], dir);
    assert.equal(right.code, 0, right.stderr);
    assert.deepEqual(await originalPageNumbers(fs.readFileSync(file('locked_page_2.pdf'))), [2]);
  });

  test('explains mistakes', async () => {
    const badPages = await pdfCut(['book.pdf', '25-40'], dir);
    assert.equal(badPages.code, 1);
    assert.match(badPages.stderr, /Page 40 doesn't exist\. This PDF has only 30 pages\./);

    const noFile = await pdfCut(['nope.pdf', '1'], dir);
    assert.equal(noFile.code, 1);
    assert.match(noFile.stderr, /"nope\.pdf" was not found/);

    const notPdf = await pdfCut([path.basename(__filename), '1'], __dirname);
    assert.equal(notPdf.code, 1);
    assert.match(notPdf.stderr, /This file is not a PDF/);
  });

  test('shows how to use it when the arguments are wrong', async () => {
    for (const args of [[], ['book.pdf'], ['book.pdf', '1', '--colour']]) {
      const result = await pdfCut(args, dir);
      assert.equal(result.code, 2, `pdf-cut ${args.join(' ')}`);
      assert.match(result.stderr, /Usage: pdf-cut <input\.pdf> <pages>/);
    }
    const help = await pdfCut(['--help'], dir);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: pdf-cut/);
    const version = await pdfCut(['--version'], dir);
    assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  });
});

describe('pdf-images command', () => {
  let dir;
  const file = (name) => path.join(dir, name);
  const list = (folder) => fs.readdirSync(file(folder)).sort();

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-images-test-'));
    fs.writeFileSync(file('book.pdf'), await makeImagesPdf());
    fs.writeFileSync(file('text.pdf'), await makeNumberedPdf(3));
    fs.copyFileSync(fixturePath('qpdf-aes256-password.pdf'), file('locked.pdf'));

    // A PDF whose only image is a 2 × 2 dot.
    const dots = await PDFLib.PDFDocument.create();
    const page = dots.addPage([100, 100]);
    const dot = dots.context.stream(Uint8Array.of(0, 85, 170, 255), {
      Type: 'XObject',
      Subtype: 'Image',
      Width: 2,
      Height: 2,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    });
    page.pushOperators(PDFLib.drawObject(page.node.newXObject('Dot', dots.context.register(dot))));
    fs.writeFileSync(file('dots.pdf'), await dots.save());

    // A PDF with a good image and one compressed in a way no PDF reader knows.
    const broken = await PDFLib.PDFDocument.create();
    const brokenPage = broken.addPage([100, 100]);
    for (const [tag, filter] of [
      ['Good', undefined],
      ['Bad', 'MysteryDecode'],
    ]) {
      const entries = {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 20,
        Height: 20,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      };
      if (filter) entries.Filter = filter;
      const ref = broken.context.register(broken.context.stream(new Uint8Array(400), entries));
      brokenPage.pushOperators(PDFLib.drawObject(brokenPage.node.newXObject(tag, ref)));
    }
    fs.writeFileSync(file('broken.pdf'), await broken.save());
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('saves the images of all pages in a folder next to the PDF', async () => {
    const result = await pdfImages(['book.pdf'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      'Saved 2 images in the PDF to book_images ' +
        '(left out 1 tiny image; add --small to save it too)\n',
    );
    assert.deepEqual(list('book_images'), ['page-1_image-1.jpg', 'page-2_image-1.png']);

    // The photo exactly as stored, and the other image without any change to its pixels.
    assert.deepEqual(
      fs.readFileSync(file('book_images/page-1_image-1.jpg')),
      fs.readFileSync(fixturePath('photo.jpg')),
    );
    const png = await decodePng(fs.readFileSync(file('book_images/page-2_image-1.png')));
    assert.deepEqual(png, await decodePng(fs.readFileSync(fixturePath('photo.png'))));
  });

  test('searches only the pages asked for, and saves tiny images with --small', async () => {
    const result = await pdfImages(['book.pdf', '2-3', '--small'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Saved 3 images on pages 2-3 to book_images_pages_2-3\n$/);
    assert.deepEqual(list('book_images_pages_2-3'), [
      'page-2_image-1.png',
      'page-2_image-2.png',
      'page-3_image-1.jpg',
    ]);
    const tiny = readPng(fs.readFileSync(file('book_images_pages_2-3/page-2_image-2.png')));
    assert.deepEqual(
      tiny.samples,
      Array.from({ length: 64 }, (_, i) => i * 4),
    );

    const listed = await pdfImages(['book.pdf', '1,', '3', '-o', 'picked'], dir);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /^Saved 1 image on pages 1, 3 to picked\n$/);
    assert.deepEqual(list('picked'), ['page-1_image-1.jpg']);
  });

  test('does not mix the images with files already in the folder unless asked to', async () => {
    fs.mkdirSync(file('full'));
    fs.writeFileSync(file('full/page-1_image-1.jpg'), 'keep me');
    const refused = await pdfImages(['book.pdf', '-o', 'full'], dir);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already has files in it\. Use --force/);
    assert.equal(fs.readFileSync(file('full/page-1_image-1.jpg'), 'utf8'), 'keep me');

    const forced = await pdfImages(['book.pdf', '-o', 'full', '--force'], dir);
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(
      fs.readFileSync(file('full/page-1_image-1.jpg')),
      fs.readFileSync(fixturePath('photo.jpg')),
    );

    fs.writeFileSync(file('a-file'), '');
    const notFolder = await pdfImages(['book.pdf', '-o', 'a-file'], dir);
    assert.equal(notFolder.code, 1);
    assert.match(notFolder.stderr, /Could not save into ".*a-file": it is a file\./);
  });

  test('says so when there is nothing to save, without making a folder', async () => {
    const none = await pdfImages(['text.pdf'], dir);
    assert.equal(none.code, 0, none.stderr);
    assert.equal(none.stdout, 'No images found in the PDF.\n');

    const page = await pdfImages(['text.pdf', '2'], dir);
    assert.equal(page.stdout, 'No images found on page 2.\n');

    const onlyTiny = await pdfImages(['dots.pdf'], dir);
    assert.equal(onlyTiny.code, 0, onlyTiny.stderr);
    assert.equal(
      onlyTiny.stdout,
      'Only tiny images were found in the PDF; add --small to save it.\n',
    );
    assert.deepEqual(
      ['text_images', 'text_images_page_2', 'dots_images'].filter((name) =>
        fs.existsSync(file(name)),
      ),
      [],
    );

    const small = await pdfImages(['dots.pdf', '--small'], dir);
    assert.equal(small.stdout, 'Saved 1 image in the PDF to dots_images\n');
    assert.deepEqual(
      readPng(fs.readFileSync(file('dots_images/page-1_image-1.png'))).samples,
      [0, 85, 170, 255],
    );
  });

  test('saves the images it can, and reports the ones it cannot', async () => {
    const result = await pdfImages(['broken.pdf'], dir);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, 'Saved 1 image in the PDF to broken_images\n');
    assert.equal(
      result.stderr,
      'pdf-images: could not save page-1_image-2.png: This image uses the "MysteryDecode" ' +
        "compression, which this tool can't convert.\n",
    );
    assert.deepEqual(list('broken_images'), ['page-1_image-1.png']);
  });

  test('opens locked PDFs with --password', async () => {
    const missing = await pdfImages(['locked.pdf'], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /locked with a password\. Add --password/);

    const right = await pdfImages(['locked.pdf', '-p', 'open-me'], dir);
    assert.equal(right.code, 0, right.stderr);
    assert.equal(right.stdout, 'No images found in the PDF.\n');
  });

  test('explains mistakes and shows how to use it', async () => {
    const badPages = await pdfImages(['book.pdf', '2-9'], dir);
    assert.equal(badPages.code, 1);
    assert.match(badPages.stderr, /Page 9 doesn't exist\. This PDF has only 3 pages\./);

    for (const args of [[], ['book.pdf', '--colour']]) {
      const result = await pdfImages(args, dir);
      assert.equal(result.code, 2, `pdf-images ${args.join(' ')}`);
      assert.match(result.stderr, /Usage: pdf-images <input\.pdf> \[pages\]/);
    }
    const help = await pdfImages(['-h'], dir);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /Usage: pdf-images/);
    const version = await pdfImages(['-v'], dir);
    assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  });
});
