import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EndingRoomParticipant } from '../types';
import AnalystStreamView from './AnalystStreamView';
import SurveyStreamView from './SurveyStreamView';
import {
  createInitialAnalystCache,
  createInitialSurveyCache,
  type AnalystCacheState,
  type SurveyCacheState,
} from './postVerdictCaches';

const { startMock, abortMock, latestStreamConfig } = vi.hoisted(() => ({
  startMock: vi.fn(async () => undefined),
  abortMock: vi.fn(() => {
    latestStreamConfig.onComplete?.();
  }),
  latestStreamConfig: {
    onComplete: null as null | (() => void),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../lib/llmProviderPolicy', () => ({
  loadLlmProviderPolicy: () => ({}),
}));

vi.mock('../hooks/useRoundtableSseStream', () => ({
  useRoundtableSseStream: (config: { onComplete: () => void }) => {
    latestStreamConfig.onComplete = config.onComplete;
    return {
      start: startMock,
      abort: abortMock,
    };
  },
}));

function AnalystHarness() {
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

const participants: EndingRoomParticipant[] = [
  {
    id: 'p1',
    room_id: 'room-1',
    role_slot: 'agent',
    display_name: 'Agent One',
  },
  {
    id: 'p2',
    room_id: 'room-1',
    role_slot: 'critic',
    display_name: 'Agent Two',
  },
];

function SurveyHarness() {
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

describe('post-verdict stream abort states', () => {
  beforeEach(() => {
    startMock.mockClear();
    abortMock.mockClear();
  });

  it('keeps an analyst abort visible even before the first streamed iteration', async () => {
    const user = userEvent.setup();
    render(<AnalystHarness />);

    await user.type(screen.getByRole('textbox'), 'What changes the outcome?');
    await user.click(screen.getByRole('button', { name: 'roundtable.analyst_ask' }));
    abortMock.mockClear();
    await user.click(screen.getByRole('button', { name: 'roundtable.analyst_stop' }));

    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('analyst.status_aborted')).toBeInTheDocument();
    expect(screen.queryByText('roundtable.explore_analyst_desc')).not.toBeInTheDocument();
  });

  it('keeps a survey abort visible even when no participant has answered yet', async () => {
    const user = userEvent.setup();
    render(<SurveyHarness />);

    await user.type(screen.getByRole('textbox'), 'Where do agents disagree?');
    await user.click(screen.getByRole('button', { name: 'roundtable.survey_ask' }));
    abortMock.mockClear();
    await user.click(screen.getByRole('button', { name: 'roundtable.survey_stop' }));

    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('survey.status_aborted')).toBeInTheDocument();
    expect(screen.queryByText('roundtable.survey_stream_failed')).not.toBeInTheDocument();
  });
});
