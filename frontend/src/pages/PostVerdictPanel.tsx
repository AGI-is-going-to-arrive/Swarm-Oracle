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
  isZh: boolean;
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
  isZh,
  activeTab,
  onTabChange,
  analystCache,
  setAnalystCache,
  surveyCache,
  setSurveyCache,
  contextVersion,
}: PostVerdictPanelProps) {
  const { t } = useTranslation();
  const { enabled: conversationEnabled, loading: conversationLoading } =
    useCapabilityCheck('agent_conversation');
  const { enabled: analystEnabled } = useCapabilityCheck('roundtable_analyst');
  const { enabled: surveyEnabled } = useCapabilityCheck('roundtable_survey');

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
      disabled: !conversationEnabled && !conversationLoading,
    },
    {
      id: 'analyst',
      label: t('roundtable.explore_analyst'),
      desc: t('roundtable.explore_analyst_desc'),
      disabled: !analystEnabled,
    },
    {
      id: 'survey',
      label: t('roundtable.explore_survey'),
      desc: t('roundtable.explore_survey_desc'),
      disabled: !surveyEnabled,
    },
  ];

  const streamSkeleton = (
    <div className="roundtable-post-verdict__placeholder">
      <span className="editorial-streaming-cursor">{t('roundtable.stream_loading')}</span>
    </div>
  );

  return (
    <section className="roundtable-post-verdict" aria-label={t('roundtable.explore_tab')}>
      <div className="roundtable-post-verdict__tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`pvp-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`pvp-panel-${tab.id}`}
            className={`roundtable-post-verdict__tab ${activeTab === tab.id ? 'is-active' : ''}`}
            onClick={() => handleTabChange(tab.id)}
            disabled={tab.disabled}
          >
            <span className="roundtable-post-verdict__tab-label">{tab.label}</span>
            <span className="roundtable-post-verdict__tab-desc">{tab.desc}</span>
          </button>
        ))}
      </div>

      <div
        id="pvp-panel-agent_chat"
        role="tabpanel"
        aria-labelledby="pvp-tab-agent_chat"
        style={{ display: activeTab === 'agent_chat' ? undefined : 'none' }}
        aria-hidden={activeTab !== 'agent_chat'}
      >
        {conversationEnabled ? (
          <RoundtableAgentChat scenarioId={scenarioId} participants={participants} isZh={isZh} />
        ) : (
          <div className="roundtable-post-verdict__placeholder">
            {t('roundtable.explore_agent_chat_placeholder')}
          </div>
        )}
      </div>

      {mountedTabs.has('analyst') && (
        <div
          id="pvp-panel-analyst"
          role="tabpanel"
          aria-labelledby="pvp-tab-analyst"
          style={{ display: activeTab === 'analyst' ? undefined : 'none' }}
          aria-hidden={activeTab !== 'analyst'}
        >
          <Suspense fallback={streamSkeleton}>
            <AnalystStreamView
              scenarioId={scenarioId}
              roomId={roomId}
              cache={analystCache}
              setCache={setAnalystCache}
              contextVersion={contextVersion}
            />
          </Suspense>
        </div>
      )}

      {mountedTabs.has('survey') && (
        <div
          id="pvp-panel-survey"
          role="tabpanel"
          aria-labelledby="pvp-tab-survey"
          style={{ display: activeTab === 'survey' ? undefined : 'none' }}
          aria-hidden={activeTab !== 'survey'}
        >
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
        </div>
      )}
    </section>
  );
}
