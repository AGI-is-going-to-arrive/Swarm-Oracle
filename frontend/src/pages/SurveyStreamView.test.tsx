import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EndingRoomParticipant, ModelProfile } from '../types';
import SurveyStreamView from './SurveyStreamView';
import {
  createInitialSurveyCache,
  type SurveyCacheState,
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

const mockPolicy = {
  apiKey: 'session-key',
  baseUrl: 'session-base',
  model: 'session-model',
};

vi.mock('../lib/llmProviderPolicy', () => ({
  loadLlmProviderPolicy: vi.fn(() => mockPolicy),
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
}));

const participants: EndingRoomParticipant[] = [
  {
    id: 'p1',
    room_id: 'room-1',
    role_slot: 'agent',
    display_name: 'Agent One',
  },
];

function TestHarness() {
  const [cache, setCache] = useState<SurveyCacheState>(() => createInitialSurveyCache());
  return (
    <SurveyStreamView
      scenarioId="scenario-1"
      participants={participants}
      cache={cache}
      setCache={setCache}
      contextVersion={1}
    />
  );
}

describe('SurveyStreamView profile integration', () => {
  beforeEach(() => {
    startMock.mockClear();
    abortMock.mockClear();
  });

  it('sends only survey_model_profile_id and excludes llm_* fields when a profile is selected', async () => {
    const user = userEvent.setup();
    render(<TestHarness />);

    // Wait for the select dropdown to load profiles
    const select = await screen.findByLabelText('model_profiles.placeholder_select');
    expect(select).toBeInTheDocument();

    // Select profile-1
    await user.selectOptions(select, 'profile-1');

    // Type question and submit
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'What is the outlook?');

    const submitBtn = screen.getByRole('button', { name: 'roundtable.survey_ask' });
    await user.click(submitBtn);

    expect(startMock).toHaveBeenCalledTimes(1);
    const startPayload = startMock.mock.calls[0][0];

    // Assert profile id is present and llm_* fields are excluded
    expect(startPayload).toHaveProperty('survey_model_profile_id', 'profile-1');
    expect(startPayload).not.toHaveProperty('llm_api_key');
    expect(startPayload).not.toHaveProperty('llm_base_url');
    expect(startPayload).not.toHaveProperty('llm_model');
  });

  it('sends llm_* fields and excludes survey_model_profile_id when no profile is selected', async () => {
    const user = userEvent.setup();
    render(<TestHarness />);

    const select = await screen.findByLabelText('model_profiles.placeholder_select');
    // Keep it on custom option (value = "")
    await user.selectOptions(select, '');

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'What is the outlook?');

    const submitBtn = screen.getByRole('button', { name: 'roundtable.survey_ask' });
    await user.click(submitBtn);

    expect(startMock).toHaveBeenCalledTimes(1);
    const startPayload = startMock.mock.calls[0][0];

    // Assert llm_* fields are sent and survey_model_profile_id is excluded
    expect(startPayload).not.toHaveProperty('survey_model_profile_id');
    expect(startPayload).toHaveProperty('llm_api_key', 'session-key');
    expect(startPayload).toHaveProperty('llm_base_url', 'session-base');
    expect(startPayload).toHaveProperty('llm_model', 'session-model');
  });
});
