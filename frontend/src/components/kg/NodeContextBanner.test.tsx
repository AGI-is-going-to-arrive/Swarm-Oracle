import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { NodeContextBanner } from './NodeContextBanner';
import type { NodeConversationOrigin } from './NodeConversationSheet';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, string | number | undefined>) => {
      const template = String(opts?.defaultValue ?? k);
      return template.replace(/\{\{(\w+)\}\}/g, (_m: string, token: string) =>
        opts?.[token] !== undefined ? String(opts[token]) : `{{${token}}}`,
      );
    },
  }),
}));

function fullOrigin(overrides?: Partial<NodeConversationOrigin>): NodeConversationOrigin {
  return {
    nodeId: 'n1',
    nodeType: 'event',
    agentName: 'Agent Alpha',
    nodeLabel: 'Test Label',
    excerpt: 'This is a short excerpt about the node.',
    roundNumber: 3,
    branchId: 'b1',
    ...overrides,
  };
}

describe('NodeContextBanner', () => {
  it('renders type, agent, round, and excerpt for a full origin', () => {
    const { getByTestId } = render(<NodeContextBanner origin={fullOrigin()} />);
    expect(getByTestId('node-context-banner')).toBeTruthy();
    expect(getByTestId('node-context-banner-type').textContent).toBe('Event');
    expect(getByTestId('node-context-banner-agent').textContent).toBe('Agent Alpha');
    expect(getByTestId('node-context-banner-round').textContent).toBe('R3');
    expect(getByTestId('node-context-banner-excerpt').textContent).toContain('short excerpt');
  });

  it('returns null when origin has no meaningful display content', () => {
    const { container } = render(
      <NodeContextBanner origin={{ nodeId: 'n1', nodeType: 'event' }} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders partial content gracefully (only roundNumber)', () => {
    const { getByTestId, queryByTestId } = render(
      <NodeContextBanner origin={{ nodeId: 'n1', nodeType: 'fork', roundNumber: 5 }} />,
    );
    expect(getByTestId('node-context-banner-round').textContent).toBe('R5');
    expect(queryByTestId('node-context-banner-agent')).toBeNull();
    expect(queryByTestId('node-context-banner-excerpt')).toBeNull();
  });

  it('renders nodeLabel when agentName is absent', () => {
    const { getByTestId, queryByTestId } = render(
      <NodeContextBanner origin={{ nodeId: 'n1', nodeType: 'claim', nodeLabel: 'My Claim' }} />,
    );
    expect(getByTestId('node-context-banner-label').textContent).toBe('My Claim');
    expect(queryByTestId('node-context-banner-agent')).toBeNull();
  });

  it('prefers agentName over nodeLabel when both are present', () => {
    const { getByTestId, queryByTestId } = render(
      <NodeContextBanner origin={fullOrigin({ agentName: 'Agent', nodeLabel: 'Label' })} />,
    );
    expect(getByTestId('node-context-banner-agent').textContent).toBe('Agent');
    expect(queryByTestId('node-context-banner-label')).toBeNull();
  });

  it('shows expand/collapse toggle for long excerpts (>80 codepoints)', () => {
    const longExcerpt = 'A'.repeat(100);
    const { getByTestId } = render(
      <NodeContextBanner origin={fullOrigin({ excerpt: longExcerpt })} />,
    );
    const toggle = getByTestId('node-context-banner-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const el = getByTestId('node-context-banner-excerpt');
    expect(el.textContent).toBe(longExcerpt);
    expect(el.className).toContain('clamped');
  });

  it('does not show toggle for short excerpt', () => {
    const { queryByTestId } = render(
      <NodeContextBanner origin={fullOrigin({ excerpt: 'Short' })} />,
    );
    expect(queryByTestId('node-context-banner-toggle')).toBeNull();
  });

  it('applies typeColor override to the decorative strip', () => {
    const { getByTestId } = render(
      <NodeContextBanner origin={fullOrigin({ typeColor: '#ff0000' })} />,
    );
    const strip = getByTestId('node-context-banner-strip');
    expect(strip.style.backgroundColor).toBe('rgb(255, 0, 0)');
  });

  it('falls back to NODE_TYPE_COLORS_HEX when typeColor is absent', () => {
    const { getByTestId } = render(
      <NodeContextBanner origin={fullOrigin({ typeColor: undefined })} />,
    );
    const strip = getByTestId('node-context-banner-strip');
    expect(strip.style.backgroundColor).toBeTruthy();
  });

  it('decorative strip is aria-hidden', () => {
    const { getByTestId } = render(<NodeContextBanner origin={fullOrigin()} />);
    expect(getByTestId('node-context-banner-strip').getAttribute('aria-hidden')).toBe('true');
  });

  it('icon is aria-hidden', () => {
    const { getByTestId } = render(<NodeContextBanner origin={fullOrigin()} />);
    expect(getByTestId('node-context-banner-icon').getAttribute('aria-hidden')).toBe('true');
  });

  it('root has node-context-banner class hook for T4', () => {
    const { getByTestId } = render(<NodeContextBanner origin={fullOrigin()} />);
    expect(getByTestId('node-context-banner').className).toContain('node-context-banner');
  });

  it('renders full surrogate-pair text with toggle when long', () => {
    const emoji = '\u{1F600}';
    const longEmoji = emoji.repeat(100);
    const { getByTestId } = render(
      <NodeContextBanner origin={fullOrigin({ excerpt: longEmoji })} />,
    );
    const el = getByTestId('node-context-banner-excerpt');
    expect(el.textContent).toBe(longEmoji);
    expect(getByTestId('node-context-banner-toggle')).toBeTruthy();
  });
});
