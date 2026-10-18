/*
 * Simple PDF Cutter - the "Extract images" tab of the web page. The image
 * handling itself lives in pdf-images.js.
 */
(function () {
  'use strict';

  const DOWNLOAD_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" /></svg>';

  /**
   * Sets up the tab.
   *
   * @param {object} app  What the tab needs from the rest of the page:
   *   getPdf(), getFileName(), setBusy(message|false), report(error),
   *   showError(message), clearError() and formatSize(bytes).
   * @returns {{reset: () => void, setBusy: (busy: boolean) => void}}
   */
  function createImagePanel(app) {
    const { findImages, exportImage, suggestImagesName } = window.PdfImages;
    const { parsePageSelection } = window.PdfCutter;
    const { crc32, createZip } = window.PdfCutterFormats;

    const $ = (id) => document.getElementById(id);
    const ui = {
      form: $('images-form'),
      allPages: $('image-pages-all'),
      somePages: $('image-pages-some'),
      pagesInput: $('image-pages-input'),
      findButton: $('find-button'),
      area: $('gallery-area'),
      summary: $('gallery-summary'),
      actions: document.querySelector('.gallery-actions'),
      selectAll: $('select-all'),
      selectNone: $('select-none'),
      showSmallToggle: $('show-small-toggle'),
      showSmall: $('show-small'),
      showSmallLabel: $('show-small-label'),
      gallery: $('gallery'),
      zipButton: $('zip-button'),
      zipButtonLabel: $('zip-button-label'),
      zipResult: $('zip-result'),
      zipResultText: $('zip-result-text'),
      zipLink: $('zip-link'),
    };

    let items = []; // one per image: { info, card, checkbox, thumb, download, file, url, failed }
    const itemsByCard = new Map();
    let searchedLabel; // the pages searched, for the ZIP file's name
    let zipUrl = null;
    let busy = false;
    let generation = 0; // changes on every new search, so older work is dropped
    let queue = Promise.resolve();
    const observer =
      'IntersectionObserver' in window
        ? new IntersectionObserver(showWhenVisible, { rootMargin: '300px' })
        : null;

    ui.pagesInput.addEventListener('input', () => {
      ui.somePages.checked = true;
    });
    ui.form.addEventListener('submit', (event) => {
      event.preventDefault();
      search();
    });
    ui.selectAll.addEventListener('click', () => selectAll(true));
    ui.selectNone.addEventListener('click', () => selectAll(false));
    ui.showSmall.addEventListener('change', () => {
      ui.gallery.classList.toggle('show-small', ui.showSmall.checked);
      changed();
    });
    ui.zipButton.addEventListener('click', saveZip);

    // ---- Finding images ------------------------------------------------------

    async function search() {
      const pdf = app.getPdf();
      if (!pdf || busy) return;
      app.clearError();

      let pageNumbers;
      let label;
      if (ui.somePages.checked) {
        try {
          ({ pages: pageNumbers, label } = parsePageSelection(
            ui.pagesInput.value,
            pdf.getPageCount(),
          ));
        } catch (error) {
          app.report(error);
          ui.pagesInput.focus();
          return;
        }
      } else {
        pageNumbers = Array.from({ length: pdf.getPageCount() }, (_, i) => i + 1);
      }

      reset();
      const run = generation;
      app.setBusy('Looking for images…');
      try {
        const found = await findImages(pdf, pageNumbers, {
          onProgress(done, total) {
            if (total > 20) app.setBusy(`Looking for images… page ${done} of ${total}`);
          },
        });
        if (run !== generation) return;
        searchedLabel = label;
        showResults(found);
      } catch (error) {
        app.report(error);
      } finally {
        app.setBusy(false);
      }
      if (items.length > 0) ui.zipButton.focus();
    }

    function showResults(found) {
      ui.area.hidden = false;
      const nothing = found.length === 0;
      ui.actions.hidden = nothing;
      ui.gallery.hidden = nothing;
      ui.zipButton.hidden = nothing;
      if (nothing) {
        ui.summary.textContent =
          `No images found ${where()}. Charts and text that the PDF draws itself are not ` +
          'stored as pictures, so there is nothing to save.';
        return;
      }
      items = found.map(createCard);
      const fragment = document.createDocumentFragment();
      for (const item of items) {
        fragment.append(item.card);
        itemsByCard.set(item.card, item);
        if (observer) observer.observe(item.card);
        else prepare(item);
      }
      ui.gallery.append(fragment);
      changed();
    }

    function createCard(info) {
      const card = document.createElement('li');
      card.className = `image-card${info.small ? ' small' : ''}`;

      const pick = document.createElement('label');
      pick.className = 'image-pick';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.setAttribute('aria-label', `Select ${info.fileName}`);
      const thumb = document.createElement('span');
      thumb.className = 'thumb';
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      thumb.append(spinner);
      pick.append(checkbox, thumb);

      const meta = document.createElement('div');
      meta.className = 'image-meta';
      const pages = document.createElement('strong');
      pages.textContent = describePages(info.pages);
      const details = document.createElement('span');
      details.textContent = `${info.width} × ${info.height} · ${info.format.toUpperCase()}`;
      meta.append(pages, details);

      const download = document.createElement('button');
      download.type = 'button';
      download.className = 'icon-button';
      download.title = `Download ${info.fileName}`;
      download.setAttribute('aria-label', `Download ${info.fileName}`);
      download.innerHTML = DOWNLOAD_ICON;

      card.append(pick, meta, download);
      const item = { info, card, checkbox, thumb, download, file: null, url: null, failed: false };
      checkbox.addEventListener('change', changed);
      download.addEventListener('click', () => downloadOne(item));
      return item;
    }

    // ---- Converting images -----------------------------------------------------

    function showWhenVisible(entries) {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const item = itemsByCard.get(entry.target);
        if (item) prepare(item);
      }
    }

    function prepare(item) {
      fileFor(item).catch(() => {}); // failures are shown on the card
    }

    /** Converts an image once; thumbnails, single downloads and the ZIP share the result. */
    function fileFor(item) {
      if (!item.file) {
        const run = generation;
        const task = () =>
          run === generation ? exportImage(item.info) : Promise.reject(new Error('Cancelled'));
        const converted = queue.then(task);
        queue = converted.catch(() => {});
        item.file = converted.then(
          ({ bytes, mimeType }) => {
            const file = {
              blob: new Blob([bytes], { type: mimeType }),
              size: bytes.length,
              crc32: crc32(bytes),
            };
            if (run === generation) showThumbnail(item, file);
            return file;
          },
          (error) => {
            if (run === generation) showFailure(item, error);
            throw error;
          },
        );
      }
      return item.file;
    }

    function showThumbnail(item, file) {
      item.url = URL.createObjectURL(file.blob);
      const image = document.createElement('img');
      image.alt = `Image ${item.info.index} from page ${item.info.pages[0]}`;
      image.decoding = 'async';
      // Show tiny images bigger, so they can be seen.
      image.addEventListener('load', () => {
        const { naturalWidth: width, naturalHeight: height } = image;
        if (width < 96 && height < 96) {
          image.classList.add('enlarged', width >= height ? 'wide' : 'tall');
        }
      });
      image.src = item.url;
      item.thumb.replaceChildren(image);
    }

    function showFailure(item, error) {
      item.failed = true;
      item.checkbox.checked = false;
      item.checkbox.disabled = true;
      item.download.disabled = true;
      const message = document.createElement('p');
      message.className = 'thumb-message';
      message.textContent =
        error && error.name === 'PdfCutterError' ? error.message : 'This image could not be read.';
      item.thumb.replaceChildren(message);
      changed();
    }

    // ---- Saving ----------------------------------------------------------------

    async function downloadOne(item) {
      try {
        await fileFor(item);
        saveFile(item.url, item.info.fileName);
      } catch {
        // Shown on the card.
      }
    }

    async function saveZip() {
      const chosen = selectedItems();
      if (chosen.length === 0 || busy) return;
      app.clearError();
      hideZip();
      const run = generation;
      const files = [];
      let failed = 0;
      app.setBusy(`Preparing ${count(chosen.length, 'image')}…`);
      try {
        for (let i = 0; i < chosen.length; i++) {
          if (chosen.length > 1) app.setBusy(`Preparing image ${i + 1} of ${chosen.length}…`);
          try {
            const file = await fileFor(chosen[i]);
            files.push({
              name: chosen[i].info.fileName,
              data: file.blob,
              size: file.size,
              crc32: file.crc32,
            });
          } catch {
            failed += 1;
          }
        }
        if (run !== generation) return;
        if (files.length === 0) {
          app.showError('None of the selected images could be saved.');
          return;
        }
        const zip = createZip(files);
        const name = `${suggestImagesName(app.getFileName(), searchedLabel)}.zip`;
        zipUrl = URL.createObjectURL(zip);
        ui.zipLink.href = zipUrl;
        ui.zipLink.download = name;
        ui.zipLink.textContent = `Download ${name}`;
        ui.zipResultText.textContent =
          `Your ZIP file is ready: ${count(files.length, 'image')} (${app.formatSize(zip.size)}).` +
          (failed
            ? ` ${count(failed, 'image')} could not be converted and ${failed === 1 ? 'was' : 'were'} left out.`
            : '');
        ui.zipResult.hidden = false;
      } catch (error) {
        app.report(error);
      } finally {
        app.setBusy(false);
      }
      if (!ui.zipResult.hidden) ui.zipLink.focus();
    }

    function saveFile(url, fileName) {
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    }

    // ---- Selection and state ---------------------------------------------------------

    function isShown(item) {
      return ui.showSmall.checked || !item.info.small;
    }

    function selectedItems() {
      return items.filter((item) => isShown(item) && item.checkbox.checked && !item.failed);
    }

    function selectAll(selected) {
      for (const item of items) if (isShown(item) && !item.failed) item.checkbox.checked = selected;
      changed();
    }

    /** Refreshes the summary, the buttons and the selection marks. */
    function changed() {
      hideZip();
      const smallCount = items.filter((item) => item.info.small).length;
      const hiddenCount = ui.showSmall.checked ? 0 : smallCount;
      const chosen = selectedItems().length;
      let summary = `${count(items.length, 'image')} found ${where()}`;
      if (hiddenCount) {
        summary += ` (${hiddenCount} small ${hiddenCount === 1 ? 'one' : 'ones'} hidden)`;
      }
      ui.summary.textContent = `${summary}.`;
      ui.showSmallToggle.hidden = smallCount === 0;
      ui.showSmallLabel.textContent = `Show small images (${smallCount})`;
      ui.zipButtonLabel.textContent = chosen
        ? `Save ${count(chosen, 'image')} as ZIP`
        : 'Select images to save';
      ui.zipButton.disabled = busy || chosen === 0;
      for (const item of items) item.card.classList.toggle('selected', item.checkbox.checked);
    }

    function hideZip() {
      ui.zipResult.hidden = true;
      if (zipUrl) URL.revokeObjectURL(zipUrl);
      zipUrl = null;
    }

    function reset() {
      generation += 1;
      if (observer) observer.disconnect();
      for (const item of items) if (item.url) URL.revokeObjectURL(item.url);
      items = [];
      itemsByCard.clear();
      ui.gallery.replaceChildren();
      ui.area.hidden = true;
      ui.showSmall.checked = false;
      ui.gallery.classList.remove('show-small');
      hideZip();
    }

    function setBusy(isBusy) {
      busy = isBusy;
      const noPdf = !app.getPdf();
      ui.findButton.disabled = isBusy || noPdf;
      for (const control of [
        ui.allPages,
        ui.somePages,
        ui.pagesInput,
        ui.selectAll,
        ui.selectNone,
        ui.showSmall,
      ]) {
        control.disabled = isBusy;
      }
      for (const item of items) item.checkbox.disabled = isBusy || item.failed;
      ui.zipButton.disabled = isBusy || selectedItems().length === 0;
    }

    // ---- Wording -----------------------------------------------------------------

    function where() {
      if (!searchedLabel) return 'in this PDF';
      const plural = /[-,]/.test(searchedLabel);
      return `on ${plural ? 'pages' : 'page'} ${searchedLabel.replace(/-/g, '–').replace(/,/g, ', ')}`;
    }

    function describePages(pages) {
      if (pages.length === 1) return `Page ${pages[0]}`;
      const shown = pages.slice(0, 3).join(', ');
      return pages.length > 3 ? `Pages ${shown} +${pages.length - 3}` : `Pages ${shown}`;
    }

    function count(number, noun) {
      return `${number} ${noun}${number === 1 ? '' : 's'}`;
    }

    return { reset, setBusy };
  }

  window.PdfCutterImagePanel = { create: createImagePanel };
})();
