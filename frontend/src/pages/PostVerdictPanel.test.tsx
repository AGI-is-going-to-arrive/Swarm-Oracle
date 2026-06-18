import { cleanup, render, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PostVerdictPanel, { type PostVerdictTab } from './PostVerdictPanel';
import {
  createInitialAnalystCache,
  createInitialSurveyCache,
} from './postVerdictCaches';
import type { EndingRoomResult } from '../types';

const { capabilityValues } = vi.hoisted(() => ({
  capabilityValues: new Map<string, boolean>(),
}));
const { capabilityErrors, capabilityReloads } = vi.hoisted(() => ({
  capabilityErrors: new Map<string, Error>(),
  capabilityReloads: new Map<string, () => Promise<void>>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: (key: string) => ({
    loading: false,
    enabled: capabilityValues.get(key) ?? false,
    capabilities: null,
    error: capabilityErrors.get(key) ?? null,
    reload: capabilityReloads.get(key),
  }),
}));

vi.mock('./RoundtableAgentChat', () => ({
  default: () => <div data-testid="agent-chat" />,
}));

vi.mock('./AnalystStreamView', () => ({
  default: () => <div data-testid="analyst-stream" />,
}));

vi.mock('./SurveyStreamView', () => ({
  default: () => <div data-testid="survey-stream" />,
}));

function renderPanel(activeTab: PostVerdictTab) {
  return render(
    <PostVerdictPanel
      scenarioId="scenario-1"
      roomId="room-1"
      participants={[]}
      effectiveResult={{ summary: 'verdict ready' } as EndingRoomResult}
      activeTab={activeTab}
      onTabChange={vi.fn()}
      analystCache={createInitialAnalystCache()}
      setAnalystCache={vi.fn()}
      surveyCache={createInitialSurveyCache()}
      setSurveyCache={vi.fn()}
      contextVersion={1}
    />,
  );
}

describe('PostVerdictPanel defensive capability gates', () => {
  beforeEach(() => {
    capabilityValues.clear();
    capabilityErrors.clear();
    capabilityReloads.clear();
    capabilityValues.set('agent_conversation', true);
    capabilityValues.set('roundtable_analyst', false);
    capabilityValues.set('roundtable_survey', false);
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps an analyst tabpanel target when a stale active tab points to a disabled capability', () => {
    const { container } = renderPanel('analyst');

    const tab = container.querySelector('#pvp-tab-analyst');
    const panel = container.querySelector('#pvp-panel-analyst');
    expect(panel).not.toBeNull();
    expect(tab?.getAttribute('aria-controls')).toBe('pvp-panel-analyst');
    expect(tab).toHaveAttribute('aria-selected', 'false');
    expect(tab).toBeDisabled();
    expect(container.querySelector('#pvp-tab-agent_chat')).toHaveAttribute('aria-selected', 'true');
    expect(panel).toHaveTextContent('roundtable.explore_analyst_disabled');
    expect(panel?.querySelector('[data-testid="analyst-stream"]')).toBeNull();
  });

  it('keeps a survey tabpanel target when a stale active tab points to a disabled capability', () => {
    const { container } = renderPanel('survey');

    const tab = container.querySelector('#pvp-tab-survey');
    const panel = container.querySelector('#pvp-panel-survey');
    expect(panel).not.toBeNull();
    expect(tab?.getAttribute('aria-controls')).toBe('pvp-panel-survey');
    expect(tab).toHaveAttribute('aria-selected', 'false');
    expect(tab).toBeDisabled();
    expect(container.querySelector('#pvp-tab-agent_chat')).toHaveAttribute('aria-selected', 'true');
    expect(panel).toHaveTextContent('roundtable.explore_survey_disabled');
    expect(panel?.querySelector('[data-testid="survey-stream"]')).toBeNull();
  });

  it('keeps the fallback selected tab addressable when every capability is disabled', () => {
    capabilityValues.set('agent_conversation', false);

    const { container } = renderPanel('agent_chat');

    const tab = container.querySelector('#pvp-tab-agent_chat');
    const panel = container.querySelector('#pvp-panel-agent_chat');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toHaveAttribute('aria-disabled', 'true');
    expect(tab).not.toBeDisabled();
    expect(tab?.getAttribute('aria-controls')).toBe('pvp-panel-agent_chat');
    expect(panel).toHaveTextContent('roundtable.explore_agent_chat_placeholder');
    expect(panel?.querySelector('[data-testid="agent-chat"]')).toBeNull();
  });

  it('shows a retryable analyst capability probe error instead of disabled copy', () => {
    const reload = vi.fn(async () => undefined);
    capabilityErrors.set('roundtable_analyst', new Error('probe failed'));
    capabilityReloads.set('roundtable_analyst', reload);

    const { container } = renderPanel('analyst');

    const tab = container.querySelector('#pvp-tab-analyst');
    const panel = container.querySelector('#pvp-panel-analyst');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).not.toBeDisabled();
    expect(panel).toHaveTextContent('Cannot verify feature');
    expect(panel).not.toHaveTextContent('roundtable.explore_analyst_disabled');
    panel?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows a retryable survey capability probe error instead of disabled copy', () => {
    const reload = vi.fn(async () => undefined);
    capabilityErrors.set('roundtable_survey', new Error('probe failed'));
    capabilityReloads.set('roundtable_survey', reload);

    const { container } = renderPanel('survey');

    const tab = container.querySelector('#pvp-tab-survey');
    const panel = container.querySelector('#pvp-panel-survey');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).not.toBeDisabled();
    expect(panel).toHaveTextContent('Cannot verify feature');
    expect(panel).not.toHaveTextContent('roundtable.explore_survey_disabled');
    panel?.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('supports roving tabindex and ArrowLeft/Right keyboard navigation on tabs', () => {
    capabilityValues.set('agent_conversation', true);
    capabilityValues.set('roundtable_analyst', true);
    capabilityValues.set('roundtable_survey', true);

    const onTabChangeMock = vi.fn();
    const { container } = render(
      <PostVerdictPanel
        scenarioId="scenario-123"
        participants={[]}
        effectiveResult={{
          room_id: 'room-1',
          consensus_pct: 75,
          prosperity_index: 0.8,
          verdict_status: 'committed',
          verdict_narrative: 'Narrative',
        } as unknown as EndingRoomResult}
        activeTab="agent_chat"
        onTabChange={onTabChangeMock}
        analystCache={createInitialAnalystCache()}
        setAnalystCache={vi.fn()}
        surveyCache={createInitialSurveyCache()}
        setSurveyCache={vi.fn()}
        contextVersion={1}
      />
    );

    const tabChat = container.querySelector('#pvp-tab-agent_chat') as HTMLButtonElement;
    const tabAnalyst = container.querySelector('#pvp-tab-analyst') as HTMLButtonElement;
    const tabSurvey = container.querySelector('#pvp-tab-survey') as HTMLButtonElement;

    expect(tabChat).toHaveAttribute('tabIndex', '0');
    expect(tabAnalyst).toHaveAttribute('tabIndex', '-1');
    expect(tabSurvey).toHaveAttribute('tabIndex', '-1');

    tabChat.focus();
    fireEvent.keyDown(tabChat, { key: 'ArrowRight' });
    expect(onTabChangeMock).toHaveBeenCalledWith('analyst');
  });
});
