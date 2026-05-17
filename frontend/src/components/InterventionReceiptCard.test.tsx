import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InterventionReceiptCard } from './InterventionReceiptCard';

const { getInterventionEffectsMock, languageState } = vi.hoisted(() => ({
  getInterventionEffectsMock: vi.fn(),
  languageState: { current: 'zh-CN' },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: languageState.current },
    t: (key: string, options?: Record<string, unknown>) => {
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

describe('InterventionReceiptCard', () => {
  beforeEach(() => {
    getInterventionEffectsMock.mockReset();
    languageState.current = 'zh-CN';
  });

  it('returns null when disabled (e.g. simulation not finished)', async () => {
    const { container } = render(
      <InterventionReceiptCard scenarioId="scenario-1" enabled={false} />,
    );
    await flushReceiptStateReset();
    expect(container).toBeEmptyDOMElement();
    expect(getInterventionEffectsMock).not.toHaveBeenCalled();
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
    expect(container.querySelector('[data-testid="intervention-receipt-card"]')).toBeNull();
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
});
