import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InterventionReceiptCard } from './InterventionReceiptCard';
import type { InterventionEffect } from '../api/client';
import i18n from '../i18n/config';

const { getInterventionEffectsMock, languageState } = vi.hoisted(() => ({
  getInterventionEffectsMock: vi.fn(),
  languageState: { current: 'zh-CN', realTranslations: false },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: languageState.current },
    t: (key: string, options?: Record<string, unknown>) => {
      if (languageState.realTranslations) return i18n.t(key, options ?? {});
      if (!options) return key;
      // Compose the rendered tail so substitutions like {{card}}, {{round}},
      // {{names}}, {{count}} surface in DOM text content for assertions.
      const tail = Object.entries(options)
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
      // Plural suffix for count-aware keys.
      if (typeof options.count === 'number') {
        const n = options.count as number;
        const suffix = n === 0 ? '_zero' : n === 1 ? '_one' : '_other';
        return `${key}${suffix}<${tail}>`;
      }
      return `${key}<${tail}>`;
    },
  }),
}));

vi.mock('../api/client', () => ({
  getInterventionEffects: getInterventionEffectsMock,
}));

async function flushReceiptStateReset(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function receipt(status: NonNullable<InterventionEffect['status']>): InterventionEffect {
  return {
    intervention_log_id: 'receipt-1', branch_id: 'branch-1', status, reason: null,
    refunded_points: 0, gameplay_usage_refunded: false, card_id: null, card_label: null,
    round_number: 2, affected_agents: [], response_excerpts: [], confidence: 0,
    no_response_detected: true, created_at: '2026-09-05T00:00:00Z',
  };
}

describe('InterventionReceiptCard', () => {
  beforeEach(() => {
    getInterventionEffectsMock.mockReset();
    languageState.current = 'zh-CN';
    languageState.realTranslations = false;
  });

  it('shows queued status without claiming execution or an absent response', async () => {
    getInterventionEffectsMock.mockResolvedValue({ effects: [receipt('queued')] });
    render(<InterventionReceiptCard scenarioId="scenario-1" enabled />);
    const card = await screen.findByTestId('intervention-receipt-card');
    expect(card).toHaveTextContent('intervention_receipt.status_queued');
    expect(card).not.toHaveTextContent('intervention_receipt.no_response');
    expect(screen.queryByTestId('intervention-receipt-card-confidence')).not.toBeInTheDocument();
  });

  it('localizes all lifecycle and refund states with the real Chinese and English resources', async () => {
    languageState.realTranslations = true;
    await i18n.changeLanguage('zh');
    getInterventionEffectsMock.mockResolvedValue({ effects: [
      { ...receipt('queued'), intervention_log_id: 'queued', reason: 'Waiting for the next available simulation round.' },
      { ...receipt('applied'), intervention_log_id: 'applied', reason: 'Applied to persisted agent responses before processing stopped.' },
      { ...receipt('expired'), intervention_log_id: 'expired', refunded_points: 3, gameplay_usage_refunded: true, reason: 'Scenario is cancelled; no remaining round can apply this intervention.' },
      { ...receipt('failed'), intervention_log_id: 'failed', reason: 'Intervention processing failed before completion.' },
    ] });
    const view = render(<InterventionReceiptCard scenarioId="scenario-1" enabled terminal />);
    const card = await screen.findByTestId('intervention-receipt-card');
    expect(card).toHaveTextContent('已排队');
    expect(card).toHaveTextContent('已执行');
    expect(card).toHaveTextContent('未执行，已过期');
    expect(card).toHaveTextContent('执行失败');
    expect(card).toHaveTextContent('已退还 3 点数');
    expect(card).toHaveTextContent('卡牌使用额度已退还');
    expect(card).toHaveTextContent('推演已取消，此干预尚未执行');
    expect(card).not.toHaveTextContent(/Waiting for|Scenario is|processing stopped|Intervention processing/);

    await i18n.changeLanguage('en');
    languageState.current = 'en';
    view.rerender(<InterventionReceiptCard scenarioId="scenario-1" enabled terminal />);
    expect(card).toHaveTextContent('Queued');
    expect(card).toHaveTextContent('Executed');
    expect(card).toHaveTextContent('Expired before execution');
    expect(card).toHaveTextContent('Execution failed');
    expect(card).toHaveTextContent('Points refunded: 3');
    expect(card).not.toHaveTextContent('推演已取消');
  });

  it('uses an expired receipt to replace stale live pending state and show its refund', async () => {
    const onRefundConfirmed = vi.fn();
    getInterventionEffectsMock.mockResolvedValue({ effects: [{
      ...receipt('expired'), refunded_points: 3, gameplay_usage_refunded: true,
      reason: 'Scenario is cancelled; no remaining round can apply this intervention.',
    }] });
    render(<InterventionReceiptCard scenarioId="scenario-1" enabled terminal interventionLifecycle={new Map([['receipt-1', 'queued']])} onRefundConfirmed={onRefundConfirmed} />);
    await waitFor(() => expect(screen.getByTestId('intervention-receipt-card')).toHaveTextContent('intervention_receipt.status_expired'));
    const card = screen.getByTestId('intervention-receipt-card');
    expect(card).toHaveTextContent('intervention_receipt.refunded_points_other<count=3>');
    expect(card).toHaveTextContent('intervention_receipt.usage_refunded');
    expect(card).toHaveTextContent('intervention_receipt.reason_scenario_cancelled');
    expect(card.querySelector('.receipt-pending')).toBeNull();
    expect(card).not.toHaveTextContent('intervention_receipt.no_response');
    expect(onRefundConfirmed).toHaveBeenCalledOnce();
  });

  it('renders failures separately from applied receipts and preserves recorded detail safely', async () => {
    getInterventionEffectsMock.mockResolvedValue({ effects: [{ ...receipt('failed'), reason: '<script>untrusted reason</script>' }] });
    render(<InterventionReceiptCard scenarioId="scenario-1" enabled terminal />);
    const card = await screen.findByTestId('intervention-receipt-card');
    expect(card).toHaveTextContent('intervention_receipt.status_failed');
    expect(card).toHaveTextContent('<script>untrusted reason</script>');
    expect(card.querySelector('script')).toBeNull();
    expect(card).not.toHaveTextContent('intervention_receipt.status_applied');
  });

  it('rechecks a queued terminal receipt until its persisted expiration arrives', async () => {
    vi.useFakeTimers();
    try {
      getInterventionEffectsMock.mockResolvedValueOnce({ effects: [receipt('queued')] }).mockResolvedValueOnce({ effects: [receipt('expired')] });
      render(<InterventionReceiptCard scenarioId="scenario-1" enabled terminal />);
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByText('intervention_receipt.final_pending')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(screen.getByText('intervention_receipt.status_expired')).toBeInTheDocument();
      expect(screen.queryByText('intervention_receipt.final_pending')).not.toBeInTheDocument();
      expect(getInterventionEffectsMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds settlement polling and keeps retry available without inventing an applied outcome', async () => {
    vi.useFakeTimers();
    try {
      getInterventionEffectsMock.mockResolvedValue({ effects: [receipt('queued')] });
      render(<InterventionReceiptCard scenarioId="scenario-1" enabled terminal />);
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(getInterventionEffectsMock).toHaveBeenCalledTimes(4);
      expect(screen.getByText('intervention_receipt.status_queued')).toBeInTheDocument();
      expect(screen.queryByText('intervention_receipt.status_applied')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
      await act(async () => { await Promise.resolve(); });
      expect(getInterventionEffectsMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not refetch for a same-content lifecycle map after a refund snapshot updates', async () => {
    getInterventionEffectsMock.mockResolvedValue({ effects: [{ ...receipt('expired'), refunded_points: 3 }] });
    const onRefundConfirmed = vi.fn();
    const view = render(<InterventionReceiptCard scenarioId="scenario-1" enabled terminal interventionLifecycle={new Map([['receipt-1', 'queued']])} onRefundConfirmed={onRefundConfirmed} />);
    await waitFor(() => expect(onRefundConfirmed).toHaveBeenCalledOnce());
    view.rerender(<InterventionReceiptCard scenarioId="scenario-1" enabled terminal interventionLifecycle={new Map([['receipt-1', 'queued']])} onRefundConfirmed={onRefundConfirmed} />);
    await act(async () => { await Promise.resolve(); });
    expect(getInterventionEffectsMock).toHaveBeenCalledTimes(1);
  });

  it('does not expose a previous scenario receipt if the next scenario read fails', async () => {
    getInterventionEffectsMock.mockResolvedValueOnce({ effects: [{ ...receipt('applied'), card_label: 'Old scenario card' }] }).mockRejectedValueOnce(new Error('new scenario unavailable'));
    const view = render(<InterventionReceiptCard scenarioId="scenario-1" enabled />);
    expect(await screen.findByTestId('intervention-receipt-card')).toHaveTextContent('Old scenario card');
    view.rerender(<InterventionReceiptCard scenarioId="scenario-2" enabled />);
    expect(await screen.findByTestId('intervention-receipt-card-error')).toBeInTheDocument();
    expect(screen.queryByText(/Old scenario card/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeEnabled();
  });

  it('returns null when disabled (e.g. simulation not finished)', async () => {
    const { container } = render(
      <InterventionReceiptCard scenarioId="scenario-1" enabled={false} />,
    );
    await flushReceiptStateReset();
    expect(container).toBeEmptyDOMElement();
    expect(getInterventionEffectsMock).not.toHaveBeenCalled();
  });

  it('renders no receipt DOM before effects for the current scenario load', async () => {
    getInterventionEffectsMock.mockReturnValueOnce(new Promise(() => {}));
    const { container, unmount } = render(
      <InterventionReceiptCard scenarioId="scenario-1" enabled />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('intervention-receipt-card')).toBeNull();
    unmount();
    await flushReceiptStateReset();
  });

  it('shows loading state then renders effect entries newest first', async () => {
    getInterventionEffectsMock.mockResolvedValueOnce({
      effects: [
        {
          intervention_log_id: 'log-new',
          card_id: 'human_takeover',
          card_label: '人类潜入',
          round_number: 2,
          affected_agents: [{ agent_id: 'a1', display_name: '审计官' }],
          response_excerpts: [
            { agent_id: 'a1', excerpt: '我们必须公开解释义务。' },
          ],
          confidence: 0.75,
          no_response_detected: false,
          created_at: '2026-05-17T10:00:00Z',
        },
        {
          intervention_log_id: 'log-old',
          card_id: null,
          card_label: null,
          round_number: 1,
          affected_agents: [],
          response_excerpts: [],
          confidence: 0.0,
          no_response_detected: true,
          created_at: '2026-05-17T09:00:00Z',
        },
      ],
    });

    render(<InterventionReceiptCard scenarioId="scenario-1" enabled />);

    // Wait for loading to resolve.
    await waitFor(() => {
      expect(screen.queryByTestId('intervention-receipt-card-loading')).toBeNull();
    });

    const card = await screen.findByTestId('intervention-receipt-card');
    expect(card).toBeInTheDocument();
    // Heading rendered for card variant — card_label and round propagated as i18n args.
    expect(card.textContent).toContain('人类潜入');
    expect(card.textContent).toContain('round=2');
    expect(card.textContent).toContain('round=1');
    // Speaker and excerpt rendered.
    expect(card.textContent).toContain('审计官');
    expect(card.textContent).toContain('公开解释义务');
    // No-response entry uses the silent confidence pill text.
    expect(card.textContent).toContain('intervention_receipt.no_response');
    // Confidence pill uses the high-tier label for the strong-echo entry.
    expect(card.textContent).toContain('intervention_receipt.confidence_high');
  });

  it('renders no DOM when the server returns an empty list', async () => {
    getInterventionEffectsMock.mockResolvedValueOnce({ effects: [] });
    const { container } = render(
      <InterventionReceiptCard scenarioId="scenario-1" enabled />,
    );
    await waitFor(() => {
      expect(getInterventionEffectsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('intervention-receipt-card-loading')).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('does not show stale receipts while a new scenario refetch is pending', async () => {
    let resolveSecondFetch: (payload: { effects: [] }) => void = () => {};
    getInterventionEffectsMock
      .mockResolvedValueOnce({
        effects: [
          {
            intervention_log_id: 'log-scenario-1',
            card_id: null,
            card_label: null,
            round_number: 1,
            affected_agents: [],
            response_excerpts: [],
            confidence: 0,
            no_response_detected: true,
            created_at: '2026-05-17T10:00:00Z',
          },
        ],
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecondFetch = resolve;
        }),
      );

    const { rerender, container } = render(
      <InterventionReceiptCard scenarioId="scenario-1" enabled />,
    );
    expect(await screen.findByTestId('intervention-receipt-card')).toBeInTheDocument();

    rerender(<InterventionReceiptCard scenarioId="scenario-2" enabled />);
    expect(screen.queryByTestId('intervention-receipt-card')).toBeNull();

    await act(async () => {
      resolveSecondFetch({ effects: [] });
    });
    await waitFor(() => {
      expect(getInterventionEffectsMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('shows error state when the request fails', async () => {
    getInterventionEffectsMock.mockRejectedValueOnce(new Error('boom'));
    render(<InterventionReceiptCard scenarioId="scenario-1" enabled />);
    const errorNode = await screen.findByTestId('intervention-receipt-card-error');
    expect(errorNode).toBeInTheDocument();
  });

  it('does not leak internal intervention_log_id into visible text', async () => {
    getInterventionEffectsMock.mockResolvedValueOnce({
      effects: [
        {
          intervention_log_id: 'secret-log-id-xyz',
          card_id: null,
          card_label: null,
          round_number: 3,
          affected_agents: [{ agent_id: 'a1', display_name: '顾问' }],
          response_excerpts: [
            { agent_id: 'a1', excerpt: 'we will adapt next round' },
          ],
          confidence: 0.4,
          no_response_detected: false,
          created_at: '2026-05-17T10:00:00Z',
        },
      ],
    });
    render(<InterventionReceiptCard scenarioId="scenario-1" enabled />);
    const card = await screen.findByTestId('intervention-receipt-card');
    expect(card.textContent).not.toContain('secret-log-id-xyz');
  });

  it('uses the singular receipt subtitle for one effect', async () => {
    getInterventionEffectsMock.mockResolvedValueOnce({
      effects: [
        {
          intervention_log_id: 'log-one',
          card_id: null,
          card_label: null,
          round_number: 1,
          affected_agents: [],
          response_excerpts: [],
          confidence: 0.2,
          no_response_detected: false,
          created_at: '2026-05-17T10:00:00Z',
        },
      ],
    });

    render(<InterventionReceiptCard scenarioId="scenario-1" enabled />);
    const card = await screen.findByTestId('intervention-receipt-card');
    expect(card.textContent).toContain('intervention_receipt.subtitle_one<count=1>');
    expect(card.textContent).not.toContain('intervention_receipt.subtitle_other<count=1>');
  });

  it('localizes card labels from card_id when UI language changes', async () => {
    languageState.current = 'en-US';
    getInterventionEffectsMock.mockResolvedValueOnce({
      effects: [
        {
          intervention_log_id: 'log-en',
          card_id: 'human_takeover',
          card_label: '人类潜入',
          round_number: 2,
          affected_agents: [],
          response_excerpts: [],
          confidence: 0,
          no_response_detected: true,
          created_at: '2026-05-17T10:00:00Z',
        },
      ],
    });

    render(<InterventionReceiptCard scenarioId="scenario-1" enabled />);
    const card = await screen.findByTestId('intervention-receipt-card');
    expect(card.textContent).toContain('Human Takeover');
    expect(card.textContent).not.toContain('人类潜入');
  });

  it('renders long affected agent names as visible text', async () => {
    const longName = 'AgentWithAnExtremelyLongUnbrokenDisplayNameForReceiptWrapping';
    getInterventionEffectsMock.mockResolvedValueOnce({
      effects: [
        {
          intervention_log_id: 'log-long-agent',
          card_id: null,
          card_label: null,
          round_number: 4,
          affected_agents: [{ agent_id: 'a-long', display_name: longName }],
          response_excerpts: [
            { agent_id: 'a-long', excerpt: 'The receipt should keep this readable.' },
          ],
          confidence: 0.5,
          no_response_detected: false,
          created_at: '2026-05-17T10:00:00Z',
        },
      ],
    });

    render(<InterventionReceiptCard scenarioId="scenario-1" enabled />);
    const card = await screen.findByTestId('intervention-receipt-card');
    expect(card.textContent).toContain(longName);
  });

  it('refetches when refreshKey changes', async () => {
    getInterventionEffectsMock.mockResolvedValue({ effects: [] });
    const { rerender } = render(
      <InterventionReceiptCard scenarioId="scenario-1" enabled refreshKey={0} />,
    );
    await waitFor(() => {
      expect(getInterventionEffectsMock).toHaveBeenCalledTimes(1);
    });
    rerender(<InterventionReceiptCard scenarioId="scenario-1" enabled refreshKey={1} />);
    await waitFor(() => {
      expect(getInterventionEffectsMock).toHaveBeenCalledTimes(2);
    });
  });

  it('does not fetch when scenarioId is empty', async () => {
    render(<InterventionReceiptCard scenarioId="" enabled />);
    await flushReceiptStateReset();
    expect(getInterventionEffectsMock).not.toHaveBeenCalled();
  });

  it('shows pending interventions when interventionLifecycle has queued or injected state', async () => {
    getInterventionEffectsMock.mockResolvedValueOnce({ effects: [] });
    const lifecycle = new Map<string, 'queued' | 'injected' | 'receipt_ready' | 'observed'>();
    lifecycle.set('int-1', 'queued');
    lifecycle.set('int-2', 'injected');

    render(
      <InterventionReceiptCard
        scenarioId="scenario-1"
        enabled
        interventionLifecycle={lifecycle}
      />,
    );

    const card = await screen.findByTestId('intervention-receipt-card');
    expect(card).toBeInTheDocument();

    // There are two pending items rendering the loading text
    expect(card.textContent).toContain('intervention_receipt.loading');
    expect(card.textContent).toContain('intervention_receipt.subtitle_pending_other<count=2>');
    expect(card.textContent).not.toContain('intervention_receipt.subtitle_zero');
  });

  it('hides pending interventions when they reach receipt_ready', async () => {
    getInterventionEffectsMock.mockResolvedValueOnce({ effects: [] });
    const lifecycle = new Map<string, 'queued' | 'injected' | 'receipt_ready' | 'observed'>();
    lifecycle.set('int-1', 'receipt_ready');

    const { container } = render(
      <InterventionReceiptCard
        scenarioId="scenario-1"
        enabled
        interventionLifecycle={lifecycle}
      />,
    );

    await waitFor(() => {
      expect(getInterventionEffectsMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('intervention-receipt-card-loading')).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
  });
});
