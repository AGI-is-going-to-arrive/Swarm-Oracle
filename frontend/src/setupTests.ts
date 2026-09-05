/* eslint-disable react-hooks/refs */
import "@testing-library/jest-dom";
import { transferableAbortController } from 'node:util';
import { afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { createPortal } from 'react-dom';

process.env.RTL_SKIP_AUTO_CLEANUP = 'true';

// fetch/Request come from Node, whose newer versions reject jsdom AbortSignals.
// Keep cancellation in the same realm as those APIs (including React Router).
const nativeAbortController = transferableAbortController();
globalThis.AbortController = nativeAbortController.constructor as typeof AbortController;
globalThis.AbortSignal = nativeAbortController.signal.constructor as typeof AbortSignal;

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

type DialogOpenContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
};

type PrimitiveProps = React.HTMLAttributes<HTMLElement> & {
  asChild?: boolean;
  children?: React.ReactNode;
};

function renderPrimitiveElement(
  tag: keyof React.JSX.IntrinsicElements,
  asChild: boolean | undefined,
  children: React.ReactNode,
  props: Record<string, unknown>,
  ref?: React.Ref<HTMLElement>,
) {
  const mergedProps: Record<string, unknown> = { ...props, ref };
  if (asChild && React.isValidElement(children)) {
    const childProps = children.props as Record<string, unknown>;
    for (const [key, value] of Object.entries(props)) {
      const childValue = childProps[key];
      if (
        key.startsWith('on')
        && typeof childValue === 'function'
        && typeof value === 'function'
      ) {
        mergedProps[key] = (...args: unknown[]) => {
          childValue(...args);
          value(...args);
        };
      }
    }
    return React.cloneElement(
      children as React.ReactElement<Record<string, unknown>>,
      mergedProps,
    );
  }
  return React.createElement(tag, mergedProps, children);
}

function createDialogPrimitiveMock(kind: 'Dialog' | 'AlertDialog') {
  const OpenContext = React.createContext<DialogOpenContextValue | null>(null);
  const useOpenContext = () => React.useContext(OpenContext);

  function Root({
    open,
    defaultOpen = false,
    onOpenChange,
    children,
  }: React.PropsWithChildren<{
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
  }>) {
    const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
    const isControlled = open !== undefined;
    const currentOpen = isControlled ? open : internalOpen;
    const generatedId = React.useId();
    const titleId = `${generatedId}-title`;
    const descriptionId = `${generatedId}-description`;
    const setOpen = React.useCallback((nextOpen: boolean) => {
      if (!isControlled) {
        setInternalOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    }, [isControlled, onOpenChange]);

    React.useEffect(() => {
      if (!currentOpen || typeof document === 'undefined') return undefined;
      const handleDocumentKeyDown = (event: KeyboardEvent) => {
        if (!event.defaultPrevented && event.key === 'Escape') {
          setOpen(false);
        }
      };
      document.addEventListener('keydown', handleDocumentKeyDown);
      return () => document.removeEventListener('keydown', handleDocumentKeyDown);
    }, [currentOpen, setOpen]);

    return React.createElement(
      OpenContext.Provider,
      { value: { open: currentOpen, setOpen, titleId, descriptionId } },
      children,
    );
  }
  Root.displayName = `${kind}.Root`;

  const Portal = ({ children, container }: React.PropsWithChildren<{ container?: Element | DocumentFragment | null }>) => {
    const target = container ?? (typeof document === 'undefined' ? null : document.body);
    return target ? createPortal(children, target) : React.createElement(React.Fragment, null, children);
  };
  Portal.displayName = `${kind}.Portal`;

  const Trigger = React.forwardRef<HTMLElement, PrimitiveProps>(
    ({ asChild, children, onClick, ...props }, ref) => {
      const context = useOpenContext();
      const handleClick: React.MouseEventHandler<HTMLElement> = (event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          context?.setOpen(true);
        }
      };
      return renderPrimitiveElement(
        'button',
        asChild,
        children,
        { type: 'button', ...props, onClick: handleClick },
        ref,
      );
    },
  );
  Trigger.displayName = `${kind}.Trigger`;

  const Overlay = React.forwardRef<HTMLElement, PrimitiveProps>(
    ({ onClick, ...props }, ref) => {
      const context = useOpenContext();
      if (context && !context.open) return null;
      return React.createElement(
        'div',
        {
          'data-state': context?.open === false ? 'closed' : 'open',
          ...props,
          ref,
          onClick,
        },
      );
    },
  );
  Overlay.displayName = `${kind}.Overlay`;

  const Content = React.forwardRef<HTMLElement, PrimitiveProps>(
    ({ asChild, children, onKeyDown, ...props }, ref) => {
      const domProps: Record<string, unknown> = { ...props };
      const onEscapeKeyDown = domProps.onEscapeKeyDown;
      delete domProps.onEscapeKeyDown;
      delete domProps.onInteractOutside;
      delete domProps.onOpenAutoFocus;
      delete domProps.onCloseAutoFocus;
      const context = useOpenContext();
      const hasOpenedRef = React.useRef(context?.open ?? false);
      if (context?.open) {
        hasOpenedRef.current = true;
      }
      if (context && !context.open && !hasOpenedRef.current) return null;
      const isClosed = context?.open === false;
      const handleKeyDown: React.KeyboardEventHandler<HTMLElement> = (event) => {
        onKeyDown?.(event);
        if (event.key === 'Escape' && typeof onEscapeKeyDown === 'function') {
          onEscapeKeyDown(event.nativeEvent);
        }
        if (!event.defaultPrevented && event.key === 'Escape') {
          event.preventDefault();
          context?.setOpen(false);
        }
      };
      return renderPrimitiveElement('div', asChild, children, {
        role: kind === 'AlertDialog' ? 'alertdialog' : 'dialog',
        'aria-modal': true,
        'aria-labelledby': context?.titleId,
        'aria-describedby': context?.descriptionId,
        'data-state': context?.open === false ? 'closed' : 'open',
        ...domProps,
        hidden: isClosed || domProps.hidden,
        'aria-hidden': isClosed ? true : domProps['aria-hidden'],
        onKeyDown: handleKeyDown,
      }, ref);
    },
  );
  Content.displayName = `${kind}.Content`;

  function createClosingButton(displayName: string) {
    const Button = React.forwardRef<HTMLElement, PrimitiveProps>(
      ({ asChild, children, onClick, ...props }, ref) => {
        const context = useOpenContext();
        const handleClick: React.MouseEventHandler<HTMLElement> = (event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            const activeElement = typeof document === 'undefined' ? null : document.activeElement;
            if (activeElement instanceof HTMLElement && activeElement !== document.body) {
              activeElement.blur();
            }
            context?.setOpen(false);
          }
        };
        return renderPrimitiveElement(
          'button',
          asChild,
          children,
          { type: 'button', ...props, onClick: handleClick },
          ref,
        );
      },
    );
    Button.displayName = displayName;
    return Button;
  }

  const Title = React.forwardRef<HTMLElement, PrimitiveProps>(
    ({ asChild, children, id, ...props }, ref) => {
      const context = useOpenContext();
      return renderPrimitiveElement(
        'h2',
        asChild,
        children,
        { id: id ?? context?.titleId, ...props },
        ref,
      );
    },
  );
  Title.displayName = `${kind}.Title`;

  const Description = React.forwardRef<HTMLElement, PrimitiveProps>(
    ({ asChild, children, id, ...props }, ref) => {
      const context = useOpenContext();
      return renderPrimitiveElement(
        'p',
        asChild,
        children,
        { id: id ?? context?.descriptionId, ...props },
        ref,
      );
    },
  );
  Description.displayName = `${kind}.Description`;

  return {
    Root,
    Trigger,
    Portal,
    Overlay,
    Content,
    Title,
    Description,
    Action: createClosingButton(`${kind}.Action`),
    Cancel: createClosingButton(`${kind}.Cancel`),
    Close: createClosingButton(`${kind}.Close`),
  };
}

vi.mock('@radix-ui/react-alert-dialog', () => createDialogPrimitiveMock('AlertDialog'));
vi.mock('@radix-ui/react-dialog', () => createDialogPrimitiveMock('Dialog'));

vi.mock('@radix-ui/react-slider', () => {
  const SliderContext = React.createContext<{ disabled?: boolean; value?: number[] }>({});

  const Root = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & {
      disabled?: boolean;
      value?: number[];
      defaultValue?: number[];
      onValueChange?: (value: number[]) => void;
    }
  >(({ children, disabled, value, defaultValue, onValueChange, onKeyDown, ...props }, ref) => {
    const currentValue = value ?? defaultValue;
    const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
      onKeyDown?.(event);
      if (disabled || !onValueChange || !currentValue?.length) return;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        onValueChange([currentValue[0] + 1]);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        onValueChange([currentValue[0] - 1]);
      }
    };
    return React.createElement(
      SliderContext.Provider,
      { value: { disabled, value: currentValue } },
      React.createElement(
        'div',
        {
          ...props,
          ref,
          'data-disabled': disabled ? '' : undefined,
          onKeyDown: handleKeyDown,
        },
        children,
      ),
    );
  });
  Root.displayName = 'Slider.Root';

  const Track = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => {
      const { disabled } = React.useContext(SliderContext);
      return React.createElement('div', {
        ...props,
        ref,
        'data-disabled': disabled ? '' : undefined,
      }, children);
    },
  );
  Track.displayName = 'Slider.Track';

  const Range = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    (props, ref) => React.createElement('div', { ...props, ref }),
  );
  Range.displayName = 'Slider.Range';

  const Thumb = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
    (props, ref) => {
      const { disabled, value } = React.useContext(SliderContext);
      return React.createElement(
        'span',
        {
          role: 'slider',
          'aria-valuenow': value?.[0],
          'aria-disabled': disabled || undefined,
          tabIndex: disabled ? -1 : 0,
          ...props,
          ref,
          'data-disabled': disabled ? '' : undefined,
        },
      );
    },
  );
  Thumb.displayName = 'Slider.Thumb';

  return { Root, Track, Range, Thumb };
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
const { act, cleanup } = await import('@testing-library/react');
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

afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
    cleanup();
    await Promise.resolve();
  });
});

vi.mock('./api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/client')>();
  return {
    ...actual,
    getCapabilities: vi.fn(async () => ({
      agent_conversation: { enabled: true },
      you_vs_oracle: { enabled: true },
      causal_graph: { enabled: true },
      kg_explorer: { enabled: true },
      custom_agents: { enabled: true },
      persona_export: { enabled: true },
      model_profiles: { enabled: true },
      counterfactual_replay: { enabled: true },
      argument_map: { enabled: true },
      agent_identity: { enabled: true },
      multi_run: { enabled: true },
      education_templates: { enabled: true },
    })),
  };
});
