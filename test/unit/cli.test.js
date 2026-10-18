'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const { makeNumberedPdf, originalPageNumbers, fixturePath } = require('../helpers.js');

const CLI = path.join(__dirname, '..', '..', 'bin', 'pdf-cut.js');

/** Runs the command-line tool and resolves with its exit code and output. */
function pdfCut(args, cwd) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

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
