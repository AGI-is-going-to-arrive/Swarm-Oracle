/**
 * ResultConversationWidget tests.
 *
 * Asserts:
 *   - Renders CTA when agent_conversation capability enabled
 *   - Does NOT render when capability disabled
 *   - Opens NodeConversationSheet on click
 *   - Passes correct props (scenarioId, identityId, showResultDeepenHint)
 *   - Does NOT interfere with existing ResultActionCard
 */
import { fireEvent, render, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      k: string,
      options?: Record<string, string | number | undefined>,
    ) => options?.defaultValue ?? k,
  }),
}));

// Track capability mock return values.
const capabilityMock = vi.hoisted(() => ({
  fn: vi.fn().mockReturnValue({ enabled: true, loading: false }),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: capabilityMock.fn,
  __resetCapabilityCacheForTests: vi.fn(),
}));

// Mock NodeConversationSheet to inspect props without rendering the full Sheet.
const sheetPropsSpy = vi.hoisted(() => ({
  lastProps: null as Record<string, unknown> | null,
}));

vi.mock('./kg/NodeConversationSheet', () => ({
  NodeConversationSheet: (props: Record<string, unknown>) => {
    sheetPropsSpy.lastProps = props;
    if (!props.open) return null;
    return <div data-testid="mock-node-conversation-sheet" />;
  },
}));

// Stub WebSocket globally to avoid console noise.
class NoopWS {
  static OPEN = 1;
  readyState = NoopWS.OPEN;
  send = vi.fn();
  close = vi.fn();
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', NoopWS as unknown as typeof WebSocket);
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
  sheetPropsSpy.lastProps = null;
  capabilityMock.fn.mockReturnValue({ enabled: true, loading: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Lazy import so mocks are applied first.
const loadWidget = async () => {
  const mod = await import('./ResultConversationWidget');
  return mod.ResultConversationWidget;
};

describe('ResultConversationWidget — visibility', () => {
  it('renders CTA button when agent_conversation capability is enabled', async () => {
    const Widget = await loadWidget();
    const { getByTestId } = render(
      <Widget scenarioId="scen-1" />,
    );
    expect(getByTestId('result-conversation-cta')).toBeInTheDocument();
  });

  it('does NOT render when capability is disabled', async () => {
    capabilityMock.fn.mockReturnValue({ enabled: false, loading: false });
    const Widget = await loadWidget();
    const { queryByTestId } = render(
      <Widget scenarioId="scen-1" />,
    );
    expect(queryByTestId('result-conversation-cta')).toBeNull();
  });

  it('does NOT render while capability is loading', async () => {
    capabilityMock.fn.mockReturnValue({ enabled: false, loading: true });
    const Widget = await loadWidget();
    const { queryByTestId } = render(
      <Widget scenarioId="scen-1" />,
    );
    expect(queryByTestId('result-conversation-cta')).toBeNull();
  });

  it('calls useCapabilityCheck with agent_conversation key', async () => {
    const Widget = await loadWidget();
    render(<Widget scenarioId="scen-1" />);
    expect(capabilityMock.fn).toHaveBeenCalledWith('agent_conversation');
  });
});

describe('ResultConversationWidget — Sheet interaction', () => {
  it('opens Sheet on CTA click', async () => {
    const Widget = await loadWidget();
    const { getByTestId, queryByTestId } = render(
      <Widget scenarioId="scen-1" primaryAgentIdentityId="agent-42" />,
    );

    // Sheet is initially closed.
    expect(queryByTestId('mock-node-conversation-sheet')).toBeNull();

    act(() => {
      fireEvent.click(getByTestId('result-conversation-cta'));
    });

    expect(getByTestId('mock-node-conversation-sheet')).toBeInTheDocument();
  });

  it('passes correct props to NodeConversationSheet', async () => {
    const Widget = await loadWidget();
    render(
      <Widget scenarioId="scen-42" primaryAgentIdentityId="agent-7" />,
    );

    // Props are always forwarded even when sheet is closed.
    expect(sheetPropsSpy.lastProps).not.toBeNull();
    expect(sheetPropsSpy.lastProps!.scenarioId).toBe('scen-42');
    expect(sheetPropsSpy.lastProps!.identityId).toBe('agent-7');
    expect(sheetPropsSpy.lastProps!.showResultDeepenHint).toBe(true);
  });

  it('passes selected result branch context into the conversation origin', async () => {
    const Widget = await loadWidget();
    render(
      <Widget
        scenarioId="scen-42"
        resultContext={{
          branchId: 'branch-1',
          title: 'Archive Branch',
          insight: 'The archive held because the late challenge never landed.',
          forkReason: 'The branch split when the council chose the archive path.',
          keyMoments: ['The witness stayed silent.'],
          comparisonTitles: ['Counter Branch'],
        }}
      />,
    );

    const origin = sheetPropsSpy.lastProps!.origin as Record<string, unknown>;
    expect(origin).toMatchObject({
      surface: 'result',
      nodeId: 'result:branch-1',
      nodeType: 'outcome',
      branchId: 'branch-1',
      nodeLabel: 'Archive Branch',
      causeContext: ['The branch split when the council chose the archive path.'],
      relatedContext: ['Counter Branch'],
    });
    expect(String(origin.excerpt)).toContain('The archive held because');
    expect(String(origin.excerpt)).toContain('The witness stayed silent.');
  });

  it('passes null identityId when primaryAgentIdentityId is undefined', async () => {
    const Widget = await loadWidget();
    render(<Widget scenarioId="scen-1" />);

    expect(sheetPropsSpy.lastProps).not.toBeNull();
    expect(sheetPropsSpy.lastProps!.identityId).toBeNull();
  });
});

describe('ResultConversationWidget — coexistence with ResultActionCard', () => {
  it('does NOT interfere with sibling ResultActionCard rendering', async () => {
    const Widget = await loadWidget();
    const { getByTestId, queryByTestId } = render(
      <div>
        <button type="button" data-testid="result-action-conversation">
          Existing Action Card
        </button>
        <Widget scenarioId="scen-1" />
      </div>,
    );

    // Both the existing action card and the widget CTA coexist.
    expect(getByTestId('result-action-conversation')).toBeInTheDocument();
    expect(getByTestId('result-conversation-cta')).toBeInTheDocument();

    // Widget CTA click does not affect the action card.
    act(() => {
      fireEvent.click(getByTestId('result-conversation-cta'));
    });
    expect(queryByTestId('result-action-conversation')).toBeInTheDocument();
  });
});
