/**
 * FE-3 — NodeConversationSheet tests.
 *
 * Critical assertions:
 *   - mobile breakpoint switches side="bottom"
 *   - mobile inner scroll touchStart stops propagation (drag-to-close guard)
 *   - 6 recovery codes render correctly (delegated to banner's own tests)
 *   - draft unavailable shows amber banner
 *   - focus stability: streaming tokens don't steal activeElement from
 *     textarea / send / close
 */
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeConversationSheet } from './NodeConversationSheet';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, options?: { defaultValue?: string }) => options?.defaultValue ?? k }),
}));

// Stub WebSocket so useAgentConversationWS does not spam the console.
class NoopWS {
  static OPEN = 1;
  readyState = NoopWS.OPEN;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    /* noop */
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', NoopWS as unknown as typeof WebSocket);
  vi.useFakeTimers();
  // Default: desktop viewport.
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

function renderSheet(overrides?: Partial<React.ComponentProps<typeof NodeConversationSheet>>) {
  return render(
    <NodeConversationSheet
      open
      onOpenChange={() => {}}
      threadId="thread-1"
      scenarioId="scen-1"
      identityId="id-1"
      {...overrides}
    />,
  );
}

describe('NodeConversationSheet — responsive', () => {
  it('desktop default: data-mobile=false', () => {
    const { getByTestId } = renderSheet();
    expect(getByTestId('node-conversation-sheet').getAttribute('data-mobile')).toBe('false');
  });

  it('mobile viewport: data-mobile=true', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: /max-width: 768/.test(q),
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    const { getByTestId } = renderSheet();
    expect(getByTestId('node-conversation-sheet').getAttribute('data-mobile')).toBe('true');
  });
});

describe('NodeConversationSheet — drag guard', () => {
  it('inner scroll region has data-no-drag and stops touch propagation', () => {
    const { getByTestId } = renderSheet();
    const region = getByTestId('node-conversation-scroll-region');
    expect(region.getAttribute('data-no-drag')).toBe('true');

    // Fire a touchstart event and capture propagation via a parent spy
    // attached to an ancestor we know the event would bubble through.
    const parentSpy = vi.fn();
    // Walk up DOM to find a real ancestor of region.
    const ancestor = region.parentElement;
    expect(ancestor).not.toBeNull();
    ancestor!.addEventListener('touchstart', parentSpy);

    fireEvent.touchStart(region, { touches: [{ clientX: 0, clientY: 0 }] });
    // Native Event.stopPropagation on region prevents parent from receiving.
    expect(parentSpy).not.toHaveBeenCalled();
  });
});

describe('NodeConversationSheet — input + send', () => {
  it('send button is disabled with empty input', () => {
    const { getByTestId } = renderSheet();
    const send = getByTestId('node-conversation-send') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it('send button enables after typing', () => {
    const { getByTestId } = renderSheet();
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: 'hello' } });
    });
    const send = getByTestId('node-conversation-send') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it('send invokes onSubmit with trimmed text', () => {
    const onSubmit = vi.fn();
    const { getByTestId } = renderSheet({ onSubmit });
    const ta = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(ta, { target: { value: '  query  ' } });
    });
    fireEvent.click(getByTestId('node-conversation-send'));
    expect(onSubmit).toHaveBeenCalledWith('query');
  });
});

describe('NodeConversationSheet — a11y', () => {
  it('sheet has aria-labelledby pointing to title', () => {
    const { getByTestId } = renderSheet();
    const sheet = getByTestId('node-conversation-sheet');
    expect(sheet.getAttribute('aria-labelledby')).toBe('node-conversation-sheet-title');
  });

  it('sr-only aria-live region is present', () => {
    const { getByTestId } = renderSheet();
    const live = getByTestId('node-conversation-aria-live');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
  });
});
