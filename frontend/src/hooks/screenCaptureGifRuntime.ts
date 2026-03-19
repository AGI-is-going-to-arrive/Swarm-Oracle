const GIF_RENDER_TIMEOUT_MS = 10000;

let gifModuleLoader: Promise<typeof import('gif.js')> | null = null;
let gifWorkerUrlLoader: Promise<string> | null = null;

interface GifRenderer {
  on(event: 'finished', callback: (blob: Blob) => void): void;
  on(event: 'error', callback: (error: Error) => void): void;
  removeListener?(event: 'finished', callback: (blob: Blob) => void): void;
  removeListener?(event: 'error', callback: (error: Error) => void): void;
  addFrame(context: CanvasRenderingContext2D, options: { copy: boolean; delay: number }): void;
  render: () => void;
  abort?: () => void;
}

async function loadGifRenderer() {
  gifModuleLoader ??= import('./screenCaptureGifVendor').then((module) => ({
    default: module.GIF,
  }));
  const module = await gifModuleLoader;
  return module.default;
}

async function loadGifWorkerUrl() {
  gifWorkerUrlLoader ??= import('./screenCaptureGifVendor').then((module) => module.gifWorkerUrl);
  return gifWorkerUrlLoader;
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

  for (let index = 0; index < frameCount; index += 1) {
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
