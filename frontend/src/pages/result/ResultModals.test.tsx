import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import ResultModals from './ResultModals';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { listModelProfiles } from '../../api/client';
import { useResultContext } from './ResultContext';
import type { ResultViewContextValue } from './ResultContext';
import type { ModelProfile } from '../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  listModelProfiles: vi.fn(),
}));

vi.mock('./ResultContext', () => ({
  useResultContext: vi.fn(),
}));

const mockProfiles: ModelProfile[] = [
  {
    id: 'profile-1',
    user_id: 'user-1',
    name: 'Profile 1',
    description: 'test model profile 1',
    provider: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    has_api_key: true,
    rpm: 100,
    tpm: 10000,
    concurrency: 5,
    supports_structured_outputs: true,
    supports_native_search: false,
    native_search_upstream: '',
    storage_notice: 'volatile',
    created_at: '2026-06-22T00:00:00Z',
    updated_at: '2026-06-22T00:00:00Z',
  },
  {
    id: 'profile-2',
    user_id: 'user-1',
    name: 'Profile 2',
    description: 'test model profile 2',
    provider: 'anthropic',
    base_url: 'https://api.anthropic.com/v1',
    model: 'claude-3-5',
    has_api_key: true,
    rpm: 50,
    tpm: 5000,
    concurrency: 2,
    supports_structured_outputs: true,
    supports_native_search: false,
    native_search_upstream: '',
    storage_notice: 'volatile',
    created_at: '2026-06-22T00:00:00Z',
    updated_at: '2026-06-22T00:00:00Z',
  },
];

const mockBranches = [
  { id: 'branch-1', title: 'Branch One', insight: 'Insight' },
];

const mockContext = {
  t: (key: string) => key,
  id: 'scenario-1',
  isReplayMode: false,
  showShare: false,
  setShowShare: vi.fn(),
  showSnapshotExport: false,
  setShowSnapshotExport: vi.fn(),
  scenario: { id: 'scenario-1', question: 'Test Question' },
  branches: mockBranches,
  agents: [{ id: 'agent-1', name: 'Agent 1' }],
  shareSourceFamilies: [],
  capabilities: {},
  activeScenarioId: 'scenario-1',
  primaryAgentIdentityId: null,
  isZh: false,
  resolvedProfileId: '',
  gameplayProfileLabel: '',
  gameplayProfileHooks: [],
  agentFollowupTarget: null,
  setAgentFollowupTarget: vi.fn(),
  analysisBranch: null,
};

const defaultProps = {
  shareFlavorContext: 'flavor-context' as unknown as Record<string, unknown>,
  setShareAutomation: vi.fn(),
  pendingEndingRoomPicker: {
    branchId: 'branch-1',
    roomType: 'ending_chamber' as const,
    selectedAgentIds: ['agent-1'],
    maxSelectable: 3,
  },
  setPendingEndingRoomPicker: vi.fn(),
  pendingEndingRoomBranch: mockBranches[0] as unknown as Record<string, unknown>,
  pendingEndingRoomCandidates: [
    { id: 'agent-1', name: 'Agent 1', role: 'Role 1', impactScore: 0.8, contributionCount: 5, keyMomentHits: 2, lastRound: 4 }
  ] as unknown as Record<string, unknown>[],
  endingRoomPickerDialogRef: { current: null },
  endingRoomPickerCloseRef: { current: null },
  openEndingRoomDirect: vi.fn(),
  activeEndingRoomBranch: null,
  activeEndingRoomMode: 'ending_chamber' as const,
  activeEndingRoomSelectedBranchIds: [],
  activeEndingRoomSelectedAgentIds: [],
  activeEndingRoomReplayPayload: null,
  endingRoomHeaderActions: null,
  setEndingRoomAutomation: vi.fn(),
  handleEndingRoomModeChange: vi.fn(),
  handleCloseEndingRoom: vi.fn(),
  sourceFamilyContext: {} as unknown as Record<string, unknown>[],
  mobileSourceSheetOpen: false,
  setMobileSourceSheetOpen: vi.fn(),
  resultConversationContext: null,
};

type CapabilityResult = ReturnType<typeof useCapabilityCheck>;

describe('ResultModals ending room picker model configuration disclosure', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(useResultContext).mockReturnValue(mockContext as unknown as ResultViewContextValue);
    vi.mocked(listModelProfiles).mockResolvedValue({ profiles: mockProfiles, count: mockProfiles.length });
  });

  it('renders disclosure triggers as closed by default when capability is enabled', async () => {
    vi.mocked(useCapabilityCheck).mockReturnValue({ enabled: true, loading: false, capabilities: null } as unknown as CapabilityResult);

    const { container } = render(<ResultModals {...(defaultProps as unknown as React.ComponentProps<typeof ResultModals>)} />);

    // Check advanced trigger is present
    const trigger = screen.getByRole('button', { name: /result.ending_room_advanced_expand_aria/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    // Check body is hidden via class or aria-hidden
    const body = container.querySelector('#ending-room-advanced-body');
    expect(body).toBeInTheDocument();
    expect(body).toHaveAttribute('aria-hidden', 'true');
    expect(body).toHaveAttribute('inert', '');
  });

  it('expands the disclosure and displays select option when trigger button is clicked', async () => {
    vi.mocked(useCapabilityCheck).mockReturnValue({ enabled: true, loading: false, capabilities: null } as unknown as CapabilityResult);

    const { container } = render(<ResultModals {...(defaultProps as unknown as React.ComponentProps<typeof ResultModals>)} />);

    const trigger = screen.getByRole('button', { name: /result.ending_room_advanced_expand_aria/i });
    fireEvent.click(trigger);

    // After click, expanded state changes
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-label', 'result.ending_room_advanced_collapse_aria');

    const body = container.querySelector('#ending-room-advanced-body');
    expect(body).toBeInTheDocument();
    expect(body).toHaveAttribute('aria-hidden', 'false');
    expect(body).not.toHaveAttribute('inert');

    // Options should be present
    await waitFor(() => {
      const select = screen.getByRole('combobox');
      expect(select).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /model_profiles.byok_custom_option/i })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: /Profile 1/i })).toBeInTheDocument();
    });
  });

  it('passes the selected profile id to openEndingRoomDirect when confirmed', async () => {
    vi.mocked(useCapabilityCheck).mockReturnValue({ enabled: true, loading: false, capabilities: null } as unknown as CapabilityResult);
    const openEndingRoomDirectMock = vi.fn();

    const propsWithMock = {
      ...defaultProps,
      openEndingRoomDirect: openEndingRoomDirectMock,
    };

    render(<ResultModals {...(propsWithMock as unknown as React.ComponentProps<typeof ResultModals>)} />);

    const trigger = screen.getByRole('button', { name: /result.ending_room_advanced_expand_aria/i });
    fireEvent.click(trigger);

    // Wait for the async listModelProfiles loading to update the select options
    await screen.findByRole('option', { name: /Profile 1/i });

    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'profile-1' } });

    const enterButton = screen.getByRole('button', { name: /result.ending_room_picker_enter/i });
    fireEvent.click(enterButton);

    expect(openEndingRoomDirectMock).toHaveBeenCalledWith(
      'branch-1',
      'ending_chamber',
      ['agent-1'],
      'profile-1'
    );
  });

  it('passes undefined to openEndingRoomDirect when no profile is selected', async () => {
    vi.mocked(useCapabilityCheck).mockReturnValue({ enabled: true, loading: false, capabilities: null } as unknown as CapabilityResult);
    const openEndingRoomDirectMock = vi.fn();

    const propsWithMock = {
      ...defaultProps,
      openEndingRoomDirect: openEndingRoomDirectMock,
    };

    render(<ResultModals {...(propsWithMock as unknown as React.ComponentProps<typeof ResultModals>)} />);

    const enterButton = screen.getByRole('button', { name: /result.ending_room_picker_enter/i });
    fireEvent.click(enterButton);

    expect(openEndingRoomDirectMock).toHaveBeenCalledWith(
      'branch-1',
      'ending_chamber',
      ['agent-1'],
      undefined
    );
  });

  it('does not render advanced settings section at all when capability is disabled', async () => {
    vi.mocked(useCapabilityCheck).mockReturnValue({ enabled: false, loading: false, capabilities: null } as unknown as CapabilityResult);

    render(<ResultModals {...(defaultProps as unknown as React.ComponentProps<typeof ResultModals>)} />);

    // Neither trigger nor body should exist in document
    expect(screen.queryByRole('button', { name: /result.ending_room_advanced_expand_aria/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('resets the disclosure and selected profile when the picker closes and reopens', async () => {
    vi.mocked(useCapabilityCheck).mockReturnValue({ enabled: true, loading: false, capabilities: null } as unknown as CapabilityResult);

    const { container, rerender } = render(<ResultModals {...(defaultProps as unknown as React.ComponentProps<typeof ResultModals>)} />);

    fireEvent.click(screen.getByRole('button', { name: /result.ending_room_advanced_expand_aria/i }));
    await screen.findByRole('option', { name: /Profile 1/i });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'profile-1' } });
    expect(screen.getByRole('combobox')).toHaveValue('profile-1');

    rerender(<ResultModals {...({
      ...defaultProps,
      pendingEndingRoomPicker: null,
      pendingEndingRoomBranch: null,
    } as unknown as React.ComponentProps<typeof ResultModals>)} />);
    rerender(<ResultModals {...(defaultProps as unknown as React.ComponentProps<typeof ResultModals>)} />);

    const trigger = screen.getByRole('button', { name: /result.ending_room_advanced_expand_aria/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('#ending-room-advanced-body')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(trigger);
    expect(screen.getByRole('combobox')).toHaveValue('');
  });

  it('clears stale profile options when the picker reload fails after reopening', async () => {
    vi.mocked(useCapabilityCheck).mockReturnValue({ enabled: true, loading: false, capabilities: null } as unknown as CapabilityResult);
    vi.mocked(listModelProfiles)
      .mockResolvedValueOnce({ profiles: mockProfiles, count: mockProfiles.length })
      .mockRejectedValueOnce(new Error('profile reload failed'));

    const { rerender } = render(<ResultModals {...(defaultProps as unknown as React.ComponentProps<typeof ResultModals>)} />);

    fireEvent.click(screen.getByRole('button', { name: /result.ending_room_advanced_expand_aria/i }));
    await screen.findByRole('option', { name: /Profile 1/i });

    rerender(<ResultModals {...({
      ...defaultProps,
      pendingEndingRoomPicker: null,
      pendingEndingRoomBranch: null,
    } as unknown as React.ComponentProps<typeof ResultModals>)} />);
    rerender(<ResultModals {...(defaultProps as unknown as React.ComponentProps<typeof ResultModals>)} />);

    await waitFor(() => expect(listModelProfiles).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /result.ending_room_advanced_expand_aria/i }));

    expect(screen.queryByRole('option', { name: /Profile 1/i })).not.toBeInTheDocument();
  });

  it('does not submit a selected profile after the model profiles capability turns off', async () => {
    let capabilityEnabled = true;
    vi.mocked(useCapabilityCheck).mockImplementation(() => ({
      enabled: capabilityEnabled,
      loading: false,
      capabilities: null,
    } as unknown as CapabilityResult));
    const openEndingRoomDirectMock = vi.fn();
    const propsWithMock = {
      ...defaultProps,
      openEndingRoomDirect: openEndingRoomDirectMock,
    };

    const { rerender } = render(<ResultModals {...(propsWithMock as unknown as React.ComponentProps<typeof ResultModals>)} />);

    fireEvent.click(screen.getByRole('button', { name: /result.ending_room_advanced_expand_aria/i }));
    await screen.findByRole('option', { name: /Profile 1/i });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'profile-1' } });

    capabilityEnabled = false;
    rerender(<ResultModals {...(propsWithMock as unknown as React.ComponentProps<typeof ResultModals>)} />);

    fireEvent.click(screen.getByRole('button', { name: /result.ending_room_picker_enter/i }));

    expect(openEndingRoomDirectMock).toHaveBeenCalledWith(
      'branch-1',
      'ending_chamber',
      ['agent-1'],
      undefined
    );
  });
});
