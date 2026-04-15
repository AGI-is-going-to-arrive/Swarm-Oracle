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

  it('closes on a global Escape press in modeless mode and restores focus to the trigger', async () => {
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

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Modeless node' })).not.toBeInTheDocument();
      expect(openButton).toHaveFocus();
    });
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
