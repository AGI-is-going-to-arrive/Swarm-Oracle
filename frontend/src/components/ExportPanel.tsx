/* ═══════════════════════════════════════════════════════════
   P1-3 — Graph Export Panel
   PNG export via html2canvas (existing infra).
   SVG export via clone + inline computed styles + foreignObject.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

type ExportStatus = 'idle' | 'exporting_png' | 'exporting_svg';
type ExportFailure = 'png_failed' | 'svg_failed' | null;

interface ExportPanelProps {
  /** CSS selector for the ReactFlow container to capture */
  containerSelector: string;
  /** Filename prefix (e.g. "causal-graph" or "argument-map") */
  filenamePrefix?: string;
}

const EXPORT_CHROME_SELECTORS = [
  '.graph-export-chrome',
  '.react-flow__controls',
  '.react-flow__minimap',
];

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function waitForNextTick(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 40);
  });
}

/** Deep-clone an element and inline every computed style so it renders standalone. */
function cloneWithInlinedStyles(source: Element): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  const sourceAll = [source, ...Array.from(source.querySelectorAll('*'))];
  const cloneAll = [clone, ...Array.from(clone.querySelectorAll('*'))];
  sourceAll.forEach((srcEl, i) => {
    const tgtEl = cloneAll[i] as HTMLElement | undefined;
    if (!tgtEl || typeof tgtEl.style?.setProperty !== 'function') return;
    const computed = window.getComputedStyle(srcEl);
    // Use indexed access — CSSStyleDeclaration may not be iterable in all runtimes
    for (let j = 0; j < computed.length; j++) {
      const prop = computed[j];
      const val = computed.getPropertyValue(prop);
      if (val) tgtEl.style.setProperty(prop, val);
    }
  });
  EXPORT_CHROME_SELECTORS.forEach((selector) => {
    clone.querySelectorAll(selector).forEach((element) => element.remove());
  });
  return clone;
}

function hideExportChrome(root: Element): () => void {
  const hiddenElements = Array.from(
    new Set(
      EXPORT_CHROME_SELECTORS.flatMap((selector) => Array.from(root.querySelectorAll<HTMLElement>(selector))),
    ),
  );
  const previousDisplay = hiddenElements.map((element) => element.style.getPropertyValue('display'));
  const previousPriority = hiddenElements.map((element) => element.style.getPropertyPriority('display'));

  hiddenElements.forEach((element) => {
    element.style.setProperty('display', 'none', 'important');
  });

  return () => {
    hiddenElements.forEach((element, index) => {
      const display = previousDisplay[index] ?? '';
      const priority = previousPriority[index] ?? '';
      if (display) {
        element.style.setProperty('display', display, priority || undefined);
      } else {
        element.style.removeProperty('display');
      }
    });
  };
}

export function ExportPanel({ containerSelector, filenamePrefix = 'graph' }: ExportPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ExportStatus>('idle');
  const [failureKey, setFailureKey] = useState<ExportFailure>(null);

  const setFailure = useCallback((key: Exclude<ExportFailure, null>) => {
    setFailureKey(key);
  }, []);

  const exportPng = useCallback(async () => {
    setFailureKey(null);
    setStatus('exporting_png');
    try {
      const { captureElementBlob } = await import('../hooks/screenCaptureRuntime');
      const container = document.querySelector(containerSelector);
      if (!container) {
        setFailure('png_failed');
        return;
      }
      const restoreChrome = hideExportChrome(container);
      const blob = await captureElementBlob(containerSelector, 'element').finally(() => {
        restoreChrome();
      });
      if (blob) {
        downloadBlob(blob, `${filenamePrefix}_${timestamp()}.png`);
      } else {
        setFailure('png_failed');
      }
    } catch (err) {
      console.error('[ExportPanel] PNG export failed:', err);
      setFailure('png_failed');
    } finally {
      setStatus('idle');
    }
  }, [containerSelector, filenamePrefix, setFailure]);

  const exportSvg = useCallback(async () => {
    setFailureKey(null);
    setStatus('exporting_svg');
    try {
      await waitForNextTick();
      const container = document.querySelector(containerSelector);
      if (!container) {
        setFailure('svg_failed');
        return;
      }

      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.ceil(rect.width));
      const height = Math.max(1, Math.ceil(rect.height));

      // Clone the entire container and inline all computed styles
      // so that ReactFlow's position:absolute / transform layout is preserved.
      const clone = cloneWithInlinedStyles(container);
      clone.style.margin = '0';
      clone.style.position = 'static';
      clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');

      const serialized = new XMLSerializer().serializeToString(clone);
      const svgString = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        `<rect width="100%" height="100%" fill="#1a1a2e"/>`,
        `<foreignObject width="100%" height="100%">${serialized}</foreignObject>`,
        `</svg>`,
      ].join('\n');

      const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
      downloadBlob(blob, `${filenamePrefix}_${timestamp()}.svg`);
    } catch (err) {
      console.error('[ExportPanel] SVG export failed:', err);
      setFailure('svg_failed');
    } finally {
      setStatus('idle');
    }
  }, [containerSelector, filenamePrefix, setFailure]);

  const disabled = status !== 'idle';
  const pngBusy = status === 'exporting_png';
  const svgBusy = status === 'exporting_svg';

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', alignItems: 'flex-start' }}
      data-testid="export-panel"
    >
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <button
          onClick={exportPng}
          disabled={disabled}
          title={t('export.png', 'Export PNG')}
          style={{
            padding: '4px 10px',
            fontSize: '0.8rem',
            background: '#2a2a3e',
            color: '#ccc',
            border: '1px solid #444',
            borderRadius: 4,
            cursor: disabled ? 'wait' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          {pngBusy ? t('export.exporting_png', 'Exporting PNG...') : t('export.png', 'Export PNG')}
        </button>
        <button
          onClick={exportSvg}
          disabled={disabled}
          title={t('export.svg', 'Export SVG')}
          style={{
            padding: '4px 10px',
            fontSize: '0.8rem',
            background: '#2a2a3e',
            color: '#ccc',
            border: '1px solid #444',
            borderRadius: 4,
            cursor: disabled ? 'wait' : 'pointer',
            opacity: disabled ? 0.6 : 1,
          }}
        >
          {svgBusy ? t('export.exporting_svg', 'Exporting SVG...') : t('export.svg', 'Export SVG')}
        </button>
      </div>
      {failureKey && (
        <div
          role="alert"
          style={{ fontSize: '0.75rem', color: '#ff9b9b' }}
        >
          {failureKey === 'png_failed'
            ? t('export.png_failed', 'Failed to export PNG. Try again.')
            : t('export.svg_failed', 'Failed to export SVG. Try again.')}
        </div>
      )}
    </div>
  );
}
