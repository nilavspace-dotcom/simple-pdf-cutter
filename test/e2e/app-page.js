// @ts-check
'use strict';

// Shared by the browser tests.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Opened straight from disk, the way someone double-clicks index.html.
const APP_URL = pathToFileURL(path.join(__dirname, '..', '..', 'index.html')).href;

/**
 * Opens the page and collects anything that would mean it is broken or not
 * as private as promised: script errors and requests to the outside world.
 *
 * @param {import('@playwright/test').Page} page
 */
async function openApp(page) {
  const problems = [];
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('request', (request) => {
    if (!/^(file|blob|data):/.test(request.url()))
      problems.push(`network request: ${request.url()}`);
  });
  await page.goto(APP_URL);
  return problems;
}

/**
 * Clicks something that downloads a file and returns the file.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} target
 */
async function download(page, target) {
  const downloading = page.waitForEvent('download');
  await target.click();
  const file = await downloading;
  return { name: file.suggestedFilename(), bytes: fs.readFileSync(await file.path()) };
}

/**
 * Chooses a PDF in the page.
 *
 * @param {import('@playwright/test').Page} page
 */
function chooseFile(page, name, buffer) {
  return page.locator('#file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer });
}

module.exports = { APP_URL, openApp, download, chooseFile };
