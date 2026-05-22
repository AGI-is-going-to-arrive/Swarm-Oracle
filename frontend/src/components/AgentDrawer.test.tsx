import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AgentDrawer } from './AgentDrawer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'agents.drawer_title': 'Agent Selection',
        'agents.drawer_close': 'Close',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('./AgentAttachPanel', () => ({
  AgentAttachPanel: vi.fn(({ userId, visible, maxSelected }: { userId: string; visible: boolean; maxSelected: number }) => (
    <div data-testid="mock-attach-panel" data-userid={userId} data-visible={String(visible)} data-maxselected={maxSelected}>
      Mock Panel
    </div>
  )),
}));

describe('AgentDrawer', () => {
  it('renders when open and shows title', () => {
    render(<AgentDrawer open onOpenChange={vi.fn()} userId="u1" maxSelected={5} />);
    expect(screen.getByTestId('agent-drawer')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Agent Selection' })).toBeInTheDocument();
  });

  it('does not render content when closed', () => {
    render(<AgentDrawer open={false} onOpenChange={vi.fn()} userId="u1" maxSelected={5} />);
    expect(screen.queryByTestId('agent-drawer')).not.toBeInTheDocument();
  });

  it('calls onOpenChange(false) on close button click', async () => {
    const onChange = vi.fn();
    render(<AgentDrawer open onOpenChange={onChange} userId="u1" maxSelected={5} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('renders a single close control', () => {
    render(<AgentDrawer open onOpenChange={vi.fn()} userId="u1" maxSelected={5} />);
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  });

  it('passes correct props to AgentAttachPanel', () => {
    render(<AgentDrawer open onOpenChange={vi.fn()} userId="u7" maxSelected={3} />);
    const panel = screen.getByTestId('mock-attach-panel');
    expect(panel).toHaveAttribute('data-userid', 'u7');
    expect(panel).toHaveAttribute('data-visible', 'true');
    expect(panel).toHaveAttribute('data-maxselected', '3');
  });

  it('does not use native dialog or showModal', () => {
    const proto = (globalThis as { HTMLDialogElement?: typeof HTMLDialogElement }).HTMLDialogElement?.prototype;
    const hasNativeShowModal = !!proto && typeof proto.showModal === 'function';
    const spy = hasNativeShowModal
      ? vi.spyOn(proto as HTMLDialogElement, 'showModal').mockImplementation(() => {})
      : null;
    render(<AgentDrawer open onOpenChange={vi.fn()} userId="u1" maxSelected={5} />);
    expect(document.querySelector('dialog')).toBeNull();
    if (spy) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
