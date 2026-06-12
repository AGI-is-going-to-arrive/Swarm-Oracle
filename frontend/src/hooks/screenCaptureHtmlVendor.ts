import type { Html2CanvasOptions } from 'html2canvas';

// Helper to parse percentages (e.g. 62%) or standard floats (0.62)
function parsePercentOrFloat(val: string): number {
  const trimmed = val.trim().toLowerCase();
  if (trimmed === 'none') return 0;
  if (trimmed.endsWith('%')) {
    return parseFloat(trimmed.slice(0, -1)) / 100;
  }
  return parseFloat(trimmed);
}

// Helper to parse hue angles in degrees (optionally with 'deg')
function parseHue(val: string): number {
  const trimmed = val.trim().toLowerCase();
  if (trimmed === 'none') return 0;
  if (trimmed.endsWith('deg')) {
    return parseFloat(trimmed.slice(0, -3));
  }
  if (trimmed.endsWith('rad')) {
    return parseFloat(trimmed.slice(0, -3)) * (180 / Math.PI);
  }
  if (trimmed.endsWith('grad')) {
    return parseFloat(trimmed.slice(0, -4)) * 0.9;
  }
  if (trimmed.endsWith('turn')) {
    return parseFloat(trimmed.slice(0, -4)) * 360;
  }
  return parseFloat(trimmed);
}

// Gamma correction for sRGB conversion
function gammaCorrect(v: number): number {
  if (v <= 0.0031308) {
    return 12.92 * v;
  } else {
    return 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }
}

/**
 * Pure helper that converts a string containing oklch(...) or oklab(...) sub-tokens
 * to sRGB rgb(...) or rgba(...) format.
 */
export function oklchStringToRgb(input: string): string {
  if (typeof input !== 'string') return input;
  const hasOklch = input.toLowerCase().includes('oklch(');
  const hasOklab = input.toLowerCase().includes('oklab(');
  if (!hasOklch && !hasOklab) {
    return input;
  }

  // Matches oklch(...) or oklab(...)
  // e.g. oklch(0.62 0.17 29) or oklch(0.7 0.1 200 / 0.5)
  return input.replace(/(oklch|oklab)\(([^)]+)\)/gi, (match, type, inner) => {
    try {
      const normalizedInner = inner.replace(/\//g, ' ');
      const parts = normalizedInner.trim().split(/[\s,]+/);
      if (parts.length < 3) return match;

      const L = parsePercentOrFloat(parts[0]);
      let a_val = 0;
      let b_val = 0;

      if (type.toLowerCase() === 'oklch') {
        const C = parsePercentOrFloat(parts[1]);
        const H = parseHue(parts[2]);
        const theta = H * (Math.PI / 180);
        a_val = C * Math.cos(theta);
        b_val = C * Math.sin(theta);
      } else {
        a_val = parsePercentOrFloat(parts[1]);
        b_val = parsePercentOrFloat(parts[2]);
      }

      // Convert OKLab -> LMS
      const l_ = L + 0.3963377774 * a_val + 0.2158037573 * b_val;
      const m_ = L - 0.1055613458 * a_val - 0.0638541728 * b_val;
      const s_ = L - 0.0894841775 * a_val - 1.2914855480 * b_val;

      // LMS to linear LMS (cube)
      const l = l_ * l_ * l_;
      const m = m_ * m_ * m_;
      const s = s_ * s_ * s_;

      // LMS to linear sRGB
      const r_lin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
      const g_lin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
      const b_lin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

      // Clamp linear values to [0, 1] before gamma correction
      const r_clamp = Math.max(0, Math.min(1, r_lin));
      const g_clamp = Math.max(0, Math.min(1, g_lin));
      const b_clamp = Math.max(0, Math.min(1, b_lin));

      // Gamma correction
      const r_gamma = gammaCorrect(r_clamp);
      const g_gamma = gammaCorrect(g_clamp);
      const b_gamma = gammaCorrect(b_clamp);

      // Clamp and round to integer [0, 255]
      const r_final = Math.max(0, Math.min(255, Math.round(r_gamma * 255)));
      const g_final = Math.max(0, Math.min(255, Math.round(g_gamma * 255)));
      const b_final = Math.max(0, Math.min(255, Math.round(b_gamma * 255)));

      const hasAlpha = parts.length >= 4;
      if (hasAlpha) {
        const alpha = parsePercentOrFloat(parts[3]);
        const alpha_final = Math.max(0, Math.min(1, alpha));
        return `rgba(${r_final}, ${g_final}, ${b_final}, ${alpha_final})`;
      } else {
        return `rgb(${r_final}, ${g_final}, ${b_final})`;
      }
    } catch {
      // Fallback to original match if parsing or conversion fails
      return match;
    }
  });
}

/**
 * Structured check to see if a node is an HTMLElement or SVGElement.
 * This avoids cross-realm instanceof failures in iframes.
 */
export function isStylableElement(node: unknown): node is HTMLElement | SVGElement {
  if (typeof node !== 'object' || node === null) return false;
  const obj = node as Record<string, unknown>;
  return (
    obj.nodeType === 1 &&
    'style' in obj &&
    typeof obj.style === 'object' &&
    obj.style !== null
  );
}

// Inner helper to walk the cloned elements and replace computed colors
function onCloneWrapper(clonedDoc: Document, liveHtmlBg: string, liveBodyBg: string): void {
  try {
    // (B) In onCloneWrapper, INJECT a hard !important override stylesheet into the clone
    try {
      const st = clonedDoc.createElement('style');
      st.textContent =
        `html{background-color:${liveHtmlBg} !important;background-image:none !important;}` +
        `body{background-color:${liveBodyBg} !important;background-image:none !important;}`;
      const target = clonedDoc.head || clonedDoc.documentElement;
      if (target) {
        target.appendChild(st);
      }
    } catch {
      // Ignore if document head/root is missing or appending fails
    }

    // Inject override style element to neutralize leftover root tokens
    try {
      const style = clonedDoc.createElement('style');
      style.textContent = '*{ color-scheme: light; }';
      const target = clonedDoc.head || clonedDoc.documentElement;
      if (target) {
        target.appendChild(style);
      }
    } catch {
      // Ignore
    }

    // (C) Convert :root oklch CUSTOM PROPERTIES inline on the clone's documentElement
    try {
      const rs = (clonedDoc.defaultView ?? window).getComputedStyle(clonedDoc.documentElement);
      for (let i = 0; i < rs.length; i++) {
        const n = rs.item(i);
        if (n.startsWith('--')) {
          const v = rs.getPropertyValue(n);
          if (v && (/oklch\(/i.test(v) || /oklab\(/i.test(v))) {
            clonedDoc.documentElement.style.setProperty(n, oklchStringToRgb(v));
          }
        }
      }
    } catch {
      // Ignore
    }

    const pinProps = [
      'color',
      'background-color',
      'border-top-color',
      'border-right-color',
      'border-bottom-color',
      'border-left-color',
      'outline-color',
      'text-decoration-color',
      'fill',
      'stroke'
    ];

    try {
      const allElements = clonedDoc.querySelectorAll('*');
      allElements.forEach((el) => {
        if (!isStylableElement(el)) return;
        try {
          const computed = (el.ownerDocument?.defaultView ?? window).getComputedStyle(el);

          // (D) 1. Pin properties: read getComputedStyle and write inline
          pinProps.forEach((prop) => {
            try {
              const computedVal = computed.getPropertyValue(prop);
              if (computedVal) {
                if (computedVal.toLowerCase().includes('oklch(') || computedVal.toLowerCase().includes('oklab(')) {
                  el.style.setProperty(prop, oklchStringToRgb(computedVal));
                } else {
                  el.style.setProperty(prop, computedVal);
                }
              }
            } catch {
              // Skip single property errors silently
            }
          });

          // (D) 2. box-shadow: only convert-and-set when it contains oklch/oklab
          try {
            const bs = computed.getPropertyValue('box-shadow');
            if (bs && (bs.toLowerCase().includes('oklch(') || bs.toLowerCase().includes('oklab('))) {
              el.style.setProperty('box-shadow', oklchStringToRgb(bs));
            }
          } catch {
            // Skip single property errors silently
          }
        } catch {
          // Skip single element errors silently
        }
      });
    } catch {
      // Ignore overall selector errors
    }
  } catch (e) {
    console.warn('Failed to sanitize colors during clone:', e);
  }
}

/**
 * Wrapper for html2canvas that automatically merges onclone hooks to rewrite
 * OKLCH/OKLab computed styles to sRGB colors in the cloned document.
 */
export async function html2canvas(
  element: HTMLElement,
  options?: Html2CanvasOptions
): Promise<HTMLCanvasElement> {
  // (A) CAPTURE the LIVE root/body background in the WRAPPER (before cloning)
  let liveBodyBg = 'rgb(255, 255, 255)';
  let liveHtmlBg = 'rgb(255, 255, 255)';
  try {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      liveBodyBg = oklchStringToRgb(window.getComputedStyle(document.body).backgroundColor) || liveBodyBg;
      liveHtmlBg = oklchStringToRgb(window.getComputedStyle(document.documentElement).backgroundColor) || liveHtmlBg;
    }
  } catch { /* keep defaults */ }

  const { default: html2canvasLib } = await import('html2canvas');

  const originalOnClone = options?.onclone;

  const mergedOnClone = async (clonedDoc: Document, clonedElement: HTMLElement) => {
    // 1. Run our sanitization first
    onCloneWrapper(clonedDoc, liveHtmlBg, liveBodyBg);

    // 2. Compose and run original caller's onclone if it exists
    if (originalOnClone) {
      try {
        await originalOnClone(clonedDoc, clonedElement);
      } catch (err) {
        console.warn('Error running caller onclone hook:', err);
      }
    }
  };

  const mergedOptions: Html2CanvasOptions = {
    ...options,
    onclone: mergedOnClone
  };

  return html2canvasLib(element, mergedOptions);
}
