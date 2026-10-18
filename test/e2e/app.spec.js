// @ts-check
'use strict';

const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { makeNumberedPdf, originalPageNumbers, fixturePath } = require('../helpers.js');
const { openApp, download: downloadFrom } = require('./app-page.js');

let book;
test.beforeAll(async () => {
  book = Buffer.from(await makeNumberedPdf(30));
});

function download(page, linkName) {
  return downloadFrom(page, page.getByRole('link', { name: linkName }));
}

const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

test('cuts the chosen pages out of a PDF', async ({ page }) => {
  const problems = await openApp(page);
  await expect(page.getByRole('button', { name: 'Cut PDF' })).toBeDisabled();

  await page
    .locator('#file-input')
    .setInputFiles({ name: 'book.pdf', mimeType: 'application/pdf', buffer: book });
  await expect(page.locator('#file-info')).toContainText('book.pdf · 30 pages');
  await expect(page.getByRole('textbox', { name: 'Pages to keep' })).toBeFocused();

  await page.getByRole('textbox', { name: 'Pages to keep' }).fill('12-27');
  await expect(page.locator('#pages-summary')).toHaveText('16 pages selected: 12–27');
  await page.getByRole('button', { name: 'Cut PDF' }).click();
  await expect(page.locator('#result-text')).toContainText('Your new PDF has 16 pages');

  const result = await download(page, 'Download book_pages_12-27.pdf');
  expect(result.name).toBe('book_pages_12-27.pdf');
  expect(await originalPageNumbers(result.bytes)).toEqual(range(12, 27));

  // A second cut from the same file.
  await page.getByRole('textbox', { name: 'Pages to keep' }).fill('1-3, 30');
  await expect(page.locator('#result')).toBeHidden();
  await page.getByRole('textbox', { name: 'Pages to keep' }).press('Enter');
  const second = await download(page, 'Download book_pages_1-3,30.pdf');
  expect(await originalPageNumbers(second.bytes)).toEqual([1, 2, 3, 30]);

  expect(problems).toEqual([]);
});

test('accepts a PDF dropped onto the page', async ({ page }) => {
  const problems = await openApp(page);
  const dataTransfer = await page.evaluateHandle(
    (bytes) => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(bytes)], 'dropped.pdf', { type: 'application/pdf' }));
      return data;
    },
    [...book],
  );

  const dropzone = page.locator('#dropzone');
  await dropzone.dispatchEvent('dragenter', { dataTransfer });
  await expect(dropzone).toHaveClass(/dragging/);
  await dropzone.dispatchEvent('drop', { dataTransfer });
  await expect(dropzone).not.toHaveClass(/dragging/);
  await expect(page.locator('#file-info')).toContainText('dropped.pdf · 30 pages');

  expect(problems).toEqual([]);
});

test('unlocks a PDF that needs a password', async ({ page }) => {
  const problems = await openApp(page);
  await page.locator('#file-input').setInputFiles({
    name: 'locked.pdf',
    mimeType: 'application/pdf',
    buffer: fs.readFileSync(fixturePath('qpdf-aes256-password.pdf')),
  });

  const password = page.getByLabel('This PDF is locked. Enter its password:');
  await expect(password).toBeFocused();
  await expect(page.getByRole('button', { name: 'Cut PDF' })).toBeDisabled();

  await password.fill('wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'That password is not correct. Please try again.',
  );

  await password.fill('open-me');
  await password.press('Enter');
  await expect(page.locator('#file-info')).toContainText('locked.pdf · 30 pages');
  await expect(password).toBeHidden();
  await expect(page.getByRole('alert')).toBeHidden();

  await page.getByRole('textbox', { name: 'Pages to keep' }).fill('2');
  await page.getByRole('button', { name: 'Cut PDF' }).click();
  const result = await download(page, 'Download locked_page_2.pdf');
  expect(await originalPageNumbers(result.bytes)).toEqual([2]);

  expect(problems).toEqual([]);
});

test('explains mistakes in plain words', async ({ page }) => {
  const problems = await openApp(page);
  const alert = page.getByRole('alert');

  await page.locator('#file-input').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('These are not the pages you are looking for.'),
  });
  await expect(alert).toHaveText('This file is not a PDF.');
  await expect(page.getByRole('button', { name: 'Cut PDF' })).toBeDisabled();

  await page
    .locator('#file-input')
    .setInputFiles({ name: 'book.pdf', mimeType: 'application/pdf', buffer: book });
  await expect(alert).toBeHidden();
  await page.getByRole('textbox', { name: 'Pages to keep' }).fill('25-40');
  await expect(page.locator('#pages-summary')).toHaveText('');
  await page.getByRole('button', { name: 'Cut PDF' }).click();
  await expect(alert).toHaveText("Page 40 doesn't exist. This PDF has only 30 pages.");
  await expect(page.locator('#result')).toBeHidden();

  await page.getByRole('textbox', { name: 'Pages to keep' }).fill('25-30');
  await expect(alert).toBeHidden();
  await expect(page.locator('#pages-summary')).toHaveText('6 pages selected: 25–30');

  expect(problems).toEqual([]);
});
