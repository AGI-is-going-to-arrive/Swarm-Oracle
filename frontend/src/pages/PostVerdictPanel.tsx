import { lazy, Suspense, useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { EndingRoomParticipant, EndingRoomResult } from '../types';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import RoundtableAgentChat from './RoundtableAgentChat';
import type { AnalystCacheState, SurveyCacheState } from './postVerdictCaches';

const AnalystStreamView = lazy(() => import('./AnalystStreamView'));
const SurveyStreamView = lazy(() => import('./SurveyStreamView'));

export type PostVerdictTab = 'agent_chat' | 'analyst' | 'survey';

interface PostVerdictPanelProps {
  scenarioId: string;
  roomId?: string | null;
  participants: EndingRoomParticipant[];
  effectiveResult: EndingRoomResult | null;
  activeTab: PostVerdictTab;
  onTabChange: (tab: PostVerdictTab) => void;
  analystCache: AnalystCacheState;
  setAnalystCache: Dispatch<SetStateAction<AnalystCacheState>>;
  surveyCache: SurveyCacheState;
  setSurveyCache: Dispatch<SetStateAction<SurveyCacheState>>;
  contextVersion: number;
}

export default function PostVerdictPanel({
  scenarioId,
  roomId,
  participants,
  effectiveResult,
  activeTab,
  onTabChange,
  analystCache,
  setAnalystCache,
  surveyCache,
  setSurveyCache,
  contextVersion,
}: PostVerdictPanelProps) {
  const { t } = useTranslation();
  const {
    enabled: conversationEnabled,
    loading: conversationLoading,
    error: conversationError,
    reload: reloadConversationCapability,
  } = useCapabilityCheck('agent_conversation');
  const {
    enabled: analystEnabled,
    loading: analystLoading,
    error: analystError,
    reload: reloadAnalystCapability,
  } = useCapabilityCheck('roundtable_analyst');
  const {
    enabled: surveyEnabled,
    loading: surveyLoading,
    error: surveyError,
    reload: reloadSurveyCapability,
  } = useCapabilityCheck('roundtable_survey');

  const [mountedTabs, setMountedTabs] = useState<Set<PostVerdictTab>>(() => new Set(['agent_chat', activeTab]));

  const handleTabChange = useCallback((tab: PostVerdictTab) => {
    setMountedTabs((prev) => {
      if (prev.has(tab)) return prev;
      return new Set(prev).add(tab);
    });
    onTabChange(tab);
  }, [onTabChange]);

  if (!effectiveResult) return null;

  const tabs: { id: PostVerdictTab; label: string; desc: string; disabled: boolean }[] = [
    {
      id: 'agent_chat',
      label: t('roundtable.explore_agent_chat'),
      desc: t('roundtable.explore_agent_chat_desc'),
      disabled: !conversationEnabled && !conversationLoading && !conversationError,
    },
    {
      id: 'analyst',
      label: t('roundtable.explore_analyst'),
      desc: t('roundtable.explore_analyst_desc'),
      disabled: !analystEnabled && !analystLoading && !analystError,
    },
    {
      id: 'survey',
      label: t('roundtable.explore_survey'),
      desc: t('roundtable.explore_survey_desc'),
      disabled: !surveyEnabled && !surveyLoading && !surveyError,
    },
  ];
  const effectiveActiveTab = tabs.some((tab) => tab.id === activeTab && !tab.disabled)
    ? activeTab
    : (tabs.find((tab) => !tab.disabled)?.id ?? 'agent_chat');

  const capabilityErrorPlaceholder = (reload?: () => Promise<void>) => (
    <div className="roundtable-post-verdict__placeholder" role="alert" aria-live="polite">
      <strong>{t('common.capability_error_title', 'Cannot verify feature')}</strong>
      <span>{t('common.capability_error', 'Unable to verify feature availability. Please try again.')}</span>
      <button type="button" className="btn btn--sm" onClick={() => void reload?.()}>
        {t('common.retry', 'Retry')}
      </button>
    </div>
  );

  const streamSkeleton = (
    <div className="roundtable-post-verdict__placeholder">
      <span className="editorial-streaming-cursor">{t('roundtable.stream_loading')}</span>
    </div>
  );

  return (
    <section className="roundtable-post-verdict" aria-label={t('roundtable.explore_tab')}>
      <div className="roundtable-post-verdict__tabs" role="tablist">
        {tabs.map((tab) => {
          const isSelected = effectiveActiveTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`pvp-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-disabled={tab.disabled || undefined}
              aria-controls={`pvp-panel-${tab.id}`}
              className={`roundtable-post-verdict__tab ${isSelected ? 'is-active' : ''}`}
              onClick={() => handleTabChange(tab.id)}
              disabled={tab.disabled && !isSelected}
            >
              <span className="roundtable-post-verdict__tab-label">{tab.label}</span>
              <span className="roundtable-post-verdict__tab-desc">{tab.desc}</span>
            </button>
          );
        })}
      </div>

      <div
        id="pvp-panel-agent_chat"
        role="tabpanel"
        aria-labelledby="pvp-tab-agent_chat"
        style={{ display: effectiveActiveTab === 'agent_chat' ? undefined : 'none' }}
        aria-hidden={effectiveActiveTab !== 'agent_chat'}
      >
        {conversationError ? (
          capabilityErrorPlaceholder(reloadConversationCapability)
        ) : conversationEnabled ? (
          <RoundtableAgentChat scenarioId={scenarioId} participants={participants} />
        ) : (
          <div className="roundtable-post-verdict__placeholder">
            {t('roundtable.explore_agent_chat_placeholder')}
          </div>
        )}
      </div>

      <div
        id="pvp-panel-analyst"
        role="tabpanel"
        aria-labelledby="pvp-tab-analyst"
        style={{ display: effectiveActiveTab === 'analyst' ? undefined : 'none' }}
        aria-hidden={effectiveActiveTab !== 'analyst'}
      >
        {analystError ? (
          capabilityErrorPlaceholder(reloadAnalystCapability)
        ) : analystEnabled && mountedTabs.has('analyst') ? (
          <Suspense fallback={streamSkeleton}>
            <AnalystStreamView
              scenarioId={scenarioId}
              roomId={roomId}
              cache={analystCache}
              setCache={setAnalystCache}
              contextVersion={contextVersion}
            />
          </Suspense>
        ) : (
          <div className="roundtable-post-verdict__placeholder">
            {t('roundtable.explore_analyst_disabled')}
          </div>
        )}
      </div>

      <div
        id="pvp-panel-survey"
        role="tabpanel"
        aria-labelledby="pvp-tab-survey"
        style={{ display: effectiveActiveTab === 'survey' ? undefined : 'none' }}
        aria-hidden={effectiveActiveTab !== 'survey'}
      >
        {surveyError ? (
          capabilityErrorPlaceholder(reloadSurveyCapability)
        ) : surveyEnabled && mountedTabs.has('survey') ? (
          <Suspense fallback={streamSkeleton}>
            <SurveyStreamView
              scenarioId={scenarioId}
              roomId={roomId}
              participants={participants}
              cache={surveyCache}
              setCache={setSurveyCache}
              contextVersion={contextVersion}
            />
          </Suspense>
        ) : (
          <div className="roundtable-post-verdict__placeholder">
            {t('roundtable.explore_survey_disabled')}
          </div>
        )}
      </div>
    </section>
  );
}
