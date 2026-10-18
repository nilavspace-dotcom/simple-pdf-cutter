/*
 * Simple PDF Cutter - the web page. Everything happens in the browser;
 * the PDF handling itself lives in pdf-cutter.js.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    fileInfo: $('file-info'),
    passwordForm: $('password-form'),
    passwordInput: $('password-input'),
    cutForm: $('cut-form'),
    pagesInput: $('pages-input'),
    pagesSummary: $('pages-summary'),
    cutButton: $('cut-button'),
    status: $('status'),
    error: $('error'),
    result: $('result'),
    resultText: $('result-text'),
    downloadLink: $('download-link'),
  };

  if (!window.PDFLib || !window.PdfCutter) {
    showError(
      'The PDF engine could not be loaded. Keep the "src" and "vendor" folders next to ' +
        'index.html and reload the page.',
    );
    ui.fileInput.disabled = true;
    return;
  }

  const { openPdf, parsePageSelection, extractPages, suggestOutputName } = window.PdfCutter;

  const state = {
    file: null, // the File the user picked
    bytes: null, // its contents
    pdf: null, // the opened document
    busy: false,
    downloadUrl: null,
  };

  // ---- Choosing a file -----------------------------------------------------

  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files[0];
    ui.fileInput.value = ''; // so that choosing the same file again still works
    if (file) loadFile(file);
  });

  // Accept a PDF dropped anywhere on the page. This also stops the browser
  // from leaving the page to display a file dropped next to the drop zone.
  let dragDepth = 0;
  const isFileDrag = (event) => Array.from(event.dataTransfer.types).includes('Files');

  document.addEventListener('dragenter', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth += 1;
    ui.dropzone.classList.add('dragging');
  });
  document.addEventListener('dragover', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = state.busy ? 'none' : 'copy';
  });
  document.addEventListener('dragleave', (event) => {
    if (!isFileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) ui.dropzone.classList.remove('dragging');
  });
  document.addEventListener('drop', (event) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    dragDepth = 0;
    ui.dropzone.classList.remove('dragging');
    const file = event.dataTransfer.files[0];
    if (file && !state.busy) loadFile(file);
  });

  async function loadFile(file) {
    resetDocument();
    state.file = file;
    setBusy(`Reading ${file.name}…`);
    try {
      state.bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      console.error(error);
      setBusy(false);
      state.file = null;
      showError(`"${file.name}" could not be read. If it is very large, try a smaller file.`);
      return;
    }
    await openDocument('');
  }

  ui.passwordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.bytes && !state.busy) openDocument(ui.passwordInput.value);
  });

  async function openDocument(password) {
    clearError();
    setBusy(`Opening ${state.file.name}…`);
    let needsPassword = false;
    try {
      state.pdf = await openPdf(state.bytes, { password });
    } catch (error) {
      needsPassword = error.code === 'PASSWORD_REQUIRED' || error.code === 'WRONG_PASSWORD';
      if (!needsPassword || error.code === 'WRONG_PASSWORD') report(error);
      if (!needsPassword) state.file = state.bytes = null;
    } finally {
      setBusy(false);
    }

    ui.passwordForm.hidden = !needsPassword;
    if (needsPassword) {
      ui.passwordInput.focus();
      ui.passwordInput.select();
    } else if (state.pdf) {
      ui.passwordInput.value = '';
      showFileInfo();
      updateSummary();
      ui.pagesInput.focus();
    }
  }

  function showFileInfo() {
    const name = document.createElement('strong');
    name.textContent = state.file.name;
    ui.fileInfo.replaceChildren(
      name,
      ` · ${pluralize(state.pdf.getPageCount(), 'page')} · ${formatSize(state.file.size)}`,
    );
    ui.fileInfo.hidden = false;
  }

  function resetDocument() {
    state.file = state.bytes = state.pdf = null;
    ui.fileInfo.hidden = true;
    ui.passwordForm.hidden = true;
    ui.passwordInput.value = '';
    clearResult();
    clearError();
    updateSummary();
  }

  // ---- Choosing pages and cutting ------------------------------------------

  ui.pagesInput.addEventListener('input', () => {
    clearResult();
    clearError();
    updateSummary();
  });

  function updateSummary() {
    ui.pagesSummary.textContent = '';
    if (!state.pdf || !ui.pagesInput.value.trim()) return;
    try {
      const { pages, label } = parsePageSelection(ui.pagesInput.value, state.pdf.getPageCount());
      ui.pagesSummary.textContent = `${pluralize(pages.length, 'page')} selected: ${prettyLabel(label)}`;
    } catch {
      // Probably still typing; problems are reported when "Cut PDF" is clicked.
    }
  }

  ui.cutForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy || !state.pdf) return;
    clearError();
    clearResult();

    let selection;
    try {
      selection = parsePageSelection(ui.pagesInput.value, state.pdf.getPageCount());
    } catch (error) {
      report(error);
      ui.pagesInput.focus();
      return;
    }

    setBusy(`Cutting ${pluralize(selection.pages.length, 'page')}…`);
    try {
      const bytes = await extractPages(state.pdf, selection.pages);
      showResult(
        bytes,
        suggestOutputName(state.file.name, selection.label),
        selection.pages.length,
      );
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
    if (!ui.result.hidden) ui.downloadLink.focus();
  });

  function showResult(bytes, fileName, pageCount) {
    state.downloadUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    ui.downloadLink.href = state.downloadUrl;
    ui.downloadLink.download = fileName;
    ui.downloadLink.textContent = `Download ${fileName}`;
    ui.resultText.textContent = `Done! Your new PDF has ${pluralize(pageCount, 'page')} (${formatSize(bytes.length)}).`;
    ui.result.hidden = false;
  }

  function clearResult() {
    ui.result.hidden = true;
    if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
    state.downloadUrl = null;
  }

  // ---- Feedback ------------------------------------------------------------

  function setBusy(message) {
    state.busy = Boolean(message);
    ui.status.replaceChildren();
    if (message) {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      ui.status.append(spinner, message);
    }
    ui.fileInput.disabled = state.busy;
    ui.passwordInput.disabled = state.busy;
    ui.pagesInput.disabled = state.busy;
    ui.cutButton.disabled = state.busy || !state.pdf;
  }

  function report(error) {
    if (error && error.name === 'PdfCutterError') {
      if (error.cause) console.warn(error.cause);
      showError(error.message);
    } else {
      console.error(error);
      showError(`Something went wrong: ${(error && error.message) || error}`);
    }
  }

  function showError(message) {
    ui.error.textContent = message;
    ui.error.hidden = false;
  }

  function clearError() {
    ui.error.hidden = true;
    ui.error.textContent = '';
  }

  // ---- Formatting ----------------------------------------------------------

  function pluralize(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }

  function prettyLabel(label) {
    return label.replace(/-/g, '–').replace(/,/g, ', ');
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    const units = ['KB', 'MB', 'GB'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size < 10 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
  }
})();
