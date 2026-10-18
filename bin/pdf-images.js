#!/usr/bin/env node
/*
 * Simple PDF Cutter - saves the images shown in a PDF as image files.
 *
 *   node bin/pdf-images.js book.pdf          (all pages)
 *   node bin/pdf-images.js book.pdf 12-27
 */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { openPdf, parsePageSelection } = require('../src/pdf-cutter.js');
const { findImages, exportImage, suggestImagesName } = require('../src/pdf-images.js');
const { UsageError, parseCommandLine, readInput, runCommand } = require('./common.js');
const { version } = require('../package.json');

const USAGE = `Usage: pdf-images <input.pdf> [pages] [options]

Saves the images shown in a PDF as image files: photos stored as JPEG exactly
as they are in the PDF, all other images as lossless PNG.

  [pages]   pages to search, for example 12-27 or "1-3, 8" (default: all pages)

Options:
  -o, --output <folder>    where to save the images
                           (default: next to the PDF, e.g. book_images)
  -p, --password <text>    password, for PDFs that are locked with one
  -s, --small              also save tiny images (under 16 pixels wide or high)
  -f, --force              save into the folder even if it already has files,
                           replacing files with the same names
  -h, --help               show this help
  -v, --version            show the version number
`;

async function main(args) {
  const { values, positionals } = parseCommandLine(args, {
    output: { type: 'string', short: 'o' },
    password: { type: 'string', short: 'p' },
    small: { type: 'boolean', short: 's' },
    force: { type: 'boolean', short: 'f' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (values.version) {
    console.log(version);
    return;
  }
  if (positionals.length === 0) throw new UsageError('Missing the PDF file.');

  const [inputPath, ...pageParts] = positionals;
  const pdf = await openPdf(await readInput(inputPath), { password: values.password });
  let pages;
  let label;
  if (pageParts.length > 0) {
    // `pdf-images book.pdf 1-3, 8` (no quotes) arrives as several arguments.
    ({ pages, label } = parsePageSelection(pageParts.join(' '), pdf.getPageCount()));
  } else {
    pages = Array.from({ length: pdf.getPageCount() }, (_, i) => i + 1);
  }
  const where = label
    ? `on ${/[-,]/.test(label) ? 'pages' : 'page'} ${label.replace(/,/g, ', ')}`
    : 'in the PDF';

  const found = await findImages(pdf, pages);
  const tiny = found.filter((image) => image.small);
  const images = values.small ? found : found.filter((image) => !image.small);
  if (images.length === 0) {
    console.log(
      found.length > 0
        ? `Only tiny images were found ${where}; add --small to save ${itOrThem(found.length)}.`
        : `No images found ${where}.`,
    );
    return;
  }

  const folder =
    values.output ||
    path.join(path.dirname(inputPath), suggestImagesName(path.basename(inputPath), label));
  await prepareFolder(folder, values.force);

  const failures = [];
  const showProgress = process.stderr.isTTY && images.length > 1;
  for (const [i, image] of images.entries()) {
    if (showProgress) process.stderr.write(`\rSaving image ${i + 1} of ${images.length}…`);
    try {
      const { bytes } = await exportImage(image);
      await fs.writeFile(path.join(folder, image.fileName), bytes);
    } catch (error) {
      failures.push(`${image.fileName}: ${error.message}`);
    }
  }
  if (showProgress) process.stderr.write('\r\x1b[K'); // clear the progress line

  let message = `Saved ${count(images.length - failures.length, 'image')} ${where} to ${folder}`;
  if (!values.small && tiny.length > 0) {
    message += ` (left out ${count(tiny.length, 'tiny image')}; add --small to save ${itOrThem(tiny.length)} too)`;
  }
  console.log(message);
  for (const failure of failures) console.error(`pdf-images: could not save ${failure}`);
  if (failures.length > 0) process.exitCode = 1;
}

/** Creates the folder, or checks that saving into it won't mix with other files. */
async function prepareFolder(folder, force) {
  let entries;
  try {
    entries = await fs.readdir(folder);
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.mkdir(folder, { recursive: true });
      return;
    }
    const reason = error.code === 'ENOTDIR' ? 'it is a file' : error.message;
    throw new Error(`Could not save into "${folder}": ${reason}.`, { cause: error });
  }
  if (entries.length > 0 && !force) {
    throw new Error(
      `The folder "${folder}" already has files in it. Use --force to save into it anyway, ` +
        'or --output to choose another folder.',
    );
  }
}

function count(number, noun) {
  return `${number} ${noun}${number === 1 ? '' : 's'}`;
}

function itOrThem(number) {
  return number === 1 ? 'it' : 'them';
}

runCommand('pdf-images', USAGE, main);
