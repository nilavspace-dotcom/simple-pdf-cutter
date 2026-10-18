'use strict';

// Shared by the unit tests and the browser tests.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PDFLib = require('../vendor/pdf-lib/pdf-lib.min.js');

const { PDFDocument, PDFName, StandardFonts } = PDFLib;

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

let qpdfAvailable;

/**
 * Runs `qpdf --check` on a file when qpdf is installed, as an independent
 * second opinion that the file is well-formed.
 *
 * @returns {{skipped: true} | {skipped: false, ok: boolean, output: string}}
 */
function checkWithQpdf(bytes) {
  if (qpdfAvailable === undefined) {
    try {
      execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
      qpdfAvailable = true;
    } catch {
      qpdfAvailable = false;
    }
  }
  if (!qpdfAvailable) return { skipped: true };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-cutter-qpdf-'));
  const file = path.join(dir, 'check.pdf');
  fs.writeFileSync(file, bytes);
  try {
    const output = execFileSync('qpdf', ['--check', file], { encoding: 'utf8', stdio: 'pipe' });
    return { skipped: false, ok: /No syntax or stream encoding errors found/.test(output), output };
  } catch (error) {
    // qpdf exits with 3 for warnings and 2 for errors.
    return { skipped: false, ok: false, output: `${error.stdout}${error.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  PDFLib,
  makeNumberedPdf,
  originalPageNumbers,
  countPageObjects,
  pageContentText,
  checkWithQpdf,
  fixturePath: (name) => path.join(__dirname, 'fixtures', name),
};
