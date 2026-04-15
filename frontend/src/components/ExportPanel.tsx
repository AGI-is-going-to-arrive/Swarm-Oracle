/* ═══════════════════════════════════════════════════════════
   P1-3 — Graph Export Panel
   PNG export via html2canvas (existing infra).
   SVG export via native SVG layers + reconstructed node cards.
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function round(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

function parsePixelValue(value: string | null | undefined, fallback = 0): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cssTransformToSvgTransform(transform: string | null | undefined): string | null {
  const trimmed = transform?.trim();
  if (!trimmed || trimmed === 'none') return null;
  return trimmed.replace(/px/g, '');
}

function resolveViewportTransform(container: Element): string | null {
  const viewport = container.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport) return null;
  const computedTransform = window.getComputedStyle(viewport).transform;
  return cssTransformToSvgTransform(computedTransform === 'none' ? viewport.style.transform : computedTransform);
}

function getSvgLayerElement(layer: Element | null): SVGSVGElement | null {
  if (!layer) return null;
  if (layer instanceof SVGSVGElement) return layer;
  return layer.querySelector('svg');
}

function serializeSvgLayer(
  layer: Element | null,
  role: 'background' | 'edges',
  width: number,
  height: number,
  viewportTransform: string | null,
): string {
  const svg = getSvgLayerElement(layer);
  if (!svg) return '';

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('data-export-layer', role);
  clone.setAttribute('x', '0');
  clone.setAttribute('y', '0');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('overflow', 'visible');
  clone.setAttribute('preserveAspectRatio', 'none');
  if (!clone.hasAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  if (viewportTransform) {
    clone.setAttribute('transform', viewportTransform);
  }

  return new XMLSerializer().serializeToString(clone);
}

function serializeNodeIcon(icon: SVGSVGElement | null, cardRect: DOMRect): string {
  if (!icon) return '';

  const iconRect = icon.getBoundingClientRect();
  if (iconRect.width <= 0 || iconRect.height <= 0) return '';

  const clone = icon.cloneNode(true) as SVGSVGElement;
  const computed = window.getComputedStyle(icon);
  clone.setAttribute('x', round(iconRect.left - cardRect.left));
  clone.setAttribute('y', round(iconRect.top - cardRect.top));
  clone.setAttribute('width', round(iconRect.width));
  clone.setAttribute('height', round(iconRect.height));
  clone.setAttribute('overflow', 'visible');
  if (computed.color) {
    clone.setAttribute('color', computed.color);
  }

  return new XMLSerializer().serializeToString(clone);
}

function serializeGraphNodes(container: Element): string {
  const containerRect = container.getBoundingClientRect();
  const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-graph-node-card="true"]'));

  return cards
    .map((card) => {
      const cardRect = card.getBoundingClientRect();
      if (cardRect.width <= 0 || cardRect.height <= 0) return '';

      const computed = window.getComputedStyle(card);
      const labelElement = card.querySelector<HTMLElement>('span');
      const labelComputed = labelElement ? window.getComputedStyle(labelElement) : computed;
      const labelRect = labelElement?.getBoundingClientRect();
      const label =
        card.getAttribute('data-graph-label')?.trim() ||
        labelElement?.textContent?.trim() ||
        card.textContent?.trim() ||
        '';

      const groupX = cardRect.left - containerRect.left;
      const groupY = cardRect.top - containerRect.top;
      const borderRadius = parsePixelValue(computed.borderTopLeftRadius, 8);
      const borderWidth = parsePixelValue(computed.borderTopWidth, 1);
      const opacity = parsePixelValue(computed.opacity, 1);
      const textX = labelRect ? labelRect.left - cardRect.left : parsePixelValue(computed.paddingLeft, 12);
      const textY = labelRect
        ? (labelRect.top - cardRect.top) + (labelRect.height / 2)
        : cardRect.height / 2;
      const fontSize = parsePixelValue(labelComputed.fontSize, 12);
      const iconMarkup = serializeNodeIcon(card.querySelector<SVGSVGElement>('svg'), cardRect);

      return [
        `<g data-export-node="true" transform="translate(${round(groupX)} ${round(groupY)})" opacity="${round(opacity)}">`,
        `<rect width="${round(cardRect.width)}" height="${round(cardRect.height)}" rx="${round(borderRadius)}" ry="${round(borderRadius)}" fill="${escapeXml(computed.backgroundColor || '#555')}" stroke="${escapeXml(computed.borderTopColor || 'transparent')}" stroke-width="${round(borderWidth)}"/>`,
        iconMarkup,
        `<text x="${round(textX)}" y="${round(textY)}" fill="${escapeXml(labelComputed.color || computed.color || '#fff')}" font-family="${escapeXml(labelComputed.fontFamily || computed.fontFamily || 'sans-serif')}" font-size="${round(fontSize)}" font-weight="${escapeXml(labelComputed.fontWeight || computed.fontWeight || '400')}" dominant-baseline="middle">${escapeXml(label)}</text>`,
        `</g>`,
      ].join('');
    })
    .filter(Boolean)
    .join('\n');
}

function buildNativeGraphSvg(container: Element, width: number, height: number): string {
  const viewportTransform = resolveViewportTransform(container);
  const backgroundLayer = serializeSvgLayer(
    container.querySelector('.react-flow__background'),
    'background',
    width,
    height,
    viewportTransform,
  );
  const edgeLayer = serializeSvgLayer(
    container.querySelector('.react-flow__edges'),
    'edges',
    width,
    height,
    viewportTransform,
  );
  const nodeLayer = serializeGraphNodes(container);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#1a1a2e"/>`,
    backgroundLayer,
    edgeLayer,
    nodeLayer,
    `</svg>`,
  ].filter(Boolean).join('\n');
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
      const svgString = buildNativeGraphSvg(container, width, height);

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
