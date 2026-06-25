import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BranchStatus } from '../types';
import { BranchNode } from './BranchNode';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}));

vi.mock('../animations/branchAnimations', () => ({
  animateNodeAppear: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      if (key === 'sim.tree.status_pruned') return '可能性较低';
      if (key === 'sim.tree.status_pruned_tooltip') return '这条可能性较低，系统不再继续扩展它。';
      if (key === 'sim.tree.status_active') return '推演中';
      if (key === 'sim.tree.status_completed') return '推演结束';
      if (key === 'sim.tree.status_interrupted') return '已中断';
      return typeof fallback === 'string' ? fallback : key;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

const baseData = {
  title: '历史拐点',
  probability: 0.25,
  branchId: 'branch-1',
};

function renderNode(status: BranchStatus) {
  return render(<BranchNode data={{ ...baseData, status }} />);
}

describe('BranchNode status presentation', () => {
  it('renders the localized PRUNED label rather than the raw enum string', () => {
    renderNode('PRUNED');
    expect(screen.getByText('可能性较低')).toBeInTheDocument();
    expect(screen.queryByText('PRUNED')).not.toBeInTheDocument();
  });

  it('renders a neutral interrupted state for an ACTIVE branch under a terminal scenario', () => {
    const { container } = render(
      <BranchNode data={{ ...baseData, status: 'ACTIVE', interrupted: true }} />,
    );
    expect(screen.getByText('已中断')).toBeInTheDocument();
    expect(screen.queryByText('推演中')).not.toBeInTheDocument();
    expect(container.querySelector('.branch-node--interrupted')).toBeTruthy();
    expect(container.querySelector('.status-dot--interrupted')).toBeTruthy();
    expect(container.querySelector('.branch-node--active')).toBeNull();
  });

  it('shows the PRUNED tooltip/help text inline so it is readable without hover', () => {
    renderNode('PRUNED');
    const help = screen.getByText('这条可能性较低，系统不再继续扩展它。');
    expect(help).toBeInTheDocument();
    expect(help).toHaveClass('status-help');
    expect(help).toHaveAttribute('role', 'note');
    expect(screen.getByText('可能性较低').closest('.branch-node__status')).toHaveAttribute(
      'aria-describedby',
      help.id,
    );
  });

  it('does not render the help text for ACTIVE or COMPLETED branches', () => {
    const { rerender } = renderNode('ACTIVE');
    expect(screen.queryByText('这条可能性较低，系统不再继续扩展它。')).not.toBeInTheDocument();

    rerender(<BranchNode data={{ ...baseData, status: 'COMPLETED' }} />);
    expect(screen.queryByText('这条可能性较低，系统不再继续扩展它。')).not.toBeInTheDocument();
  });

  it('does not add tabIndex to non-interactive status label', () => {
    renderNode('PRUNED');
    const label = screen.getByText('可能性较低');
    expect(label).not.toHaveAttribute('tabIndex');
  });

  it('falls back gracefully for unknown branch statuses', () => {
    renderNode('STALE' as BranchStatus);
    expect(screen.getByText('可能性较低')).toBeInTheDocument();
    expect(screen.queryByText('STALE')).not.toBeInTheDocument();
    expect(document.querySelector('.status-dot--pruned')).toBeTruthy();
  });
});

describe('BranchNode intervention button lifecycle', () => {
  it('does not render the intervention button when status is ACTIVE but canIntervene is false (done state)', () => {
    const onIntervene = vi.fn();
    render(
      <BranchNode
        data={{
          ...baseData,
          status: 'ACTIVE',
          canIntervene: false,
          onIntervene,
        }}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders the intervention button when status is ACTIVE and canIntervene is true', () => {
    const onIntervene = vi.fn();
    render(
      <BranchNode
        data={{
          ...baseData,
          status: 'ACTIVE',
          canIntervene: true,
          onIntervene,
        }}
      />
    );
    const button = screen.getByRole('button');
    expect(button).toBeInTheDocument();
    expect(button).toHaveClass('branch-node__intervene');
  });
});

describe('BranchNode CSS contract', () => {
  const css = readFileSync('src/components/BranchNode.css', 'utf8');

  it('removes the uppercase shouting from the status label so localized strings are readable', () => {
    const labelBlock = css.match(/\.status-label\s*\{[^}]*\}/);
    expect(labelBlock).not.toBeNull();
    expect(labelBlock?.[0]).not.toMatch(/text-transform:\s*uppercase/);
    expect(labelBlock?.[0]).toMatch(/letter-spacing:\s*0/);
  });

  it('declares a status-help block with forced-colors GrayText coverage', () => {
    expect(css).toMatch(/\.status-help\s*\{[^}]*display:\s*block[\s\S]*?\}/);
    expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)[\s\S]*?\.status-help[\s\S]*?GrayText/);
  });
});
