import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveScreenshotBlobMock,
  normalizeDownloadBlobMock,
  downloadBlobMock,
  timestampMock,
  recordGifCaptureMock,
} = vi.hoisted(() => ({
  resolveScreenshotBlobMock: vi.fn(),
  normalizeDownloadBlobMock: vi.fn(),
  downloadBlobMock: vi.fn(),
  timestampMock: vi.fn(),
  recordGifCaptureMock: vi.fn(),
}));

vi.mock('./screenCaptureRuntime', () => ({
  canvasToBlobWithFallback: async (canvas: HTMLCanvasElement, type = 'image/png') => {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type);
    });
    if (blob) return blob;

    const dataUrl = canvas.toDataURL(type);
    const encoded = dataUrl.split(',', 2)[1] ?? '';
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return new Blob([bytes], { type });
  },
  captureCompositeElementBlob: vi.fn(),
  captureCompositeElementDataUrl: vi.fn(),
  captureElementDataUrl: vi.fn(),
  downloadBlob: downloadBlobMock,
  normalizeDownloadBlob: normalizeDownloadBlobMock,
  resolveScreenshotBlob: resolveScreenshotBlobMock,
  timestamp: timestampMock,
}));

vi.mock('./screenCaptureGifRuntime', () => ({
  recordGifCapture: recordGifCaptureMock,
}));

import {
  canvasToBlobWithFallback,
  isLikelyWebKitCaptureUserAgent,
  useScreenCapture,
} from './useScreenCapture';

describe('canvasToBlobWithFallback', () => {
  beforeEach(() => {
    resolveScreenshotBlobMock.mockReset();
    normalizeDownloadBlobMock.mockReset();
    downloadBlobMock.mockReset();
    timestampMock.mockReset();
    recordGifCaptureMock.mockReset();
    vi.stubGlobal('URL', {
      ...URL,
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns the native blob when toBlob succeeds', async () => {
    const canvas = document.createElement('canvas');
    const blob = new Blob(['ok'], { type: 'image/png' });
    canvas.toBlob = vi.fn((callback) => callback(blob));

    await expect(canvasToBlobWithFallback(canvas)).resolves.toBe(blob);
  });

  it('falls back to toDataURL when toBlob returns null', async () => {
    const canvas = document.createElement('canvas');
    canvas.toBlob = vi.fn((callback) => callback(null));
    canvas.toDataURL = vi.fn(() => 'data:image/png;base64,ZmFrZQ==');

    const blob = await canvasToBlobWithFallback(canvas);

    expect(blob).not.toBeNull();
    expect(blob?.type).toBe('image/png');
    expect(blob?.size).toBeGreaterThan(0);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png');
  });

  it('detects Safari/WebKit user agents for conservative capture fallbacks', () => {
    expect(isLikelyWebKitCaptureUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    )).toBe(true);
    expect(isLikelyWebKitCaptureUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    )).toBe(false);
  });

  it('revokes the previous blob URL when a new screenshot replaces it and on unmount', async () => {
    const firstBlob = new Blob(['first'], { type: 'image/png' });
    const secondBlob = new Blob(['second'], { type: 'image/png' });
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    resolveScreenshotBlobMock
      .mockResolvedValueOnce(firstBlob)
      .mockResolvedValueOnce(secondBlob);
    normalizeDownloadBlobMock.mockImplementation(async (blob: Blob) => blob);
    downloadBlobMock
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    timestampMock.mockReturnValue('ts');

    const { result, unmount } = renderHook(() => useScreenCapture());

    await act(async () => {
      await result.current.captureScreenshot();
    });

    expect(result.current.blobUrl).toBe('blob:first');
    expect(revokeSpy).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.captureScreenshot();
    });

    expect(result.current.blobUrl).toBe('blob:second');
    expect(revokeSpy).toHaveBeenCalledWith('blob:first');

    unmount();

    expect(revokeSpy).toHaveBeenCalledWith('blob:second');
  });
});
