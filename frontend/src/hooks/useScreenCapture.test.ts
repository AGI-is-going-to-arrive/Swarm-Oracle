import { describe, expect, it, vi } from 'vitest';

import {
  canvasToBlobWithFallback,
  isLikelyWebKitCaptureUserAgent,
} from './useScreenCapture';

describe('canvasToBlobWithFallback', () => {
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
});
