import { describe, it, expect, vi } from 'vitest';
import { oklchStringToRgb, html2canvas, isStylableElement } from './screenCaptureHtmlVendor';

// Mock html2canvas library
vi.mock('html2canvas', () => {
  return {
    default: vi.fn().mockImplementation(async (_element, options) => {
      // Simulate calling the onclone option if provided
      if (options && typeof options.onclone === 'function') {
        const dummyDoc = document.implementation.createHTMLDocument('test');
        const dummyElement = dummyDoc.createElement('div');
        dummyDoc.body.appendChild(dummyElement);
        await options.onclone(dummyDoc, dummyElement);
        return { dummyDoc };
      }
      return {};
    })
  };
});

describe('isStylableElement', () => {
  it('identifies real div element as true', () => {
    const div = document.createElement('div');
    expect(isStylableElement(div)).toBe(true);
  });

  it('identifies SVG element as true', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    expect(isStylableElement(svg)).toBe(true);
  });

  it('identifies duck-typed object as true', () => {
    const duck = { nodeType: 1, style: {} };
    expect(isStylableElement(duck)).toBe(true);
  });

  it('identifies text node as false', () => {
    const txt = document.createTextNode('hello');
    expect(isStylableElement(txt)).toBe(false);
  });

  it('identifies null, undefined, and strings as false', () => {
    expect(isStylableElement(null)).toBe(false);
    expect(isStylableElement(undefined)).toBe(false);
    expect(isStylableElement('div')).toBe(false);
    expect(isStylableElement(123)).toBe(false);
  });
});

describe('oklchStringToRgb', () => {
  it('converts oklch(0 0 0) to black rgb(0, 0, 0)', () => {
    expect(oklchStringToRgb('oklch(0 0 0)')).toBe('rgb(0, 0, 0)');
  });

  it('converts oklch(0.62 0.17 29) to a valid reddish sRGB color', () => {
    const converted = oklchStringToRgb('oklch(0.62 0.17 29)');
    expect(converted).not.toContain('oklch');
    expect(converted).toMatch(/^rgb\(\d+, \d+, \d+\)$/);

    // Check that red channel is strong (hue 29 is a warm red/orange)
    const match = converted.match(/\d+/g);
    expect(match).not.toBeNull();
    if (match) {
      const [r, g, b] = match.map(Number);
      expect(r).toBeGreaterThan(g);
      expect(r).toBeGreaterThan(b);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });

  it('converts oklch(0.7 0.1 200 / 0.5) and preserves alpha', () => {
    const converted = oklchStringToRgb('oklch(0.7 0.1 200 / 0.5)');
    expect(converted).not.toContain('oklch');
    expect(converted).toMatch(/^rgba\(\d+, \d+, \d+, 0.5\)$/);
  });

  it('parses percentage L (oklch(62% 0.17 29)) without throwing and yields rgb', () => {
    const converted = oklchStringToRgb('oklch(62% 0.17 29)');
    expect(converted).not.toContain('oklch');
    expect(converted).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  it('passes through non-oklch/oklab colors unchanged', () => {
    expect(oklchStringToRgb('rgb(10, 20, 30)')).toBe('rgb(10, 20, 30)');
    expect(oklchStringToRgb('#abcdef')).toBe('#abcdef');
    expect(oklchStringToRgb('inherit')).toBe('inherit');
  });

  it('replaces oklch sub-token inside box-shadow and preserves the rest', () => {
    const shadow = '0 2px 4px oklch(0.62 0.17 29)';
    const converted = oklchStringToRgb(shadow);
    expect(converted).not.toContain('oklch');
    expect(converted).toContain('0 2px 4px rgb(');
    expect(converted).toMatch(/^0 2px 4px rgb\(\d+, \d+, \d+\)$/);
  });

  it('handles oklab format conversion', () => {
    const converted = oklchStringToRgb('oklab(0.62 0.1 0.2)');
    expect(converted).not.toContain('oklab');
    expect(converted).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});

describe('html2canvas wrapper', () => {
  it('captures live background and injects style with !important on clone', async () => {
    const originalGetComputedStyle = window.getComputedStyle;

    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      if (el === document.body) {
        return {
          backgroundColor: 'oklch(0.98 0.005 80)',
          getPropertyValue: (prop: string) => prop === 'background-color' ? 'oklch(0.98 0.005 80)' : ''
        } as unknown as CSSStyleDeclaration;
      }
      if (el === document.documentElement) {
        return {
          backgroundColor: 'oklch(0.95 0.01 100)',
          getPropertyValue: (prop: string) => prop === 'background-color' ? 'oklch(0.95 0.01 100)' : ''
        } as unknown as CSSStyleDeclaration;
      }
      // For checking custom properties on cloned element in onCloneWrapper
      return {
        length: 2,
        item: (index: number) => index === 0 ? '--color-base' : '--color-text',
        getPropertyValue: (prop: string) => {
          if (prop === '--color-base') return 'oklch(0.98 0.005 80)';
          if (prop === '--color-text') return 'oklch(0.2 0.01 20)';
          if (prop === 'color') return 'oklch(0.2 0.01 20)';
          return '';
        }
      } as unknown as CSSStyleDeclaration;
    });

    const element = document.createElement('div');
    const result = await html2canvas(element) as unknown as { dummyDoc: Document };

    window.getComputedStyle = originalGetComputedStyle;

    const clonedDoc: Document = result.dummyDoc;
    expect(clonedDoc).toBeDefined();

    // Verify style element is injected with !important overrides
    const styles = clonedDoc.querySelectorAll('style');
    let foundOverride = false;
    styles.forEach((style) => {
      if (style.textContent?.includes('background-color') && style.textContent?.includes('!important')) {
        foundOverride = true;
        // Verify converted rgb values
        expect(style.textContent).toContain('html{background-color:rgb(');
        expect(style.textContent).toContain('body{background-color:rgb(');
      }
    });
    expect(foundOverride).toBe(true);

    // Verify that custom properties were converted on documentElement
    const colorBase = clonedDoc.documentElement.style.getPropertyValue('--color-base');
    const colorText = clonedDoc.documentElement.style.getPropertyValue('--color-text');
    expect(colorBase).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    expect(colorText).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });

  it('pins oklch values on elements from external documents', async () => {
    // Create an external document to simulate cross-realm elements
    const extDoc = document.implementation.createHTMLDocument('external');
    const extDiv = extDoc.createElement('div');
    extDiv.style.color = 'oklch(0.62 0.17 29)';

    // We override the default mock of html2canvas for this test
    const html2canvasMock = vi.mocked(await import('html2canvas')).default as unknown as {
      mockImplementationOnce: (fn: (element: HTMLElement, options?: { onclone?: (doc: Document, el: HTMLElement) => Promise<void> }) => Promise<unknown>) => void;
    };
    html2canvasMock.mockImplementationOnce(async (_element: HTMLElement, options?: { onclone?: (doc: Document, el: HTMLElement) => Promise<void> }) => {
      if (options && typeof options.onclone === 'function') {
        const dummyDoc = document.implementation.createHTMLDocument('test');
        // Append extDiv to the dummyDoc BEFORE calling onclone,
        // simulating it being cloned as part of the document
        dummyDoc.body.appendChild(extDiv);

        const dummyElement = dummyDoc.createElement('div');
        dummyDoc.body.appendChild(dummyElement);
        await options.onclone(dummyDoc, dummyElement);
        return { dummyDoc };
      }
      return {};
    });

    const originalGetComputedStyle = window.getComputedStyle;

    // Stub window.getComputedStyle for our test setup
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      if (el === extDiv) {
        return {
          getPropertyValue: (prop: string) => prop === 'color' ? 'oklch(0.62 0.17 29)' : ''
        } as unknown as CSSStyleDeclaration;
      }
      return {
        getPropertyValue: () => ''
      } as unknown as CSSStyleDeclaration;
    });

    const element = document.createElement('div');
    await html2canvas(element);

    window.getComputedStyle = originalGetComputedStyle;

    expect(extDiv.style.color).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  });
});
