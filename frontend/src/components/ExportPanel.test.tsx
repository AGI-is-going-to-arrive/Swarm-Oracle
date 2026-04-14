/**
 * P1-3 — ExportPanel unit tests
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

// Top-level mock — factory must not reference outer variables
const mockCaptureElementBlob = vi.fn();
vi.mock('../hooks/screenCaptureRuntime', () => ({
  captureElementBlob: (...args: unknown[]) => mockCaptureElementBlob(...args),
}));

import { ExportPanel } from './ExportPanel';

// Stub anchor.click to suppress jsdom "navigation not implemented" stderr
let anchorClickStub: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  anchorClickStub = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:stub');
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  mockCaptureElementBlob.mockReset();
  anchorClickStub.mockRestore();
});

describe('ExportPanel', () => {
  it('renders PNG and SVG export buttons', () => {
    render(<ExportPanel containerSelector=".test-container" />);
    expect(screen.getByText('Export PNG')).toBeInTheDocument();
    expect(screen.getByText('Export SVG')).toBeInTheDocument();
  });

  it('has export-panel test id', () => {
    render(<ExportPanel containerSelector=".test-container" />);
    expect(screen.getByTestId('export-panel')).toBeInTheDocument();
  });

  it('PNG button calls captureElementBlob and triggers download', async () => {
    const mockBlob = new Blob(['png'], { type: 'image/png' });
    mockCaptureElementBlob.mockResolvedValue(mockBlob);
    const container = document.createElement('div');
    container.className = 'my-graph';
    document.body.appendChild(container);

    const appendSpy = vi.spyOn(document.body, 'appendChild');

    const user = userEvent.setup();
    render(<ExportPanel containerSelector=".my-graph" filenamePrefix="test" />);
    await user.click(screen.getByText('Export PNG'));

    // Verify captureElementBlob was called with the correct selector
    expect(mockCaptureElementBlob).toHaveBeenCalledWith('.my-graph', 'element');

    // Verify download anchor was created
    const anchors = appendSpy.mock.calls
      .map(c => c[0])
      .filter((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement);
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors[0].download).toMatch(/^test_.*\.png$/);

    appendSpy.mockRestore();
    document.body.removeChild(container);
  });

  it('PNG button recovers to idle when captureElementBlob returns null', async () => {
    mockCaptureElementBlob.mockResolvedValue(null);
    const container = document.createElement('div');
    container.className = 'missing';
    document.body.appendChild(container);

    const user = userEvent.setup();
    render(<ExportPanel containerSelector=".missing" />);
    await user.click(screen.getByText('Export PNG'));

    // No crash, button is re-enabled
    expect(screen.getByText('Export PNG')).not.toBeDisabled();
    expect(mockCaptureElementBlob).toHaveBeenCalledOnce();
    document.body.removeChild(container);
  });

  it('SVG button does not crash when container is missing', async () => {
    const user = userEvent.setup();
    render(<ExportPanel containerSelector=".nonexistent" />);
    await user.click(screen.getByText('Export SVG'));
    expect(screen.getByText('Export SVG')).not.toBeDisabled();
  });

  it('SVG button produces SVG blob with foreignObject when container exists', async () => {
    const container = document.createElement('div');
    container.className = 'svg-test-container';
    container.style.width = '400px';
    container.style.height = '300px';
    container.innerHTML = '<div class="react-flow__viewport"><span>node</span></div>';
    document.body.appendChild(container);

    const createObjUrl = vi.fn().mockReturnValue('blob:svg-url');
    globalThis.URL.createObjectURL = createObjUrl;

    const user = userEvent.setup();
    render(<ExportPanel containerSelector=".svg-test-container" filenamePrefix="graph" />);
    await user.click(screen.getByText('Export SVG'));

    // Verify blob was created with correct MIME
    expect(createObjUrl).toHaveBeenCalledOnce();
    const blobArg = createObjUrl.mock.calls[0][0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe('image/svg+xml;charset=utf-8');

    // Verify the SVG content includes foreignObject (style-inlined clone)
    const svgText = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blobArg);
    });
    expect(svgText).toContain('<foreignObject');
    expect(svgText).toContain('svg-test-container');

    document.body.removeChild(container);
  });
});
