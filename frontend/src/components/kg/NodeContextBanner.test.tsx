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

  it('does not repeat the same node label as excerpt', () => {
    const duplicate = '路线分岔：先稳后攻；另一条继续强攻。';
    const { getByTestId, queryByTestId } = render(
      <NodeContextBanner
        origin={{
          nodeId: 'fork-1',
          nodeType: 'fork',
          nodeLabel: duplicate,
          excerpt: duplicate,
        }}
      />,
    );

    expect(getByTestId('node-context-banner-label').textContent).toBe(duplicate);
    expect(queryByTestId('node-context-banner-excerpt')).toBeNull();
  });

  it('renders the explicit conversation target when provided', () => {
    const { getByTestId } = render(
      <NodeContextBanner
        origin={fullOrigin({
          targetLabel: 'Graph analyst',
          targetDescription: 'Answers from the selected node and nearby graph context.',
        })}
      />,
    );

    expect(getByTestId('node-context-banner-target').textContent).toContain('Graph analyst');
    expect(getByTestId('node-context-banner-target-description').textContent).toContain('nearby graph context');
  });

  it('renders card meaning and grouped causal context when provided', () => {
    const { getByTestId, queryByTestId } = render(
      <NodeContextBanner
        origin={fullOrigin({
          meaningTitle: 'Event card',
          meaningDescription: 'This records one important move.',
          causeContext: ['It follows Event A.'],
          effectContext: ['It pushes toward Outcome B.'],
          relationContext: ['It conflicts with Event C.'],
          relatedContext: ['Legacy relation should not duplicate'],
        })}
      />,
    );

    const meaning = getByTestId('node-context-banner-meaning');
    expect(meaning.textContent).toContain('Event card');
    expect(meaning.textContent).toContain('important move');
    const groups = getByTestId('node-context-banner-causal-groups');
    expect(groups.textContent).toContain('Why it appears');
    expect(groups.textContent).toContain('It follows Event A.');
    expect(groups.textContent).toContain('What it changes');
    expect(groups.textContent).toContain('It pushes toward Outcome B.');
    expect(groups.textContent).toContain('How it relates');
    expect(groups.textContent).toContain('It conflicts with Event C.');
    expect(queryByTestId('node-context-banner-relations')).toBeNull();
  });

  it('renders adjacent relation context when provided', () => {
    const { getByTestId } = render(
      <NodeContextBanner
        origin={fullOrigin({
          relatedContext: [
            'Source: Zhuge Liang · responds to',
            'Next: leads to · Falling Star',
          ],
        })}
      />,
    );

    const relations = getByTestId('node-context-banner-relations');
    expect(relations.textContent).toContain('Related links');
    expect(relations.textContent).toContain('Source: Zhuge Liang · responds to');
    expect(relations.textContent).toContain('Next: leads to · Falling Star');
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
