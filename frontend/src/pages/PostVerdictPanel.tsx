import { lazy, Suspense, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EndingRoomParticipant, EndingRoomResult } from '../types';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import RoundtableAgentChat from './RoundtableAgentChat';
import type { AnalystCacheState } from './AnalystStreamView';
import type { SurveyCacheState } from './SurveyStreamView';

const AnalystStreamView = lazy(() => import('./AnalystStreamView'));
const SurveyStreamView = lazy(() => import('./SurveyStreamView'));

export type PostVerdictTab = 'agent_chat' | 'analyst' | 'survey';

interface PostVerdictPanelProps {
  scenarioId: string;
  participants: EndingRoomParticipant[];
  effectiveResult: EndingRoomResult | null;
  isZh: boolean;
  activeTab: PostVerdictTab;
  onTabChange: (tab: PostVerdictTab) => void;
  analystCacheRef: React.RefObject<AnalystCacheState>;
  analystVersion: number;
  bumpAnalyst: () => void;
  surveyCacheRef: React.RefObject<SurveyCacheState>;
  surveyVersion: number;
  bumpSurvey: () => void;
  onSheetClose?: () => void;
}

export default function PostVerdictPanel({
  scenarioId,
  participants,
  effectiveResult,
  isZh,
  activeTab,
  onTabChange,
  analystCacheRef,
  analystVersion,
  bumpAnalyst,
  surveyCacheRef,
  surveyVersion,
  bumpSurvey,
  onSheetClose: _onSheetClose,
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
              cacheRef={analystCacheRef}
              version={analystVersion}
              bumpVersion={bumpAnalyst}
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
              participants={participants}
              cacheRef={surveyCacheRef}
              version={surveyVersion}
              bumpVersion={bumpSurvey}
            />
          </Suspense>
        </div>
      )}
    </section>
  );
}
