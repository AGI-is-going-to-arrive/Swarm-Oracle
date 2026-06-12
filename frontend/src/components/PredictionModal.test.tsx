import type { ComponentProps } from 'react';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PredictionModal from './PredictionModal';
import type { BranchInfo } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../api/client', () => ({
  submitPrediction: vi.fn(),
  listPredictions: vi.fn(() => Promise.resolve([])),
  getSessionBoundUserId: vi.fn(() => 'default_user'),
  getSessionPrincipalSubject: vi.fn(() => null),
}));

function makeBranch(overrides: Partial<BranchInfo> & Pick<BranchInfo, 'id' | 'title'>): BranchInfo {
  return {
    id: overrides.id,
    parent_branch_id: null,
    fork_round: 1,
    fork_reason: 'test',
    title: overrides.title,
    description: overrides.description,
    summary: overrides.summary ?? '',
    story: overrides.story ?? '',
    insight: overrides.insight ?? '',
    key_moments: overrides.key_moments ?? [],
    probability: overrides.probability ?? 0.5,
    status: overrides.status ?? 'ACTIVE',
  };
}

function renderPredictionModal(
  overrides: Partial<ComponentProps<typeof PredictionModal>> = {},
) {
  const onClose = vi.fn();
  render(
    <PredictionModal
      scenarioId="scenario-1"
      {...overrides}
      onClose={onClose}
    />,
  );
  return { onClose };
}

describe('PredictionModal automation callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('exposes modal dialog semantics and moves initial focus inside', async () => {
    renderPredictionModal();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await waitFor(() => {
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    });
  });

  it('closes when Escape is pressed', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPredictionModal();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports text and confidence changes', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <PredictionModal
        scenarioId="scenario-1"
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), '预测内容');

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.kind).toBe('prediction_modal');
    expect(latestState.text_length).toBe(4);
    expect(latestState.can_submit).toBe(true);
  });

  it('falls back to ending tone bets when no branch targets are available', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <PredictionModal
        scenarioId="scenario-1"
        branches={[]}
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), '预测内容');

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.bet_kind).toBe('ending_tone');
    expect(latestState.can_submit).toBe(true);
    expect(screen.getByLabelText('prediction.bet_kind_label')).toHaveValue('ending_tone');
  });

  it('adopts the first available branch target when branches arrive after mount', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();
    const { rerender } = render(
      <PredictionModal
        scenarioId="scenario-1"
        branches={[]}
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), '预测内容');
    expect(screen.getByLabelText('prediction.bet_kind_label')).toHaveValue('ending_tone');

    rerender(
      <PredictionModal
        scenarioId="scenario-1"
        branches={[
          makeBranch({ id: 'branch-1', title: 'Worldline One', probability: 0.6 }),
          makeBranch({ id: 'branch-2', title: 'Worldline Two', probability: 0.4 }),
        ]}
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    expect(screen.getByLabelText('prediction.bet_kind_label')).toHaveValue('branch_winner');
    expect(screen.getByLabelText('prediction.bet_target_label')).toHaveValue('branch-1');

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.bet_kind).toBe('branch_winner');
    expect(latestState.target_branch_id).toBe('branch-1');
    expect(latestState.can_submit).toBe(true);
  });

  it('supports theme resonance bets as a new lightweight gameplay option', async () => {
    const user = userEvent.setup();
    const onAutomationStateChange = vi.fn();

    render(
      <PredictionModal
        scenarioId="scenario-1"
        onClose={() => {}}
        onAutomationStateChange={onAutomationStateChange}
      />,
    );

    const advancedToggle = screen.getByRole('button', { name: /prediction\.show_advanced/ });
    expect(advancedToggle).not.toHaveAttribute('aria-controls');
    await user.click(advancedToggle);
    const controlsId = advancedToggle.getAttribute('aria-controls');
    expect(controlsId).toBeTruthy();
    expect(document.getElementById(controlsId as string)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('prediction.bet_kind_label'), 'profile_resonance');
    await user.type(screen.getByLabelText('prediction.text_label'), '我押这局会精准命中题材核心。');

    const latestState = onAutomationStateChange.mock.calls.at(-1)?.[0];
    expect(latestState.bet_kind).toBe('profile_resonance');
    expect(latestState.profile_resonance).toBe('aligned');
    expect(latestState.can_submit).toBe(true);
  });

  it('renders english labels for structured bet targets when the UI language is english', async () => {
    const user = userEvent.setup();

    render(
      <PredictionModal
        scenarioId="scenario-1"
        onClose={() => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText('prediction.bet_kind_label'), 'ending_tone');
    expect(screen.getByRole('option', { name: 'Order Consolidation' })).toBeInTheDocument();
    expect(
      screen.getByText((content) => (
        content.includes('prediction.bet_preview_prefix')
        && content.includes('Order Consolidation')
      )),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /prediction\.show_advanced/ }));
    await user.selectOptions(screen.getByLabelText('prediction.bet_kind_label'), 'profile_resonance');
    expect(screen.getByRole('option', { name: 'Direction Aligned' })).toBeInTheDocument();
    expect(
      screen.getByText((content) => (
        content.includes('prediction.bet_preview_prefix')
        && content.includes('Direction Aligned')
      )),
    ).toBeInTheDocument();
  });

  it('calls onPlacedBet with the updated gameplay meta after a successful submission', async () => {
    const user = userEvent.setup();
    const onPlacedBet = vi.fn();
    const { submitPrediction } = await import('../api/client');
    vi.mocked(submitPrediction).mockResolvedValue({
      id: 'prediction-1',
      scenario_id: 'scenario-1',
      user_name: 'Test Director',
      prediction_text: 'Structured bet',
      confidence: 0.7,
      score: null,
      score_reason: null,
      created_at: '2026-03-19T00:00:00Z',
    });

    render(
      <PredictionModal
        scenarioId="scenario-1"
        onClose={() => {}}
        onPlacedBet={onPlacedBet}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), 'I think this branch will hold.');
    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalledTimes(1);
    expect(submitPrediction).toHaveBeenCalledWith(
      'scenario-1',
      expect.any(String),
      0.5,
      'Local Director',
      'default_user',
    );
    expect(onPlacedBet).toHaveBeenCalledTimes(1);
    expect(onPlacedBet.mock.calls[0][0].betting.bets).toHaveLength(1);
    expect(onPlacedBet.mock.calls[0][0].betting.bets[0].targetLabel).toBeTruthy();
  });

  it('budgets rationale length against the final backend prediction payload', async () => {
    const user = userEvent.setup();
    const { submitPrediction } = await import('../api/client');
    vi.mocked(submitPrediction).mockResolvedValue({
      id: 'prediction-budgeted',
      scenario_id: 'scenario-1',
      user_name: 'Test Director',
      prediction_text: 'Structured bet',
      confidence: 0.7,
      score: null,
      score_reason: null,
      created_at: '2026-03-19T00:00:00Z',
    });

    render(
      <PredictionModal
        scenarioId="scenario-1"
        branches={[makeBranch({ id: 'branch-1', title: 'Long metadata worldline', probability: 0.6 })]}
        question={'What if a civic budget review chamber must publish structured wagers? '.repeat(4)}
        onClose={() => {}}
      />,
    );

    const predictionInput = screen.getByLabelText('prediction.text_label') as HTMLTextAreaElement;
    const maxLength = Number(predictionInput.getAttribute('maxlength'));
    expect(maxLength).toBeGreaterThan(0);
    expect(maxLength).toBeLessThan(500);

    await user.type(predictionInput, 'x'.repeat(500));
    expect(predictionInput.value).toHaveLength(maxLength);

    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalledTimes(1);
    const submittedPredictionText = vi.mocked(submitPrediction).mock.calls[0][1];
    expect(submittedPredictionText.length).toBeLessThanOrEqual(500);
  });

  it('submits the branch currently selected by the user even when a commitment branch exists', async () => {
    const user = userEvent.setup();
    const onPlacedBet = vi.fn();
    const { submitPrediction } = await import('../api/client');
    vi.mocked(submitPrediction).mockResolvedValue({
      id: 'prediction-commitment-branch',
      scenario_id: 'scenario-1',
      user_name: 'Test Director',
      prediction_text: 'Structured bet',
      confidence: 0.7,
      score: null,
      score_reason: null,
      created_at: '2026-03-19T00:00:00Z',
    });

    render(
      <PredictionModal
        scenarioId="scenario-1"
        initialMeta={{
          director: {
            maxPoints: 3,
            remainingPoints: 3,
            spentPoints: 0,
          },
          cooldowns: {},
          cards: {
            usageLog: [],
          },
          betting: {
            bets: [],
          },
          commitment: {
            branchId: 'branch-committed',
            branchTitle: 'Committed worldline',
            active: true,
            committedAtRound: 2,
            committedAt: '2026-03-19T00:00:00Z',
            outcome: null,
          },
          objectives: {
            generatedForQuestion: null,
            generatedForProfile: null,
            goals: [],
          },
          archive: {
            branchSnapshots: [],
            keyMoments: [],
          },
        }}
        branches={[
          makeBranch({ id: 'branch-committed', title: 'Committed worldline', probability: 0.7 }),
          makeBranch({ id: 'branch-alt', title: 'Alternate worldline', probability: 0.3 }),
        ]}
        onClose={() => {}}
        onPlacedBet={onPlacedBet}
      />,
    );

    await user.selectOptions(screen.getByLabelText('prediction.bet_target_label'), 'branch-alt');
    await user.type(screen.getByLabelText('prediction.text_label'), 'I think the alternate branch wins.');
    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalledTimes(1);
    expect(onPlacedBet).toHaveBeenCalledTimes(1);
    expect(onPlacedBet.mock.calls[0][0].betting.bets[0].targetId).toBe('branch-alt');
    expect(onPlacedBet.mock.calls[0][0].betting.bets[0].targetLabel).toBe('Alternate worldline');
  });

  it('surfaces a persistence error without closing the modal and retry skips re-submitting the prediction', async () => {
    const user = userEvent.setup();
    const { submitPrediction } = await import('../api/client');
    vi.mocked(submitPrediction).mockResolvedValue({
      id: 'prediction-persistence',
      scenario_id: 'scenario-1',
      user_name: 'Test Director',
      prediction_text: 'Structured bet',
      confidence: 0.7,
      score: null,
      score_reason: null,
      created_at: '2026-03-19T00:00:00Z',
    });
    const persistenceError = new Error('gameplay-state persistence failed');
    const onPlacedBet = vi
      .fn<(meta: unknown) => Promise<void>>()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();

    render(
      <PredictionModal
        scenarioId="scenario-1"
        onClose={onClose}
        onPlacedBet={onPlacedBet}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), 'Persist this prediction.');
    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalledTimes(1);
    expect(onPlacedBet).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText('prediction.error_persistence')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'prediction.submit' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalledTimes(1);
    expect(onPlacedBet).toHaveBeenCalledTimes(2);
  });

  it('prevents duplicate submit while the prediction request is in flight', async () => {
    const user = userEvent.setup();
    const { submitPrediction } = await import('../api/client');
    let resolvePrediction!: (value: {
      id: string;
      scenario_id: string;
      user_name: string;
      prediction_text: string;
      confidence: number;
      score: null;
      score_reason: null;
      created_at: string;
    }) => void;
    vi.mocked(submitPrediction).mockReturnValue(
      new Promise((resolve) => {
        resolvePrediction = resolve;
      }),
    );
    const onPlacedBet = vi.fn<(meta: unknown) => Promise<void>>().mockResolvedValue(undefined);

    renderPredictionModal({ onPlacedBet });

    await user.type(screen.getByLabelText('prediction.text_label'), 'Only submit once.');
    await user.dblClick(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalledTimes(1);
    expect(onPlacedBet).not.toHaveBeenCalled();

    await act(async () => {
      resolvePrediction({
        id: 'prediction-in-flight',
        scenario_id: 'scenario-1',
        user_name: 'Test Director',
        prediction_text: 'Structured bet',
        confidence: 0.7,
        score: null,
        score_reason: null,
        created_at: '2026-03-19T00:00:00Z',
      });
    });

    await waitFor(() => expect(onPlacedBet).toHaveBeenCalledTimes(1));
  });

  it('releases the scenario meta lock after a successful submission', async () => {
    const user = userEvent.setup();
    const scenarioId = 'scenario-lock-cleanup';
    const lockKey = `swarmoracle:scenario-meta:v1:lock:${scenarioId}`;
    const { submitPrediction } = await import('../api/client');
    vi.mocked(submitPrediction).mockResolvedValue({
      id: 'prediction-2',
      scenario_id: scenarioId,
      user_name: 'Test Director',
      prediction_text: 'Structured bet',
      confidence: 0.7,
      score: null,
      score_reason: null,
      created_at: '2026-03-19T00:00:00Z',
    });

    render(
      <PredictionModal
        scenarioId={scenarioId}
        onClose={() => {}}
      />,
    );

    await user.type(screen.getByLabelText('prediction.text_label'), 'I think this branch will hold.');
    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalled();
    expect(window.localStorage.getItem(lockKey)).toBeNull();
  });

  it('lock flow submits confidence, after lock the value is read-only / non-editable, unlocked allows skip/close, and 409 surfaces already-locked state', async () => {
    const user = userEvent.setup();
    const { submitPrediction, listPredictions } = await import('../api/client');

    // 1. Unlocked allows close/skip
    const onClose = vi.fn();
    const { unmount } = render(
      <PredictionModal
        scenarioId="scenario-lock-test"
        onClose={onClose}
      />
    );
    const closeBtn = screen.getByRole('button', { name: 'prediction.cancel' });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    // 2. Lock flow submits confidence & makes it read-only
    vi.mocked(submitPrediction).mockResolvedValue({
      id: 'prediction-lock-flow',
      scenario_id: 'scenario-lock-test',
      user_name: 'Test Director',
      prediction_text: 'Structured bet',
      confidence: 0.85,
      score: null,
      score_reason: null,
      created_at: '2026-03-19T00:00:00Z',
    });

    const onPlacedBet = vi.fn().mockResolvedValue(undefined);
    const { unmount: unmountLocked } = render(
      <PredictionModal
        scenarioId="scenario-lock-test"
        onClose={() => {}}
        onPlacedBet={onPlacedBet}
      />
    );

    const slider = screen.getByLabelText('prediction.lock.probability_label') as HTMLInputElement;
    expect(slider).toBeEnabled();
    fireEvent.change(slider, { target: { value: '0.85' } });

    await user.type(screen.getByLabelText('prediction.text_label'), 'Testing lock flow.');
    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(submitPrediction).toHaveBeenCalledWith(
      'scenario-lock-test',
      expect.any(String),
      0.85,
      expect.any(String),
      expect.any(String)
    );

    await waitFor(() => {
      expect(slider).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Locked' })).toBeDisabled();
    });
    unmountLocked();

    // 3. 409 duplicate submission surfaces the already-locked state and sets confidence
    vi.mocked(submitPrediction).mockRejectedValueOnce({
      status: 409,
      message: 'Already locked',
    });
    vi.mocked(listPredictions)
      .mockResolvedValueOnce([]) // for mount
      .mockResolvedValueOnce([   // for 409 catch
        {
          id: 'pred-already-locked',
          scenario_id: 'scenario-lock-test',
          user_name: 'Local Director',
          prediction_text: 'Locked prediction text',
          confidence: 0.9,
          score: null,
          score_reason: null,
          created_at: '2026-03-19T00:00:00Z',
        }
      ]);

    const { unmount: unmount409 } = render(
      <PredictionModal
        scenarioId="scenario-lock-test"
        onClose={() => {}}
      />
    );

    const slider409 = screen.getByLabelText('prediction.lock.probability_label') as HTMLInputElement;

    await user.type(screen.getByLabelText('prediction.text_label'), 'Another attempt.');
    await user.click(screen.getByRole('button', { name: 'prediction.submit' }));

    expect(await screen.findByText('prediction.lock.already_locked')).toBeInTheDocument();
    await waitFor(() => {
      expect(slider409).toBeDisabled();
      expect(Number(slider409.value)).toBe(0.9);
    });
    unmount409();
  });
});
