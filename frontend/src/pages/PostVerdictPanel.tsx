import { lazy, Suspense, useCallback, useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { EndingRoomParticipant, EndingRoomResult, SavedPostVerdictOutput, SavePostVerdictOutputRequest, SavedSurveyResponse } from '../types';
import { isApiError, savePostVerdictOutput } from '../api/client';
import SavedAnalysisArchive from './SavedAnalysisArchive';
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
  const [savedOutputs, setSavedOutputs] = useState<SavedPostVerdictOutput[]>([]);
  const [newOutput, setNewOutput] = useState<{ scenarioId: string; output: SavedPostVerdictOutput } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const archiveEpochRef = useRef(0);
  const savePendingRef = useRef(false);
  useEffect(() => {
    archiveEpochRef.current += 1;
    setSavedOutputs([]);
    setNewOutput(null);
    setSaveError(null);
    setSaving(false);
    savePendingRef.current = false;
    return () => { archiveEpochRef.current += 1; };
  }, [scenarioId, roomId, contextVersion]);
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

  const tabRefs = useRef<Record<PostVerdictTab, HTMLButtonElement | null>>({
    agent_chat: null,
    analyst: null,
    survey: null,
  });
  const pendingFocusTabRef = useRef<PostVerdictTab | null>(null);

  const [mountedTabs, setMountedTabs] = useState<Set<PostVerdictTab>>(() => new Set(['agent_chat', activeTab]));

  const handleTabChange = useCallback((tab: PostVerdictTab) => {
    setMountedTabs((prev) => {
      if (prev.has(tab)) return prev;
      return new Set(prev).add(tab);
    });
    onTabChange(tab);
  }, [onTabChange]);

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

  let savePayload: SavePostVerdictOutputRequest | null = null;
  if (
    effectiveActiveTab === 'analyst' && !analystCache.streaming && !analystCache.error
    && !analystCache.aborted && analystCache.stoppedReason === 'final_response'
    && analystCache.finalAnswer?.trim() && analystCache.resultId && analystCache.question
  ) {
    savePayload = {
      client_result_id: analystCache.resultId,
      kind: 'analyst', room_id: roomId, question: analystCache.question,
      provider: analystCache.provider, answer: analystCache.finalAnswer,
      stopped_reason: 'final_response',
    };
  }
  if (
    effectiveActiveTab === 'survey' && !surveyCache.streaming && !surveyCache.error
    && !surveyCache.aborted && surveyCache.resultId && surveyCache.question
    && surveyCache.participantOrder.length > 0
    && surveyCache.participantOrder.every((id) => {
      const response = surveyCache.responses.get(id);
      return response && !response.error && Boolean(response.answer.trim());
    })
  ) {
    const responses: SavedSurveyResponse[] = surveyCache.participantOrder.flatMap((id) => {
      const response = surveyCache.responses.get(id);
      return response ? [{
        participant_id: response.participant_id, display_name: response.display_name,
        role: response.role, source_agent_id: response.source_agent_id,
        source_branch_id: response.source_branch_id, agent_identity_id: response.agent_identity_id,
        answer: response.answer, elapsed_ms: response.elapsed_ms,
      }] : [];
    });
    savePayload = {
      client_result_id: surveyCache.resultId,
      kind: 'survey', room_id: roomId, question: surveyCache.question,
      provider: surveyCache.provider, participant_ids: surveyCache.participantOrder, responses,
    };
  }
  const alreadySaved = Boolean(savePayload && savedOutputs.some((item) => item.id === savePayload.client_result_id));
  const handleSave = async (): Promise<void> => {
    if (!savePayload || savePendingRef.current || alreadySaved) return;
    const epoch = archiveEpochRef.current;
    savePendingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const output = await savePostVerdictOutput(scenarioId, savePayload);
      if (archiveEpochRef.current === epoch) {
        setSavedOutputs((current) => [output, ...current.filter((item) => item.id !== output.id)]);
        setNewOutput({ scenarioId, output });
      }
    } catch (error: unknown) {
      if (archiveEpochRef.current === epoch) {
        setSaveError(isApiError(error) && error.code === 'SAVED_OUTPUT_LIMIT_REACHED' ? 'limit' : 'failed');
      }
    } finally {
      if (archiveEpochRef.current === epoch) {
        savePendingRef.current = false;
        setSaving(false);
      }
    }
  };

  useEffect(() => {
    if (pendingFocusTabRef.current && pendingFocusTabRef.current === effectiveActiveTab) {
      tabRefs.current[effectiveActiveTab]?.focus();
      pendingFocusTabRef.current = null;
    }
  }, [effectiveActiveTab]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, tabId: PostVerdictTab) => {
    const enabledTabs = tabs.filter((t) => !t.disabled || t.id === effectiveActiveTab);
    const currentIndex = enabledTabs.findIndex((t) => t.id === tabId);
    if (currentIndex === -1) return;

    let nextTab: PostVerdictTab | null = null;
    if (event.key === 'ArrowRight') {
      nextTab = enabledTabs[(currentIndex + 1) % enabledTabs.length]?.id ?? null;
    } else if (event.key === 'ArrowLeft') {
      nextTab = enabledTabs[(currentIndex - 1 + enabledTabs.length) % enabledTabs.length]?.id ?? null;
    } else if (event.key === 'Home') {
      nextTab = enabledTabs[0]?.id ?? null;
    } else if (event.key === 'End') {
      nextTab = enabledTabs[enabledTabs.length - 1]?.id ?? null;
    }

    if (nextTab && nextTab !== tabId) {
      event.preventDefault();
      pendingFocusTabRef.current = nextTab;
      handleTabChange(nextTab);
    }
  };

  const capabilityErrorPlaceholder = (reload?: () => Promise<void>) => (
    <div className="roundtable-post-verdict__placeholder" role="status">
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

  if (!effectiveResult) return null;

  return (
    <section className="roundtable-post-verdict" aria-label={t('roundtable.explore_tab')}>
      <div className="roundtable-post-verdict__tabs" role="tablist">
        {tabs.map((tab) => {
          const isSelected = effectiveActiveTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(el) => { tabRefs.current[tab.id] = el; }}
              type="button"
              role="tab"
              id={`pvp-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-disabled={tab.disabled || undefined}
              aria-controls={`pvp-panel-${tab.id}`}
              tabIndex={isSelected ? 0 : -1}
              className={`roundtable-post-verdict__tab ${isSelected ? 'is-active' : ''}`}
              onClick={() => handleTabChange(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, tab.id)}
              disabled={tab.disabled && !isSelected}
            >
              <span className="roundtable-post-verdict__tab-label">{tab.label}</span>
              <span className="roundtable-post-verdict__tab-desc">{tab.desc}</span>
            </button>
          );
        })}
      </div>

      {savePayload && (
        <div className="roundtable-post-verdict__save" style={{ marginBlock: '0.75rem' }}>
          <button type="button" className="btn btn--sm" disabled={saving || alreadySaved} onClick={() => void handleSave()}>
            {saving ? t('roundtable.output_saving') : alreadySaved ? t('roundtable.output_saved') : t('roundtable.output_save')}
          </button>
          <p>{t('roundtable.output_origin_notice')}</p>
        </div>
      )}
      {saveError && <p role="alert">{t(saveError === 'limit' ? 'roundtable.output_limit' : 'roundtable.output_save_failed')}</p>}
      <SavedAnalysisArchive scenarioId={scenarioId} roomId={roomId} refreshKey={contextVersion}
        newOutput={newOutput} onOutputsChange={setSavedOutputs} />

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
