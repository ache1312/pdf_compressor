import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

const { PDFDocument } = window.PDFLib ?? {};

if (!PDFDocument) {
  throw new Error("No fue posible cargar pdf-lib.");
}

const PDFJS_BASE = new URL("./vendor/pdfjs/", import.meta.url);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdf.worker.min.mjs",
  PDFJS_BASE,
).href;

const MAX_FILE_BYTES = 500_000_000;
const MAX_PAGE_PIXELS = 16_000_000;
const MAX_CANVAS_DIMENSION = 16_384;

const PROFILE_DESCRIPTIONS = {
  balanced: "150 ppp, color y ajuste automático si es necesario.",
  sharp: "Comienza con más detalle y reduce gradualmente hasta cumplir el límite.",
  compact: "Prioriza velocidad y un archivo pequeño desde el primer intento.",
};

const ALL_PRESETS = [
  { dpi: 170, quality: 0.56 },
  { dpi: 160, quality: 0.5 },
  { dpi: 150, quality: 0.44 },
  { dpi: 150, quality: 0.4 },
  { dpi: 140, quality: 0.4 },
  { dpi: 130, quality: 0.4 },
  { dpi: 120, quality: 0.38 },
  { dpi: 110, quality: 0.36 },
  { dpi: 96, quality: 0.33 },
  { dpi: 84, quality: 0.3 },
  { dpi: 72, quality: 0.28 },
];

const PROFILE_START = {
  sharp: 0,
  balanced: 3,
  compact: 5,
};

const elements = {
  body: document.body,
  dropzone: document.querySelector("#dropzone"),
  fileInput: document.querySelector("#file-input"),
  chooseButton: document.querySelector("#choose-button"),
  emptyState: document.querySelector("#empty-state"),
  fileState: document.querySelector("#file-state"),
  fileName: document.querySelector("#file-name"),
  originalSize: document.querySelector("#original-size"),
  pageCount: document.querySelector("#page-count"),
  previewPages: document.querySelector("#preview-pages"),
  previewCanvas: document.querySelector("#preview-canvas"),
  removeFile: document.querySelector("#remove-file"),
  targetSize: document.querySelector("#target-size"),
  qualityProfile: document.querySelector("#quality-profile"),
  profileDescription: document.querySelector("#profile-description"),
  compressButton: document.querySelector("#compress-button"),
  progressPanel: document.querySelector("#progress-panel"),
  progressPercent: document.querySelector("#progress-percent"),
  progressTrack: document.querySelector("#progress-track"),
  progressBar: document.querySelector("#progress-bar"),
  progressDetail: document.querySelector("#progress-detail"),
  cancelButton: document.querySelector("#cancel-button"),
  resultPanel: document.querySelector("#result-panel"),
  resultSize: document.querySelector("#result-size"),
  resultReduction: document.querySelector("#result-reduction"),
  resultDetail: document.querySelector("#result-detail"),
  downloadButton: document.querySelector("#download-button"),
  restartButton: document.querySelector("#restart-button"),
  toast: document.querySelector("#toast"),
  liveRegion: document.querySelector("#live-region"),
};

let selectedFile = null;
let sourcePdf = null;
let sourceMetadata = null;
let loadingTask = null;
let activeRenderTask = null;
let resultUrl = null;
let toastTimer = null;
let cancelRequested = false;
let processing = false;
let lastResultBytes = null;
let selectionVersion = 0;

class CancelledError extends Error {
  constructor() {
    super("Operación cancelada");
    this.name = "CancelledError";
  }
}

function pdfLoadOptions(data) {
  return {
    data,
    cMapUrl: new URL("cmaps/", PDFJS_BASE).href,
    cMapPacked: true,
    iccUrl: new URL("iccs/", PDFJS_BASE).href,
    standardFontDataUrl: new URL("standard_fonts/", PDFJS_BASE).href,
    wasmUrl: new URL("wasm/", PDFJS_BASE).href,
    enableXfa: false,
  };
}

function formatBytes(bytes, digits = 2) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(0)} KB`;
  return `${(bytes / 1_000_000).toFixed(digits)} MB`;
}

function formatPercent(value) {
  return new Intl.NumberFormat("es-CL", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(value);
}

function outputName(name) {
  const stem = name.replace(/\.pdf$/i, "");
  return `${stem}_comprimido.pdf`;
}

function showToast(message, duration = 6000) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  elements.liveRegion.textContent = message;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, duration);
}

function setPanel(panel) {
  elements.dropzone.hidden = panel !== "dropzone";
  elements.progressPanel.hidden = panel !== "progress";
  elements.resultPanel.hidden = panel !== "result";
  elements.body.dataset.state = panel;
}

function openFilePicker() {
  elements.fileInput.value = "";
  elements.fileInput.click();
}

function setFileState(hasFile) {
  elements.emptyState.hidden = hasFile;
  elements.fileState.hidden = !hasFile;
  elements.dropzone.classList.toggle("has-file", hasFile);
  elements.compressButton.disabled = !hasFile || processing;
}

function setProcessing(value) {
  processing = value;
  elements.body.classList.toggle("is-processing", value);
  elements.targetSize.disabled = value;
  elements.qualityProfile.disabled = value;
  elements.removeFile.disabled = value;
  elements.compressButton.disabled = value || !sourcePdf;
  elements.cancelButton.disabled = false;
  elements.cancelButton.textContent = "Cancelar";
  elements.dropzone.setAttribute("aria-disabled", String(value));
}

function updateProgress(percent, detail) {
  const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
  elements.progressPercent.textContent = `${safePercent}%`;
  elements.progressBar.style.width = `${safePercent}%`;
  elements.progressTrack.setAttribute("aria-valuenow", String(safePercent));
  elements.progressDetail.textContent = detail;
}

function clearResultUrl() {
  if (resultUrl) {
    URL.revokeObjectURL(resultUrl);
    resultUrl = null;
  }
  lastResultBytes = null;
  elements.downloadButton.removeAttribute("href");
}

async function disposeSource() {
  const taskToDestroy = loadingTask ?? sourcePdf?.loadingTask;
  if (taskToDestroy) {
    try {
      await taskToDestroy.destroy();
    } catch {
      // La tarea puede haber terminado o haberse destruido previamente.
    }
    loadingTask = null;
  }
  sourcePdf = null;
}

function resetPreview() {
  const canvas = elements.previewCanvas;
  canvas.width = 1;
  canvas.height = 1;
}

async function resetApp() {
  selectionVersion += 1;

  if (processing) {
    cancelRequested = true;
    activeRenderTask?.cancel();
  }

  await disposeSource();
  clearResultUrl();
  selectedFile = null;
  sourceMetadata = null;
  elements.fileInput.value = "";
  resetPreview();
  setProcessing(false);
  setFileState(false);
  setPanel("dropzone");
  updateProgress(0, "Preparando documento…");
}

async function renderPreview(pdf = sourcePdf) {
  const page = await pdf.getPage(1);
  const baseViewport = page.getViewport({ scale: 1 });
  const displayWidth = Math.min(280, baseViewport.width);
  const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
  const scale = (displayWidth / baseViewport.width) * deviceScale;
  const viewport = page.getViewport({ scale });
  const canvas = elements.previewCanvas;

  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));

  activeRenderTask = page.render({
    canvas,
    viewport,
    background: "#ffffff",
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
  });

  try {
    await activeRenderTask.promise;
  } finally {
    activeRenderTask = null;
    page.cleanup();
  }
}

async function selectFile(file) {
  if (processing || !file) return;

  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    showToast("Selecciona un archivo con formato PDF.");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showToast("El archivo supera el límite de 500 MB de esta versión.");
    return;
  }

  const currentSelection = ++selectionVersion;
  activeRenderTask?.cancel();
  await disposeSource();
  if (currentSelection !== selectionVersion) return;

  clearResultUrl();
  selectedFile = file;
  sourceMetadata = null;
  setFileState(false);
  setPanel("dropzone");
  elements.compressButton.disabled = true;
  elements.liveRegion.textContent = `Leyendo ${file.name}`;

  let passwordRequired = false;

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    if (currentSelection !== selectionVersion) return;

    const task = pdfjsLib.getDocument(pdfLoadOptions(data));
    loadingTask = task;
    task.onPassword = () => {
      passwordRequired = true;
      task.destroy();
    };

    const pdf = await task.promise;
    if (currentSelection !== selectionVersion) {
      await task.destroy();
      return;
    }

    sourcePdf = pdf;
    sourceMetadata = await pdf.getMetadata().catch(() => null);
    if (currentSelection !== selectionVersion) return;

    elements.fileName.textContent = file.name;
    elements.originalSize.textContent = formatBytes(file.size);
    elements.pageCount.textContent = String(pdf.numPages);
    elements.previewPages.textContent = `${pdf.numPages} ${
      pdf.numPages === 1 ? "página" : "páginas"
    }`;

    await renderPreview(pdf);
    if (currentSelection !== selectionVersion) return;

    setFileState(true);
    elements.compressButton.disabled = false;
    elements.liveRegion.textContent = `${file.name}, ${pdf.numPages} páginas, listo para comprimir.`;

    const targetBytes = Number(elements.targetSize.value) * 1_000_000;
    if (file.size < targetBytes) {
      showToast("Este archivo ya cumple el tamaño indicado. Si continúas, se entregará sin alterar.");
    }
  } catch (error) {
    if (currentSelection !== selectionVersion) return;

    await disposeSource();
    selectedFile = null;
    setFileState(false);
    resetPreview();
    showToast(
      passwordRequired
        ? "Los PDF protegidos con contraseña todavía no son compatibles."
        : "No fue posible abrir el PDF. Puede estar dañado o usar una función no compatible.",
    );
    console.error(error);
  }
}

function throwIfCancelled() {
  if (cancelRequested) throw new CancelledError();
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("El navegador no pudo codificar una página como JPEG."));
      },
      "image/jpeg",
      quality,
    );
  });
}

function calculateRenderViewport(page, dpi) {
  const baseViewport = page.getViewport({ scale: 1 });
  const requestedScale = dpi / 72;
  const pixelScale = Math.sqrt(
    MAX_PAGE_PIXELS / (baseViewport.width * baseViewport.height),
  );
  const dimensionScale =
    MAX_CANVAS_DIMENSION / Math.max(baseViewport.width, baseViewport.height);
  const scale = Math.min(requestedScale, pixelScale, dimensionScale);

  return {
    baseViewport,
    viewport: page.getViewport({ scale }),
    effectiveDpi: Math.round(scale * 72),
  };
}

function applyMetadata(output) {
  const info = sourceMetadata?.info ?? {};
  const fallbackTitle = selectedFile.name.replace(/\.pdf$/i, "");

  output.setTitle(
    typeof info.Title === "string" && info.Title.trim()
      ? info.Title
      : `${fallbackTitle} (comprimido)`,
  );
  if (typeof info.Author === "string" && info.Author.trim()) {
    output.setAuthor(info.Author);
  }
  if (typeof info.Subject === "string" && info.Subject.trim()) {
    output.setSubject(info.Subject);
  }
  output.setCreator("PDF Compressor");
  output.setProducer("PDF Compressor · procesamiento local en navegador");
  output.setModificationDate(new Date());
}

async function yieldToBrowser() {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
}

async function runCompressionAttempt(preset, targetBytes, attempt, totalAttempts) {
  const output = await PDFDocument.create();
  const canvas = document.createElement("canvas");
  const pageTotal = sourcePdf.numPages;
  const overheadReserve = Math.max(250_000, pageTotal * 2_500);
  const jpegBudget = Math.max(100_000, targetBytes - overheadReserve);
  let encodedBytes = 0;
  let minimumDpi = preset.dpi;

  applyMetadata(output);

  try {
    for (let pageNumber = 1; pageNumber <= pageTotal; pageNumber += 1) {
      throwIfCancelled();
      const page = await sourcePdf.getPage(pageNumber);
      const { baseViewport, viewport, effectiveDpi } = calculateRenderViewport(
        page,
        preset.dpi,
      );
      minimumDpi = Math.min(minimumDpi, effectiveDpi);

      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));

      activeRenderTask = page.render({
        canvas,
        viewport,
        background: "#ffffff",
        intent: "display",
        annotationMode: pdfjsLib.AnnotationMode.ENABLE,
      });

      try {
        await activeRenderTask.promise;
        throwIfCancelled();

        const jpegBlob = await canvasToJpeg(canvas, preset.quality);
        encodedBytes += jpegBlob.size;

        const progress = (pageNumber / pageTotal) * 100;
        updateProgress(
          progress,
          `Intento ${attempt}/${totalAttempts} · página ${pageNumber}/${pageTotal} · ${minimumDpi} ppp`,
        );

        if (encodedBytes >= jpegBudget && pageNumber < pageTotal) {
          return { tooLarge: true };
        }

        const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
        const image = await output.embedJpg(jpegBytes);
        const outputPage = output.addPage([
          baseViewport.width,
          baseViewport.height,
        ]);
        outputPage.drawImage(image, {
          x: 0,
          y: 0,
          width: baseViewport.width,
          height: baseViewport.height,
        });
      } finally {
        activeRenderTask = null;
        page.cleanup();
        canvas.width = 1;
        canvas.height = 1;
      }

      if (pageNumber % 2 === 0) await yieldToBrowser();
    }

    throwIfCancelled();
    updateProgress(100, `Armando PDF · ${minimumDpi} ppp`);
    const bytes = await output.save({
      useObjectStreams: true,
      addDefaultPage: false,
      objectsPerTick: 50,
    });

    return {
      tooLarge: bytes.byteLength >= targetBytes,
      bytes,
      dpi: minimumDpi,
      quality: preset.quality,
    };
  } finally {
    canvas.width = 1;
    canvas.height = 1;
  }
}

async function validateOutput(bytes, expectedPages) {
  throwIfCancelled();
  updateProgress(100, "Validando páginas y tamaño final…");

  const validationBytes = bytes.slice();
  const task = pdfjsLib.getDocument(pdfLoadOptions(validationBytes));
  let documentForValidation = null;

  try {
    documentForValidation = await task.promise;
    if (documentForValidation.numPages !== expectedPages) {
      throw new Error(
        `La salida tiene ${documentForValidation.numPages} páginas; se esperaban ${expectedPages}.`,
      );
    }

    const samples = [...new Set([1, Math.ceil(expectedPages / 2), expectedPages])];
    const canvas = document.createElement("canvas");

    for (const pageNumber of samples) {
      throwIfCancelled();
      const page = await documentForValidation.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 0.15 });
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const taskForPage = page.render({
        canvas,
        viewport,
        background: "#ffffff",
        annotationMode: pdfjsLib.AnnotationMode.DISABLE,
      });
      await taskForPage.promise;
      page.cleanup();
      canvas.width = 1;
      canvas.height = 1;
    }
  } finally {
    await task.destroy().catch(() => {});
  }
}

function getPresets(profile) {
  return ALL_PRESETS.slice(PROFILE_START[profile] ?? PROFILE_START.balanced);
}

function showResult(blob, options = {}) {
  clearResultUrl();
  resultUrl = URL.createObjectURL(blob);
  lastResultBytes = blob.size;
  const reduction = selectedFile.size
    ? Math.max(0, 100 * (1 - blob.size / selectedFile.size))
    : 0;

  elements.resultSize.textContent = formatBytes(blob.size);
  elements.resultReduction.textContent = options.unchanged
    ? "ya cumplía el objetivo"
    : `${formatPercent(reduction)}% menos`;
  elements.resultDetail.textContent = options.unchanged
    ? `${sourcePdf.numPages} páginas · sin recompresión`
    : `${sourcePdf.numPages} páginas · ${options.dpi} ppp · JPEG ${Math.round(
        options.quality * 100,
      )}`;
  elements.downloadButton.href = resultUrl;
  elements.downloadButton.download = outputName(selectedFile.name);
  setPanel("result");
  elements.liveRegion.textContent = `Compresión terminada. Resultado: ${formatBytes(
    blob.size,
  )}.`;
  elements.downloadButton.focus({ preventScroll: true });
}

async function startCompression() {
  if (!sourcePdf || !selectedFile || processing) return;

  const targetMb = Number.parseFloat(elements.targetSize.value);
  if (!Number.isFinite(targetMb) || targetMb < 1 || targetMb > 500) {
    showToast("Indica un tamaño máximo entre 1 y 500 MB.");
    elements.targetSize.focus();
    return;
  }

  const targetBytes = Math.floor(targetMb * 1_000_000);
  cancelRequested = false;
  clearResultUrl();
  setProcessing(true);
  setPanel("progress");
  updateProgress(0, "Preparando documento…");

  try {
    if (selectedFile.size < targetBytes) {
      await yieldToBrowser();
      showResult(selectedFile, { unchanged: true });
      await disposeSource();
      return;
    }

    const presets = getPresets(elements.qualityProfile.value);
    let successfulResult = null;

    for (let index = 0; index < presets.length; index += 1) {
      throwIfCancelled();
      const preset = presets[index];
      updateProgress(
        0,
        `Intento ${index + 1}/${presets.length} · ${preset.dpi} ppp · JPEG ${Math.round(
          preset.quality * 100,
        )}`,
      );

      const result = await runCompressionAttempt(
        preset,
        targetBytes,
        index + 1,
        presets.length,
      );

      if (!result.tooLarge && result.bytes?.byteLength < targetBytes) {
        successfulResult = result;
        break;
      }

      updateProgress(
        0,
        `El intento ${index + 1} aún es grande. Ajustando resolución…`,
      );
      await yieldToBrowser();
    }

    if (!successfulResult) {
      throw new Error(
        "No fue posible alcanzar ese tamaño manteniendo una resolución legible. Prueba con un límite mayor.",
      );
    }

    await validateOutput(successfulResult.bytes, sourcePdf.numPages);
    throwIfCancelled();

    const blob = new Blob([successfulResult.bytes], {
      type: "application/pdf",
    });
    showResult(blob, successfulResult);
    await disposeSource();
  } catch (error) {
    if (error instanceof CancelledError || cancelRequested) {
      showToast("Compresión cancelada.", 3500);
    } else {
      showToast(error.message || "No fue posible comprimir el PDF.", 8000);
      console.error(error);
    }
    setPanel("dropzone");
    setFileState(Boolean(sourcePdf));
  } finally {
    activeRenderTask = null;
    setProcessing(false);
  }
}

elements.chooseButton.addEventListener("click", (event) => {
  event.stopPropagation();
  openFilePicker();
});

elements.dropzone.addEventListener("click", (event) => {
  if (processing || event.target.closest("button, a")) return;
  openFilePicker();
});

elements.fileInput.addEventListener("change", () => {
  const [file] = elements.fileInput.files;
  selectFile(file);
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (!processing) elements.dropzone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  elements.dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropzone.classList.remove("is-dragging");
  });
}

elements.dropzone.addEventListener("drop", (event) => {
  if (processing) return;
  const [file] = event.dataTransfer.files;
  selectFile(file);
});

elements.removeFile.addEventListener("click", async (event) => {
  event.stopPropagation();
  await resetApp();
  elements.chooseButton.focus();
});

elements.qualityProfile.addEventListener("change", () => {
  elements.profileDescription.textContent =
    PROFILE_DESCRIPTIONS[elements.qualityProfile.value];
});

elements.compressButton.addEventListener("click", startCompression);

elements.cancelButton.addEventListener("click", () => {
  cancelRequested = true;
  elements.cancelButton.disabled = true;
  elements.cancelButton.textContent = "Cancelando…";
  elements.progressDetail.textContent = "Deteniendo el procesamiento…";
  activeRenderTask?.cancel();
});

elements.restartButton.addEventListener("click", async () => {
  await resetApp();
  elements.chooseButton.focus();
});

window.addEventListener("beforeunload", () => {
  clearResultUrl();
  (loadingTask ?? sourcePdf?.loadingTask)?.destroy();
});

document.documentElement.dataset.appReady = "true";
window.__PDF_COMPRESSOR__ = {
  get state() {
    return {
      fileName: selectedFile?.name ?? null,
      pages: sourcePdf?.numPages ?? null,
      processing,
      resultBytes: lastResultBytes,
    };
  },
};
