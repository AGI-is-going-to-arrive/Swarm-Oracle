import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import type { AgentInfo, ScenarioAgentProfileResponse } from '../../types';

vi.mock('../../api/client', () => ({
  getAgentProfileData: vi.fn(),
  normalizeScenarioAgentSource: (source: string | null | undefined) => {
    const normalized = String(source ?? '').trim().toLowerCase();
    if (normalized === 'generated' || normalized === 'custom' || normalized === 'replay') {
      return normalized;
    }
    return normalized ? 'unknown' : 'generated';
  },
}));

import { getAgentProfileData } from '../../api/client';
import { AgentProfileSheet } from './AgentProfileSheet';

const i18n = i18next.createInstance();

void i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        common: { close: 'Close', unknown: 'Unknown' },
        result: {
          agent_profile_sheet: {
            title: 'Agent Profile',
            description: 'View agent identity and growth history',
            close: 'Close',
            loading: 'Loading profile...',
            error: 'Failed to load agent profile',
            empty_memories: 'No cross-scenario memories yet',
            empty_events: 'No growth events yet',
            memories_title: 'Memories',
            events_title: 'Growth Events',
            retry: 'Retry',
            persona: 'Persona',
            no_persistent_identity: 'This agent is generated for this scenario only.',
            empty_history: 'No memories or growth events recorded yet.',
            source_custom: 'Custom',
            source_replay: 'Replay',
            source_generated: 'AI-generated',
            start_conversation: 'Start conversation',
          },
        },
      },
    },
  },
});

function makeAgent(overrides?: Partial<AgentInfo>): AgentInfo {
  return {
    id: 'agent-1',
    name: 'Ada',
    role: 'Systems analyst',
    persona: 'Reads the room before speaking.',
    tier: 'IMPORTANT',
    emotion: 'calm',
    agent_identity_id: 'identity-1',
    source_type: 'generated',
    ...overrides,
  };
}

function makeResponse(overrides?: Partial<ScenarioAgentProfileResponse>): ScenarioAgentProfileResponse {
  return {
    source: 'generated',
    identity_id: 'identity-1',
    profile: null,
    memories: [],
    growth_events: [],
    ...overrides,
  };
}

function renderSheet(agent: AgentInfo | null, onClose = vi.fn(), onStartConversation?: (agent: AgentInfo) => void) {
  return render(
    <I18nextProvider i18n={i18n}>
      <AgentProfileSheet
        agent={agent}
        userId="user-1"
        onClose={onClose}
        onStartConversation={onStartConversation}
      />
    </I18nextProvider>,
  );
}

const mockedGetAgentProfileData = vi.mocked(getAgentProfileData);

describe('AgentProfileSheet', () => {
  beforeEach(() => {
    mockedGetAgentProfileData.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when agent is null', () => {
    renderSheet(null);
    expect(screen.queryByTestId('agent-profile-sheet')).not.toBeInTheDocument();
    expect(mockedGetAgentProfileData).not.toHaveBeenCalled();
  });

  it('renders agent name, role, and source badge', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());

    renderSheet(makeAgent());

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Systems analyst')).toBeInTheDocument();
    expect(screen.getByText('AI-generated')).toBeInTheDocument();
    expect(screen.getByText('IMPORTANT')).toBeInTheDocument();
  });

  it('normalizes source badges before rendering', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse({ source: 'replay' }));

    renderSheet(makeAgent({ source_type: 'REPLAY' as AgentInfo['source_type'] }));

    expect(await screen.findByText('Replay')).toBeInTheDocument();
  });

  it('shows loading state while fetching', async () => {
    let resolveFetch: (value: ScenarioAgentProfileResponse) => void = () => {};
    mockedGetAgentProfileData.mockImplementationOnce(
      () =>
        new Promise<ScenarioAgentProfileResponse>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    renderSheet(makeAgent());

    expect(await screen.findByTestId('agent-profile-sheet-loading')).toBeInTheDocument();

    resolveFetch(makeResponse());
    await waitFor(() => expect(screen.queryByTestId('agent-profile-sheet-loading')).not.toBeInTheDocument());
  });

  it('shows error state with retry button on fetch failure', async () => {
    mockedGetAgentProfileData
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(makeResponse());

    renderSheet(makeAgent());

    const errorBox = await screen.findByTestId('agent-profile-sheet-error');
    expect(errorBox).toHaveTextContent('Failed to load agent profile');

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);

    await waitFor(() =>
      expect(screen.queryByTestId('agent-profile-sheet-error')).not.toBeInTheDocument(),
    );
    expect(mockedGetAgentProfileData).toHaveBeenCalledTimes(2);
  });

  it('shows empty history message when no memories or events', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());

    renderSheet(makeAgent());

    expect(await screen.findByTestId('agent-profile-sheet-empty')).toHaveTextContent(
      'No memories or growth events recorded yet.',
    );
  });

  it('calls onClose when the close button is clicked', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());
    const onClose = vi.fn();
    renderSheet(makeAgent(), onClose);

    await screen.findByTestId('agent-profile-sheet');
    fireEvent.click(screen.getByTestId('agent-profile-sheet-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('starts a conversation for non-replay agents', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());
    const onStartConversation = vi.fn();
    const agent = makeAgent();
    renderSheet(agent, vi.fn(), onStartConversation);

    await screen.findByTestId('agent-profile-sheet');
    fireEvent.click(screen.getByRole('button', { name: 'Start conversation' }));

    expect(onStartConversation).toHaveBeenCalledWith(agent);
  });

  it('does not show start conversation for replay agents', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse({ source: 'replay' }));
    renderSheet(makeAgent({ source_type: 'replay' }), vi.fn(), vi.fn());

    await screen.findByTestId('agent-profile-sheet');
    expect(screen.queryByRole('button', { name: 'Start conversation' })).not.toBeInTheDocument();
  });

  it('shows no-identity message and skips fetch when agent_identity_id is null', () => {
    renderSheet(makeAgent({ agent_identity_id: null }));

    expect(screen.getByTestId('agent-profile-sheet-no-identity')).toBeInTheDocument();
    expect(mockedGetAgentProfileData).not.toHaveBeenCalled();
  });

  it('renders persona inside a collapsible details element', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());

    renderSheet(makeAgent());

    await screen.findByTestId('agent-profile-sheet');
    const summary = screen.getByText('Persona');
    expect(summary.closest('details')).not.toBeNull();
    expect(screen.getByText('Reads the room before speaking.')).toBeInTheDocument();
  });

  it('renders memories and growth events when present', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(
      makeResponse({
        memories: [
          { summary: 'Met with the council', scenario_id: 's1', created_at: '2026-01-02T00:00:00Z' },
        ],
        growth_events: [
          {
            id: 'event-1',
            scenario_id: 's1',
            branch_id: null,
            round_number: 3,
            event_type: 'stance_shift',
            summary: 'Shifted towards diplomacy',
            metrics_json: null,
            created_at: '2026-01-05T00:00:00Z',
          },
        ],
      }),
    );

    renderSheet(makeAgent());

    await screen.findByTestId('agent-profile-sheet');
    expect(await screen.findByTestId('agent-profile-sheet-memories')).toHaveTextContent(
      'Met with the council',
    );
    expect(screen.getByTestId('agent-profile-sheet-events')).toHaveTextContent(
      'Shifted towards diplomacy',
    );
    expect(screen.queryByTestId('agent-profile-sheet-empty')).not.toBeInTheDocument();
  });

  it('race-guards: ignores stale fetch resolutions when agent changes mid-flight', async () => {
    let resolveFirst: (value: ScenarioAgentProfileResponse) => void = () => {};
    mockedGetAgentProfileData
      .mockImplementationOnce(
        () =>
          new Promise<ScenarioAgentProfileResponse>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          identity_id: 'identity-2',
          memories: [
            { summary: 'Newer memory', scenario_id: 's2', created_at: '2026-02-01T00:00:00Z' },
          ],
        }),
      );

    const { rerender } = renderSheet(makeAgent());
    await screen.findByTestId('agent-profile-sheet-loading');

    rerender(
      <I18nextProvider i18n={i18n}>
        <AgentProfileSheet
          agent={makeAgent({ id: 'agent-2', name: 'Bo', agent_identity_id: 'identity-2' })}
          userId="user-1"
          onClose={() => {}}
        />
      </I18nextProvider>,
    );

    resolveFirst(
      makeResponse({
        memories: [
          { summary: 'Stale memory', scenario_id: 's1', created_at: '2026-01-02T00:00:00Z' },
        ],
      }),
    );

    expect(await screen.findByText('Newer memory')).toBeInTheDocument();
    expect(screen.queryByText('Stale memory')).not.toBeInTheDocument();
  });
});
