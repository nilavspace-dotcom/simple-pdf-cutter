'use strict';

// Shared by the command-line tools in this folder.

const fs = require('node:fs/promises');
const { parseArgs } = require('node:util');

/** A mistake in how the command was typed; the usage text is shown with it. */
class UsageError extends Error {}

/** Parses the command line, turning mistakes into UsageErrors. */
function parseCommandLine(args, options) {
  try {
    return parseArgs({ args, allowPositionals: true, options });
  } catch (error) {
    throw new UsageError(error.message, { cause: error });
  }
}

async function readInput(inputPath) {
  try {
    return await fs.readFile(inputPath);
  } catch (error) {
    const reasons = {
      ENOENT: `"${inputPath}" was not found.`,
      EISDIR: `"${inputPath}" is a folder, not a PDF file.`,
    };
    const message = reasons[error.code] || `Could not read "${inputPath}": ${error.message}`;
    throw new Error(message, { cause: error });
  }
}

/**
 * Runs a command and turns its errors into messages and exit codes:
 * 2 for usage mistakes, 1 for everything else.
 */
function runCommand(name, usage, main) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof UsageError) {
      console.error(`${name}: ${error.message}\n`);
      console.error(usage);
      process.exitCode = 2;
      return;
    }
    const message =
      error.code === 'PASSWORD_REQUIRED'
        ? 'This PDF is locked with a password. Add --password <text> to open it.'
        : error.message;
    console.error(`${name}: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = { UsageError, parseCommandLine, readInput, runCommand };
