import "@testing-library/jest-dom";
import { vi } from 'vitest';

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
