import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
          aria_headline_card: 'Headline Card: {{headline}}'
        }
      }
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

describe('SocialFeedPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
});
