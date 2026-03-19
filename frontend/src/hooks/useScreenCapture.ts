/**
 * useScreenCapture — Hook for capturing screenshots and GIF recordings.
 *
 * Keeps the heavy capture runtime behind a dynamic import so pages that only
 * expose capture affordances do not eagerly pay for DOM snapshot logic.
 */
import { useCallback, useRef, useState } from 'react';

export type CaptureStatus = 'idle' | 'capturing' | 'recording' | 'done' | 'error';
export type CaptureResultKind = 'screenshot_png' | 'gif' | 'gif_fallback_png';

interface UseScreenCaptureOptions {
  /** Selector for the target element (default: '.theater-panel') */
  selector?: string;
  /** GIF recording duration in ms (default: 3000) */
  gifDuration?: number;
  /** GIF frame interval in ms (default: 200) */
  gifFrameInterval?: number;
}

export type CaptureTargetMode = 'auto' | 'canvas' | 'element';
export type CaptureMode = 'panel' | 'canvas' | 'modal';

export interface CaptureRequestOptions {
  selector?: string;
  selectors?: string[];
  captureTarget?: CaptureTargetMode;
  captureBlob?: () => Promise<Blob | null>;
}

interface UseScreenCaptureReturn {
  status: CaptureStatus;
  blobUrl: string | null;
  lastCaptureKind: CaptureResultKind | null;
  captureScreenshot: (options?: CaptureRequestOptions) => Promise<void>;
  captureGIF: (options?: CaptureRequestOptions) => Promise<void>;
}

let runtimeLoader: Promise<typeof import('./screenCaptureRuntime')> | null = null;

async function loadScreenCaptureRuntime() {
  runtimeLoader ??= import('./screenCaptureRuntime');
  return runtimeLoader;
}

export async function canvasToBlobWithFallback(
  canvas: HTMLCanvasElement,
  type = 'image/png',
): Promise<Blob | null> {
  const runtime = await loadScreenCaptureRuntime();
  return runtime.canvasToBlobWithFallback(canvas, type);
}

export async function captureElementDataUrl(
  selector: string,
  captureTarget: CaptureTargetMode = 'auto',
): Promise<string | null> {
  const runtime = await loadScreenCaptureRuntime();
  return runtime.captureElementDataUrl(selector, captureTarget);
}

export async function captureCompositeElementDataUrl(
  rootSelector: string,
  overlaySelector: string,
): Promise<string | null> {
  const runtime = await loadScreenCaptureRuntime();
  return runtime.captureCompositeElementDataUrl(rootSelector, overlaySelector);
}

export function useScreenCapture(options: UseScreenCaptureOptions = {}): UseScreenCaptureReturn {
  const {
    selector = '.theater-panel',
    gifDuration = 3000,
    gifFrameInterval = 200,
  } = options;

  const [status, setStatus] = useState<CaptureStatus>('idle');
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [lastCaptureKind, setLastCaptureKind] = useState<CaptureResultKind | null>(null);
  const recordingRef = useRef(false);

  const captureScreenshot = useCallback(async (requestOptions?: CaptureRequestOptions) => {
    setLastCaptureKind(null);
    setStatus('capturing');
    try {
      const runtime = await loadScreenCaptureRuntime();
      const blob = await runtime.resolveScreenshotBlob(selector, requestOptions);
      if (!blob) {
        setStatus('error');
        window.setTimeout(() => setStatus('idle'), 2000);
        return;
      }

      const downloadFile = `swarmoracle_${runtime.timestamp()}.png`;
      const normalizedBlob = await runtime.normalizeDownloadBlob(blob, downloadFile);
      const url = runtime.downloadBlob(normalizedBlob, downloadFile);
      setBlobUrl(url);
      setLastCaptureKind('screenshot_png');
      setStatus('done');
      window.setTimeout(() => setStatus('idle'), 2000);
    } catch (error) {
      console.error('[useScreenCapture] Screenshot failed:', error);
      setStatus('error');
      window.setTimeout(() => setStatus('idle'), 2000);
    }
  }, [selector]);

  const captureGIF = useCallback(async (requestOptions?: CaptureRequestOptions) => {
    if (recordingRef.current) return;
    recordingRef.current = true;
    setLastCaptureKind(null);
    setStatus('recording');

    try {
      const runtime = await loadScreenCaptureRuntime();
      const targetSelector = requestOptions?.selector ?? selector;
      const capture = await runtime.recordGifCapture(targetSelector, gifDuration, gifFrameInterval);
      if (!capture) {
        setStatus('error');
        window.setTimeout(() => setStatus('idle'), 2000);
        return;
      }

      const extension = capture.kind === 'gif' ? 'gif' : 'png';
      const downloadFile = `swarmoracle_${runtime.timestamp()}.${extension}`;
      const normalizedBlob = await runtime.normalizeDownloadBlob(capture.blob, downloadFile);
      const url = runtime.downloadBlob(normalizedBlob, downloadFile);
      setBlobUrl(url);
      setLastCaptureKind(capture.kind);
      setStatus('done');
      window.setTimeout(() => setStatus('idle'), 2000);
    } catch (error) {
      console.error('[useScreenCapture] GIF recording failed:', error);
      setStatus('error');
      window.setTimeout(() => setStatus('idle'), 2000);
    } finally {
      recordingRef.current = false;
    }
  }, [gifDuration, gifFrameInterval, selector]);

  return { status, blobUrl, lastCaptureKind, captureScreenshot, captureGIF };
}
