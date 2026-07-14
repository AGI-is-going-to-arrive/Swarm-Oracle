/**
 * P1-4 — NodeDetailPanel unit tests
 */
import * as React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockT = vi.fn((key: string, fallback?: string) => fallback ?? key);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (...args: unknown[]) => mockT(...(args as [string, string?])),
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

import { NodeDetailPanel, type NodeDetail } from './NodeDetailPanel';
import { copyText } from '../lib/copyText';

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const originalExecCommand = document.execCommand;

afterEach(() => {
  cleanup();
  mockT.mockClear();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
  }
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: originalExecCommand,
  });
});

describe('NodeDetailPanel', () => {
  it('returns null when node is null', () => {
    const { container } = render(<NodeDetailPanel node={null} onClose={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders node label and type badge', () => {
    const node: NodeDetail = {
      id: 'n1',
      label: 'Trade shock announced',
      type: 'event',
      round: 1,
      payload: null,
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByText('Trade shock announced')).toBeInTheDocument();
    // i18n mock returns fallback (raw type string)
    expect(screen.getByText('event')).toBeInTheDocument();
    expect(screen.getByText(/Round.*1/)).toBeInTheDocument();
  });

  it('renders argument unit details when provided', () => {
    const node: NodeDetail = {
      id: 'u1',
      label: 'Economy will grow',
      type: 'claim',
      unitText: 'The economy will grow due to fiscal stimulus and consumer spending recovery.',
      unitStatus: 'standing',
      unitTurnId: 'turn-3',
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    // i18n mock returns fallback (raw type string)
    expect(screen.getByText('claim')).toBeInTheDocument();
    expect(screen.getByText('standing')).toBeInTheDocument();
    expect(screen.getByText(/fiscal stimulus/)).toBeInTheDocument();
    expect(screen.getByText(/Turn.*turn-3/)).toBeInTheDocument();
  });

  it('uses dark text on bright type badges for readability', () => {
    const node: NodeDetail = {
      id: 'n-bright',
      label: 'Verdict',
      type: 'verdict',
      payload: null,
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByText('verdict')).toHaveStyle({ color: '#111' });
  });

  it('renders payload as JSON when present', () => {
    const node: NodeDetail = {
      id: 'n2',
      label: 'Policy change',
      type: 'intervention',
      payload: { action: 'rate_cut', magnitude: 0.25 },
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    // i18n mock returns 'Payload' fallback
    expect(screen.getByText('Payload')).toBeInTheDocument();
    expect(screen.getByText(/rate_cut/)).toBeInTheDocument();
  });

  it('renders outcome payload as readable story and insight fields', () => {
    const node: NodeDetail = {
      id: 'outcome-br1',
      label: '星落未尽',
      type: 'outcome',
      payload: {
        branch_id: 'br1',
        story_excerpt: '夜潮压着粮道，守军仍在关口撑住。',
        insight: '补给被稳住后，北线没有立刻崩盘。',
        probability: 0.42,
        status: 'completed',
      },
    };

    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);

    expect(screen.getByText('Outcome Story')).toBeInTheDocument();
    expect(screen.getByText(/夜潮压着粮道/)).toBeInTheDocument();
    expect(screen.getByText('Insight')).toBeInTheDocument();
    expect(screen.getByText(/北线没有立刻崩盘/)).toBeInTheDocument();
    expect(screen.getByText(/Probability/)).toBeInTheDocument();
  });

  it('renders event provenance as distinct semantic fields instead of relying on raw JSON', () => {
    const node: NodeDetail = {
      id: 'event-1',
      label: 'Policy response',
      type: 'event',
      payload: {
        agent_name: 'Ada Lovelace',
        agent_id: 'agent-ada',
        branch_id: 'branch-main',
        message_id: 'message-42',
        emotion: 'determined',
        emotion_metadata_status: 'available',
        synthetic_provenance: true,
        content: 'We should respond now.',
      },
    };

    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);

    expect(screen.getByText('Agent Name')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Agent ID')).toBeInTheDocument();
    expect(screen.getByText('agent-ada')).toBeInTheDocument();
    expect(screen.getByText('Branch')).toBeInTheDocument();
    expect(screen.getByText('branch-main')).toBeInTheDocument();
    expect(screen.getByText('Message ID')).toBeInTheDocument();
    expect(screen.getByText('message-42')).toBeInTheDocument();
    expect(screen.getByTestId('emotion-metadata-status')).toHaveTextContent('Available');
    expect(screen.getByTestId('emotion-metadata-failure')).toHaveTextContent('Unavailable');
    expect(screen.getByText('Synthetic provenance')).toBeInTheDocument();
    expect(screen.getByTestId('synthetic-provenance')).toHaveTextContent('Yes');
    expect(screen.queryByText(/"message_id"/)).not.toBeInTheDocument();
  });

  it.each([
    {
      name: 'runtime projection',
      node: {
        id: 'outcome-runtime',
        label: 'Projected outcome',
        type: 'outcome',
        payload: {
          provenance_kind: 'runtime_projection',
          synthetic_provenance: true,
          evidence_status: 'unavailable',
          evidence_caveat: 'server English must not be rendered directly',
        },
      } satisfies NodeDetail,
      expected: 'This outcome is a runtime projection from the simulated branch. It has no persisted causal evidence and is not a real-world probability.',
    },
    {
      name: 'legacy repair',
      node: {
        id: 'legacy-event:message-1',
        label: 'Recovered event',
        type: 'event',
        payload: {
          message_id: 'message-1',
          synthetic_provenance: true,
          content: 'Recovered from an older snapshot.',
        },
      } satisfies NodeDetail,
      expected: 'This event was reconstructed at read time to repair legacy graph provenance. It is not persisted causal truth.',
    },
    {
      name: 'affect proxy',
      node: {
        id: 'affect-shift-1',
        label: 'Affect shifted',
        type: 'stance_shift',
        payload: {
          display_type: 'affect_shift_proxy',
          metric_kind: 'affect_proxy',
        },
      } satisfies NodeDetail,
      expected: 'This relation is derived from model-generated emotion or divergence fields. It is not verified stance, relationship, or causal evidence.',
    },
  ])('shows an explicit localized caveat for $name nodes', ({ node, expected }) => {
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);

    expect(screen.getByRole('note')).toHaveTextContent(expected);
    expect(screen.queryByText(/server English/)).not.toBeInTheDocument();
  });

  it('marks missing or failed emotion metadata unavailable without fabricating neutral emotion', () => {
    const unavailableNode: NodeDetail = {
      id: 'event-unavailable',
      label: 'Metadata gap',
      type: 'event',
      payload: {
        agent_name: 'Grace Hopper',
        agent_id: 'agent-grace',
        content: 'The real speech remains visible.',
        emotion: 'neutral',
        emotion_metadata_status: 'unavailable',
        emotion_metadata_failure_code: 'LLM_TIMEOUT',
      },
    };

    const { rerender } = render(<NodeDetailPanel node={unavailableNode} onClose={vi.fn()} />);

    expect(screen.getByTestId('emotion-metadata-status')).toHaveTextContent('Unavailable');
    expect(screen.getByText('Emotion metadata failure')).toBeInTheDocument();
    expect(screen.getByTestId('emotion-metadata-failure')).toHaveTextContent('LLM_TIMEOUT');
    expect(screen.queryByText(/neutral/i)).not.toBeInTheDocument();

    rerender(
      <NodeDetailPanel
        node={{
          ...unavailableNode,
          id: 'event-missing-metadata',
          payload: {
            agent_name: 'Grace Hopper',
            emotion: 'confident',
            content: 'No emotion metadata status was emitted.',
          },
        }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('emotion-metadata-status')).toHaveTextContent('Unavailable');
    expect(screen.getByText(/confident/)).toBeInTheDocument();
    expect(screen.queryByText(/neutral/i)).not.toBeInTheDocument();
  });

  it('bounds event identifiers and content while rendering markup-like values as text', () => {
    const longAgentId = `agent-${'x'.repeat(180)}`;
    const longContent = `content-${'y'.repeat(700)}`;
    const node: NodeDetail = {
      id: 'event-bounded',
      label: 'Bounded event',
      type: 'event',
      payload: {
        agent_name: '<img src=x onerror=alert(1)>',
        agent_id: longAgentId,
        content: longContent,
      },
    };

    const { container } = render(<NodeDetailPanel node={node} onClose={vi.fn()} />);

    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    const boundedAgentId = screen.getByTestId('event-agent-id');
    const boundedContent = screen.getByTestId('event-content');
    expect(boundedAgentId).toHaveTextContent(/…$/);
    expect(boundedContent).toHaveTextContent(/…$/);
    expect(Array.from(boundedAgentId.textContent ?? '')).toHaveLength(121);
    expect(Array.from(boundedContent.textContent ?? '')).toHaveLength(501);
    expect(screen.queryByText(longAgentId)).not.toBeInTheDocument();
    expect(screen.queryByText(longContent)).not.toBeInTheDocument();
  });

  it('renders fork payload with display reason instead of raw template text first', () => {
    const node: NodeDetail = {
      id: 'fork-1',
      label: '路线分岔：先稳后攻；另一条继续强攻。',
      type: 'fork',
      payload: {
        display_reason: '路线分岔：先稳后攻；另一条继续强攻。',
        display_summary: '这会改写后勤、继任与前线责任链。',
        reason: '讨论已明确分成“先稳后攻”和“继续强攻”两套互相排斥的军事路线，并会改写后勤、继任与前线责任链，因此应 fork。',
        source_branch_id: 'br1',
      },
    };

    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);

    expect(screen.getByText('Fork Reason')).toBeInTheDocument();
    expect(screen.getAllByText(/另一条继续强攻/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Impact/)).toBeInTheDocument();
    expect(screen.getByText(/改写后勤/)).toBeInTheDocument();
    expect(screen.queryByText(/讨论已明确分成/)).not.toBeInTheDocument();
    expect(screen.getByText(/Source Branch/)).toBeInTheDocument();
  });

  it('does not render payload section when payload is null', () => {
    const node: NodeDetail = {
      id: 'n1',
      label: 'Test',
      type: 'event',
      payload: null,
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.queryByText('Payload')).not.toBeInTheDocument();
  });

  it('does not render round when not provided', () => {
    const node: NodeDetail = {
      id: 'n1',
      label: 'Test',
      type: 'claim',
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.queryByText(/Round/)).not.toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const node: NodeDetail = { id: 'n1', label: 'Test', type: 'event' };
    render(<NodeDetailPanel node={node} onClose={onClose} />);
    await user.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('renders an accessible dialog and moves focus to the close button', async () => {
    const node: NodeDetail = { id: 'n1', label: 'Focused node', type: 'event' };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Focused node' });
    const closeButton = screen.getByRole('button', { name: 'Close' });

    expect(dialog).toBeInTheDocument();
    expect(closeButton).toHaveFocus();
  });

  it('calls onClose when Escape is pressed inside the dialog', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const node: NodeDetail = { id: 'n1', label: 'Escapable node', type: 'event' };
    render(<NodeDetailPanel node={node} onClose={onClose} />);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not hijack Escape when focus has already moved outside the modeless dialog', async () => {
    const user = userEvent.setup();
    const node: NodeDetail = { id: 'n1', label: 'Modeless node', type: 'event' };

    function Harness() {
      const [selectedNode, setSelectedNode] = React.useState<NodeDetail | null>(null);

      return (
        <div>
          <button type="button" onClick={() => setSelectedNode(node)}>
            Open panel
          </button>
          <button type="button">Outside action</button>
          <NodeDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />
        </div>
      );
    }

    render(<Harness />);

    const openButton = screen.getByRole('button', { name: 'Open panel' });
    const outsideButton = screen.getByRole('button', { name: 'Outside action' });

    await user.click(openButton);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    await user.click(outsideButton);
    expect(outsideButton).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.getByRole('dialog', { name: 'Modeless node' })).toBeInTheDocument();
    expect(outsideButton).toHaveFocus();
    expect(openButton).not.toHaveFocus();
  });

  it('restores focus to the latest trigger when switching from node A to node B before close', async () => {
    const user = userEvent.setup();
    const nodeA: NodeDetail = { id: 'a', label: 'Node A', type: 'event' };
    const nodeB: NodeDetail = { id: 'b', label: 'Node B', type: 'claim' };

    function Harness() {
      const [selectedNode, setSelectedNode] = React.useState<NodeDetail | null>(null);

      return (
        <div>
          <button type="button" onClick={() => setSelectedNode(nodeA)}>
            Open A
          </button>
          <button type="button" onClick={() => setSelectedNode(nodeB)}>
            Open B
          </button>
          <NodeDetailPanel node={selectedNode} onClose={() => setSelectedNode(null)} />
        </div>
      );
    }

    render(<Harness />);

    const openAButton = screen.getByRole('button', { name: 'Open A' });
    const openBButton = screen.getByRole('button', { name: 'Open B' });

    await user.click(openAButton);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();

    await user.click(openBButton);

    const closeButton = screen.getByRole('button', { name: 'Close' });
    expect(closeButton).toHaveFocus();

    await user.click(closeButton);

    expect(openBButton).toHaveFocus();
    expect(openAButton).not.toHaveFocus();
  });

  it('falls back when clipboard write is rejected', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValueOnce(new Error('clipboard denied'));
    const execCommand = vi.fn().mockReturnValue(true);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(<NodeDetailPanel node={{ id: 'copy-me', label: 'Copy node', type: 'event' }} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Copy Reference' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith('copy-me');
      expect(execCommand).toHaveBeenCalledTimes(1);
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(document.querySelectorAll('textarea')).toHaveLength(0);
    });
  });

  it('shows an explicit error when Copy Reference fails', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValueOnce(new Error('clipboard denied'));
    const execCommand = vi.fn().mockReturnValue(false);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    render(<NodeDetailPanel node={{ id: 'copy-me', label: 'Copy node', type: 'event' }} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Copy Reference' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to copy reference');
    });
  });

  it('clears stale copy errors when reopening the same node', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    const execCommand = vi.fn().mockReturnValue(false);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    const node: NodeDetail = { id: 'copy-me', label: 'Copy node', type: 'event' };

    function Harness() {
      const [selectedNode, setSelectedNode] = React.useState<NodeDetail | null>(node);
      return (
        <div>
          <button type="button" onClick={() => setSelectedNode(node)}>
            Reopen
          </button>
          <button type="button" onClick={() => setSelectedNode(null)}>
            Close panel
          </button>
          <NodeDetailPanel
            key={selectedNode?.id ?? 'closed'}
            node={selectedNode}
            onClose={() => setSelectedNode(null)}
          />
        </div>
      );
    }

    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Copy Reference' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Failed to copy reference');
    });

    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('turn label uses i18n key node_detail.turn (not hardcoded)', () => {
    const node: NodeDetail = {
      id: 'u1',
      label: 'Test',
      type: 'claim',
      unitTurnId: 'T-42',
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    // Verify t() was called with the i18n key for Turn
    expect(mockT).toHaveBeenCalledWith('node_detail.turn', 'Turn');
  });

  it('has node-detail-panel test id', () => {
    const node: NodeDetail = { id: 'n1', label: 'Test', type: 'event' };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();
  });
});

describe('NodeDetailPanel evidence rendering', () => {
  it('does not render evidence section when evidence is null and evidenceList is empty', () => {
    const node: NodeDetail = {
      id: 'ev-null',
      label: 'No Evidence',
      type: 'event',
      evidence: null,
      evidenceList: [],
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.queryByText('Evidence')).not.toBeInTheDocument();
  });

  it('does not render evidence section when all evidence fields are null', () => {
    const node: NodeDetail = {
      id: 'ev-empty',
      label: 'Empty Evidence',
      type: 'event',
      evidence: { confidence_tier: null, source_ref: null, source_round_number: null, detail: null },
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.queryByText('Evidence')).not.toBeInTheDocument();
  });

  it('renders evidence section when evidence has non-null fields', () => {
    const node: NodeDetail = {
      id: 'ev-has',
      label: 'Has Evidence',
      type: 'event',
      evidence: { confidence_tier: 'high', source_ref: 'agent-42', source_round_number: 3, detail: null },
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByText('Evidence')).toBeInTheDocument();
    expect(screen.getByText('agent-42')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders correct number of evidence items from evidenceList with mixed null entries', () => {
    const node: NodeDetail = {
      id: 'ev-list',
      label: 'Evidence List',
      type: 'event',
      evidenceList: [
        { confidence_tier: 'high', source_ref: null, source_round_number: null, detail: null },
        { confidence_tier: null, source_ref: null, source_round_number: null, detail: null },
        { confidence_tier: null, source_ref: 'ref-2', source_round_number: null, detail: null },
      ],
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByText('Evidence')).toBeInTheDocument();
    expect(screen.getByText('ref-2')).toBeInTheDocument();
  });

  it('renders relation and direction context for edge evidence', () => {
    const node: NodeDetail = {
      id: 'ev-context',
      label: 'Contextual evidence',
      type: 'event',
      evidence: {
        confidence_tier: 'medium',
        source_ref: 'message-7',
        source_round_number: 4,
        detail: 'A direct response.',
        relation: 'responds to',
        direction: 'incoming',
      },
    };

    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);

    expect(screen.getByText('Relation')).toBeInTheDocument();
    expect(screen.getByText('responds to')).toBeInTheDocument();
    expect(screen.getByText('Direction')).toBeInTheDocument();
    expect(screen.getByText('Incoming')).toBeInTheDocument();
  });

  it('truncates string detail to 200 characters with ellipsis', () => {
    const longDetail = 'A'.repeat(250);
    const node: NodeDetail = {
      id: 'ev-long',
      label: 'Long Detail',
      type: 'event',
      evidence: { confidence_tier: null, source_ref: null, source_round_number: null, detail: longDetail },
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByText('Evidence')).toBeInTheDocument();
    const detailText = screen.getByText(/A{10,}/);
    expect(detailText.textContent).toContain('…');
    expect(detailText.textContent!.length).toBeLessThan(longDetail.length + 20);
  });

  it('JSON.stringifies object detail and truncates to 200 chars', () => {
    const objDetail: Record<string, string> = {};
    for (let i = 0; i < 30; i++) objDetail[`key_${i}`] = `value_${i}_padding`;
    const node: NodeDetail = {
      id: 'ev-obj',
      label: 'Object Detail',
      type: 'event',
      evidence: { confidence_tier: null, source_ref: null, source_round_number: null, detail: objDetail },
    };
    render(<NodeDetailPanel node={node} onClose={vi.fn()} />);
    expect(screen.getByText('Evidence')).toBeInTheDocument();
    const detailEl = screen.getByText(/key_0/);
    expect(detailEl.textContent).toContain('…');
  });
});

describe('copyText', () => {
  it('rejects when clipboard write and execCommand fallback both fail', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('clipboard denied'));
    const execCommand = vi.fn().mockReturnValue(false);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });

    await expect(copyText('copy-me')).rejects.toThrow('Failed to copy text');

    expect(writeText).toHaveBeenCalledWith('copy-me');
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });
});
