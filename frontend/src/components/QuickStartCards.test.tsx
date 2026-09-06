import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuickStartCards } from './QuickStartCards';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('QuickStartCards material browsing', () => {
  it('shows four choices initially and reveals the full set on request', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<QuickStartCards onSelect={onSelect} />);
    expect(document.querySelectorAll('.quickstart-card')).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'home.materials_show_more' }));
    expect(document.querySelectorAll('.quickstart-card')).toHaveLength(11);
    expect(onSelect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /quickstart.random_leader_swap.question/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
      question: 'quickstart.random_leader_swap.question', rounds: 4, numAgents: 4, mode: 'blackboard', visualizationEnabled: true,
    }));
    await user.click(screen.getByRole('button', { name: 'home.materials_show_less' }));
    expect(document.querySelectorAll('.quickstart-card')).toHaveLength(4);
  });

  it('allows keyboard selection and disables material changes while submitting', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(<QuickStartCards onSelect={onSelect} />);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ question: 'quickstart.zhuge_liang.question' }));
    onSelect.mockClear();
    rerender(<QuickStartCards onSelect={onSelect} disabled />);
    const first = screen.getByRole('button', { name: /quickstart.zhuge_liang.question/ });
    expect(first).toBeDisabled();
    await user.click(first);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
