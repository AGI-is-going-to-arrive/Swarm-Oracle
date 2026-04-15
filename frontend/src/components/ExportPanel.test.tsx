/**
 * P1-3 — ExportPanel unit tests
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockElementRect(
  element: Element,
  rect: Partial<DOMRect> & Pick<DOMRect, 'width' | 'height'>,
) {
  const left = rect.left ?? 0;
  const top = rect.top ?? 0;
  const width = rect.width;
  const height = rect.height;
  const right = rect.right ?? left + width;
  const bottom = rect.bottom ?? top + height;

  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right,
        bottom,
        toJSON: () => ({}),
      }) satisfies DOMRect,
  });
}

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
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to export PNG. Try again.');
    document.body.removeChild(container);
  });

  it('shows a PNG-specific busy label while PNG export is pending', async () => {
    const deferred = createDeferred<Blob | null>();
    mockCaptureElementBlob.mockReturnValue(deferred.promise);
    const container = document.createElement('div');
    container.className = 'pending-png-export';
    document.body.appendChild(container);

    const user = userEvent.setup();
    render(<ExportPanel containerSelector=".pending-png-export" />);
    await user.click(screen.getByRole('button', { name: 'Export PNG' }));

    expect(screen.getByRole('button', { name: 'Exporting PNG...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export SVG' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Exporting SVG...' })).not.toBeInTheDocument();

    deferred.resolve(new Blob(['png'], { type: 'image/png' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Export PNG' })).toBeEnabled());
    document.body.removeChild(container);
  });

  it('SVG button shows a visible failure hint when container is missing', async () => {
    const user = userEvent.setup();
    render(<ExportPanel containerSelector=".nonexistent" />);
    await user.click(screen.getByRole('button', { name: 'Export SVG' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export SVG' })).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to export SVG. Try again.');
  });

  it('shows a SVG-specific busy label before SVG export finishes', async () => {
    const container = document.createElement('div');
    container.className = 'pending-svg-export';
    container.style.width = '320px';
    container.style.height = '180px';
    container.innerHTML = '<div class="react-flow__viewport"><span>node</span></div>';
    document.body.appendChild(container);

    const createObjUrl = vi.fn().mockReturnValue('blob:svg-url');
    globalThis.URL.createObjectURL = createObjUrl;

    const user = userEvent.setup();
    render(<ExportPanel containerSelector=".pending-svg-export" />);
    await user.click(screen.getByRole('button', { name: 'Export SVG' }));

    expect(screen.getByRole('button', { name: 'Exporting SVG...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export PNG' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Exporting PNG...' })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Export SVG' })).toBeEnabled());
    expect(createObjUrl).toHaveBeenCalledOnce();
    document.body.removeChild(container);
  });

  it('SVG button produces a native SVG export without foreignObject', async () => {
    const container = document.createElement('div');
    container.className = 'svg-test-container';
    container.style.width = '400px';
    container.style.height = '300px';
    container.innerHTML = `
      <div class="react-flow__viewport" style="transform: translate(10px, 20px) scale(1.25);">
        <svg class="react-flow__background" viewBox="0 0 400 300">
          <circle cx="24" cy="24" r="2" fill="#3b3b52"></circle>
        </svg>
        <div class="react-flow__edges">
          <svg viewBox="0 0 400 300">
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#7dd3fc"></path>
              </marker>
            </defs>
            <path d="M40 30 L140 120" stroke="#7dd3fc" fill="none" marker-end="url(#arrow)"></path>
          </svg>
        </div>
        <button
          type="button"
          data-graph-node-card="true"
          data-graph-label="Node A"
          style="background: rgb(31, 41, 55); color: rgb(243, 244, 246); border: 2px solid rgb(125, 211, 252); border-radius: 8px; padding: 10px 12px; font-size: 14px; font-weight: 600;"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M4 12h16"></path>
          </svg>
          <span>Node A</span>
        </button>
      </div>
    `;
    document.body.appendChild(container);

    const viewport = container.querySelector('.react-flow__viewport');
    const button = container.querySelector('[data-graph-node-card="true"]');
    const icon = button?.querySelector('svg');
    const label = button?.querySelector('span');
    expect(viewport).toBeTruthy();
    expect(button).toBeTruthy();
    expect(icon).toBeTruthy();
    expect(label).toBeTruthy();

    mockElementRect(container, { left: 0, top: 0, width: 400, height: 300 });
    mockElementRect(button!, { left: 72, top: 92, width: 140, height: 44 });
    mockElementRect(icon!, { left: 84, top: 107, width: 14, height: 14 });
    mockElementRect(label!, { left: 108, top: 104, width: 72, height: 18 });

    const createObjUrl = vi.fn().mockReturnValue('blob:svg-url');
    globalThis.URL.createObjectURL = createObjUrl;

    const user = userEvent.setup();
    render(<ExportPanel containerSelector=".svg-test-container" filenamePrefix="graph" />);
    await user.click(screen.getByRole('button', { name: 'Export SVG' }));

    // Verify blob was created with correct MIME
    await waitFor(() => expect(createObjUrl).toHaveBeenCalledOnce());
    const blobArg = createObjUrl.mock.calls[0][0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);
    expect(blobArg.type).toBe('image/svg+xml;charset=utf-8');

    // Verify the SVG content is native and does not rely on foreignObject.
    const svgText = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blobArg);
    });
    expect(svgText).toContain('<svg');
    expect(svgText).not.toContain('<foreignObject');
    expect(svgText).toContain('data-export-layer="edges"');
    expect(svgText).toContain('data-export-layer="background"');
    expect(svgText).toContain('data-export-node="true"');
    expect(svgText).toContain('Node A');
    expect(svgText).toContain('marker-end="url(#arrow)"');

    document.body.removeChild(container);
  });

  it('prefers the full node label over the truncated display label in SVG exports', async () => {
    const container = document.createElement('div');
    container.className = 'svg-full-label-container';
    container.style.width = '400px';
    container.style.height = '300px';
    container.innerHTML = `
      <div class="react-flow__viewport" style="transform: translate(0px, 0px) scale(1);">
        <div
          data-graph-node-card="true"
          data-graph-label="Truncated…"
          data-graph-full-label="This is the complete label"
          style="background: rgb(31, 41, 55); color: rgb(243, 244, 246); border: 1px solid rgb(125, 211, 252); border-radius: 8px; padding: 10px 12px; font-size: 14px; font-weight: 600;"
        >
          <span>Truncated…</span>
        </div>
      </div>
    `;
    document.body.appendChild(container);

    const button = container.querySelector('[data-graph-node-card="true"]');
    const label = button?.querySelector('span');
    expect(button).toBeTruthy();
    expect(label).toBeTruthy();

    mockElementRect(container, { left: 0, top: 0, width: 400, height: 300 });
    mockElementRect(button!, { left: 72, top: 92, width: 140, height: 44 });
    mockElementRect(label!, { left: 108, top: 104, width: 72, height: 18 });

    const createObjUrl = vi.fn().mockReturnValue('blob:svg-url');
    globalThis.URL.createObjectURL = createObjUrl;

    const user = userEvent.setup();
    render(<ExportPanel containerSelector=".svg-full-label-container" filenamePrefix="graph" />);
    await user.click(screen.getByRole('button', { name: 'Export SVG' }));

    await waitFor(() => expect(createObjUrl).toHaveBeenCalledOnce());
    const blobArg = createObjUrl.mock.calls[0][0] as Blob;
    const svgText = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.readAsText(blobArg);
    });

    expect(svgText).toContain('This is the complete label');
    expect(svgText).not.toContain('Truncated…</text>');

    document.body.removeChild(container);
  });
});
