'use strict';

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { parsePageSelection, suggestOutputName } = require('../../src/pdf-cutter.js');

const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

function rejects(text, pageCount, messagePattern) {
  assert.throws(
    () => parsePageSelection(text, pageCount),
    (error) => error.code === 'INVALID_PAGES' && messagePattern.test(error.message),
  );
}

describe('parsePageSelection', () => {
  test('reads a single range', () => {
    assert.deepEqual(parsePageSelection('12-27', 700), {
      pages: range(12, 27),
      ranges: [[12, 27]],
      label: '12-27',
    });
  });

  test('reads lists of pages and ranges', () => {
    const selection = parsePageSelection('1-3, 8, 10-12', 20);
    assert.deepEqual(selection.pages, [1, 2, 3, 8, 10, 11, 12]);
    assert.equal(selection.label, '1-3,8,10-12');
  });

  test('accepts the ways people actually type ranges', () => {
    for (const text of [
      ' 12 - 27 ',
      '12–27', // en dash, e.g. pasted from a document
      '12—27', // em dash
      '12 to 27',
      '12 TO 27',
      '１２-２７', // full-width digits
    ]) {
      assert.deepEqual(parsePageSelection(text, 30).pages, range(12, 27), text);
    }
    assert.deepEqual(parsePageSelection('1;3 5,,7', 10).pages, [1, 3, 5, 7]);
  });

  test('accepts ranges written backwards', () => {
    assert.deepEqual(parsePageSelection('27-12', 30).pages, range(12, 27));
  });

  test('keeps pages in document order without duplicates', () => {
    const selection = parsePageSelection('20-27, 12-21, 5, 5, 4', 30);
    assert.deepEqual(selection.pages, [4, 5, ...range(12, 27)]);
    assert.deepEqual(selection.ranges, [
      [4, 5],
      [12, 27],
    ]);
    assert.equal(selection.label, '4-5,12-27');
  });

  test('allows the first and the last page', () => {
    assert.deepEqual(parsePageSelection('1, 700', 700).pages, [1, 700]);
    assert.equal(parsePageSelection('007', 10).label, '7');
  });

  test('explains what is wrong with a selection', () => {
    rejects('', 10, /Type the pages you want to keep/);
    rejects('  , ', 10, /Type the pages you want to keep/);
    rejects('abc', 10, /"abc" is not a page number or a range/);
    rejects('12-', 30, /"12-" is not a page number or a range/);
    rejects('1-2-3', 30, /"1-2-3" is not/);
    rejects('2.5', 30, /"2.5" is not/);
    rejects('0', 10, /There is no page 0/);
    rejects('0-5', 10, /There is no page 0/);
    rejects('5-11', 10, /Page 11 doesn't exist\. This PDF has only 10 pages\./);
    rejects('2', 1, /This PDF has only 1 page\./);
    rejects('99999999999999999999', 10, /Page 99999999999999999999 doesn't exist/);
  });

  test('requires the page count of the document', () => {
    assert.throws(() => parsePageSelection('1', 0), TypeError);
    assert.throws(() => parsePageSelection('1', undefined), TypeError);
  });
});

describe('suggestOutputName', () => {
  test('names the result after the original file and the pages', () => {
    assert.equal(suggestOutputName('book.pdf', '12-27'), 'book_pages_12-27.pdf');
    assert.equal(suggestOutputName('My Book.PDF', '1-3,8'), 'My Book_pages_1-3,8.pdf');
    assert.equal(suggestOutputName('book.pdf', '7'), 'book_page_7.pdf');
  });

  test('uses only the file name of a path', () => {
    assert.equal(suggestOutputName('/home/me/docs/book.pdf', '1-2'), 'book_pages_1-2.pdf');
    assert.equal(suggestOutputName('C:\\Users\\me\\book.pdf', '1-2'), 'book_pages_1-2.pdf');
  });

  test('copes with unusual names and long selections', () => {
    assert.equal(suggestOutputName('', '1-2'), 'document_pages_1-2.pdf');
    assert.equal(suggestOutputName('.pdf', '1-2'), 'document_pages_1-2.pdf');
    assert.equal(suggestOutputName('scan', '1-2'), 'scan_pages_1-2.pdf');
    const long = Array.from({ length: 20 }, (_, i) => String(i * 3 + 1)).join(',');
    assert.equal(suggestOutputName('book.pdf', long), 'book_selected_pages.pdf');
  });
});
