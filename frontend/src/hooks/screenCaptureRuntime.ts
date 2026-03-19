import type { CaptureRequestOptions, CaptureTargetMode } from './useScreenCapture';

const GIF_RENDER_TIMEOUT_MS = 10000;
let html2canvasLoader: Promise<typeof import('html2canvas')> | null = null;
let gifModuleLoader: Promise<typeof import('gif.js')> | null = null;
let gifWorkerUrlLoader: Promise<string> | null = null;

async function loadHtml2Canvas() {
  html2canvasLoader ??= import('html2canvas');
  const module = await html2canvasLoader;
  return module.default;
}

async function loadGifRenderer() {
  gifModuleLoader ??= import('gif.js');
  const module = await gifModuleLoader;
  return module.default;
}

async function loadGifWorkerUrl() {
  gifWorkerUrlLoader ??= import('gif.js/dist/gif.worker.js?url').then((module) => module.default);
  return gifWorkerUrlLoader;
}

async function settleFrames() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

async function settleElementImages(root: Element) {
  const images = Array.from(root.querySelectorAll('img'));
  if (images.length === 0) return;

  await Promise.all(images.map((image) => {
    if (image.complete) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const cleanup = () => {
        image.removeEventListener('load', cleanup);
        image.removeEventListener('error', cleanup);
        resolve();
      };
      image.addEventListener('load', cleanup, { once: true });
      image.addEventListener('error', cleanup, { once: true });
      window.setTimeout(cleanup, 1000);
    });
  }));
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(blob);
  });
}

async function blobToImageElement(blob: Blob): Promise<HTMLImageElement> {
  const dataUrl = await blobToDataUrl(blob);
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onerror = () => reject(new Error('Failed to decode capture image'));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

const COLOR_FUNCTION_REGEX = /oklch\([^)]*\)/g;

function collectElementSequence(root: Element): Element[] {
  return [root, ...Array.from(root.querySelectorAll('*'))];
}

function normalizeCssColorFunctions(value: string, context: CanvasRenderingContext2D): string {
  return value.replace(COLOR_FUNCTION_REGEX, (match) => {
    const previous = context.fillStyle;
    context.fillStyle = '#000';
    context.fillStyle = match;
    const normalized = String(context.fillStyle || match);
    context.fillStyle = previous;
    return normalized;
  });
}

function collectColorStyleOverrides(root: Element): Array<Array<[string, string]>> {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return [];

  return collectElementSequence(root).map((element) => {
    const computed = window.getComputedStyle(element);
    const overrides: Array<[string, string]> = [];

    for (const property of computed) {
      const value = computed.getPropertyValue(property);
      if (!value || !value.includes('oklch(')) continue;

      const normalized = normalizeCssColorFunctions(value, context);
      if (normalized !== value) {
        overrides.push([property, normalized]);
      }
    }

    return overrides;
  });
}

function applyColorStyleOverrides(root: Element, overrides: Array<Array<[string, string]>>) {
  const elements = collectElementSequence(root);
  elements.forEach((element, index) => {
    const elementOverrides = overrides[index];
    if (!elementOverrides?.length) return;

    for (const [property, value] of elementOverrides) {
      (element as HTMLElement).style.setProperty(property, value);
    }
  });
}

function copyComputedStylesToClone(sourceRoot: Element, cloneRoot: Element) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return;

  const sourceElements = collectElementSequence(sourceRoot);
  const cloneElements = collectElementSequence(cloneRoot);

  sourceElements.forEach((sourceElement, index) => {
    const cloneElement = cloneElements[index] as HTMLElement | undefined;
    if (!cloneElement) return;

    const computed = window.getComputedStyle(sourceElement);
    for (const property of computed) {
      let value = computed.getPropertyValue(property);
      if (!value) continue;
      if (value.includes('oklch(')) {
        value = normalizeCssColorFunctions(value, context);
      }
      cloneElement.style.setProperty(property, value);
    }
  });
}

async function captureElementBlobViaSvgFallback(el: Element): Promise<Blob | null> {
  const rect = el.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));

  const clone = el.cloneNode(true) as HTMLElement;
  copyComputedStylesToClone(el, clone);
  clone.style.margin = '0';
  clone.style.transform = 'none';
  clone.style.maxWidth = 'none';
  clone.style.maxHeight = 'none';
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');

  const serialized = new XMLSerializer().serializeToString(clone);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <foreignObject width="100%" height="100%">
        ${serialized}
      </foreignObject>
    </svg>
  `;
  const encoded = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(svg)))
    : null;
  if (!encoded) return null;

  const image = new Image();
  image.decoding = 'async';
  image.src = `data:image/svg+xml;base64,${encoded}`;

  try {
    await image.decode();
  } catch (error) {
    console.warn('[useScreenCapture] svg fallback decode failed', error);
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, 0, 0, width, height);
  return canvasToBlobWithFallback(canvas, 'image/png');
}

export async function canvasToBlobWithFallback(
  canvas: HTMLCanvasElement,
  type = 'image/png',
): Promise<Blob | null> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((nextBlob) => resolve(nextBlob), type);
  });
  if (blob) return blob;

  try {
    const dataUrl = canvas.toDataURL(type);
    if (!dataUrl) return null;
    const response = await fetch(dataUrl);
    return await response.blob();
  } catch (error) {
    console.warn('[useScreenCapture] canvasToBlob fallback failed', error);
    return null;
  }
}

export async function captureElementBlob(
  selector: string,
  captureTarget: CaptureTargetMode = 'auto',
): Promise<Blob | null> {
  const el = document.querySelector(selector);
  if (!el) return null;

  const targetCanvas = el instanceof HTMLCanvasElement ? el : el.querySelector('canvas');
  const captureCanvasDirectly = captureTarget !== 'element';
  const captureElementFirst = captureTarget === 'element';

  await settleFrames();
  await settleElementImages(el);

  if (captureCanvasDirectly && targetCanvas instanceof HTMLCanvasElement) {
    const directBlob = await canvasToBlobWithFallback(targetCanvas, 'image/png');
    if (directBlob) return directBlob;
  }

  const tryHtml2Canvas = async () => {
    const html2canvas = await loadHtml2Canvas();
    const colorOverrides = collectColorStyleOverrides(el);
    const html2CanvasOptions = {
      useCORS: true,
      backgroundColor: '#1a1a2e',
      scale: 2,
      foreignObjectRendering: true,
      onclone: (clonedDocument: Document) => {
        const cloneRoot =
          el === document.body
            ? clonedDocument.body
            : clonedDocument.querySelector(selector);
        if (cloneRoot) {
          applyColorStyleOverrides(cloneRoot, colorOverrides);
        }
      },
    } as unknown as Parameters<Awaited<ReturnType<typeof loadHtml2Canvas>>>[1];
    const canvas = await html2canvas(el as HTMLElement, html2CanvasOptions);
    return canvasToBlobWithFallback(canvas, 'image/png');
  };

  try {
    if (captureElementFirst || !targetCanvas) {
      const html2CanvasBlob = await tryHtml2Canvas();
      if (html2CanvasBlob) return html2CanvasBlob;
    }
  } catch (error) {
    console.warn('[useScreenCapture] html2canvas capture failed', { selector, captureTarget, error });
    if (captureElementFirst) {
      const fallbackBlob = await captureElementBlobViaSvgFallback(el);
      if (fallbackBlob) return fallbackBlob;
    }
  }

  if (!(targetCanvas instanceof HTMLCanvasElement)) return null;
  return canvasToBlobWithFallback(targetCanvas, 'image/png');
}

export async function captureElementDataUrl(
  selector: string,
  captureTarget: CaptureTargetMode = 'auto',
): Promise<string | null> {
  const blob = await captureElementBlob(selector, captureTarget);
  if (!blob) return null;
  return blobToDataUrl(blob);
}

export async function captureCompositeElementDataUrl(
  rootSelector: string,
  overlaySelector: string,
): Promise<string | null> {
  const root = document.querySelector(rootSelector);
  const overlay = document.querySelector(overlaySelector);
  if (!(root instanceof HTMLElement)) return null;

  const rootBlob = await captureElementBlob(rootSelector, 'element');
  if (!rootBlob) return null;

  if (!(overlay instanceof HTMLElement)) {
    return blobToDataUrl(rootBlob);
  }

  const overlayBlob = await captureElementBlob(overlaySelector, 'canvas');
  if (!overlayBlob) {
    return blobToDataUrl(rootBlob);
  }

  const rootRect = root.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const [rootImage, overlayImage] = await Promise.all([
    blobToImageElement(rootBlob),
    blobToImageElement(overlayBlob),
  ]);

  const scaleX = rootImage.width / Math.max(rootRect.width, 1);
  const scaleY = rootImage.height / Math.max(rootRect.height, 1);
  const offsetX = Math.round((overlayRect.left - rootRect.left) * scaleX);
  const offsetY = Math.round((overlayRect.top - rootRect.top) * scaleY);
  const drawWidth = Math.round(overlayRect.width * scaleX);
  const drawHeight = Math.round(overlayRect.height * scaleY);

  const composite = document.createElement('canvas');
  composite.width = rootImage.width;
  composite.height = rootImage.height;
  const context = composite.getContext('2d');
  if (!context) {
    return blobToDataUrl(rootBlob);
  }

  context.drawImage(rootImage, 0, 0, composite.width, composite.height);
  context.drawImage(overlayImage, offsetX, offsetY, drawWidth, drawHeight);

  const mergedBlob = await canvasToBlobWithFallback(composite, 'image/png');
  return mergedBlob ? blobToDataUrl(mergedBlob) : blobToDataUrl(rootBlob);
}

export async function captureFirstAvailableBlob(
  selectors: string[],
  captureTarget: CaptureTargetMode = 'auto',
): Promise<Blob | null> {
  for (const selector of selectors) {
    const blob = await captureElementBlob(selector, captureTarget);
    if (blob) return blob;
  }
  return null;
}

export function downloadBlob(blob: Blob, filename: string): string {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return url;
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function inferMimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

export async function normalizeDownloadBlob(blob: Blob, filename: string): Promise<Blob> {
  const mime = inferMimeFromFilename(filename);
  if (blob.type === mime) return blob;
  return new Blob([await blob.arrayBuffer()], { type: mime });
}

interface GifRenderer {
  on(event: 'finished', callback: (blob: Blob) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  removeListener?(event: 'finished', callback: (blob: Blob) => void): void;
  removeListener?(event: 'error', callback: (error: Error) => void): void;
  addFrame(context: CanvasRenderingContext2D, options: { copy: boolean; delay: number }): void;
  render: () => void;
  abort?: () => void;
}

async function renderGifWithTimeout(
  gif: GifRenderer,
  timeoutMs = GIF_RENDER_TIMEOUT_MS,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (!gif.removeListener) return;
      gif.removeListener('finished', onFinished);
      gif.removeListener('error', onError);
    };

    const settle = (fn: (value: Blob) => void, value: Blob) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      cleanup();
      fn(value);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onFinished = (blob: unknown) => {
      if (blob instanceof Blob) {
        settle(resolve, blob);
        return;
      }
      fail(new Error('GIF renderer returned a non-Blob payload'));
    };
    const onError = (error: unknown) => fail(error);
    const timeoutId = window.setTimeout(() => {
      gif.abort?.();
      fail(new Error(`GIF render timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    gif.on('finished', onFinished);
    gif.on('error', onError);
    gif.render();
  });
}

async function collectCanvasFrames(
  canvas: HTMLCanvasElement,
  gifDuration: number,
  gifFrameInterval: number,
): Promise<Blob[]> {
  const frames: Blob[] = [];
  const frameCount = Math.floor(gifDuration / gifFrameInterval);

  for (let i = 0; i < frameCount; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, gifFrameInterval));
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((nextBlob) => resolve(nextBlob), 'image/png');
    });
    if (blob) frames.push(blob);
  }

  return frames;
}

export async function recordGifCapture(
  selector: string,
  gifDuration: number,
  gifFrameInterval: number,
): Promise<{ blob: Blob; kind: 'gif' | 'gif_fallback_png' } | null> {
  const element = document.querySelector(selector);
  const canvas = element?.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    return null;
  }

  const frames = await collectCanvasFrames(canvas, gifDuration, gifFrameInterval);
  if (frames.length === 0) {
    return null;
  }

  try {
    const [GIF, gifWorkerUrl] = await Promise.all([
      loadGifRenderer(),
      loadGifWorkerUrl(),
    ]);
    const gif = new GIF({
      workers: 2,
      quality: 10,
      width: canvas.width,
      height: canvas.height,
      workerScript: gifWorkerUrl,
    });

    const offscreen = document.createElement('canvas');
    offscreen.width = canvas.width;
    offscreen.height = canvas.height;
    const context = offscreen.getContext('2d');
    if (!context) {
      return { blob: frames[frames.length - 1], kind: 'gif_fallback_png' };
    }

    for (const frameBlob of frames) {
      const image = await createImageBitmap(frameBlob);
      context.clearRect(0, 0, offscreen.width, offscreen.height);
      context.drawImage(image, 0, 0);
      gif.addFrame(context, { copy: true, delay: gifFrameInterval });
    }

    const gifBlob = await renderGifWithTimeout(gif);
    return { blob: gifBlob, kind: 'gif' };
  } catch (error) {
    console.warn('[useScreenCapture] GIF render fell back to PNG frame:', error);
    return { blob: frames[frames.length - 1], kind: 'gif_fallback_png' };
  }
}

export async function resolveScreenshotBlob(
  defaultSelector: string,
  options?: CaptureRequestOptions,
): Promise<Blob | null> {
  const targetSelector = options?.selector ?? defaultSelector;
  const captureTarget = options?.captureTarget
    ?? (targetSelector.includes('phaser-game-container') ? 'canvas' : 'auto');

  if (options?.captureBlob) {
    return options.captureBlob();
  }
  if (options?.selectors?.length) {
    return captureFirstAvailableBlob(options.selectors, captureTarget);
  }
  return captureElementBlob(targetSelector, captureTarget);
}
