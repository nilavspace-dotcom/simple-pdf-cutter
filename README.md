# ✂️ Simple PDF Cutter

Keep only the pages you need from a big PDF &mdash; for example **pages 12&ndash;27 of a 700-page
book** &mdash; and save them as a new, small PDF.

- **Easy:** choose a PDF, type the pages, click **Cut PDF**, download.
- **Private:** your PDF is processed inside your own web browser. It is never uploaded anywhere,
  and the tool works without an internet connection.
- **Opens protected PDFs:** e-books that are protected against copying or printing open as normal;
  for PDFs locked with a password, it asks for the password.
- **Clean results:** the new file contains only the pages you picked. Links between those pages
  keep working, and nothing from the rest of the book is hidden inside, so the file stays small.

<p align="center">
  <img src="docs/screenshot.png" width="560" alt="Simple PDF Cutter after cutting pages 12-27 out of a 700-page textbook">
</p>

## How to use it

1. **Get the tool.** On this page, click the green **Code** button and choose **Download ZIP**.
   Unzip the downloaded file.
2. **Open it.** In the unzipped folder, double-click **`index.html`**. It opens in your web browser.
3. **Choose your PDF.** Drag it onto the page, or click **click to choose a file**.
4. **Type the pages to keep**, for example `12-27`, and click **Cut PDF**.
5. **Click Download.** The new file is named after the original, for example
   `book_pages_12-27.pdf`.

Keep `index.html` together with the `src` and `vendor` folders: the page needs them.

### Use it from a web link instead (optional)

GitHub can host the tool for you as a web page, so it opens from a link on any computer or phone:

1. In this repository on GitHub, open **Settings &rarr; Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, select the branch that has this
   code and the **`/ (root)`** folder, then click **Save**.
3. After a minute or two the tool is at `https://<your-user-name>.github.io/simple-pdf-cutter/`.

Files opened on that page are still processed only in the visitor's browser; they are not sent to
GitHub or anywhere else.

## Choosing pages

| You type        | You get                         |
| --------------- | ------------------------------- |
| `12-27`         | pages 12 to 27 (16 pages)       |
| `5`             | page 5 only                     |
| `1-3, 8, 10-12` | pages 1, 2, 3, 8, 10, 11 and 12 |
| `12 to 27`      | pages 12 to 27                  |

- **Page 1 is the first page of the file**, including the cover. Printed books often number their
  pages differently, so the page printed as "12" may be, say, page 30 of the file. Your PDF viewer
  shows the file's page number in its toolbar.
- Pages always stay in their original order, and a page listed twice is included once.

## Good to know

- The new PDF keeps the page contents exactly as they were, along with comments, highlights, web
  links and links between the pages you kept. It also keeps the document's title, author and
  language.
- Bookmarks are not copied. Filled-in form fields still show their contents but can't be edited in
  the new file.
- A PDF that needs a password to open still needs that password; the tool doesn't break passwords.
- Large files are fine: a 700-page, 290 MB test book opens in a few seconds and cuts in under a
  second on a normal computer. Very large files need a fair amount of memory, so phones may
  struggle with them.

## Command line (optional)

If you have [Node.js](https://nodejs.org/) 22 or newer, you can also cut PDFs from a terminal:

```sh
node bin/pdf-cut.js book.pdf 12-27
# Saved 16 pages (12-27) to book_pages_12-27.pdf

node bin/pdf-cut.js book.pdf 1-3, 8 --output chapter-one.pdf
node bin/pdf-cut.js locked.pdf 12-27 --password "the password"
```

Existing files are never overwritten unless you add `--force`. Run `node bin/pdf-cut.js --help`
for all options.

## For developers

There is no build step: the web page is plain HTML, CSS and JavaScript.

| Path                | What it is                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `index.html`        | The web page                                                            |
| `src/pdf-cutter.js` | Core logic shared by the web page and the command line                  |
| `src/app.js`        | Web page behaviour (file picking, password prompt, download)            |
| `src/styles.css`    | Web page styles, with automatic dark mode                               |
| `bin/pdf-cut.js`    | Command-line tool                                                       |
| `vendor/pdf-lib/`   | The PDF engine, [`@cantoo/pdf-lib`](vendor/pdf-lib/README.md)           |
| `test/`             | Unit, command-line and browser tests, plus encrypted sample PDFs        |

### How it works

- **Reading** uses `@cantoo/pdf-lib`, a maintained fork of [pdf-lib](https://pdf-lib.js.org/) that
  can decrypt PDFs (RC4, AES-128 and AES-256). The original pdf-lib refuses encrypted files.
- **Copying pages** uses a small page copier of our own (`PageCopier` in `src/pdf-cutter.js`).
  pdf-lib's `copyPages()` follows every reference on a page, so a link to another page silently
  pulls that page, with its images and fonts, into the new file. Cutting pages 12&ndash;27 from a
  700-page scanned test book that way gave a 37 MB file containing 70 hidden pages; this copier
  gives 7 MB with none. It points links between kept pages at their new copies (including named
  destinations), drops links to removed pages, copies pages' inherited size, rotation and
  resources, and keeps hidden layers hidden.
- **Privacy:** everything runs in the browser and the page loads nothing from the internet. Its
  Content Security Policy also stops scripts from opening network connections or loading images
  from elsewhere, and the browser tests check that no request leaves the computer.

### Running the tests

```sh
npm install                          # installs Playwright for the browser tests
npm test                             # unit and command-line tests
npx playwright install chromium      # first time only
npm run test:e2e                     # browser tests, using index.html opened from disk
```

If [qpdf](https://qpdf.readthedocs.io/) is installed, the unit tests also use it to check that
every PDF they produce is well-formed. The encrypted sample PDFs in `test/fixtures/` were made with
qpdf and pypdf by `test/fixtures/make_fixtures.py`. GitHub Actions runs all tests on every push.
