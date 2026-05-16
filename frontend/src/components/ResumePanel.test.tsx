/**
 * P1-9 — ResumePanel unit tests
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('react-i18next', () => {
  const t = (key: string, options?: string | Record<string, unknown>) => {
    if (typeof options === 'string') return options;
    const template = typeof options?.defaultValue === 'string' ? options.defaultValue : key;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''));
  };
  return {
    useTranslation: () => ({
      t,
      i18n: { changeLanguage: vi.fn(), language: 'en' },
    }),
  };
});

vi.mock('../api/client', () => ({
  resumeFromRound: vi.fn(),
  getCheckpoints: vi.fn(),
  isApiError: vi.fn((error: unknown) => Boolean(error && typeof error === 'object' && 'status' in error)),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: vi.fn(() => ({
    enabled: true,
    loading: false,
    capabilities: null,
    error: null,
    reload: vi.fn(),
  })),
}));

import { ResumePanel } from './ResumePanel';
import { getCheckpoints, resumeFromRound } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import type { CheckpointInfo } from '../types';

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

const baseCheckpoint = (overrides: Partial<CheckpointInfo>): CheckpointInfo => ({
  id: overrides.id ?? 'cp-default',
  scenario_id: overrides.scenario_id ?? 'sc-123',
  branch_id: overrides.branch_id ?? 'branch-1',
  round_number: overrides.round_number ?? 1,
  compressed_summary: overrides.compressed_summary ?? null,
  blackboard_json: overrides.blackboard_json ?? null,
  created_at: overrides.created_at ?? null,
});

function setEnabledCapability() {
  vi.mocked(useCapabilityCheck).mockReturnValue({
    enabled: true,
    loading: false,
    capabilities: null,
    error: null,
    reload: vi.fn(),
  });
}

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

beforeEach(() => {
  // Default: capability disabled so existing tests see legacy numeric input.
  vi.mocked(useCapabilityCheck).mockReturnValue({
    enabled: false,
    loading: false,
    capabilities: null,
    error: null,
    reload: vi.fn(),
  });
  // Default: empty checkpoints list (numeric input fallback).
  vi.mocked(getCheckpoints).mockResolvedValue([]);
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

describe('ResumePanel — checkpoint picker', () => {
  it('renders checkpoint picker when getCheckpoints returns non-empty list', async () => {
    setEnabledCapability();
    const user = userEvent.setup();
    vi.mocked(getCheckpoints).mockResolvedValue([
      baseCheckpoint({ id: 'cp-1', round_number: 2, compressed_summary: 'Recap A' }),
      baseCheckpoint({ id: 'cp-2', round_number: 4, compressed_summary: 'Recap B' }),
    ]);

    renderPanel({ totalRounds: 5 });

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    const picker = await screen.findByLabelText('Resume from checkpoint') as HTMLSelectElement;
    expect(picker).toBeInTheDocument();
    // placeholder + 2 checkpoints
    await waitFor(() => {
      expect(picker.options).toHaveLength(3);
    });
    expect(picker.options[0].value).toBe('');
    expect(picker.options[1].value).toBe('cp-1');
    expect(picker.options[2].value).toBe('cp-2');
    // Numeric input should NOT be present.
    expect(screen.queryByLabelText(/^Round$|^From Round$/)).not.toBeInTheDocument();
  });

  it('falls back to numeric input on empty list', async () => {
    setEnabledCapability();
    const user = userEvent.setup();
    vi.mocked(getCheckpoints).mockResolvedValue([]);

    renderPanel({ totalRounds: 5 });
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');

    await waitFor(() => {
      expect(getCheckpoints).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText('Resume from checkpoint')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Round|From Round/)).toBeInTheDocument();
  });

  it('falls back to numeric input on getCheckpoints fetch error', async () => {
    setEnabledCapability();
    const user = userEvent.setup();
    vi.mocked(getCheckpoints).mockRejectedValue(new Error('500 server'));

    renderPanel({ totalRounds: 5 });
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');

    await waitFor(() => {
      expect(getCheckpoints).toHaveBeenCalled();
    });
    // Picker absent, numeric input present.
    expect(screen.queryByLabelText('Resume from checkpoint')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Round|From Round/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load checkpoints for this branch');
  });

  it('refetches checkpoints on branch change', async () => {
    setEnabledCapability();
    const user = userEvent.setup();
    vi.mocked(getCheckpoints).mockResolvedValue([]);

    renderPanel({ totalRounds: 5 });

    expect(getCheckpoints).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');

    await waitFor(() => {
      expect(getCheckpoints).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(getCheckpoints).mock.calls[0]).toEqual(['sc-123', 'branch-1']);

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-2');

    await waitFor(() => {
      expect(getCheckpoints).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(getCheckpoints).mock.calls[1]).toEqual(['sc-123', 'branch-2']);
  });

  it('populates selectedRoundInput when a checkpoint is picked and submits with that round', async () => {
    setEnabledCapability();
    vi.mocked(getCheckpoints).mockResolvedValue([
      baseCheckpoint({ id: 'cp-7', round_number: 3, compressed_summary: 'Round 3 recap' }),
    ]);
    vi.mocked(resumeFromRound).mockResolvedValueOnce({
      branch_id: 'resume-cp',
      message: 'ok',
    });

    const user = userEvent.setup();
    renderPanel({ totalRounds: 5 });

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    const picker = await screen.findByLabelText('Resume from checkpoint');
    // Submit must be disabled until a checkpoint is picked.
    expect(screen.getByRole('button', { name: /Resume/ })).toBeDisabled();

    await user.selectOptions(picker, 'cp-7');

    // Resolved round hint visible.
    expect(screen.getByTestId('resume-resolved-round')).toHaveTextContent('Round 3');
    expect(screen.getByRole('button', { name: /Resume/ })).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Resume/ }));

    await waitFor(() => {
      expect(resumeFromRound).toHaveBeenCalledWith('sc-123', {
        source_branch_id: 'branch-1',
        round_number: 3,
      });
    });
  });

  it('shows compressed_summary preview when checkpoint has summary', async () => {
    setEnabledCapability();
    vi.mocked(getCheckpoints).mockResolvedValue([
      baseCheckpoint({ id: 'cp-9', round_number: 2, compressed_summary: 'Compressed recap text' }),
    ]);

    const user = userEvent.setup();
    renderPanel({ totalRounds: 5 });

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    const picker = await screen.findByLabelText('Resume from checkpoint');
    await user.selectOptions(picker, 'cp-9');

    expect(screen.getByText('Compressed recap text')).toBeInTheDocument();
    expect(screen.getByText('Summary')).toBeInTheDocument();
  });

  it('summarizes structured checkpoint arrays without crashing on malformed entries', async () => {
    setEnabledCapability();
    vi.mocked(getCheckpoints).mockResolvedValue([
      baseCheckpoint({
        id: 'cp-json',
        round_number: 2,
        compressed_summary: JSON.stringify([
          null,
          { stance: 'Hold the line' },
          42,
          { stance: '?' },
          { stance: 'Negotiate' },
        ]),
      }),
    ]);

    const user = userEvent.setup();
    renderPanel({ totalRounds: 5 });

    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');
    const picker = await screen.findByLabelText('Resume from checkpoint');
    await user.selectOptions(picker, 'cp-json');

    expect(screen.getByText(/Resume with 5 agents/)).toHaveTextContent('Hold the line');
    expect(screen.getByText(/Resume with 5 agents/)).toHaveTextContent('Negotiate');
  });

  it('filters out checkpoints whose round_number exceeds totalRounds', async () => {
    setEnabledCapability();
    const user = userEvent.setup();
    vi.mocked(getCheckpoints).mockResolvedValue([
      baseCheckpoint({ id: 'cp-low', round_number: 2 }),
      baseCheckpoint({ id: 'cp-high', round_number: 99 }),
    ]);

    renderPanel({ totalRounds: 5 });
    await user.selectOptions(screen.getByLabelText('Branch'), 'branch-1');

    const picker = await screen.findByLabelText('Resume from checkpoint') as HTMLSelectElement;
    await waitFor(() => {
      // placeholder + 1 in-bounds checkpoint
      expect(picker.options).toHaveLength(2);
    });
    expect(picker.options[1].value).toBe('cp-low');
  });
});
