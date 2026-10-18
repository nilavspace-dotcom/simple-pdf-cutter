/*!
 * Simple PDF Cutter - core logic shared by the web page and the command line.
 *
 * In a browser this file defines `window.PdfCutter` and expects the bundled
 * pdf-lib engine (`window.PDFLib`) to be loaded first. In Node.js it can be
 * loaded with `require()`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/pdf-lib/pdf-lib.min.js'));
  } else {
    root.PdfCutter = factory(root.PDFLib);
  }
})(globalThis, function (PDFLib) {
  'use strict';

  const {
    EncryptedPDFError,
    MissingPDFHeaderError,
    ParseSpeeds,
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNull,
    PDFNumber,
    PDFPage,
    PDFPageLeaf,
    PDFRef,
    PDFStream,
    PDFString,
  } = PDFLib;

  const NAMES = {
    A: PDFName.of('A'),
    Annots: PDFName.of('Annots'),
    B: PDFName.of('B'),
    D: PDFName.of('D'),
    Dest: PDFName.of('Dest'),
    Dests: PDFName.of('Dests'),
    GoTo: PDFName.of('GoTo'),
    Kids: PDFName.of('Kids'),
    Link: PDFName.of('Link'),
    Names: PDFName.of('Names'),
    OCProperties: PDFName.of('OCProperties'),
    Parent: PDFName.of('Parent'),
    S: PDFName.of('S'),
    Subtype: PDFName.of('Subtype'),
    Type: PDFName.of('Type'),
  };

  // Objects that tie a document together. A copied page must never pull these
  // in, or the "small" result would quietly contain the whole original file.
  const DOCUMENT_STRUCTURE_TYPES = new Set(
    ['Catalog', 'Pages', 'Page'].map((name) => PDFName.of(name)),
  );

  /** An error whose message is written for the person using the tool. */
  class PdfCutterError extends Error {
    /**
     * @param {string} code  Machine-readable reason, e.g. 'PASSWORD_REQUIRED'.
     * @param {string} message  Plain-language explanation.
     * @param {{cause?: unknown}} [options]
     */
    constructor(code, message, options) {
      super(message, options);
      this.name = 'PdfCutterError';
      this.code = code;
    }
  }

  // --------------------------------------------------------------------------
  // Page selection, e.g. "12-27" or "1-3, 8, 10-12"
  // --------------------------------------------------------------------------

  // Hyphen, non-breaking hyphen, figure/en/em dashes, horizontal bar, minus.
  const DASHES = /[\u2010-\u2015\u2212]/g;

  /**
   * Turns what the user typed into a list of pages.
   *
   * Accepts single pages and ranges separated by commas, semicolons or spaces.
   * Ranges may use any kind of dash or the word "to", and may be written
   * backwards. The result is always in document order without duplicates,
   * because cutting keeps pages in the order they appear in the original.
   *
   * @param {string} text  What the user typed.
   * @param {number} pageCount  Number of pages in the PDF.
   * @returns {{pages: number[], ranges: Array<[number, number]>, label: string}}
   *   `pages` are 1-based page numbers; `ranges` are the merged ranges;
   *   `label` is a compact form such as "1-3,8,10-12".
   * @throws {PdfCutterError} with code 'INVALID_PAGES'.
   */
  function parsePageSelection(text, pageCount) {
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new TypeError(`pageCount must be a positive integer, got ${pageCount}`);
    }

    const normalized = String(text == null ? '' : text)
      .normalize('NFKC') // full-width digits and punctuation -> ASCII
      .replace(DASHES, '-')
      .replace(/\s*(?:-|\bto\b)\s*/gi, '-')
      .trim();

    const ranges = [];
    for (const part of normalized.split(/[\s,;]+/)) {
      if (!part) continue;
      const match = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!match) {
        throw invalidPages(
          `"${part}" is not a page number or a range. Write pages like 12-27 or 1-3, 8.`,
        );
      }
      const first = checkPageNumber(match[1], pageCount);
      const last = match[2] === undefined ? first : checkPageNumber(match[2], pageCount);
      ranges.push(first <= last ? [first, last] : [last, first]);
    }
    if (ranges.length === 0) {
      throw invalidPages('Type the pages you want to keep, for example 12-27.');
    }

    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [first, last] of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && first <= previous[1] + 1) {
        previous[1] = Math.max(previous[1], last);
      } else {
        merged.push([first, last]);
      }
    }

    const pages = [];
    for (const [first, last] of merged) {
      for (let page = first; page <= last; page++) pages.push(page);
    }
    const label = merged
      .map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`))
      .join(',');
    return { pages, ranges: merged, label };
  }

  function checkPageNumber(digits, pageCount) {
    const page = Number(digits);
    if (page === 0) {
      throw invalidPages('There is no page 0. The first page of the file is page 1.');
    }
    if (page > pageCount) {
      const shown = Number.isSafeInteger(page) ? page : digits;
      throw invalidPages(
        `Page ${shown} doesn't exist. This PDF has only ${pluralize(pageCount, 'page')}.`,
      );
    }
    return page;
  }

  function invalidPages(message) {
    return new PdfCutterError('INVALID_PAGES', message);
  }

  /**
   * Suggests a file name for the result, e.g. "book.pdf" -> "book_pages_12-27.pdf".
   *
   * @param {string} inputName  Name (or path) of the original file.
   * @param {string} label  The `label` returned by parsePageSelection().
   * @returns {string}
   */
  function suggestOutputName(inputName, label) {
    let suffix = 'selected_pages';
    if (/^\d+$/.test(label)) suffix = `page_${label}`;
    else if (label.length <= 40) suffix = `pages_${label}`;
    return `${fileBaseName(inputName)}_${suffix}.pdf`;
  }

  /** The name of a file without its folder and ".pdf", e.g. "/docs/book.pdf" -> "book". */
  function fileBaseName(inputName) {
    return (
      String(inputName || '')
        .split(/[\\/]/)
        .pop()
        .replace(/\.pdf$/i, '')
        .trim() || 'document'
    );
  }

  function pluralize(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }

  // --------------------------------------------------------------------------
  // Opening a PDF
  // --------------------------------------------------------------------------

  /**
   * Reads a PDF. Files that are only protected against copying or printing
   * open without a password; files that need a password to be viewed need
   * `options.password`.
   *
   * @param {ArrayBuffer|Uint8Array} data  The file contents.
   * @param {{password?: string}} [options]
   * @returns {Promise<PDFLib.PDFDocument>}
   * @throws {PdfCutterError} with code 'PASSWORD_REQUIRED', 'WRONG_PASSWORD',
   *   'UNSUPPORTED_ENCRYPTION', 'NOT_A_PDF' or 'UNREADABLE'.
   */
  async function openPdf(data, options = {}) {
    const password = options.password || '';
    let pdf;
    try {
      pdf = await PDFDocument.load(data, {
        password,
        updateMetadata: false,
        parseSpeed: ParseSpeeds.Fast,
      });
    } catch (error) {
      throw explainOpenError(error, password);
    }

    let pageCount;
    try {
      pageCount = pdf.getPageCount();
    } catch (error) {
      throw unreadable(error);
    }
    if (pageCount === 0) {
      throw new PdfCutterError('UNREADABLE', 'This PDF has no pages.');
    }
    return pdf;
  }

  function explainOpenError(error, password) {
    const message = String(error && error.message);
    if (message.includes('NEEDS PASSWORD') || error instanceof EncryptedPDFError) {
      return new PdfCutterError(
        'PASSWORD_REQUIRED',
        'This PDF is locked with a password. Enter the password to open it.',
        { cause: error },
      );
    }
    if (message.includes('Password incorrect')) {
      return new PdfCutterError(
        password ? 'WRONG_PASSWORD' : 'PASSWORD_REQUIRED',
        password
          ? 'That password is not correct. Please try again.'
          : 'This PDF is locked with a password. Enter the password to open it.',
        { cause: error },
      );
    }
    if (/encryption|crypt|cipher|key length/i.test(message)) {
      return new PdfCutterError(
        'UNSUPPORTED_ENCRYPTION',
        'This PDF uses a kind of protection that this tool cannot open.',
        { cause: error },
      );
    }
    if (error instanceof MissingPDFHeaderError) {
      return new PdfCutterError('NOT_A_PDF', 'This file is not a PDF.', { cause: error });
    }
    return unreadable(error);
  }

  function unreadable(error) {
    return new PdfCutterError(
      'UNREADABLE',
      'This PDF could not be read. The file may be damaged or incomplete.',
      { cause: error },
    );
  }

  // --------------------------------------------------------------------------
  // Cutting
  // --------------------------------------------------------------------------

  /**
   * Builds a new PDF that contains only the given pages of `source`.
   *
   * @param {PDFLib.PDFDocument} source  A document returned by openPdf().
   * @param {number[]} pageNumbers  1-based page numbers, each at most once,
   *   in the order they should appear.
   * @returns {Promise<Uint8Array>} The new PDF file.
   */
  async function extractPages(source, pageNumbers) {
    if (pageNumbers.length === 0) throw new RangeError('No pages to extract');
    const sourcePages = source.getPages();
    const seen = new Set();
    const kept = pageNumbers.map((number) => {
      if (!Number.isInteger(number) || !sourcePages[number - 1] || seen.has(number)) {
        throw new RangeError(`Invalid or repeated page number: ${number}`);
      }
      seen.add(number);
      return sourcePages[number - 1];
    });

    const output = await PDFDocument.create();
    const copier = new PageCopier(source, output, kept);
    for (const page of kept) output.addPage(copier.copyPage(page));
    copyDocumentSettings(source, output, copier);

    return output.save({ useObjectStreams: true, objectsPerTick: 1000 });
  }

  /**
   * Copies pages into another document together with everything they use
   * (fonts, images, ...) and nothing else.
   *
   * pdf-lib's own copyPages() follows every reference it finds, so a link to
   * another page drags that page - with its images and fonts - into the new
   * file as a hidden object; a book with a linked table of contents can end up
   * almost as large as the original. This copier instead:
   *  - points links between kept pages at their new copies,
   *  - drops links to pages that were cut away (also for named destinations),
   *  - replaces any other reference to a removed page or to the page tree
   *    with null.
   */
  class PageCopier {
    constructor(source, target, keptPages) {
      this.source = source;
      this.target = target;
      this.src = source.context;
      this.dst = target.context;
      // Reserve the new page references up front so that links can point at
      // pages that have not been copied yet.
      this.keptPageRefs = new Map();
      for (const page of keptPages) {
        if (!this.keptPageRefs.has(page.ref)) {
          this.keptPageRefs.set(page.ref, this.dst.nextRef());
        }
      }
      this.copiedRefs = new Map(); // source ref -> target ref
      this.pending = []; // [source object, target ref] still to be copied
      this.namedDestinations = undefined; // built on first use
    }

    /** @returns {PDFLib.PDFPage} The copy, ready to be added to the target. */
    copyPage(page) {
      const original = page.node;
      const copy = original.clone(this.dst);
      copy.delete(NAMES.Parent);
      // Article beads chain pages into threads that are not carried over.
      copy.delete(NAMES.B);
      // Attributes such as the page size may be inherited from the page tree,
      // which is not copied, so store them on the page itself.
      for (const key of PDFPageLeaf.InheritableEntries) {
        const name = PDFName.of(key);
        if (copy.has(name)) continue;
        const inherited = original.getInheritableAttribute(name);
        if (inherited !== undefined) copy.set(name, inherited);
      }

      for (const [key, value] of copy.entries()) {
        if (key !== NAMES.Annots) {
          copy.set(key, this.copy(value));
          continue;
        }
        const annotations = this.copyAnnotations(value);
        if (annotations) copy.set(key, annotations);
        else copy.delete(key);
      }

      const ref = this.keptPageRefs.get(page.ref);
      this.dst.assign(ref, copy);
      this.flush();
      return PDFPage.of(copy, ref, this.target);
    }

    /**
     * Copies any object from the source document. Indirect objects are queued
     * and copied by flush(), which keeps the call stack shallow even for long
     * chains of objects.
     */
    copy(object) {
      if (object instanceof PDFRef) return this.copyRef(object);
      if (object instanceof PDFDict) return this.copyEntries(object, object.clone(this.dst));
      if (object instanceof PDFStream) {
        const stream = object.clone(this.dst);
        this.copyEntries(object.dict, stream.dict);
        return stream;
      }
      if (object instanceof PDFArray) {
        const array = object.clone(this.dst);
        for (let i = 0; i < object.size(); i++) array.set(i, this.copy(object.get(i)));
        return array;
      }
      return object.clone();
    }

    copyEntries(from, to) {
      for (const [key, value] of from.entries()) to.set(key, this.copy(value));
      return to;
    }

    copyRef(ref) {
      const keptPage = this.keptPageRefs.get(ref);
      if (keptPage) return keptPage;
      let copied = this.copiedRefs.get(ref);
      if (copied) return copied;

      const object = this.src.lookup(ref);
      if (object === undefined || isDocumentStructure(object)) return PDFNull;
      copied = this.dst.nextRef();
      this.copiedRefs.set(ref, copied);
      this.pending.push([object, copied]);
      return copied;
    }

    flush() {
      while (this.pending.length > 0) {
        const [object, ref] = this.pending.pop();
        this.dst.assign(ref, this.copy(object));
      }
    }

    copyAnnotations(value) {
      const annotations = this.src.lookup(value);
      if (!(annotations instanceof PDFArray)) return undefined;

      const result = PDFArray.withContext(this.dst);
      for (let i = 0; i < annotations.size(); i++) {
        const entry = annotations.get(i);
        const annotation = this.src.lookup(entry);
        if (!(annotation instanceof PDFDict)) continue;

        const link = this.findLinkTarget(annotation);
        if (link && !link.targetRef) continue; // its page was cut away

        const copied = this.copy(entry);
        if (copied === PDFNull) continue;
        if (link && link.rewrite) this.pointLinkAt(copied, link);
        result.push(copied);
      }
      return result.size() > 0 ? result : undefined;
    }

    /**
     * Works out where a link annotation leads.
     *
     * @returns {undefined|{targetRef?: PDFLib.PDFRef, rewrite?: boolean,
     *   inAction?: boolean, destination?: PDFLib.PDFArray}}
     *   undefined if the annotation is not a link within this document;
     *   otherwise `targetRef` is the new reference of the target page, or
     *   missing if that page is not kept. `rewrite` is set when the link
     *   names its target in a way the new file cannot resolve (a named
     *   destination or a page index), so it must be rewritten to point at
     *   `targetRef` directly.
     */
    findLinkTarget(annotation) {
      if (annotation.lookup(NAMES.Subtype) !== NAMES.Link) return undefined;

      let inAction = false;
      let destination = annotation.get(NAMES.Dest);
      if (destination === undefined) {
        const action = annotation.lookup(NAMES.A);
        if (!(action instanceof PDFDict) || action.lookup(NAMES.S) !== NAMES.GoTo) {
          return undefined; // a web link, a link to another file, ...
        }
        inAction = true;
        destination = action.get(NAMES.D);
      }

      const explicit = this.resolveDestination(destination);
      const first = explicit && explicit.get(0);
      let pageRef;
      if (first instanceof PDFRef) {
        pageRef = first;
      } else if (first instanceof PDFNumber) {
        // Not allowed by the PDF standard, but some tools store a page index.
        const page = this.source.getPages()[first.asNumber()];
        pageRef = page && page.ref;
      }

      const targetRef = pageRef && this.keptPageRefs.get(pageRef);
      if (!targetRef) return {};
      const rewrite = !(
        this.src.lookup(destination) instanceof PDFArray && first instanceof PDFRef
      );
      return { targetRef, rewrite, inAction, destination: explicit };
    }

    /** Resolves a destination (explicit, or a name to look up) to an array. */
    resolveDestination(destination) {
      let value = this.src.lookup(destination);
      if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
        value = this.src.lookup(this.getNamedDestinations().get(textKey(value)));
      }
      if (value instanceof PDFDict) value = value.lookup(NAMES.D);
      return value instanceof PDFArray ? value : undefined;
    }

    getNamedDestinations() {
      if (this.namedDestinations) return this.namedDestinations;
      const destinations = new Map();
      const catalog = this.source.catalog;

      // PDF 1.2 and later: a name tree under /Names /Dests.
      const names = catalog.lookup(NAMES.Names);
      const stack =
        names instanceof PDFDict && names.get(NAMES.Dests) ? [names.get(NAMES.Dests)] : [];
      const visited = new Set();
      while (stack.length > 0) {
        const node = this.src.lookup(stack.pop());
        if (!(node instanceof PDFDict) || visited.has(node)) continue;
        visited.add(node);
        const pairs = node.lookup(NAMES.Names);
        if (pairs instanceof PDFArray) {
          for (let i = 0; i + 1 < pairs.size(); i += 2) {
            const key = textKey(pairs.lookup(i));
            if (key !== undefined && !destinations.has(key)) {
              destinations.set(key, pairs.get(i + 1));
            }
          }
        }
        const kids = node.lookup(NAMES.Kids);
        if (kids instanceof PDFArray) {
          for (let i = 0; i < kids.size(); i++) stack.push(kids.get(i));
        }
      }

      // PDF 1.1: a plain dictionary in the catalog.
      const legacy = catalog.lookup(NAMES.Dests);
      if (legacy instanceof PDFDict) {
        for (const [name, value] of legacy.entries()) {
          const key = textKey(name);
          if (!destinations.has(key)) destinations.set(key, value);
        }
      }

      this.namedDestinations = destinations;
      return destinations;
    }

    /** Makes a copied link point straight at the copy of its target page. */
    pointLinkAt(copiedAnnotation, link) {
      this.flush(); // the copied annotation and its action must exist first
      const destination = PDFArray.withContext(this.dst);
      destination.push(link.targetRef);
      for (let i = 1; i < link.destination.size(); i++) {
        destination.push(this.copy(link.destination.get(i)));
      }
      const annotation = this.dst.lookup(copiedAnnotation);
      const holder = link.inAction ? this.dst.lookup(annotation.get(NAMES.A)) : annotation;
      holder.set(link.inAction ? NAMES.D : NAMES.Dest, destination);
    }
  }

  function isDocumentStructure(object) {
    return object instanceof PDFDict && DOCUMENT_STRUCTURE_TYPES.has(object.lookup(NAMES.Type));
  }

  /** The raw bytes of a name or string, as a string usable as a Map key. */
  function textKey(object) {
    if (
      !(object instanceof PDFName || object instanceof PDFString || object instanceof PDFHexString)
    ) {
      return undefined;
    }
    let key = '';
    for (const byte of object.asBytes()) key += String.fromCharCode(byte);
    return key;
  }

  /**
   * Carries over document properties that still make sense for an excerpt:
   * title, author and similar details, the language, and the visibility of
   * layers (otherwise hidden layers would suddenly show up).
   */
  function copyDocumentSettings(source, output, copier) {
    const details = {
      Title: (value) => output.setTitle(value),
      Author: (value) => output.setAuthor(value),
      Subject: (value) => output.setSubject(value),
      Keywords: (value) => output.setKeywords([value]),
      Creator: (value) => output.setCreator(value),
      Language: (value) => output.setLanguage(value),
    };
    for (const [name, write] of Object.entries(details)) {
      try {
        const value = source[`get${name}`]();
        if (value) write(value);
      } catch {
        // Malformed metadata is not worth failing over.
      }
    }

    const layers = source.catalog.get(NAMES.OCProperties);
    if (layers) {
      output.catalog.set(NAMES.OCProperties, copier.copy(layers));
      copier.flush();
    }
  }

  return {
    PdfCutterError,
    parsePageSelection,
    suggestOutputName,
    fileBaseName,
    openPdf,
    extractPages,
  };
});
