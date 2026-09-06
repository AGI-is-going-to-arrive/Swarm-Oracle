import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelProfile } from '../types';
import AnalystStreamView from './AnalystStreamView';
import {
  createInitialAnalystCache,
  type AnalystCacheState,
} from './postVerdictCaches';

const { startMock, abortMock } = vi.hoisted(() => ({
  startMock: vi.fn<(payload: Record<string, unknown>) => Promise<undefined>>(async () => undefined),
  abortMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../hooks/useRoundtableSseStream', () => ({
  useRoundtableSseStream: () => ({
    start: startMock,
    abort: abortMock,
  }),
}));

const mockProfiles: ModelProfile[] = [
  {
    id: 'profile-1',
    user_id: 'user-1',
    name: 'Profile One',
    provider: 'openai',
    model: 'gpt-4',
    has_api_key: true,
    supports_structured_outputs: true,
    supports_native_search: false,
    storage_notice: '',
    created_at: '',
    updated_at: '',
  },
];

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({ enabled: true }),
}));

vi.mock('../api/client', () => ({
  listModelProfiles: vi.fn(async () => ({ profiles: mockProfiles })),
  getRoundtableProvider: vi.fn(async () => ({ source: 'scenario_profile', profile_id: 'scene-profile', name: 'Inherited model', model: 'scene-model' })),
}));

function TestHarness() {
  const [cache, setCache] = useState<AnalystCacheState>(() => createInitialAnalystCache());
  return (
    <AnalystStreamView
      scenarioId="scenario-1"
      cache={cache}
      setCache={setCache}
      contextVersion={1}
    />
  );
}

describe('AnalystStreamView profile integration', () => {
  beforeEach(() => {
    startMock.mockClear();
    abortMock.mockClear();
  });

  it('sends only analyst_model_profile_id and excludes llm_* fields when a profile is selected', async () => {
    const user = userEvent.setup();
    render(<TestHarness />);

    // Wait for the select dropdown to load profiles
    await user.click(screen.getByText('roundtable.provider_change'));
    const select = await screen.findByLabelText('model_profiles.placeholder_select');
    expect(select).toBeInTheDocument();

    // Select profile-1
    await user.selectOptions(select, 'profile-1');

    // Type question and submit
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'What is the outlook?');

    const submitBtn = screen.getByRole('button', { name: 'roundtable.analyst_ask' });
    await user.click(submitBtn);

    expect(startMock).toHaveBeenCalledTimes(1);
    const startPayload = startMock.mock.calls[0][0];

    // Assert profile id is present and llm_* fields are excluded
    expect(startPayload).toHaveProperty('analyst_model_profile_id', 'profile-1');
    expect(startPayload).not.toHaveProperty('llm_api_key');
    expect(startPayload).not.toHaveProperty('llm_base_url');
    expect(startPayload).not.toHaveProperty('llm_model');
  });

  it('inherits the scenario model without session credentials when no override is selected', async () => {
    const user = userEvent.setup();
    render(<TestHarness />);

    await user.click(screen.getByText('roundtable.provider_change'));
    const select = await screen.findByLabelText('model_profiles.placeholder_select');
    // Keep the inherited provider selection.
    await user.selectOptions(select, '');

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'What is the outlook?');

    const submitBtn = screen.getByRole('button', { name: 'roundtable.analyst_ask' });
    await user.click(submitBtn);

    expect(startMock).toHaveBeenCalledTimes(1);
    const startPayload = startMock.mock.calls[0][0];

    // Inheritance is resolved by the server, without stale session credentials.
    expect(startPayload).not.toHaveProperty('analyst_model_profile_id');
    expect(startPayload).not.toHaveProperty('llm_api_key');
    expect(startPayload).not.toHaveProperty('llm_base_url');
    expect(startPayload).not.toHaveProperty('llm_model');
  });
});
