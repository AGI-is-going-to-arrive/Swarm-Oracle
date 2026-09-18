import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

// The shared setup double drops onCloseAutoFocus; verify focus with real Radix.
vi.unmock('@radix-ui/react-dialog');

const readinessFixture = vi.hoisted(() => ({ configured: true }));
vi.mock('../../hooks/useCapabilityCheck', () => ({ useCapabilityCheck: () => ({ loading: false, enabled: true, capabilities: null, error: null }) }));
vi.mock('../../api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/client')>(),
  getScenario: async () => ({ conversation_llm_configured: readinessFixture.configured }),
  getConversation: async (threadId: string) => ({ thread_id: threadId, scenario_id: 'scen-1', turns: [] }),
  getScenarioConversations: async () => ({
    items: [{ thread_id: 'history-thread', scenario_id: 'scen-1', owner_user_id: 'fixture-owner', origin_node_id: 'dense-node', origin_node_type: 'event', last_turn_sequence: 4, latest_status: 'committed', created_at: '2026-09-18T00:00:00Z', updated_at: '2026-09-18T00:00:00Z' }],
    cursor: 1,
    has_more: false,
  }),
}));

const refStats = vi.hoisted(() => ({
  attachCount: 0,
  reset() {
    this.attachCount = 0;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
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
    readinessFixture.configured = true;
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

  it('returns focus to the graph trigger after closing the real mobile dialog', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const trigger = document.createElement('button');
    trigger.textContent = 'Graph node';
    document.body.append(trigger);
    trigger.focus();
    function Harness() {
      const [open, setOpen] = useState(true);
      return <NodeConversationSheet open={open} onOpenChange={setOpen} scenarioId="scen-1" restoreFocusTarget={trigger} />;
    }
    const view = render(<Harness />);
    fireEvent.click(within(view.getByTestId('node-conversation-sheet')).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it.each([false, true])('restores the opening graph button without a caller target (mobile=%s)', async (mobile) => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: mobile && query.includes('max-width'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" data-graph-node-card="true" onClick={() => setOpen(true)}>Open graph node</button>
        {open ? <NodeConversationSheet open onOpenChange={setOpen} scenarioId="scen-1" /> : null}
      </>;
    }
    const view = render(<Harness />);
    const trigger = view.getByRole('button', { name: 'Open graph node' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(within(view.getByTestId('node-conversation-sheet')).getByRole('button', { name: /close/i }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('keeps long context and expanded history in the scroll body at the default mobile snap', async () => {
    readinessFixture.configured = false;
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    window.sessionStorage.setItem('swarmoracle_draft:public:default_user:scen-1:dense-node:branch-1:1', 'Saved question draft');
    const view = render(<NodeConversationSheet open onOpenChange={() => {}} scenarioId="scen-1" origin={{
      nodeId: 'dense-node', nodeType: 'event', branchId: 'branch-1', roundNumber: 1,
      agentName: 'Audit officer', nodeLabel: 'Audit hearing',
      meaningTitle: 'Event card', meaningDescription: 'A detailed explanation of the event. '.repeat(20),
      effectContext: ['The court schedules a hearing. '.repeat(20)],
    }} />);
    const sheet = view.getByTestId('node-conversation-sheet');
    const scroll = view.getByTestId('node-conversation-scroll-region');
    expect(sheet).toHaveAttribute('data-snap', '70');
    expect(scroll).toContainElement(view.getByTestId('node-context-banner'));
    expect(scroll).toContainElement(await view.findByTestId('conversation-draft-restored'));
    await waitFor(() => expect(scroll).toContainElement(view.getByTestId('conversation-model-readiness')));
    expect(scroll).not.toContainElement(view.getByTestId('node-conversation-input'));
    expect(view.getByTestId('node-conversation-input')).toHaveValue('Saved question draft');
    fireEvent.click(view.getByTestId('conversation-history-picker-toggle'));
    const historyRow = await view.findByTestId('conversation-history-picker-row-history-thread');
    expect(scroll).toContainElement(historyRow);
    fireEvent.click(historyRow);
    await waitFor(() => expect(view.getByTestId('node-conversation-meta')).toHaveTextContent('thread=history-thread'));
  });
});
