import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProfile, RoundtableProviderSelection } from '../types';
import RoundtableProviderPicker from './RoundtableProviderPicker';

const { getProvider, listProfiles } = vi.hoisted(() => ({
  getProvider: vi.fn<() => Promise<RoundtableProviderSelection>>(),
  listProfiles: vi.fn<() => Promise<{ profiles: ModelProfile[] }>>(),
}));
vi.mock('../api/client', () => ({ getRoundtableProvider: getProvider, listModelProfiles: listProfiles }));
vi.mock('../hooks/useCapabilityCheck', () => ({ useCapabilityCheck: () => ({ enabled: true }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const inherited: RoundtableProviderSelection = {
  source: 'room_profile', profile_id: 'room-profile', name: 'Room model', model: 'bound-model',
};
const profile: ModelProfile = {
  id: 'profile-1', user_id: 'owner', name: 'Override profile', provider: 'openai', model: 'other-model',
  has_api_key: true, storage_notice: '', created_at: '', updated_at: '',
  supports_structured_outputs: null, supports_native_search: null,
};

describe('RoundtableProviderPicker', () => {
  beforeEach(() => {
    getProvider.mockReset().mockResolvedValue(inherited);
    listProfiles.mockReset().mockResolvedValue({ profiles: [profile] });
  });

  it('shows the inherited model and leaves overrides an explicit choice', async () => {
    const onChange = vi.fn();
    const onReadyChange = vi.fn();
    render(<RoundtableProviderPicker scenarioId="scenario" roomId="room" role="analyst"
      value="" onChange={onChange} onReadyChange={onReadyChange} disabled={false} />);
    expect(await screen.findByText(/Room model \(bound-model\)/)).toBeVisible();
    expect(screen.getByText('roundtable.provider_change').parentElement).not.toHaveAttribute('open');
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  });

  it('shows a retryable profile-list failure without changing the selected override', async () => {
    listProfiles.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RoundtableProviderPicker scenarioId="scenario" role="survey"
      value="profile-1" onChange={onChange} onReadyChange={vi.fn()} disabled={false} />);
    await user.click(screen.getByText('roundtable.provider_change'));
    expect(await screen.findByText('roundtable.profile_list_failed')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'common.retry' }));
    expect(await screen.findByRole('option', { name: 'Override profile (openai - other-model)' })).toBeInTheDocument();
    expect(screen.getByLabelText('model_profiles.placeholder_select')).toHaveValue('profile-1');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not authorize an inherited request until provider recovery succeeds', async () => {
    getProvider.mockRejectedValueOnce(new Error('profile deleted'));
    const user = userEvent.setup();
    const onReadyChange = vi.fn();
    render(<RoundtableProviderPicker scenarioId="scenario" role="analyst"
      value="" onChange={vi.fn()} onReadyChange={onReadyChange} disabled={false} />);
    expect(await screen.findByText('roundtable.provider_load_failed')).toBeVisible();
    expect(onReadyChange).toHaveBeenLastCalledWith(false);
    await user.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  });

  it('ignores provider results from the previous scenario', async () => {
    let resolveOld: ((value: RoundtableProviderSelection) => void) | undefined;
    getProvider.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const props = { role: 'analyst' as const, value: '', onChange: vi.fn(), onReadyChange: vi.fn(), disabled: false };
    const view = render(<RoundtableProviderPicker scenarioId="old" {...props} />);
    view.rerender(<RoundtableProviderPicker scenarioId="new" {...props} />);
    expect(await screen.findByText(/Room model \(bound-model\)/)).toBeVisible();
    await act(async () => { resolveOld?.({ ...inherited, name: 'Old scenario model' }); });
    expect(screen.queryByText(/Old scenario model/)).not.toBeInTheDocument();
  });
});
