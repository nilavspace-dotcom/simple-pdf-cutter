#!/usr/bin/env node
/*
 * Simple PDF Cutter - command-line version.
 *
 *   node bin/pdf-cut.js book.pdf 12-27
 */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  openPdf,
  parsePageSelection,
  extractPages,
  suggestOutputName,
} = require('../src/pdf-cutter.js');
const { UsageError, parseCommandLine, readInput, runCommand } = require('./common.js');
const { version } = require('../package.json');

const USAGE = `Usage: pdf-cut <input.pdf> <pages> [options]

Keeps only the pages you list and saves them as a new PDF.

  <pages>   pages to keep, for example 12-27 or "1-3, 8, 10-12"
            (page 1 is the first page of the file)

Options:
  -o, --output <file>      where to save the result
                           (default: next to the input, e.g. book_pages_12-27.pdf)
  -p, --password <text>    password, for PDFs that are locked with one
  -f, --force              overwrite the output file if it already exists
  -h, --help               show this help
  -v, --version            show the version number
`;

async function main(args) {
  const { values, positionals } = parseCommandLine(args, {
    output: { type: 'string', short: 'o' },
    password: { type: 'string', short: 'p' },
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
  if (positionals.length < 2) {
    throw new UsageError(
      positionals.length === 0
        ? 'Missing the PDF file and the pages to keep.'
        : 'Missing the pages to keep.',
    );
  }

  const [inputPath, ...pageParts] = positionals;
  // `pdf-cut book.pdf 1-3, 8` (no quotes) arrives as several arguments.
  const pageText = pageParts.join(' ');

  const pdf = await openPdf(await readInput(inputPath), { password: values.password });
  const { pages, label } = parsePageSelection(pageText, pdf.getPageCount());
  const outputPath =
    values.output ||
    path.join(path.dirname(inputPath), suggestOutputName(path.basename(inputPath), label));

  const bytes = await extractPages(pdf, pages);
  try {
    await fs.writeFile(outputPath, bytes, { flag: values.force ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        `"${outputPath}" already exists. Use --force to replace it, or --output to choose another name.`,
        { cause: error },
      );
    }
    throw new Error(`Could not save "${outputPath}": ${error.message}`, { cause: error });
  }

  console.log(
    `Saved ${pages.length === 1 ? '1 page' : `${pages.length} pages`} (${label.replace(/,/g, ', ')}) ` +
      `to ${outputPath}`,
  );
}

runCommand('pdf-cut', USAGE, main);
