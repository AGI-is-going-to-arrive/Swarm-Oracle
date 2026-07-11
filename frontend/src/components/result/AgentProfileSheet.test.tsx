import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';

vi.mock('react-router-dom', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));
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
            state_reference_title: 'State reference',
            baseline_stance_label: 'Configured stance',
            observed_emotion_label: 'Observed emotion',
            configured_emotion_label: 'Configured starting emotion',
            snapshot_emotion_label: 'Scenario emotion snapshot',
            live_observation_source: 'Latest observed on {{branch}} · R{{round}}',
            replay_observation_source: 'Replay selection {{selectedBranch}} · R{{selectedRound}}; latest matching observation {{branch}} · R{{round}}',
            result_observation_source: 'Result branch {{selectedBranch}}; latest matching observation {{branch}} · R{{round}}',
            replay_no_observation_source: 'No matching observation in replay selection {{selectedBranch}} · R{{selectedRound}}.',
            no_observation_value: 'No matching observation',
            baseline_emotion_source: 'No message observation yet; showing the configured starting emotion.',
            snapshot_emotion_source: 'No branch and round observation context is available for this snapshot.',
            knowledge_domains_title: 'Knowledge domains',
            decision_bias_title: 'Decision style',
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

interface TestProfileObservation {
  emotion: string | null;
  source: 'live' | 'replay' | 'replay_unavailable' | 'result' | 'baseline' | 'snapshot';
  branchId: string | null;
  branchTitle: string | null;
  round: number | null;
  selectedBranchId?: string | null;
  selectedBranchTitle?: string | null;
  selectedRound?: number | null;
}

function renderSheet(
  agent: AgentInfo | null,
  onClose = vi.fn(),
  onStartConversation?: (agent: AgentInfo) => void,
  observation?: TestProfileObservation,
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <AgentProfileSheet
        agent={agent}
        userId="user-1"
        onClose={onClose}
        onStartConversation={onStartConversation}
        observation={observation}
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

  it('shows configured stance and a sourced observation instead of the mutable agent emotion', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(
      makeResponse({
        profile: {
          id: 'identity-1',
          user_id: 'user-1',
          kind: 'generated',
          display_name: 'Ada',
          role: 'Systems analyst',
          continuity_key: 'ada',
          decision_bias: {
            caution: 0.8,
            optimism: 'not-a-number',
            creativity: 2,
            unsafe_extra: '<script>',
          },
          knowledge_domains: ['technology', 'law'],
          created_at: null,
          updated_at: null,
        },
      }),
    );

    renderSheet(
      makeAgent({ stance: 'Protect the audit trail', emotion: 'stale-global-value' }),
      vi.fn(),
      undefined,
      {
        emotion: 'focused',
        source: 'live',
        branchId: 'branch-a',
        branchTitle: 'Audit survives',
        round: 4,
      },
    );

    expect(await screen.findByTestId('agent-profile-sheet-current-state')).toHaveTextContent(
      'Configured stanceProtect the audit trail',
    );
    expect(screen.getByTestId('agent-profile-sheet-current-state')).toHaveTextContent(
      'Observed emotionfocused',
    );
    expect(screen.getByTestId('agent-profile-sheet-current-state')).toHaveTextContent(
      'Latest observed on Audit survives · R4',
    );
    expect(screen.getByTestId('agent-profile-sheet-current-state')).not.toHaveTextContent(
      'stale-global-value',
    );
    expect(screen.getByTestId('agent-profile-sheet-domains')).toHaveTextContent('technology');
    expect(screen.getByTestId('agent-profile-sheet-domains')).toHaveTextContent('law');
    const bias = screen.getByTestId('agent-profile-sheet-decision-bias');
    expect(bias).toHaveTextContent('Caution');
    expect(bias).toHaveTextContent('80%');
    expect(bias).toHaveTextContent('Creativity');
    expect(bias).toHaveTextContent('100%');
    expect(bias).not.toHaveTextContent('Optimism');
    expect(bias).not.toHaveTextContent('unsafe_extra');
    expect(bias).not.toHaveTextContent('<script>');
  });

  it('labels an unscoped caller value as a scenario snapshot rather than a current or configured emotion', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());

    renderSheet(makeAgent({ emotion: 'calm-snapshot' }));

    const state = await screen.findByTestId('agent-profile-sheet-current-state');
    expect(state).toHaveTextContent('Scenario emotion snapshotcalm-snapshot');
    expect(state).toHaveTextContent(
      'No branch and round observation context is available for this snapshot.',
    );
    expect(state).not.toHaveTextContent('Configured starting emotion');
  });

  it('labels replay emotion with both the selected context and actual matching observation', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());

    renderSheet(
      makeAgent({ emotion: 'stale-other-branch' }),
      vi.fn(),
      undefined,
      {
        emotion: 'cautious',
        source: 'replay',
        branchId: 'root',
        branchTitle: 'Shared history',
        round: 1,
        selectedBranchId: 'child',
        selectedBranchTitle: 'Diplomatic fork',
        selectedRound: 2,
      },
    );

    expect(await screen.findByTestId('agent-profile-sheet-current-state')).toHaveTextContent(
      'Replay selection Diplomatic fork · R2; latest matching observation Shared history · R1',
    );
    expect(screen.getByTestId('agent-profile-sheet-current-state')).toHaveTextContent('cautious');
    expect(screen.getByTestId('agent-profile-sheet-current-state')).not.toHaveTextContent(
      'stale-other-branch',
    );
  });

  it('labels result emotion with both the target branch and actual evidence coordinates', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());

    renderSheet(
      makeAgent({ emotion: 'stale-result-value' }),
      vi.fn(),
      undefined,
      {
        emotion: 'cautious',
        source: 'result',
        branchId: 'root',
        branchTitle: 'Shared history',
        round: 1,
        selectedBranchId: 'child',
        selectedBranchTitle: 'Diplomatic fork',
      },
    );

    const state = await screen.findByTestId('agent-profile-sheet-current-state');
    expect(state).toHaveTextContent(
      'Result branch Diplomatic fork; latest matching observation Shared history · R1',
    );
    expect(state).toHaveTextContent('Observed emotioncautious');
    expect(state).not.toHaveTextContent('stale-result-value');
  });

  it('labels a result without matching evidence as the configured baseline', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());

    renderSheet(
      makeAgent({ emotion: 'configured-calm' }),
      vi.fn(),
      undefined,
      {
        emotion: 'configured-calm',
        source: 'baseline',
        branchId: null,
        branchTitle: null,
        round: null,
      },
    );

    const state = await screen.findByTestId('agent-profile-sheet-current-state');
    expect(state).toHaveTextContent('Configured starting emotionconfigured-calm');
    expect(state).toHaveTextContent(
      'No message observation yet; showing the configured starting emotion.',
    );
  });

  it('does not fall back to a cross-branch agent emotion when replay has no matching observation', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());

    renderSheet(
      makeAgent({ emotion: 'emotion-from-another-branch' }),
      vi.fn(),
      undefined,
      {
        emotion: null,
        source: 'replay_unavailable',
        branchId: null,
        branchTitle: null,
        round: null,
        selectedBranchId: 'child',
        selectedBranchTitle: 'Diplomatic fork',
        selectedRound: 2,
      },
    );

    const state = await screen.findByTestId('agent-profile-sheet-current-state');
    expect(state).toHaveTextContent('No matching observation');
    expect(state).toHaveTextContent(
      'No matching observation in replay selection Diplomatic fork · R2.',
    );
    expect(state).not.toHaveTextContent('emotion-from-another-branch');
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

  it('renders View memory inspector link when agent_identity_id is present', async () => {
    mockedGetAgentProfileData.mockResolvedValueOnce(makeResponse());
    renderSheet(makeAgent({ agent_identity_id: 'identity-123' }));

    expect(await screen.findByTestId('agent-profile-sheet-inspector')).toBeInTheDocument();
    const link = screen.getByTestId('agent-profile-sheet-inspector');
    expect(link).toHaveAttribute('href', '/agents/identities/identity-123/memories');
    expect(link.textContent).toBe('View memory inspector');
  });
});
