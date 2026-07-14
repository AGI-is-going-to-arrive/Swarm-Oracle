import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenarioActions, type SocialActionsResponse } from '../../api/client';
import ActionLedgerPanel from './ActionLedgerPanel';
import { ACTION_LEDGER_POLL_INTERVAL_MS, isActionsUnavailableError } from './actionLedgerUtils';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'action_ledger.entry_aria') return `${values?.agent} ${values?.type} round ${values?.round}`;
      if (key === 'action_ledger.round') return `Round ${values?.round}`;
      if (key === 'action_ledger.target') return `Target: ${values?.target}`;
      return key;
    },
  }),
}));

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, getScenarioActions: vi.fn() };
});

const mockedGetActions = vi.mocked(getScenarioActions);

function response(content: string, nextCursor: string | null = null): SocialActionsResponse {
  return {
    scenario_id: 'scenario-1', next_cursor: nextCursor, has_more: nextCursor !== null,
    items: [{
      id: `action:${content}`, sequence: content === 'Second' ? 2 : 1, branch_id: 'branch-1', round: 2,
      agent: { id: 'agent-1', name: 'Ada' }, action_type: 'POST', status: 'verified',
      target: { kind: 'topic', id: 'launch' }, parent_action_id: null, content, payload: {},
      failure_code: null, created_at: '2026-07-14T01:02:03Z',
    }],
  };
}

async function expand(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: /action_ledger.title/ }));
}

describe('ActionLedgerPanel', () => {
  beforeEach(() => mockedGetActions.mockReset());
  afterEach(() => vi.useRealTimers());

  it('is collapsed by default and loads only durable actions after expansion', async () => {
    mockedGetActions.mockResolvedValue(response('Published update'));
    render(<ActionLedgerPanel scenarioId="scenario-1" branchId="branch-1" />);
    expect(screen.getByRole('button', { name: /action_ledger.title/ })).toHaveAttribute('aria-expanded', 'false');
    expect(mockedGetActions).not.toHaveBeenCalled();
    await expand();
    expect(await screen.findByText('Published update')).toBeVisible();
    expect(mockedGetActions).toHaveBeenCalledWith('scenario-1', expect.objectContaining({ branchId: 'branch-1' }), expect.anything());
    expect(screen.getByText('Target: topic:launch')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'action_ledger.details' }));
    expect(screen.getByText('action_ledger.none')).toBeVisible();
  });

  it('sends action, agent, round and status filters to the API', async () => {
    mockedGetActions.mockResolvedValue(response('Filtered'));
    render(<ActionLedgerPanel scenarioId="scenario-1" />);
    await expand();
    await screen.findByText('Filtered');
    await userEvent.selectOptions(screen.getByLabelText('action_ledger.type_filter'), 'POST');
    await userEvent.selectOptions(screen.getByLabelText('action_ledger.agent_filter'), 'agent-1');
    await userEvent.type(screen.getByLabelText('action_ledger.round_filter'), '3');
    await userEvent.selectOptions(screen.getByLabelText('action_ledger.status_filter'), 'failed');
    await waitFor(() => expect(mockedGetActions).toHaveBeenLastCalledWith(
      'scenario-1',
      expect.objectContaining({ actionType: 'POST', agentId: 'agent-1', round: 3, status: 'failed' }),
      expect.anything(),
    ));
  });

  it('merges cursor pages and links selection to branch, round and Agent', async () => {
    mockedGetActions.mockResolvedValueOnce(response('First', 'cursor-2')).mockResolvedValueOnce(response('Second'));
    const onSelectAction = vi.fn();
    render(<ActionLedgerPanel scenarioId="scenario-1" onSelectAction={onSelectAction} />);
    await expand();
    await screen.findByText('First');
    await userEvent.click(screen.getByRole('button', { name: 'action_ledger.load_more' }));
    expect(await screen.findByText('Second')).toBeVisible();
    expect(screen.getByText('First')).toBeVisible();
    expect(mockedGetActions.mock.calls[1][1]).toMatchObject({ cursor: 'cursor-2' });
    await userEvent.click(screen.getAllByRole('button', { name: 'Ada POST round 2' })[0]);
    expect(onSelectAction).toHaveBeenCalledWith({ branchId: 'branch-1', round: 2, agent: { id: 'agent-1', name: 'Ada' }, actionId: 'action:First' });
  });

  it('expands safe bootstrap details without requiring a selection callback', async () => {
    const bootstrap = response('World event');
    bootstrap.items[0].parent_action_id = 'parent-action-1';
    bootstrap.items[0].payload = {
      bootstrap: true,
      source_name: 'Flood Office',
      published_at: '2026-07-14T08:10:00+10:00',
      credibility_hint: 'Official bulletin',
      tags: ['storm', 'traffic', 42],
      secret: '<b>must not render</b>',
    };
    mockedGetActions.mockResolvedValue(bootstrap);
    render(<ActionLedgerPanel scenarioId="scenario-1" />);
    await expand();
    await screen.findByText('World event');

    const detailsToggle = screen.getByRole('button', { name: 'action_ledger.details' });
    expect(detailsToggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(detailsToggle);

    expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('parent-action-1')).toBeVisible();
    expect(screen.getByText('Flood Office')).toBeVisible();
    expect(screen.getByText('2026-07-14T08:10:00+10:00')).toBeVisible();
    expect(screen.getByText('Official bulletin')).toBeVisible();
    expect(screen.getByText('storm, traffic')).toBeVisible();
    expect(screen.queryByText(/must not render/)).not.toBeInTheDocument();
  });

  it('shows only the whitelisted reaction field and keeps disclosure separate from selection', async () => {
    const reaction = response('Reacted');
    reaction.items[0].action_type = 'REACTION';
    reaction.items[0].payload = { reaction: 'support', unknown: 'hidden value' };
    const onSelectAction = vi.fn();
    mockedGetActions.mockResolvedValue(reaction);
    render(<ActionLedgerPanel scenarioId="scenario-1" onSelectAction={onSelectAction} />);
    await expand();
    await screen.findByText('Reacted');

    await userEvent.click(screen.getByRole('button', { name: 'action_ledger.details' }));
    expect(screen.getByText('support')).toBeVisible();
    expect(screen.queryByText('hidden value')).not.toBeInTheDocument();
    expect(onSelectAction).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Ada REACTION round 2' }));
    expect(onSelectAction).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight page when scope changes and ignores its late result', async () => {
    let resolvePage!: (value: SocialActionsResponse) => void;
    mockedGetActions
      .mockResolvedValueOnce(response('Old', 'cursor-2'))
      .mockReturnValueOnce(new Promise((resolve) => { resolvePage = resolve; }))
      .mockResolvedValueOnce(response('New'));
    const { rerender } = render(<ActionLedgerPanel scenarioId="old" />);
    await expand();
    await screen.findByText('Old');
    await userEvent.click(screen.getByRole('button', { name: 'action_ledger.load_more' }));
    const pageSignal = mockedGetActions.mock.calls[1][2]?.signal;
    rerender(<ActionLedgerPanel scenarioId="new" />);
    await expand();
    expect(await screen.findByText('New')).toBeVisible();
    expect(pageSignal?.aborted).toBe(true);
    resolvePage(response('Late'));
    await waitFor(() => expect(screen.queryByText('Late')).not.toBeInTheDocument());
  });

  it('classifies only a real old-backend 404 as unavailable', () => {
    expect(isActionsUnavailableError(Object.assign(new Error('missing'), { status: 404 }))).toBe(true);
    expect(isActionsUnavailableError(Object.assign(new Error('offline'), { status: 503 }))).toBe(false);
    expect(isActionsUnavailableError(new Error('missing'))).toBe(false);
  });

  it('polls only while expanded and merges new durable actions without resetting pagination', async () => {
    vi.useFakeTimers();
    mockedGetActions
      .mockResolvedValueOnce(response('First', 'page-2'))
      .mockResolvedValueOnce(response('Live'));
    render(<ActionLedgerPanel scenarioId="scenario-1" />);
    await act(async () => {
      screen.getByRole('button', { name: /action_ledger.title/ }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('First')).toBeVisible();

    await act(async () => { await vi.advanceTimersByTimeAsync(ACTION_LEDGER_POLL_INTERVAL_MS); });
    expect(screen.getByText('Live')).toBeVisible();
    expect(screen.getByText('First')).toBeVisible();
    expect(screen.getByRole('button', { name: 'action_ledger.load_more' })).toBeVisible();
    expect(mockedGetActions.mock.calls[1][1]).toMatchObject({ cursor: '1:action:First' });

    screen.getByRole('button', { name: /action_ledger.title/ }).click();
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTION_LEDGER_POLL_INTERVAL_MS * 2); });
    expect(mockedGetActions).toHaveBeenCalledTimes(2);
  });

  it('aborts polling on scope change and ignores a late poll response', async () => {
    vi.useFakeTimers();
    let resolvePoll!: (value: SocialActionsResponse) => void;
    mockedGetActions
      .mockResolvedValueOnce(response('Old'))
      .mockReturnValueOnce(new Promise((resolve) => { resolvePoll = resolve; }))
      .mockResolvedValueOnce(response('New'));
    const { rerender } = render(<ActionLedgerPanel scenarioId="old" />);
    await act(async () => {
      screen.getByRole('button', { name: /action_ledger.title/ }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Old')).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTION_LEDGER_POLL_INTERVAL_MS); });
    const pollSignal = mockedGetActions.mock.calls[1][2]?.signal;

    rerender(<ActionLedgerPanel scenarioId="new" />);
    await act(async () => {
      screen.getByRole('button', { name: /action_ledger.title/ }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('New')).toBeVisible();
    expect(pollSignal?.aborted).toBe(true);
    resolvePoll(response('Late poll'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Late poll')).not.toBeInTheDocument();
  });

  it('aborts polling and clears its timer on unmount', async () => {
    vi.useFakeTimers();
    mockedGetActions.mockResolvedValueOnce(response('First'));
    let resolvePoll!: (value: SocialActionsResponse) => void;
    mockedGetActions.mockReturnValueOnce(new Promise((resolve) => { resolvePoll = resolve; }));
    const { unmount } = render(<ActionLedgerPanel scenarioId="scenario-1" />);
    await act(async () => {
      screen.getByRole('button', { name: /action_ledger.title/ }).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('First')).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTION_LEDGER_POLL_INTERVAL_MS); });
    const pollSignal = mockedGetActions.mock.calls[1][2]?.signal;
    unmount();
    expect(pollSignal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(ACTION_LEDGER_POLL_INTERVAL_MS * 2); });
    expect(mockedGetActions).toHaveBeenCalledTimes(2);
    resolvePoll(response('Late after unmount'));
  });
});
