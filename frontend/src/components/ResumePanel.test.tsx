/**
 * P1-9 — ResumePanel unit tests
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { defaultValue?: string }) => {
      if (typeof options === 'string') return options;
      return options?.defaultValue ?? key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

vi.mock('../api/client', () => ({
  resumeFromRound: vi.fn(),
  isApiError: vi.fn((error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error)),
}));

import { ResumePanel } from './ResumePanel';
import { resumeFromRound } from '../api/client';
const MOCK_BRANCHES = [
  {
    id: 'branch-1',
    title: 'Main Branch',
  },
  {
    id: 'branch-2',
    title: 'Fork A',
  },
];

function renderPanel(props?: Partial<React.ComponentProps<typeof ResumePanel>>) {
  return render(
    <MemoryRouter>
      <ResumePanel
        scenarioId="sc-123"
        branches={MOCK_BRANCHES}
        totalRounds={5}
        {...props}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('ResumePanel', () => {
  it('renders title and form elements', () => {
    renderPanel();
    expect(screen.getByText('Resume Simulation')).toBeInTheDocument();
    expect(screen.getByLabelText('Branch')).toBeInTheDocument();
    expect(screen.getByLabelText(/Round|From Round/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resume/ })).toBeInTheDocument();
  });

  it('submit button disabled when no branch selected', () => {
    renderPanel();
    const btn = screen.getByRole('button', { name: /Resume/ });
    expect(btn).toBeDisabled();
  });

  it('submit button disabled while submitting', async () => {
    const user = userEvent.setup();
    vi.mocked(resumeFromRound).mockReturnValue(new Promise(() => {}));
    renderPanel();

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.click(screen.getByRole('button', { name: /Resume/ }));

    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('shows success message on 201 response', async () => {
    const user = userEvent.setup();
    vi.mocked(resumeFromRound).mockResolvedValueOnce({
      branch_id: 'resume-001',
      message: 'ok',
    });

    renderPanel();
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.click(screen.getByRole('button', { name: /Resume/ }));

    await waitFor(() => {
      expect(screen.getByText(/Resume branch created/)).toBeInTheDocument();
    });
  });

  it('navigates to /sim/{scenarioId} on success', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(resumeFromRound).mockResolvedValueOnce({
      branch_id: 'resume-001',
      message: 'ok',
    });

    renderPanel();
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.click(screen.getByRole('button', { name: /Resume/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Resume/ })).toBeDisabled();
    });
    await vi.advanceTimersByTimeAsync(600);

    expect(mockNavigate).toHaveBeenCalledWith('/sim/sc-123');
  });

  it('keeps submit button disabled after success while redirect is pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(resumeFromRound).mockResolvedValueOnce({
      branch_id: 'resume-locked',
      message: 'ok',
    });

    renderPanel();
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.click(screen.getByRole('button', { name: /Resume/ }));

    await screen.findByText(/Resume branch created/);
    const submitButton = screen.getByRole('button');

    expect(submitButton).toBeDisabled();
    await user.click(submitButton);
    expect(resumeFromRound).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();
  });

  it('shows limit_reached on 429 response', async () => {
    const user = userEvent.setup();
    vi.mocked(resumeFromRound).mockRejectedValueOnce(new Error('429 Too Many Requests'));

    renderPanel();
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.click(screen.getByRole('button', { name: /Resume/ }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Maximum 3 replay branches/);
    });
  });

  it('shows error text on 400/404/409 responses', async () => {
    const user = userEvent.setup();
    vi.mocked(resumeFromRound).mockRejectedValueOnce(new Error('Scenario not found'));

    renderPanel();
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.click(screen.getByRole('button', { name: /Resume/ }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Scenario not found');
    });
  });

  it('round input respects min=1 and max=totalRounds', () => {
    renderPanel({ totalRounds: 8 });
    const input = screen.getByLabelText(/Round|From Round/) as HTMLInputElement;
    expect(input.min).toBe('1');
    expect(input.max).toBe('8');
    expect(input.step).toBe('1');
  });

  it('shows a validation error and disables submit when round input is cleared', async () => {
    const user = userEvent.setup();

    renderPanel();
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.clear(screen.getByLabelText(/Round|From Round/));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole round between 1 and 5');
    expect(screen.getByRole('button', { name: /Resume/ })).toBeDisabled();
    expect(resumeFromRound).not.toHaveBeenCalled();
  });

  it('shows a validation error and disables submit when round exceeds totalRounds', async () => {
    const user = userEvent.setup();

    renderPanel({ totalRounds: 5 });
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.clear(screen.getByLabelText(/Round|From Round/));
    await user.type(screen.getByLabelText(/Round|From Round/), '6');

    const roundInput = screen.getByLabelText(/Round|From Round/);
    expect(roundInput).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole round between 1 and 5');
    expect(screen.getByRole('button', { name: /Resume/ })).toBeDisabled();
    expect(resumeFromRound).not.toHaveBeenCalled();
  });

  it('shows a validation error and disables submit when round is not an integer', async () => {
    const user = userEvent.setup();

    renderPanel({ totalRounds: 5 });
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.clear(screen.getByLabelText(/Round|From Round/));
    await user.type(screen.getByLabelText(/Round|From Round/), '2.5');

    expect(screen.getByLabelText(/Round|From Round/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole round between 1 and 5');
    expect(screen.getByRole('button', { name: /Resume/ })).toBeDisabled();
    expect(resumeFromRound).not.toHaveBeenCalled();
  });

  it('submits the selected branch id and round number', async () => {
    const user = userEvent.setup();
    vi.mocked(resumeFromRound).mockResolvedValueOnce({
      branch_id: 'resume-003',
      message: 'ok',
    });

    renderPanel();
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-2');
    await user.clear(screen.getByLabelText(/Round|From Round/));
    await user.type(screen.getByLabelText(/Round|From Round/), '3');
    await user.click(screen.getByRole('button', { name: /Resume/ }));

    await waitFor(() => {
      expect(resumeFromRound).toHaveBeenCalledWith('sc-123', {
        source_branch_id: 'branch-2',
        round_number: 3,
      });
    });
  });

  it('keeps the form locked after success while redirect is pending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.mocked(resumeFromRound).mockResolvedValueOnce({
      branch_id: 'resume-locked',
      message: 'ok',
    });

    renderPanel();
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.click(screen.getByRole('button', { name: /Resume/ }));

    await waitFor(() => {
      expect(screen.getByText(/Resume branch created/)).toBeInTheDocument();
      expect(screen.getByLabelText('Branch')).toBeDisabled();
      expect(screen.getByLabelText(/Round|From Round/)).toBeDisabled();
      expect(screen.getByRole('button', { name: /Resume/ })).toBeDisabled();
    });

    await user.click(screen.getByRole('button', { name: /Resume/ }));
    expect(resumeFromRound).toHaveBeenCalledTimes(1);
  });

  it('branch dropdown populates from branches prop', () => {
    renderPanel();
    const select = screen.getByLabelText('Branch') as HTMLSelectElement;
    const options = Array.from(select.options);
    // placeholder + 2 branches
    expect(options).toHaveLength(3);
    expect(options[1].value).toBe('branch-1');
    expect(options[1].text).toBe('Main Branch');
    expect(options[2].value).toBe('branch-2');
    expect(options[2].text).toBe('Fork A');
  });

  it('calls onCreated callback with new branch id', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    vi.mocked(resumeFromRound).mockResolvedValueOnce({
      branch_id: 'resume-002',
      message: 'ok',
    });

    renderPanel({ onCreated });
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    await user.click(screen.getByRole('button', { name: /Resume/ }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('resume-002');
    });
  });
});
