'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { describe, test } = require('node:test');
const { openPdf, extractPages, parsePageSelection } = require('../../src/pdf-cutter.js');
const {
  PDFLib,
  makeNumberedPdf,
  originalPageNumbers,
  countPageObjects,
  pageContentText,
  checkWithQpdf,
  fixturePath,
} = require('../helpers.js');

const { PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict, PDFRef } = PDFLib;

const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

async function cut(bytes, selection, options) {
  const pdf = await openPdf(bytes, options);
  return extractPages(pdf, parsePageSelection(selection, pdf.getPageCount()).pages);
}

function assertValidPdf(bytes) {
  const result = checkWithQpdf(bytes);
  if (!result.skipped) assert.ok(result.ok, `qpdf --check failed:\n${result.output}`);
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'PdfCutterError');
    assert.equal(error.code, code);
    return true;
  });
}

describe('extractPages', () => {
  test('keeps exactly the selected pages, with their content', async () => {
    const source = await makeNumberedPdf(30);
    const output = await cut(source, '12-27');

    assert.deepEqual(await originalPageNumbers(output), range(12, 27));
    const sourceDoc = await PDFDocument.load(source);
    const outputDoc = await PDFDocument.load(output);
    assert.equal(pageContentText(outputDoc.getPage(0)), pageContentText(sourceDoc.getPage(11)));
    assertValidPdf(output);
  });

  test('keeps pages in the order they are given', async () => {
    const pdf = await openPdf(await makeNumberedPdf(5));
    assert.deepEqual(await originalPageNumbers(await extractPages(pdf, [3, 1, 2])), [3, 1, 2]);
  });

  test('can cut the same opened PDF several times', async () => {
    const pdf = await openPdf(await makeNumberedPdf(30));
    const first = await extractPages(pdf, range(12, 27));
    const second = await extractPages(pdf, range(12, 27));
    const third = await extractPages(pdf, [1, 30]);
    assert.deepEqual(await originalPageNumbers(first), range(12, 27));
    assert.deepEqual(await originalPageNumbers(second), range(12, 27));
    assert.deepEqual(await originalPageNumbers(third), [1, 30]);
  });

  test('copies resources shared by several pages only once', async () => {
    const output = await cut(await makeNumberedPdf(30), '12-27');
    const doc = await PDFDocument.load(output);
    const fonts = doc.context
      .enumerateIndirectObjects()
      .filter(
        ([, object]) =>
          object instanceof PDFDict && object.lookup(PDFName.of('Type')) === PDFName.of('Font'),
      );
    assert.equal(fonts.length, 1);
  });

  test('keeps size, rotation and fonts that pages inherit from the page tree', async () => {
    const source = await makePdfWithInheritedAttributes();
    const sourceDoc = await PDFDocument.load(source);
    assert.equal(sourceDoc.getPage(1).node.get(PDFName.of('MediaBox')), undefined, 'test setup');

    const page = (await PDFDocument.load(await cut(source, '2'))).getPage(0);
    assert.deepEqual(page.getSize(), { width: 400, height: 300 });
    assert.equal(page.getRotation().angle, 90);
    const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict);
    assert.ok(fonts.get(PDFName.of('F1')), 'the inherited font is available on the page');
    assert.match(pageContentText(page), /\(Page 2\) Tj/);
  });

  test('keeps links between kept pages and drops links to removed pages', async () => {
    const output = await cut(await makePdfWithLinks(), '12-27');
    const doc = await PDFDocument.load(output);

    assert.deepEqual(describeAnnotations(doc), [
      'page 1: link to page 4 /XYZ', // explicit destination (page 15)
      'page 1: link to page 9 /XYZ', // named destination in the name tree (page 20)
      'page 1: link to page 2 /Fit', // PDF 1.1 named destination (page 13)
      'page 1: link to page 6 /Fit', // page index 16 (page 17)
      'page 1: link to page 7 /Fit via action', // GoTo action (page 18)
      'page 1: link to page 9 /XYZ via action', // GoTo action with a named destination
      'page 1: link to https://example.com',
      'page 1: Text annotation of page 1',
    ]);
    assert.equal(doc.catalog.get(PDFName.of('Names')), undefined);
    assertValidPdf(output);
  });

  test('does not drag other pages along through links', async () => {
    // Every page carries a 20 KB image and links to every other page, like a
    // scanned book with a linked table of contents. Each page also has an
    // action that jumps to the next page, which is not a link annotation.
    const source = await makeNumberedPdf(40, { edit: addImagesAndLinksToEveryPage });
    assert.ok(source.length > 40 * 20_000, 'test setup');

    const output = await cut(source, '12');
    assert.deepEqual(await originalPageNumbers(output), [12]);
    assert.equal(await countPageObjects(output), 1);
    assert.ok(
      output.length < 30_000,
      `expected about one page worth of data, got ${output.length} bytes`,
    );
    assertValidPdf(output);
  });

  test('keeps hidden layers hidden', async () => {
    const output = await cut(await makePdfWithHiddenLayer(), '2');
    const doc = await PDFDocument.load(output);

    const layers = doc.catalog.lookup(PDFName.of('OCProperties'), PDFDict);
    const hidden = layers
      .lookup(PDFName.of('D'), PDFDict)
      .lookup(PDFName.of('OFF'), PDFArray)
      .get(0);
    const used = doc
      .getPage(0)
      .node.Resources()
      .lookup(PDFName.of('Properties'), PDFDict)
      .get(PDFName.of('oc1'));
    assert.ok(hidden instanceof PDFRef);
    assert.equal(hidden, used, 'the page and the layer settings refer to the same layer');
    assertValidPdf(output);
  });

  test('carries over the title, author and language', async () => {
    const source = await makeNumberedPdf(3, {
      edit(doc) {
        doc.setTitle('A Long Book');
        doc.setAuthor('Ada Author');
        doc.setSubject('Testing');
        doc.setKeywords(['pdf', 'cutting']);
        doc.setLanguage('en-GB');
      },
    });
    const doc = await PDFDocument.load(await cut(source, '2'));
    assert.equal(doc.getTitle(), 'A Long Book');
    assert.equal(doc.getAuthor(), 'Ada Author');
    assert.equal(doc.getSubject(), 'Testing');
    assert.equal(doc.getKeywords(), 'pdf cutting');
    assert.equal(doc.getLanguage(), 'en-GB');
  });

  test('rejects page numbers that are missing, repeated or out of range', async () => {
    const pdf = await openPdf(await makeNumberedPdf(5));
    await assert.rejects(extractPages(pdf, []), RangeError);
    await assert.rejects(extractPages(pdf, [0]), RangeError);
    await assert.rejects(extractPages(pdf, [6]), RangeError);
    await assert.rejects(extractPages(pdf, [2, 2]), RangeError);
    await assert.rejects(extractPages(pdf, [1.5]), RangeError);
  });
});

describe('openPdf', () => {
  test('opens copy-protected PDFs without a password and saves them unprotected', async () => {
    for (const name of ['qpdf-aes256-objstreams.pdf', 'pypdf-aes128.pdf', 'pypdf-rc4-40.pdf']) {
      const output = await cut(fs.readFileSync(fixturePath(name)), '12-27');
      assert.deepEqual(await originalPageNumbers(output), range(12, 27), name);
      const doc = await PDFDocument.load(output);
      assert.equal(doc.isEncrypted, false, name);
      assert.match(pageContentText(doc.getPage(0)), /\(Page 12\) Tj/, name);
      assertValidPdf(output);
    }
  });

  test('asks for the password of a locked PDF', async () => {
    const locked = fs.readFileSync(fixturePath('qpdf-aes256-password.pdf'));
    await rejectsWith(openPdf(locked), 'PASSWORD_REQUIRED');
    await rejectsWith(openPdf(locked, { password: 'wrong' }), 'WRONG_PASSWORD');
    const output = await cut(locked, '12-27', { password: 'open-me' });
    assert.deepEqual(await originalPageNumbers(output), range(12, 27));
  });

  test('opens PDFs encrypted by pdf-lib itself', async () => {
    const restricted = await makeNumberedPdf(5, {
      encrypt: { ownerPassword: 'owner', userPassword: '' },
    });
    assert.deepEqual(await originalPageNumbers(await cut(restricted, '2-3')), [2, 3]);

    const locked = await makeNumberedPdf(5, {
      encrypt: { ownerPassword: 'owner', userPassword: 'user' },
    });
    await rejectsWith(openPdf(locked), 'PASSWORD_REQUIRED');
    assert.deepEqual(
      await originalPageNumbers(await cut(locked, '2-3', { password: 'user' })),
      [2, 3],
    );
  });

  test('explains files that cannot be used', async () => {
    await rejectsWith(openPdf(new Uint8Array(0)), 'NOT_A_PDF');
    await rejectsWith(openPdf(Buffer.from('Just some text, not a PDF.\n'.repeat(20))), 'NOT_A_PDF');
    await rejectsWith(openPdf(Buffer.from('%PDF-1.7\n%%EOF\n')), 'UNREADABLE');

    const empty = await PDFDocument.create();
    await rejectsWith(openPdf(await empty.save({ addDefaultPage: false })), 'UNREADABLE');
  });

  test('opens a damaged PDF as far as it can be read', async () => {
    const source = await makeNumberedPdf(30);
    const truncated = source.subarray(0, source.length - 200); // lost the end of the file
    const output = await cut(truncated, '12-27');
    assert.deepEqual(await originalPageNumbers(output), range(12, 27));
  });
});

// ---- Test documents ---------------------------------------------------------

async function makePdfWithInheritedAttributes() {
  const doc = await PDFDocument.create();
  const context = doc.context;
  const font = context.register(
    context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }),
  );
  for (let n = 1; n <= 3; n++) {
    const page = doc.addPage();
    page.node.delete(PDFName.of('MediaBox'));
    page.node.delete(PDFName.of('Resources'));
    page.node.set(
      PDFName.of('Contents'),
      context.register(context.stream(`BT /F1 24 Tf 20 150 Td (Page ${n}) Tj ET`)),
    );
  }
  const tree = doc.catalog.Pages();
  tree.set(PDFName.of('MediaBox'), context.obj([0, 0, 400, 300]));
  tree.set(PDFName.of('Rotate'), context.obj(90));
  tree.set(PDFName.of('Resources'), context.obj({ Font: { F1: font } }));
  return doc.save();
}

/** Page 12 of a 30-page document gets every kind of link. */
function makePdfWithLinks() {
  return makeNumberedPdf(30, {
    edit(doc) {
      const context = doc.context;
      const pages = doc.getPages();
      const ref = (n) => pages[n - 1].ref;

      // Named destinations: a name tree with two leaves, and a PDF 1.1 dictionary.
      const chapter20 = context.register(
        context.obj({
          Limits: [PDFString.of('chapter-20'), PDFString.of('chapter-20')],
          Names: [PDFString.of('chapter-20'), context.obj({ D: [ref(20), 'XYZ', 0, 300, 0] })],
        }),
      );
      const intro = context.register(
        context.obj({
          Limits: [PDFHexString.fromText('intro'), PDFHexString.fromText('intro')],
          Names: [PDFHexString.fromText('intro'), [ref(2), 'Fit']],
        }),
      );
      doc.catalog.set(PDFName.of('Names'), context.obj({ Dests: { Kids: [chapter20, intro] } }));
      doc.catalog.set(PDFName.of('Dests'), context.obj({ Legacy13: [ref(13), 'Fit'] }));

      const annotations = [
        { Subtype: 'Link', Dest: [ref(15), 'XYZ', 0, 300, 0] },
        { Subtype: 'Link', Dest: [ref(5), 'Fit'] }, // removed page
        { Subtype: 'Link', Dest: PDFString.of('chapter-20') },
        { Subtype: 'Link', Dest: PDFHexString.fromText('intro') }, // removed page
        { Subtype: 'Link', Dest: PDFName.of('Legacy13') },
        { Subtype: 'Link', Dest: [16, 'Fit'] }, // a page index instead of a page
        { Subtype: 'Link', A: { S: 'GoTo', D: [ref(18), 'Fit'] } },
        { Subtype: 'Link', A: { S: 'GoTo', D: PDFString.of('chapter-20') } },
        { Subtype: 'Link', A: { S: 'URI', URI: PDFString.of('https://example.com') } },
        { Subtype: 'Link', Dest: PDFString.of('no-such-destination') },
        { Subtype: 'Text', Contents: PDFString.of('A note') },
      ].map((fields, i) =>
        context.register(
          context.obj({
            Type: 'Annot',
            Rect: [10, 10 + 12 * i, 100, 20 + 12 * i],
            P: ref(12),
            ...fields,
          }),
        ),
      );
      pages[11].node.set(PDFName.of('Annots'), context.obj(annotations));
    },
  });
}

function describeAnnotations(doc) {
  const pageNumbers = new Map(doc.getPages().map((page, i) => [page.ref, i + 1]));
  const describeDestination = (destination) => {
    const array = doc.context.lookup(destination, PDFArray);
    return `page ${pageNumbers.get(array.get(0))} ${array.get(1).asString()}`;
  };
  return doc.getPages().flatMap((page, i) => {
    const annotations = page.node.lookup(PDFName.of('Annots'));
    if (!annotations) return [];
    return annotations.asArray().map((entry) => {
      const annotation = doc.context.lookup(entry, PDFDict);
      const subtype = annotation.lookup(PDFName.of('Subtype'), PDFName).decodeText();
      let description = `${subtype} annotation of page ${pageNumbers.get(annotation.get(PDFName.of('P')))}`;
      if (subtype === 'Link') {
        const action = annotation.lookup(PDFName.of('A'));
        if (!action) {
          description = `link to ${describeDestination(annotation.get(PDFName.of('Dest')))}`;
        } else if (action.lookup(PDFName.of('S')) === PDFName.of('URI')) {
          description = `link to ${action.lookup(PDFName.of('URI')).decodeText()}`;
        } else {
          description = `link to ${describeDestination(action.get(PDFName.of('D')))} via action`;
        }
      }
      return `page ${i + 1}: ${description}`;
    });
  });
}

function addImagesAndLinksToEveryPage(doc) {
  const context = doc.context;
  const pages = doc.getPages();
  let seed = 42;
  for (const page of pages) {
    const pixels = new Uint8Array(20_000);
    for (let i = 0; i < pixels.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      pixels[i] = seed >>> 24;
    }
    const image = context.register(
      context.stream(pixels, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 100,
        Height: 200,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
      }),
    );
    page.node.setXObject(PDFName.of('Im0'), image);
  }
  pages.forEach((page, index) => {
    const links = pages
      .filter((other) => other !== page)
      .map((other, i) =>
        context.register(
          context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [0, i, 10, i + 1],
            Dest: [other.ref, 'Fit'],
            P: page.ref,
          }),
        ),
      );
    page.node.set(PDFName.of('Annots'), context.obj(links));
    const next = pages[(index + 1) % pages.length];
    page.node.set(PDFName.of('AA'), context.obj({ C: { S: 'GoTo', D: [next.ref, 'Fit'] } }));
  });
}

function makePdfWithHiddenLayer() {
  return makeNumberedPdf(3, {
    edit(doc) {
      const context = doc.context;
      const layer = context.register(
        context.obj({ Type: 'OCG', Name: PDFHexString.fromText('Answers') }),
      );
      doc.catalog.set(
        PDFName.of('OCProperties'),
        context.obj({ OCGs: [layer], D: { Order: [layer], OFF: [layer] } }),
      );
      const page = doc.getPage(1);
      page.node.Resources().set(PDFName.of('Properties'), context.obj({ oc1: layer }));
      page.node.addContentStream(
        context.register(context.stream('/OC /oc1 BDC 20 20 m 80 80 l S EMC')),
      );
    },
  });
}
