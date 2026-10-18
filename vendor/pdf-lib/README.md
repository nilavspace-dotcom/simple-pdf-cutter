# PDF engine

`pdf-lib.min.js` is the browser build of [`@cantoo/pdf-lib`](https://www.npmjs.com/package/@cantoo/pdf-lib),
an actively maintained fork of [pdf-lib](https://github.com/Hopding/pdf-lib) that can also open
encrypted PDFs. It is kept in this repository, rather than loaded from the internet, so that the
tool works offline and when `index.html` is opened straight from disk.

|         |                                                                    |
| ------- | ------------------------------------------------------------------ |
| Package | `@cantoo/pdf-lib` 2.11.1 from npm                                  |
| File    | `dist/pdf-lib.min.js`, unmodified                                  |
| SHA-256 | `2294a0bb8742d8948ae2d49a60cb6a3600c0b5deae6de198e57fb368d1b79ba9` |
| License | MIT, see [LICENSE.md](LICENSE.md)                                  |

The file is built together with the package's dependencies: fflate, culori,
node-html-better-parser and html-entities (MIT) and tslib (0BSD).

## Updating

```sh
npm pack @cantoo/pdf-lib@<version>
tar -xzf cantoo-pdf-lib-<version>.tgz
cp package/dist/pdf-lib.min.js package/LICENSE.md vendor/pdf-lib/
sha256sum vendor/pdf-lib/pdf-lib.min.js   # record the new checksum above
npm test && npm run test:e2e
```

`src/pdf-cutter.js` recognises password problems by the engine's error messages, so check that
the password tests still pass after an update.
