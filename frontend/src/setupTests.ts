import "@testing-library/jest-dom";
import { beforeEach, vi } from 'vitest';
import React from 'react';

const LOCIZE_BANNER = 'i18next is made possible by our own product, Locize';
const originalConsoleLog = console.log.bind(console);
const originalConsoleInfo = console.info.bind(console);

vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes(LOCIZE_BANNER)) {
    return;
  }
  originalConsoleLog(...args);
});

vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes(LOCIZE_BANNER)) {
    return;
  }
  originalConsoleInfo(...args);
});

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
}

// ── Motion mock ──────────────────────────────────────────────
// Preserves semantic HTML tags: motion.button -> <button>, motion.li -> <li>, etc.
vi.mock('motion', () => {
  // Allowlist of DOM-safe props to forward (avoids React warnings from motion-specific props)
  const DOM_PROP_RE = /^(on[A-Z]|className$|style$|id$|role$|tabIndex$|aria-|data-|type$|disabled$|href$|target$|rel$|htmlFor$|name$|value$|checked$|placeholder$|autoFocus$|autoComplete$|min$|max$|step$|rows$|cols$|src$|alt$|title$|lang$|dir$|hidden$|open$|form$|action$|method$|draggable$|contentEditable$)/;

  function createMotionComponent(tag: string) {
    const Component = React.forwardRef(
      ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>, ref: React.Ref<unknown>) => {
        const domProps: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (DOM_PROP_RE.test(k)) {
            domProps[k] = v;
          }
        }
        return React.createElement(tag, { ...domProps, ref }, children);
      },
    );
    Component.displayName = `motion.${tag}`;
    return Component;
  }

  // Cache created components so the same proxy property always returns the same reference
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cache = new Map<string, any>();

  const motionProxy = new Proxy({} as Record<string, unknown>, {
    get(_target, prop: string) {
      if (prop === '$$typeof' || prop === 'render') return undefined;
      let component = cache.get(prop);
      if (!component) {
        component = createMotionComponent(prop);
        cache.set(prop, component);
      }
      return component;
    },
  });

  return {
    motion: motionProxy,
    AnimatePresence: ({ children }: React.PropsWithChildren) => children,
    useReducedMotion: () => prefersReducedMotion(),
    useInView: () => true,
    useScroll: () => ({ scrollY: { get: () => 0, onChange: vi.fn() } }),
    useMotionValue: (init: number) => ({ get: () => init, set: vi.fn(), onChange: vi.fn() }),
    useTransform: () => ({ get: () => 0, onChange: vi.fn() }),
    useSpring: () => ({ get: () => 0, set: vi.fn(), onChange: vi.fn() }),
    useAnimation: () => ({ start: vi.fn(), stop: vi.fn() }),
  };
});

// Also mock 'motion/react' and 'framer-motion' for all import paths
vi.mock('motion/react', async () => {
  return await vi.importMock('motion');
});
vi.mock('framer-motion', async () => {
  return await vi.importMock('motion');
});

// ── matchMedia mock ──────────────────────────────────────────
// Returns matches: false by default (no reduced-motion preference).
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })),
  });
}

// ── ResizeObserver mock ──────────────────────────────────────
// No-op observer for Radix UI / shadcn components.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof globalThis.ResizeObserver;
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(String(key)) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(String(key));
    },
    setItem(key: string, value: string) {
      store.set(String(key), String(value));
    },
  };
}

function installFreshStorage() {
  const localStorage = createMemoryStorage();
  const sessionStorage = createMemoryStorage();

  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: localStorage,
  });
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: sessionStorage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: localStorage,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: sessionStorage,
  });
}

function parseFontSize(font: string): number {
  const match = font.match(/(\d+(?:\.\d+)?)px/);
  return match ? Number.parseFloat(match[1]) : 16;
}

function measureMockTextWidth(text: string, font: string): number {
  const fontSize = parseFontSize(font);
  let total = 0;

  for (const grapheme of Array.from(text)) {
    if (grapheme === '\n') continue;
    if (grapheme === '\t') {
      total += fontSize * 2.6;
      continue;
    }
    if (/\s/u.test(grapheme)) {
      total += fontSize * 0.32;
      continue;
    }
    if (/\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(grapheme)) {
      total += fontSize;
      continue;
    }
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(grapheme)) {
      total += fontSize * 0.94;
      continue;
    }
    if (/[A-Z]/u.test(grapheme)) {
      total += fontSize * 0.66;
      continue;
    }
    if (/[a-z0-9]/u.test(grapheme)) {
      total += fontSize * 0.56;
      continue;
    }
    total += fontSize * 0.38;
  }

  return total;
}

const canvas2DContext = {
  font: '16px "Instrument Sans", sans-serif',
  measureText(text: string): TextMetrics {
    return {
      width: measureMockTextWidth(text, canvas2DContext.font),
    } as TextMetrics;
  },
};

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: vi.fn((contextId: string) => {
      if (contextId !== '2d') {
        return null;
      }
      return canvas2DContext;
    }),
  });
}

if (typeof window !== 'undefined') {
  installFreshStorage();
}

const { default: i18n, LANGUAGE_STORAGE_KEY } = await import('./i18n/config');
const defaultTestLanguage =
  typeof window !== 'undefined' && window.navigator.language.toLowerCase().startsWith('zh')
    ? 'zh'
    : 'en';

beforeEach(async () => {
  if (typeof window === 'undefined') return;

  installFreshStorage();
  await i18n.changeLanguage(defaultTestLanguage);
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
  window.sessionStorage.clear();
});
