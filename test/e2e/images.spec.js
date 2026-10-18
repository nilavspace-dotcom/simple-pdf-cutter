// @ts-check
'use strict';

const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const {
  makeImagesPdf,
  makeNumberedPdf,
  readZip,
  decodePng,
  checkWithUnzip,
  fixturePath,
} = require('../helpers.js');
const { openApp, download, chooseFile } = require('./app-page.js');

const fixture = (name) => fs.readFileSync(fixturePath(name));

// photo.jpg on pages 1 and 3, photo.png and a tiny image on page 2.
let book;
test.beforeAll(async () => {
  book = Buffer.from(await makeImagesPdf());
});

/** Opens the page with a PDF, on the "Extract images" tab. */
async function openWithPdf(page, name, buffer) {
  const problems = await openApp(page);
  await page.getByRole('tab', { name: 'Extract images' }).click();
  await chooseFile(page, name, buffer);
  await expect(page.getByRole('button', { name: 'Find images' })).toBeFocused();
  return problems;
}

/** Waits until every image card that is shown has its thumbnail. */
async function expectThumbnails(page, count) {
  const thumbnails = page.getByRole('list', { name: 'Images found' }).getByRole('img');
  await expect(thumbnails).toHaveCount(count);
  for (const thumbnail of await thumbnails.all()) {
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  }
}

async function expectSamePixels(png, expectedPng) {
  expect(await decodePng(png)).toEqual(await decodePng(expectedPng));
}

test('finds the images in a PDF and saves them as a ZIP file', async ({ page }) => {
  const problems = await openWithPdf(page, 'book.pdf', book);
  await page.getByRole('button', { name: 'Find images' }).click();

  await expect(page.locator('#gallery-summary')).toHaveText(
    '3 images found in this PDF (1 small one hidden).',
  );
  const cards = page.getByRole('list', { name: 'Images found' }).getByRole('listitem');
  await expect(cards.filter({ visible: true })).toHaveText(
    ['Pages 1, 3 64 × 48 · JPG', 'Page 2 40 × 30 · PNG'],
    { useInnerText: true },
  );
  await expectThumbnails(page, 2);

  const zipButton = page.getByRole('button', { name: 'Save 2 images as ZIP' });
  await expect(zipButton).toBeFocused();
  await zipButton.click();
  await expect(page.locator('#zip-result-text')).toHaveText(
    /^Your ZIP file is ready: 2 images \(\d\.\d KB\)\.$/,
  );
  const zip = await download(page, page.getByRole('link', { name: 'Download book_images.zip' }));
  expect(zip.name).toBe('book_images.zip');

  const files = readZip(zip.bytes);
  expect(files.map((file) => file.name)).toEqual(['page-1_image-1.jpg', 'page-2_image-1.png']);
  expect(Buffer.from(files[0].data).equals(fixture('photo.jpg'))).toBe(true);
  await expectSamePixels(files[1].data, fixture('photo.png'));
  const unzip = checkWithUnzip(zip.bytes);
  if (!unzip.skipped) expect(unzip.ok, unzip.output).toBe(true);

  expect(problems).toEqual([]);
});

test('lets you choose which images to save', async ({ page }) => {
  const problems = await openWithPdf(page, 'book.pdf', book);
  await page.getByRole('button', { name: 'Find images' }).click();
  const zipButton = page.locator('#zip-button');
  await expect(zipButton).toHaveText('Save 2 images as ZIP');

  await page.getByLabel('Show small images (1)').check();
  await expect(page.locator('#gallery-summary')).toHaveText('3 images found in this PDF.');
  await expectThumbnails(page, 3);
  await expect(zipButton).toHaveText('Save 3 images as ZIP');

  await page.getByRole('checkbox', { name: 'Select page-1_image-1.jpg' }).uncheck();
  await expect(zipButton).toHaveText('Save 2 images as ZIP');
  await page.getByRole('button', { name: 'Select none' }).click();
  await expect(zipButton).toHaveText('Select images to save');
  await expect(zipButton).toBeDisabled();
  await page.getByRole('button', { name: 'Select all' }).click();
  await expect(zipButton).toHaveText('Save 3 images as ZIP');

  // Hidden images are not saved.
  await page.getByLabel('Show small images (1)').uncheck();
  await expect(zipButton).toHaveText('Save 2 images as ZIP');

  // Single images can be downloaded straight away.
  const single = await download(
    page,
    page.getByRole('button', { name: 'Download page-2_image-1.png' }),
  );
  expect(single.name).toBe('page-2_image-1.png');
  await expectSamePixels(single.bytes, fixture('photo.png'));

  expect(problems).toEqual([]);
});

test('searches only the pages you choose', async ({ page }) => {
  const problems = await openWithPdf(page, 'book.pdf', book);
  const pagesBox = page.getByRole('textbox', { name: 'Pages to search' });

  await pagesBox.fill('5');
  await expect(page.getByRole('radio', { name: 'Only these pages:' })).toBeChecked();
  await page.getByRole('button', { name: 'Find images' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    "Page 5 doesn't exist. This PDF has only 3 pages.",
  );
  await expect(pagesBox).toBeFocused();

  await pagesBox.fill('2');
  await pagesBox.press('Enter');
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.locator('#gallery-summary')).toHaveText(
    '2 images found on page 2 (1 small one hidden).',
  );
  await page.locator('#zip-button').click();
  const zip = await download(
    page,
    page.getByRole('link', { name: 'Download book_images_page_2.zip' }),
  );
  expect(readZip(zip.bytes).map((file) => file.name)).toEqual(['page-2_image-1.png']);

  await page.getByRole('radio', { name: 'All pages' }).check();
  await page.getByRole('button', { name: 'Find images' }).click();
  await expect(page.locator('#gallery-summary')).toHaveText(
    '3 images found in this PDF (1 small one hidden).',
  );

  expect(problems).toEqual([]);
});

test('says so when a PDF has no images', async ({ page }) => {
  const problems = await openWithPdf(page, 'text.pdf', Buffer.from(await makeNumberedPdf(5)));
  await page.getByRole('button', { name: 'Find images' }).click();
  await expect(page.locator('#gallery-summary')).toHaveText(
    'No images found in this PDF. Charts and text that the PDF draws itself are not stored ' +
      'as pictures, so there is nothing to save.',
  );
  await expect(page.locator('#zip-button')).toBeHidden();
  await expect(page.getByRole('list', { name: 'Images found' })).toBeHidden();

  expect(problems).toEqual([]);
});

test('decodes scanned images: JBIG2, CCITT fax and JPEG 2000', async ({ page }) => {
  const problems = await openWithPdf(page, 'scans.pdf', fixture('scans.pdf'));
  await page.getByRole('button', { name: 'Find images' }).click();
  await expect(page.locator('#gallery-summary')).toHaveText('6 images found in this PDF.');
  await expectThumbnails(page, 6);

  await page.locator('#zip-button').click();
  const zip = await download(page, page.getByRole('link', { name: 'Download scans_images.zip' }));
  const files = readZip(zip.bytes);
  const expected = [
    'bitmap.png',
    'bitmap-jbig2-symbols.png',
    'bitmap.png',
    'photo.png',
    'photo-gray.png',
    'photo-alpha.png',
  ];
  expect(files.map((file) => file.name)).toEqual(
    expected.map((_, i) => `page-${i + 1}_image-1.png`),
  );
  for (const [i, name] of expected.entries()) await expectSamePixels(files[i].data, fixture(name));

  expect(problems).toEqual([]);
});

test('switches between tasks with the keyboard', async ({ page }) => {
  const problems = await openApp(page);
  const cutTab = page.getByRole('tab', { name: 'Cut pages' });
  const imagesTab = page.getByRole('tab', { name: 'Extract images' });
  const cutPanel = page.getByRole('tabpanel', { name: 'Cut pages' });
  const imagesPanel = page.getByRole('tabpanel', { name: 'Extract images' });

  await expect(cutTab).toHaveAttribute('aria-selected', 'true');
  await expect(imagesPanel).toBeHidden();

  await cutTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(imagesTab).toBeFocused();
  await expect(imagesTab).toHaveAttribute('aria-selected', 'true');
  await expect(cutTab).toHaveAttribute('aria-selected', 'false');
  await expect(imagesPanel).toBeVisible();
  await expect(cutPanel).toBeHidden();

  await page.keyboard.press('ArrowRight'); // wraps around
  await expect(cutTab).toBeFocused();
  await expect(cutPanel).toBeVisible();
  await page.keyboard.press('End');
  await expect(imagesTab).toBeFocused();
  await page.keyboard.press('Home');
  await expect(cutTab).toBeFocused();
  await expect(cutTab).toHaveAttribute('aria-selected', 'true');

  // Only the selected tab is in the tab order.
  await expect(cutTab).toHaveAttribute('tabindex', '0');
  await expect(imagesTab).toHaveAttribute('tabindex', '-1');

  expect(problems).toEqual([]);
});
