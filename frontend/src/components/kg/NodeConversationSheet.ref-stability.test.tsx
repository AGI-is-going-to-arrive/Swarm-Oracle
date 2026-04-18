import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refStats = vi.hoisted(() => ({
  attachCount: 0,
  reset() {
    this.attachCount = 0;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      key: string,
      options?: Record<string, string | number | undefined>,
    ) => String(options?.defaultValue ?? key),
  }),
}));

vi.mock('../../hooks/useStreamingAriaLive', () => ({
  useStreamingAriaLive: () => ({
    announceRef: { current: null },
    appendToken: vi.fn(),
    complete: vi.fn(),
    reset: vi.fn(),
    flushNow: vi.fn(),
  }),
}));

vi.mock('./StreamingBubbleIsolated', async () => {
  const React = await import('react');
  return {
    StreamingBubbleIsolated: ({
      onRef,
    }: {
      onRef: (api: {
        appendToken: (delta: string) => void;
        finalize: (fullText: string) => void;
        reset: () => void;
      } | null) => void;
    }) => {
      React.useEffect(() => {
        refStats.attachCount += 1;
        onRef({
          appendToken: () => {},
          finalize: () => {},
          reset: () => {},
        });
        return () => onRef(null);
      }, [onRef]);

      return <div data-testid="mock-streaming-bubble" />;
    },
  };
});

import { NodeConversationSheet } from './NodeConversationSheet';

describe('NodeConversationSheet — ref stability', () => {
  beforeEach(() => {
    refStats.reset();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
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
    window.sessionStorage.clear();
  });

  it('does not re-register the streaming bubble when local input rerenders', () => {
    const { getByTestId } = render(
      <NodeConversationSheet
        open
        onOpenChange={() => {}}
        threadId="thread-1"
        scenarioId="scen-1"
        identityId="id-1"
      />,
    );

    expect(refStats.attachCount).toBe(1);

    const input = getByTestId('node-conversation-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    expect(refStats.attachCount).toBe(1);

    fireEvent.change(input, { target: { value: 'hello again' } });
    expect(refStats.attachCount).toBe(1);
  });
});
