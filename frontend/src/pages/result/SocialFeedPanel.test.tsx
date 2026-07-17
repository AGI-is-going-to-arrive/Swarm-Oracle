import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import i18n from 'i18next';
import SocialFeedPanel from './SocialFeedPanel';
import { getSocialFeed } from '../../api/client';
import type { SocialFeedResponse, SocialFeedEvent, SocialHeadlineCard } from '../../types';

// Mock getSocialFeed
vi.mock('../../api/client', () => ({
  getSocialFeed: vi.fn(),
}));

const useCapabilityCheckMock = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
}));

i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        social_feed: {
          section_title: 'Social Feed',
          headlines_title: 'Headline Cards',
          empty: 'No social feed events or headlines generated for this scenario.',
          disabled_explanation: 'Social Feed is disabled. Check capability settings.',
          error: 'Failed to load social feed.',
          retry: 'Retry',
          mode_deterministic: 'Deterministic',
          event_round: 'Round {{round}}',
          confidence_label: 'Group share',
          share_headline: 'Social Feed Headline',
          share_download: 'Download Headline Card',
          share_copy: 'Copy Headline Card',
          share_copied: 'Copied!',
          export_failed: 'Headline card export failed. Please try again.',
          copy_failed: 'Could not copy headline card. Try downloading instead.',
          aria_feed_list: 'Social Feed Events',
          aria_headline_card: 'Headline Card: {{headline}}',
          event_count: 'Showing {{visible}} of {{total}} events',
          event_count_truncated: 'Showing {{visible}} of {{loaded}} loaded events ({{total}} total)',
          show_more: 'Show more ({{count}} remaining)',
          show_first: 'Show first {{count}} only',
          truncated_notice: 'This feed contains the latest {{loaded}} of {{total}} projected events. The Agent Action Ledger preserves complete native agent actions; older faction projections may be unavailable here.',
          event_types: {
            post: 'Post',
            comment: 'Comment',
            reaction: 'Reaction',
            follow: 'Follow',
            mute: 'Mute',
            search: 'Search',
            trend: 'Trend',
            refresh: 'Refresh',
            idle: 'Idle',
            alliance_formed: 'Alliance formed',
            alliance_broken: 'Alliance broken',
            affect_shift_proxy: 'Affect shift (proxy)',
          },
        }
      }
    },
    zh: {
      translation: {
        social_feed: {
          section_title: '社交动态',
          headlines_title: '头条新闻卡片',
          event_round: '第 {{round}} 轮',
          confidence_label: '群体占比',
          aria_feed_list: '社交动态事件列表',
          aria_headline_card: '头条卡片：{{headline}}',
          event_types: {
            post: '发布动态',
            affect_shift_proxy: '情绪代理变化',
          },
        },
      },
    }
  }
});

const wellFormedFixture: SocialFeedResponse = {
  scenario_id: 'scenario-123',
  question: 'What happens if we block ports?',
  generation_mode: 'llm',
  events: [
    {
      event_id: 'event_1',
      round_number: 1,
      event_type: 'Conflict',
      branch_title: 'Port Blockade Active',
      faction_label: 'Military Faction',
      confidence: 0.9,
      summary: 'Military forces have established a blockade around the main harbor.',
    },
  ],
  headline_cards: [
    {
      card_id: 'card_1',
      headline: 'PORTS BLOCKED!',
      summary: 'Trade comes to a grinding halt.',
      branch_title: 'Port Blockade Active',
      round_number: 1,
      event_type: 'Economic Shock',
      faction_label: 'Logistics Guild',
      source_event_id: 'event_1',
    },
  ],
};

const deterministicFixture: SocialFeedResponse = {
  ...wellFormedFixture,
  generation_mode: 'deterministic',
};

const maliciousFixture: SocialFeedResponse = {
  scenario_id: 'scenario-123',
  question: 'What happens if we block ports?',
  generation_mode: 'llm',
  events: [
    {
      event_id: 'event_1',
      round_number: 1,
      event_type: 'Conflict',
      branch_title: 'Port Blockade Active',
      faction_label: 'Military Faction',
      confidence: 0.9,
      summary: 'Benign summary text',
      api_key: 'secret-api-key',
      base_url: 'secret-base-url',
      token: 'secret-token',
      Authorization: 'Bearer secret-auth',
    } as SocialFeedEvent,
  ],
  headline_cards: [
    {
      card_id: 'card_1',
      headline: 'PORTS BLOCKED!',
      summary: 'Benign headline summary',
      branch_title: 'Port Blockade Active',
      round_number: 1,
      event_type: 'Economic Shock',
      faction_label: 'Logistics Guild',
      source_event_id: 'event_1',
      api_key: 'secret-api-key',
      base_url: 'secret-base-url',
      token: 'secret-token',
      Authorization: 'Bearer secret-auth',
    } as SocialHeadlineCard,
  ],
};

function makeLargeFixture(
  scenarioId = 'scenario-123',
  label = 'Timeline event',
  eventCount = 50,
): SocialFeedResponse {
  return {
    ...wellFormedFixture,
    scenario_id: scenarioId,
    events: Array.from({ length: eventCount }, (_, index) => ({
      event_id: `${scenarioId}-event-${index + 1}`,
      round_number: index + 1,
      event_type: 'Update',
      branch_title: 'Main branch',
      faction_label: 'Observers',
      confidence: null,
      summary: `${label} ${index + 1}`,
    })),
  };
}

describe('SocialFeedPanel', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await i18n.changeLanguage('en');
  });

  it('renders loading state when capability loading', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: true,
      enabled: false,
      capabilities: null,
      error: null,
    });

    render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>
    );

    expect(screen.getByTestId('social-feed-skeleton')).toBeInTheDocument();
  });

  it('renders disabled explanation when capability is disabled and does not fetch', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
      error: null,
    });

    render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>
    );

    expect(screen.getByText('Social Feed is disabled. Check capability settings.')).toBeInTheDocument();
    expect(getSocialFeed).not.toHaveBeenCalled();
  });

  it('renders timeline events and headline cards from a well-formed fixture', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    vi.mocked(getSocialFeed).mockResolvedValue(wellFormedFixture);

    render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Social Feed')).toBeInTheDocument();
    });

    expect(screen.getByText('PORTS BLOCKED!')).toBeInTheDocument();
    expect(screen.getByText('Trade comes to a grinding halt.')).toBeInTheDocument();
    expect(screen.getByText('Military forces have established a blockade around the main harbor.')).toBeInTheDocument();
    expect(screen.getByText('Group share: 90%')).toBeInTheDocument();
    expect(screen.queryByText('Confidence: 90%')).not.toBeInTheDocument();
  });

  it('renders a bounded event window and makes every event keyboard-accessible in batches', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    vi.mocked(getSocialFeed).mockResolvedValue(makeLargeFixture());
    const user = userEvent.setup();

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>
    );

    expect(await screen.findByText('Timeline event 12')).toBeInTheDocument();
    expect(screen.queryByText('Timeline event 13')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.social-feed-event')).toHaveLength(12);
    expect(
      [...container.querySelectorAll('.social-feed-event__summary')].map((element) => element.textContent),
    ).toEqual(Array.from({ length: 12 }, (_, index) => `Timeline event ${index + 1}`));
    expect(screen.getByText('Showing 12 of 50 events')).toBeInTheDocument();

    const firstShowMore = screen.getByRole('button', { name: 'Show more (38 remaining)' });
    firstShowMore.focus();
    await user.keyboard('{Enter}');
    expect(container.querySelectorAll('.social-feed-event')).toHaveLength(24);
    expect(screen.getByText('Timeline event 24')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show more (26 remaining)' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Show more (26 remaining)' }));
    await user.click(screen.getByRole('button', { name: 'Show more (14 remaining)' }));
    await user.click(screen.getByRole('button', { name: 'Show more (2 remaining)' }));

    expect(container.querySelectorAll('.social-feed-event')).toHaveLength(50);
    expect(screen.getByText('Timeline event 50')).toBeInTheDocument();
    expect(
      [...container.querySelectorAll('.social-feed-event__summary')].map((element) => element.textContent),
    ).toEqual(Array.from({ length: 50 }, (_, index) => `Timeline event ${index + 1}`));
    expect(screen.getByText('Showing 50 of 50 events')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show first 12 only' })).toHaveFocus();
  });

  it('can collapse an expanded feed and resets the event window when the scenario changes', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    vi.mocked(getSocialFeed)
      .mockResolvedValueOnce(makeLargeFixture())
      .mockResolvedValueOnce(makeLargeFixture('scenario-456', 'New timeline event'));
    const user = userEvent.setup();

    const view = render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>
    );

    await user.click(await screen.findByRole('button', { name: 'Show more (38 remaining)' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(25);

    await user.click(screen.getByRole('button', { name: 'Show first 12 only' }));
    expect(screen.getByText('Timeline event 12')).toBeInTheDocument();
    expect(screen.queryByText('Timeline event 13')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Show more (38 remaining)' })).toHaveFocus();
    });

    await user.click(screen.getByRole('button', { name: 'Show more (38 remaining)' }));
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-456" />
      </I18nextProvider>,
    );

    expect(await screen.findByText('New timeline event 12')).toBeInTheDocument();
    expect(screen.queryByText('New timeline event 13')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 12 of 50 events')).toBeInTheDocument();
  });

  it('renders deterministic badge when generation_mode is deterministic', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    vi.mocked(getSocialFeed).mockResolvedValue(deterministicFixture);

    render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('deterministic-badge')).toBeInTheDocument();
    });
    expect(screen.getByText('Deterministic')).toBeInTheDocument();
  });

  it('reports the loaded and server totals honestly for a truncated feed', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    vi.mocked(getSocialFeed).mockResolvedValue({
      ...makeLargeFixture('scenario-123', 'Projected event', 256),
      total_event_count: 300,
      events_truncated: true,
    });

    render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>,
    );

    expect(await screen.findByText('Showing 12 of 256 loaded events (300 total)')).toBeInTheDocument();
    expect(screen.getByTestId('social-feed-truncated-notice')).toHaveTextContent(
      'This feed contains the latest 256 of 300 projected events.',
    );
    expect(screen.getByTestId('social-feed-truncated-notice')).toHaveTextContent(
      'older faction projections may be unavailable here',
    );
  });

  it('localizes native social action enums while preserving unknown event labels', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    vi.mocked(getSocialFeed).mockResolvedValue({
      ...wellFormedFixture,
      events: [
        { ...wellFormedFixture.events[0], event_type: 'POST' },
        {
          ...wellFormedFixture.events[0],
          event_id: 'event_unknown',
          event_type: 'Community pulse',
        },
      ],
      headline_cards: [
        { ...wellFormedFixture.headline_cards[0], event_type: 'REFRESH' },
      ],
    });

    render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>,
    );

    expect(await screen.findByText('Post')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.getByText('Community pulse')).toBeInTheDocument();
    expect(screen.queryByText('POST')).not.toBeInTheDocument();
    expect(screen.queryByText('REFRESH')).not.toBeInTheDocument();
  });

  it('localizes raw faction-derived types in Chinese deterministic events and headline cards', async () => {
    await i18n.changeLanguage('zh');
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    vi.mocked(getSocialFeed).mockResolvedValue({
      ...wellFormedFixture,
      generation_mode: 'deterministic',
      events: [{
        ...wellFormedFixture.events[0],
        event_type: 'affect shift (proxy)',
        faction_label: '观察者',
        branch_title: '主世界线',
        summary: '观察者在主世界线触发了情绪代理变化',
      }],
      headline_cards: [{
        ...wellFormedFixture.headline_cards[0],
        event_type: 'affect shift (proxy)',
        faction_label: '观察者',
        branch_title: '主世界线',
        headline: '观察者：情绪代理变化',
        summary: '观察者在主世界线触发了情绪代理变化',
      }],
    });

    render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>,
    );

    expect((await screen.findAllByText('情绪代理变化')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('观察者：情绪代理变化')).toBeInTheDocument();
    expect(screen.queryByText('affect shift (proxy)')).not.toBeInTheDocument();
  });

  it('does not throw and renders empty state on malformed feed response', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    vi.mocked(getSocialFeed).mockResolvedValue({
      scenario_id: 'scenario-123',
      question: 'broken',
      generation_mode: 'llm',
      events: null as never,
      headline_cards: undefined as never,
    } as SocialFeedResponse);

    render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('social-feed-empty')).toBeInTheDocument();
    });
    expect(screen.getByText('No social feed events or headlines generated for this scenario.')).toBeInTheDocument();
  });

  it('verifies that sensitive strings are not leaked even if malicious fields are present in the response', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    vi.mocked(getSocialFeed).mockResolvedValue(maliciousFixture);

    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Benign summary text')).toBeInTheDocument();
    });

    const content = container.textContent || '';
    expect(content).not.toContain('api_key');
    expect(content).not.toContain('base_url');
    expect(content).not.toContain('Bearer');
    expect(content).not.toContain('token');
    expect(content).not.toContain('secret-api-key');
    expect(content).not.toContain('secret-base-url');
    expect(content).not.toContain('secret-token');
    expect(content).not.toContain('secret-auth');
  });

  it('ignores a retry response after the scenario changes', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
    });
    let resolveRetry!: (value: SocialFeedResponse) => void;
    const retryResponse = new Promise<SocialFeedResponse>((resolve) => {
      resolveRetry = resolve;
    });
    vi.mocked(getSocialFeed)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockReturnValueOnce(retryResponse)
      .mockResolvedValueOnce({
        ...wellFormedFixture,
        scenario_id: 'scenario-456',
        headline_cards: [{
          ...wellFormedFixture.headline_cards[0],
          card_id: 'card-new',
          headline: 'NEW SCENARIO',
        }],
      });

    const view = render(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-123" />
      </I18nextProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <SocialFeedPanel scenarioId="scenario-456" />
      </I18nextProvider>,
    );
    expect(await screen.findByText('NEW SCENARIO')).toBeInTheDocument();

    await act(async () => {
      resolveRetry(wellFormedFixture);
      await retryResponse;
    });
    expect(screen.getByText('NEW SCENARIO')).toBeInTheDocument();
    expect(screen.queryByText('PORTS BLOCKED!')).not.toBeInTheDocument();
  });
});
