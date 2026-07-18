/* ═══════════════════════════════════════════════════════════
   SwarmOracle — ResultView (Multi-Ending Comparison)
   ═══════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo, useCallback, useRef, useId, type FocusEvent } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  createReplayArtifact,
  exportScenario,
  finalizeCampaign,
  getAgents,
  getCampaignBadges,
  getCampaignMastery,
  getCampaignProfile,
  getCampaignScenarioSummary,
  getCampaignWeeklySummary,
  getReplayArtifact,
  getScenario,
  getSessionBoundUserId,
  importReplayScenario,
  getStory,
  listPredictions,
  scorePredictions,
} from '../api/client';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import { getDirectorIdentity } from '../lib/directorIdentity';
import {
  buildBranchEndingRoomCandidates,
} from '../lib/endingRoomCandidates';
import { buildSharedChallengeUrl } from '../lib/challengeShare';
import { copyText } from '../lib/copyText';
import { buildAutomationErrorState, getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { loadLlmProviderPolicy, validateByok } from '../lib/llmProviderPolicy';
import { getReportDisclaimerText } from './result/reportDisclaimer';
import { formatPremortemMarkdown } from './result/PremortemAnalysisBlock';
import {
  buildOracleReplayLocalUrl,
  buildOracleReplayShareUrl,
  buildOracleReplayUrl,
  loadOracleReplayLocalCopy,
  normalizeOracleReplayPayload,
  readOracleReplayPayload,
  saveOracleReplayLocalCopy,
  sanitizeOracleReplayPayload,
  type OracleReplayPayload,
} from '../lib/oracleReplay';
import { isReplayEnvelopeLikelyTooLarge } from '../lib/replayCodec';
import {
  challengeDateKey,
  findChallengeProgressByScenarioId,
  markChallengeCompleted,
} from '../lib/dailyChallenge';
import { buildArchiveSummary, getDirectorStyleLabel } from '../lib/archiveSummary';
import {
  ensureScenarioObjectivesInMemory,
  getScenarioArchiveKeyMoments,
  loadScenarioMeta,
  mergeScenarioArchive,
  subscribeScenarioMeta,
  type ScenarioMeta,
} from '../lib/scenarioMeta';
import { hasScenarioDirectorAuthority } from '../lib/scenarioDirectorState';
import { hasScenarioGameplayAuthority } from '../lib/scenarioGameplayState';
import { mergeScenarioMetaAuthority } from '../lib/scenarioAuthority';
import {
  buildDefaultDirectorObjectives,
  countCompletedObjectives,
  evaluateDirectorObjectives,
} from '../lib/directorObjectives';
import {
  resolveStructuredBetOutcome,
} from '../lib/predictionBetting';
import { type ShareFlavorContext } from '../lib/shareEnvelope';
import {
  getScenarioRuntimePresetConfig,
  loadScenarioRuntimePreset,
  matchScenarioRuntimePreset,
} from '../lib/runtimePreset';
import {
  getGameplayCardDefinition,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
  getGameplayProfileTacticalState,
  getScenarioSystemTrackState,
  getGameplaySignatureArcState,
  inferGameplayProfile,
} from '../components/gameplayCards';
import {
  type ScenarioResultReplayPayload,
} from '../lib/scenarioReplay';
import { useEndingRoomStore } from '../stores/endingRoomStore';
import { useUIPreferencesStore } from '../stores/uiPreferencesStore';
import type {
  AgentInfo,
  CampaignFinalizeResult,
  CampaignScenarioSummary,
  CampaignWeeklySummary,
  PredictionInfo,
  Scenario,
  StoryData,
  ScorePredictionResultItem,
} from '../types';
import { WeeklyLeaderboard } from '../components/campaign';
import {
  buildCampaignSummaryFromExistingData,
  buildMomentHighlights,
  buildStoryKeyMoments,
  classifyCampaignFinalizeError,
  formatArchiveKeyMoment,
  getCampaignBadgeCopy,
  getCampaignBoundaryMessage,
  readCachedCampaignFinalizeResult,
  writeCachedCampaignFinalizeResult,
} from './resultHelpers';
import './ResultView.css';
import HOPsAnimation from '../components/result/HOPsAnimation';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { HookSummaryPanel } from '../components/result/HookSummaryPanel';
import { DirectorDebriefPanel } from '../components/result/DirectorDebriefPanel';
import { ProgressIndicator } from '../components/ProgressIndicator';
import { ResultContextProvider, type ResultViewContextValue } from './result/ResultContext';
import ResultHeader from './result/ResultHeader';
import SocialFeedPanel from './result/SocialFeedPanel';
import { MultiRunDistributionPanel } from '../components/result/MultiRunDistributionPanel';
import { MultiRunWaitingPanel } from '../components/result/MultiRunWaitingPanel';
import ResultVerdictPanel from './result/ResultVerdictPanel';
import {
  ResultReportPanel,
  resolveReportContentLanguage,
} from './result/ResultReportPanel';
import EndingCardsGrid from './result/EndingCardsGrid';
import DomainWorldStrip from '../components/domainWorld/DomainWorldStrip';
import WorldOutcomesSection from '../components/domainWorld/WorldOutcomesSection';
import ExploreDeeperBridge from './result/ExploreDeeperBridge';
import UnifiedSourceFeed from '../components/result/UnifiedSourceFeed';
import PredictionsSection from './result/PredictionsSection';
import DirectorNotebook from './result/DirectorNotebook';
import AgentRoster from './result/AgentRoster';
import ResultModals from './result/ResultModals';
import { AgentProfileSheet } from '../components/result/AgentProfileSheet';
import { buildAgentProfileObservation } from '../lib/agentProfileObservation';

const loadScenarioReplayHelpers = () => import('../lib/scenarioReplay');
const EMPTY_GAMEPLAY_PROFILE_HOOKS: string[] = [];
const EMPTY_SOURCE_FAMILY_CONTEXT = {};

type SourceFamilyContext = NonNullable<NonNullable<Scenario['web_search_context']>['family_context']>;


export default function ResultView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const replayToken = searchParams.get('replay');
  const replayShareId = searchParams.get('share');
  const roomReplayShareId = searchParams.get('roomShare');
  const roomReplayLocalId = searchParams.get('roomLocal');
  const roomReplayToken = searchParams.get('roomReplay');
  const debugEndingRoomBranch = searchParams.get('debugEndingRoomBranch');
  const debugEndingRoomMode = searchParams.get('debugEndingRoomMode');
  const debugEndingRoomAgents = searchParams.get('debugEndingRoomAgents');
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const directorIdentity = getDirectorIdentity();
  const apiUserId = getSessionBoundUserId();

  const {
    capabilities,
    loading: capLoading,
    error: capError = null,
    reload: reloadCapabilities,
  } = useCapabilityCheck('causal_graph');
  const resultVerdictEnabled = capabilities?.result_verdict?.enabled ?? false;
  const resultViewMode = useUIPreferencesStore((state) => state.resultViewMode);
  const setResultViewMode = useUIPreferencesStore((state) => state.setResultViewMode);
  const isWorkbenchMode = resultViewMode === 'workbench';
  const [cfBranchId, setCfBranchId] = useState<string | null>(null);
  const [cfInitialRound, setCfInitialRound] = useState<number | undefined>(undefined);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [debriefOpen, setDebriefOpen] = useState(false);
  // 默认展开:来源是可信度凭证,应当默认可见(对齐 visual-plan.html 方案 C 内联流);
  // 长度由 feed 内部 cap(默认 6 条 + 加载更多)控制,用户仍可手动收起。
  const [webSourcesOpen, setWebSourcesOpen] = useState(true);
  const blurCollapsedPanelFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    event.preventDefault();
    (event.target as HTMLElement | null)?.blur?.();
  }, []);
  const [storyData, setStoryData] = useState<StoryData | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentFollowupTarget, setAgentFollowupTarget] = useState<AgentInfo | null>(null);
  const [profileTarget, setProfileTarget] = useState<AgentInfo | null>(null);
  const [predictions, setPredictions] = useState<PredictionInfo[]>([]);
  const [scoreResults, setScoreResults] = useState<ScorePredictionResultItem[]>([]);
  const [expandedBranch, setExpandedBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const exportResetTimerRef = useRef<number | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [showSnapshotExport, setShowSnapshotExport] = useState(false);
  const [activeEndingRoomBranchId, setActiveEndingRoomBranchId] = useState<string | null>(null);
  const [activeEndingRoomMode, setActiveEndingRoomMode] = useState<'ending_chamber' | 'one_move_only' | 'crossline_gallery'>('ending_chamber');
  const [activeEndingRoomSelectedAgentIds, setActiveEndingRoomSelectedAgentIds] = useState<string[]>([]);
  const [activeEndingRoomModelProfileId, setActiveEndingRoomModelProfileId] = useState<string>('');
  const [pendingEndingRoomPicker, setPendingEndingRoomPicker] = useState<{
    branchId: string;
    roomType: 'ending_chamber' | 'one_move_only';
    selectedAgentIds: string[];
    maxSelectable: number;
  } | null>(null);
  const endingRoomPickerDialogRef = useRef<HTMLDivElement | null>(null);
  const endingRoomPickerCloseRef = useRef<HTMLButtonElement | null>(null);
  const endingRoomAutomationRef = useRef<Record<string, unknown> | null>(null);
  const debugEndingRoomAppliedRef = useRef(false);
  const setEndingRoomAutomation = useCallback((value: Record<string, unknown> | null) => {
    endingRoomAutomationRef.current = value;
  }, []);
  const [challengeLinkCopied, setChallengeLinkCopied] = useState(false);
  const [permalinkCopied, setPermalinkCopied] = useState(false);
  const [endingRoomPermalinkCopied, setEndingRoomPermalinkCopied] = useState(false);
  const [endingRoomLocalCopySaved, setEndingRoomLocalCopySaved] = useState(false);
  const challengeLinkCopiedTimerRef = useRef<number | null>(null);
  const permalinkCopiedTimerRef = useRef<number | null>(null);
  const endingRoomPermalinkCopiedTimerRef = useRef<number | null>(null);
  const endingRoomLocalCopySavedTimerRef = useRef<number | null>(null);
  const [importingEndingRoomReplay, setImportingEndingRoomReplay] = useState(false);
  // FE-5: mobile source sheet visibility (R1 FM5)
  const [mobileSourceSheetOpen, setMobileSourceSheetOpen] = useState(false);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const replayUrlPromiseRef = useRef<Promise<string | null> | null>(null);
  const replayUrlGenerationRef = useRef({ epoch: 0, scenarioId: null as string | null });
  const [replayPayload, setReplayPayload] = useState<ScenarioResultReplayPayload | null>(null);
  const [replayEndingRoomPayload, setReplayEndingRoomPayload] = useState<OracleReplayPayload | null>(null);
  const [shareAutomation, setShareAutomation] = useState<Record<string, unknown> | null>(null);
  const [importingReplay, setImportingReplay] = useState(false);
  const [importError, setImportError] = useState('');
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState('');
  const [campaignSummary, setCampaignSummary] = useState<CampaignFinalizeResult | null>(null);
  const [campaignScenarioSummary, setCampaignScenarioSummary] = useState<CampaignScenarioSummary | null>(null);
  const [weeklySummary, setWeeklySummary] = useState<CampaignWeeklySummary | null>(null);
  const [weeklySummaryLoading, setWeeklySummaryLoading] = useState(false);
  const [weeklySummaryError, setWeeklySummaryError] = useState(false);
  const [campaignError, setCampaignError] = useState('');
  const [campaignNotice, setCampaignNotice] = useState('');
  const [derivedScenarioMeta, setDerivedScenarioMeta] = useState<ScenarioMeta | null>(null);
  const [localMetaRevision, setLocalMetaRevision] = useState(0);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  // Multi-run completion refetches final scenario state exactly once. The load
  // effect clears state and unmounts the panel; the remounted panel would
  // otherwise re-fire onRefresh and loop, so guard it to a single trigger.
  const refreshTriggeredRef = useRef(false);
  const refresh = useCallback(() => {
    if (refreshTriggeredRef.current) return;
    refreshTriggeredRef.current = true;
    setRefreshTrigger((prev) => prev + 1);
  }, []);
  const reportRefreshSeqRef = useRef(0);
  useEffect(() => {
    reportRefreshSeqRef.current += 1;
  }, [id]);
  // 内联报告页「重新生成报告」完成后局部重拉 story 同步最新 full_report，避免
  // ResultReportPanel 无 onRefresh 时走 window.location.reload 硬刷整页（丢失本页其它
  // 状态）。不复用上面一次性的 refresh：那是 multi-run 完成专用（once-guard + 经
  // refreshTrigger 触发会清空 storyData 的 load effect、会重挂面板）；报告可多次重
  // 生成，故独立局部刷新，不清状态、不重挂、稳定引用避免 panel onRefresh effect 抖动。
  const refreshReportData = useCallback(() => {
    if (!id) return;
    const requestSeq = reportRefreshSeqRef.current + 1;
    reportRefreshSeqRef.current = requestSeq;
    void getStory(id)
      .then((story) => {
        if (reportRefreshSeqRef.current !== requestSeq) return;
        setStoryData((prev) =>
          prev ? { ...story, question: story.question || prev.question } : story,
        );
      })
      .catch((err: unknown) => {
        if (reportRefreshSeqRef.current !== requestSeq) return;
        console.error('Failed to refresh result report data:', err);
      });
  }, [id]);
  const endingRoomLiveSnapshot = useEndingRoomStore((state) => state.snapshot);
  const endingRoomLiveResult = useEndingRoomStore((state) => state.result);
  const endingRoomLiveActiveThreadId = useEndingRoomStore((state) => state.activeThreadId);
  const isReplayMode = Boolean(replayPayload);
  const activeScenarioId = scenario?.id ?? id ?? replayPayload?.scenario.id ?? null;
  useEffect(() => {
    setAgentFollowupTarget(null);
    setProfileTarget(null);
  }, [activeScenarioId, isReplayMode]);
  const handleStartConversationFromProfile = useCallback((agent: AgentInfo) => {
    setProfileTarget(null);
    setAgentFollowupTarget(agent);
  }, []);
  const hasUnscored = predictions.some((p) => p.score == null);
  const fallbackRuntimePreset = useMemo(() => loadScenarioRuntimePreset(), []);
  const scenarioRuntimePreset = useMemo(
    () => matchScenarioRuntimePreset(scenario?.fork_debug?.round_checks ?? null),
    [scenario?.fork_debug?.round_checks],
  );
  const activeRuntimePreset = scenarioRuntimePreset ?? fallbackRuntimePreset;
  const primaryAgentIdentityId = useMemo(
    () => agents.find((agent) => typeof agent.agent_identity_id === 'string' && agent.agent_identity_id.trim().length > 0)?.agent_identity_id ?? null,
    [agents],
  );
  const activeRuntimePresetConfig = useMemo(
    () => getScenarioRuntimePresetConfig(activeRuntimePreset),
    [activeRuntimePreset],
  );
  const activeRuntimePresetLabel = t(`home.runtime_preset_${activeRuntimePreset}`);
  const challengeMatch = id ? findChallengeProgressByScenarioId(id) : null;
  const replayInvalidMessage = t('result.replay_invalid');
  const loadResultErrorMessage = t('result.load_result_failed');
  const replayInvalidMessageRef = useRef(replayInvalidMessage);
  const loadResultErrorMessageRef = useRef(loadResultErrorMessage);
  const isZhRef = useRef(isZh);
  const translationRef = useRef(t);

  const resetCopiedStateAfter = useCallback((
    timerRef: { current: number | null },
    reset: () => void,
    delayMs: number,
  ) => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      reset();
    }, delayMs);
  }, []);

  useEffect(() => () => {
    [
      challengeLinkCopiedTimerRef,
      permalinkCopiedTimerRef,
      endingRoomPermalinkCopiedTimerRef,
      endingRoomLocalCopySavedTimerRef,
      exportResetTimerRef,
    ].forEach((timerRef) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    });
  }, []);

  useEffect(() => () => {
    if (exportResetTimerRef.current) {
      clearTimeout(exportResetTimerRef.current);
      exportResetTimerRef.current = null;
    }
  }, []);
  const isDailyChallenge = Boolean(
    challengeMatch
    || campaignScenarioSummary?.completed_daily_challenge
    || replayPayload?.isDailyChallenge,
  );
  const challengeProgress = challengeMatch?.progress ?? null;
  const refreshLocalMeta = useCallback(() => {
    setLocalMetaRevision((current) => current + 1);
  }, []);
  useEffect(() => {
    if (!id || isReplayMode) return;
    return subscribeScenarioMeta(id, refreshLocalMeta);
  }, [id, isReplayMode, refreshLocalMeta]);

  useEffect(() => {
    replayInvalidMessageRef.current = replayInvalidMessage;
    loadResultErrorMessageRef.current = loadResultErrorMessage;
    isZhRef.current = isZh;
    translationRef.current = t;
  }, [isZh, loadResultErrorMessage, replayInvalidMessage, t]);

  const applyScenarioReplay = useCallback((replay: ScenarioResultReplayPayload) => {
    const replayProfile = inferGameplayProfile(replay.scenario.question, replay.scenario.scene_theme);
    const replayAuthorityMeta = mergeScenarioMetaAuthority(
      replay.scenarioMeta,
      replay.scenario.gameplay_state ?? null,
      replay.scenario.director_state ?? null,
      { resetGameplayCompat: true },
    );
    const mergedReplayMeta = mergeScenarioArchive(replayAuthorityMeta, {
      profileId: replayProfile.id,
      keyMoments: Array.from(new Set([
        ...replayAuthorityMeta.archive.keyMoments,
        ...buildStoryKeyMoments(replay.storyData),
      ])),
      branchSnapshots: replay.storyData.branches.map((branch) => ({
        branchId: branch.id,
        title: branch.title,
        probability: branch.probability,
      })),
    });
    setReplayPayload(replay);
    setStoryData(replay.storyData);
    setScenario(replay.scenario);
    setAgents(replay.agents);
    setPredictions(replay.predictions);
    setCampaignSummary(replay.campaignSummary ?? null);
    setCampaignScenarioSummary(replay.campaignScenarioSummary ?? null);
    setDerivedScenarioMeta(mergedReplayMeta);
  }, []);

  const applyEndingRoomReplay = useCallback((payload: OracleReplayPayload) => {
    if (payload.scenarioReplay) {
      applyScenarioReplay(payload.scenarioReplay);
    }
    setReplayEndingRoomPayload(payload);
    if (payload.branchId) {
      setActiveEndingRoomBranchId(payload.branchId);
    }
    if (
      payload.roomSnapshot.room_type === 'one_move_only'
      || payload.roomSnapshot.room_type === 'ending_chamber'
      || payload.roomSnapshot.room_type === 'crossline_gallery'
    ) {
      setActiveEndingRoomMode(payload.roomSnapshot.room_type);
    }
    setActiveEndingRoomSelectedAgentIds(payload.selectedAgentIds ?? []);
  }, [applyScenarioReplay]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    const load = async () => {
      setReplayEndingRoomPayload(null);
      if (replayShareId) {
        const artifact = await Promise.resolve()
          .then(() => getReplayArtifact(replayShareId))
          .catch(() => null);
        if (cancelled) return;
        if (!artifact || artifact.kind !== 'scenario_result_v1' || !artifact.payload) {
          setError(replayInvalidMessageRef.current);
          setErrorCode('REPLAY_INVALID');
          setLoading(false);
          return;
        }
        const { normalizeScenarioResultReplayPayload } = await loadScenarioReplayHelpers();
        const replay = normalizeScenarioResultReplayPayload(artifact.payload);
        if (!replay) {
          setError(replayInvalidMessageRef.current);
          setErrorCode('REPLAY_INVALID');
          setLoading(false);
          return;
        }
        applyScenarioReplay(replay);
        setCampaignError('');
        setCampaignNotice('');
        setLoading(false);
        return;
      }
      if (roomReplayShareId || roomReplayLocalId || roomReplayToken) {
        const roomReplay = roomReplayLocalId
          ? loadOracleReplayLocalCopy(roomReplayLocalId, 'ending_room_v1')
          : roomReplayShareId
            ? await Promise.resolve()
              .then(() => getReplayArtifact(roomReplayShareId))
              .then((artifact) => normalizeOracleReplayPayload(artifact.payload, 'ending_room_v1'))
              .catch(() => null)
            : await readOracleReplayPayload(searchParams, 'ending_room_v1');
        if (cancelled) return;
        if (!roomReplay) {
          setError(replayInvalidMessageRef.current);
          setErrorCode('REPLAY_INVALID');
          setLoading(false);
          return;
        }
        applyEndingRoomReplay(roomReplay);
        setCampaignError('');
        setCampaignNotice('');
        setLoading(false);
        return;
      }
      if (replayToken) {
        const replayParams = new URLSearchParams();
        replayParams.set('replay', replayToken);
        const { readScenarioReplayPayload } = await loadScenarioReplayHelpers();
        const replay = await readScenarioReplayPayload(replayParams);
        if (cancelled) return;
        if (!replay) {
          setError(replayInvalidMessageRef.current);
          setErrorCode('REPLAY_INVALID');
          setLoading(false);
          return;
        }
        applyScenarioReplay(replay);
        setCampaignError('');
        setCampaignNotice('');
        setLoading(false);
        return;
      }

      setReplayPayload(null);
      if (!id) {
        setError(loadResultErrorMessageRef.current);
        setErrorCode('RESULT_LOAD_FAILED');
        setLoading(false);
        return;
      }

      try {
        // Fetch story and scenario in parallel, handle prediction API failure gracefully
        const [story, agentList, scenario, preds] = await Promise.all([
          getStory(id),
          getAgents(id),
          getScenario(id),
          Promise.resolve()
            .then(() => listPredictions(id))
            .catch(() => [] as PredictionInfo[]),
        ]);
        if (cancelled) return;

        setScenario(scenario);
        setAgents(agentList);
        setPredictions(preds);

        if (scenario.status === 'done' && preds.some(p => p.score !== null)) {
          try {
            const scoreRes = await scorePredictions(id);
            if (!cancelled && scoreRes && scoreRes.results) {
              setScoreResults(scoreRes.results);
            }
          } catch (e) {
            console.error('Failed to pre-score predictions:', e);
          }
        }

        if (scenario.status !== 'done') {
          // error/cancelled 是终态：停止轮询、退出 loading，由主体渲染（multi-run 仍会显示分布
          // 面板 + 失败计数，不会卡在永久 loading）。codex 审查 M3。
          if (scenario.status === 'error' || scenario.status === 'cancelled') {
            setLoading(false);
            return;
          }
          // parsing/simulating/narrating：retryTimer 轮询直到终态。不再按 capabilities.multi_run
          // .enabled 提前分流——该 capability 异步加载、未就绪时反而会显示单场景 loading_narration
          // （multi-run“正在生成结局叙事”的根因）。loading 态改由 run_group_id + capability!==false
          // 决定渲染 MultiRunWaitingPanel（见下方 loading 分支）。
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void load();
          }, 1500);
          return;
        }

        const rawCampaignSummary = await getCampaignScenarioSummary(id);
        if (cancelled) return;

        const hasExplicitNoCampaign = !!rawCampaignSummary && (rawCampaignSummary as { has_campaign?: boolean }).has_campaign === false;
        const persistedCampaignSummary = (hasExplicitNoCampaign ? null : rawCampaignSummary) as CampaignScenarioSummary | null;

        setCampaignScenarioSummary(persistedCampaignSummary);

        // Story API might not include question — merge from scenario
        setStoryData({
          ...story,
          question: story.question || scenario.question,
        });
        const challengeMatch = findChallengeProgressByScenarioId(id);
        const isDailyChallenge = Boolean(challengeMatch);
        const profile = inferGameplayProfile(scenario.question, scenario.scene_theme);
        const finalizedProfileId = persistedCampaignSummary?.profile_id ?? profile.id;
        const cachedCampaignSummary = persistedCampaignSummary?.finalized_at
          ? readCachedCampaignFinalizeResult(id, apiUserId, finalizedProfileId)
          : null;
        const remoteDirectorState = scenario.director_state ?? null;
        const remoteGameplayState = scenario.gameplay_state ?? null;
        const localMeta = loadScenarioMeta(id);
        let workingMeta = mergeScenarioMetaAuthority(
          localMeta,
          remoteGameplayState,
          remoteDirectorState,
          { resetGameplayCompat: true },
        );
        const storyKeyMoments = buildStoryKeyMoments(story);
        const storyBranchSnapshots = story.branches.map((branch) => ({
          branchId: branch.id,
          title: branch.title,
          probability: branch.probability,
        }));
        workingMeta = mergeScenarioArchive(workingMeta, {
          profileId: profile.id,
          keyMoments: Array.from(new Set([
            ...workingMeta.archive.keyMoments,
            ...storyKeyMoments,
          ])),
          branchSnapshots: Array.from(
            new Map(
              [...workingMeta.archive.branchSnapshots, ...storyBranchSnapshots]
                .map((snapshot) => [snapshot.branchId, snapshot]),
            ).values(),
          ),
        });
        if (
          workingMeta.objectives.goals.length === 0
          && (persistedCampaignSummary?.objective_total_count ?? null) == null
        ) {
          const objectiveArc = getGameplaySignatureArcState(
            profile.id,
            workingMeta.cards.usageLog,
            isZhRef.current,
          );
          workingMeta = ensureScenarioObjectivesInMemory(workingMeta, {
            question: scenario.question,
            profileId: profile.id,
            goals: buildDefaultDirectorObjectives({
              profileId: profile.id,
              signatureCardId: objectiveArc?.nextCardId ?? null,
            }),
          });
        }
        const dominantBranchForArchive = [...story.branches].sort((a, b) => b.probability - a.probability)[0] ?? null;
        const evaluatedObjectives = evaluateDirectorObjectives({
          objectives: workingMeta.objectives.goals,
          meta: workingMeta,
          dominantBranch: dominantBranchForArchive,
          isZh: isZhRef.current,
          isFinal: true,
          t,
        });
        const completedObjectiveCount = countCompletedObjectives(evaluatedObjectives);
        const commitmentOutcome = !workingMeta.commitment.active
          ? null
          : dominantBranchForArchive?.id === workingMeta.commitment.branchId
            ? 'hit'
            : 'miss';
        const tracks = getScenarioSystemTrackState(
          profile.id,
          workingMeta.cards.usageLog,
          workingMeta.commitment,
          isZhRef.current,
        );
        const archiveSummary = buildArchiveSummary({
          branches: story.branches,
          usages: workingMeta.cards.usageLog,
          bets: workingMeta.betting.bets,
          keyMomentCount: getScenarioArchiveKeyMoments(workingMeta).length,
          isDailyChallenge,
          profileId: profile.id,
          objectiveCompletedCount: completedObjectiveCount,
          objectiveTotalCount: evaluatedObjectives.length,
          commitmentOutcome,
        });
        const finalMeta = mergeScenarioArchive(workingMeta, {
          ...archiveSummary,
          riskValue: tracks?.riskValue ?? null,
          resourceValue: tracks?.resourceValue ?? null,
        });
        setDerivedScenarioMeta(finalMeta);
        if (isDailyChallenge && challengeMatch?.challengeId) {
          markChallengeCompleted(challengeMatch.challengeId, id, {
            resultBranchId: story.branches[0]?.id,
            usedCards: finalMeta.cards.usageLog.map((usage) => usage.cardId),
            betPlaced: finalMeta.betting.bets.length > 0,
            bettingHit: archiveSummary.bettingHit ?? null,
            profileResonance: archiveSummary.profileResonance,
          }, challengeMatch.challengeDay ? new Date(`${challengeMatch.challengeDay}T12:00:00`) : new Date());
        }

        let campaign = cachedCampaignSummary;
        if (!campaign && persistedCampaignSummary?.finalized_at) {
          const existingCampaign = await Promise.all([
            getCampaignProfile(apiUserId).catch(() => null),
            getCampaignMastery(apiUserId).catch(() => []),
            getCampaignBadges(apiUserId).catch(() => []),
          ]).then(([profileSummary, masteryList, badgeList]) => (
            profileSummary
              ? buildCampaignSummaryFromExistingData(
                  persistedCampaignSummary,
                  profileSummary,
                  masteryList,
                  badgeList,
                )
              : null
          ));
          if (existingCampaign) {
            campaign = existingCampaign;
          }
        }
        const shouldFinalizeCampaign = !hasExplicitNoCampaign && !persistedCampaignSummary?.finalized_at;
        if (!campaign && shouldFinalizeCampaign) {
          campaign = await finalizeCampaign(id, {
            user_id: apiUserId,
            user_name: directorIdentity.userName,
            profile_id: profile.id,
            archive_grade: archiveSummary.archiveGrade,
            profile_resonance: archiveSummary.profileResonance,
            betting_hit: archiveSummary.bettingHit ?? null,
            bet_count: finalMeta.betting.bets.length,
            most_used_card: archiveSummary.mostUsedCard ?? null,
            completed_daily_challenge: isDailyChallenge,
            objective_completed_count: completedObjectiveCount,
            objective_total_count: evaluatedObjectives.length,
            commitment_outcome: commitmentOutcome,
          }).catch((err) => {
            if (!cancelled) {
              const kind = classifyCampaignFinalizeError(err);
              if (kind === 'missing' || kind === 'conflict') {
                setCampaignNotice(getCampaignBoundaryMessage(kind, t));
              } else {
                setCampaignError(err instanceof Error ? err.message : 'Failed to finalize campaign');
              }
            }
            return null;
          });
        }
        if (!cancelled) {
          setCampaignSummary(campaign);
          if (campaign) {
            writeCachedCampaignFinalizeResult(
              id,
              apiUserId,
              campaign.mastery.profile_id,
              campaign,
            );
            setCampaignScenarioSummary(
              persistedCampaignSummary?.finalized_at
                ? persistedCampaignSummary
                : {
                    scenario_id: id,
                    profile_id: campaign.mastery.profile_id,
                    archive_grade: archiveSummary.archiveGrade,
                    profile_resonance: archiveSummary.profileResonance,
                    betting_hit: archiveSummary.bettingHit ?? null,
                    most_used_card: archiveSummary.mostUsedCard ?? null,
                    completed_daily_challenge: isDailyChallenge,
                    objective_completed_count: completedObjectiveCount,
                    objective_total_count: evaluatedObjectives.length,
                    commitment_outcome: commitmentOutcome,
                    campaign_score_delta: campaign.campaign_score_delta,
                    score_breakdown: campaign.score_breakdown ?? [],
                    finalized_at: null,
                  },
            );
          }
        }
      } catch (err) {
        if (cancelled) return;
        setErrorCode(getApiErrorCode(err) ?? 'RESULT_LOAD_FAILED');
        setError(getLocalizedApiErrorMessage(err, translationRef.current, loadResultErrorMessageRef.current));
      } finally {
        if (!cancelled && retryTimer == null) {
          setLoading(false);
        }
      }
    };

    setLoading(true);
    setError('');
    setErrorCode(null);
    setStoryData(null);
    setCampaignSummary(null);
    setCampaignScenarioSummary(null);
    setCampaignError('');
    setCampaignNotice('');
    setDerivedScenarioMeta(null);
    void load();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [
    applyEndingRoomReplay,
    applyScenarioReplay,
    apiUserId,
    directorIdentity.userName,
    id,
    replayShareId,
    replayToken,
    roomReplayLocalId,
    roomReplayShareId,
    roomReplayToken,
    searchParams,
    t,
    capabilities,
    refreshTrigger,
  ]);

  useEffect(() => {
    if (!campaignSummary) {
      setWeeklySummary(null);
      setWeeklySummaryError(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const localDate = challengeDateKey(new Date());
    const timezoneOffsetMinutes = new Date().getTimezoneOffset();
    setWeeklySummaryLoading(true);
    setWeeklySummaryError(false);
    getCampaignWeeklySummary(
      apiUserId,
      localDate,
      timezoneOffsetMinutes,
      { signal: controller.signal },
    )
      .then((data) => {
        if (cancelled) return;
        setWeeklySummary(data);
      })
      .catch(() => {
        if (cancelled) return;
        setWeeklySummary(null);
        setWeeklySummaryError(true);
      })
      .finally(() => {
        if (cancelled) return;
        setWeeklySummaryLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [campaignSummary, apiUserId]);

  const handleExport = async () => {
    if (!id || exporting || isReplayMode) return;
    setExporting(true);
    setExportError('');
    try {
      const filename = `swarmoracle-${id.slice(0, 8)}.md`;
      let markdown = await exportScenario(id);

      if (storyData?.full_report && 'verdict' in storyData.full_report) {
        const report = storyData.full_report;
        const hasSavedSections = report.sections.length > 0;
        const isExportableTerminal = report.status === 'complete'
          || report.status === 'partial'
          || ((report.status === 'failed' || report.status === 'cancelled') && hasSavedSections);
        if (isExportableTerminal) {
          const reportContentLanguage = resolveReportContentLanguage(report, isZh ? 'zh' : 'en');
          const reportContentIsZh = reportContentLanguage === 'zh';
          const usesPrimaryReportLanguage = reportContentLanguage === report.language;
          const fixedReportT = i18n.getFixedT(reportContentLanguage);
          const translateReportCopy = (key: string, defaultValue: string): string => {
            const translated = fixedReportT(key, { defaultValue });
            return typeof translated === 'string' && translated !== key ? translated : defaultValue;
          };
          const title = report.title_i18n?.[reportContentLanguage]
            || (usesPrimaryReportLanguage ? report.title : translateReportCopy('result.report.title', 'Full report'));
          const summary = report.summary_i18n?.[reportContentLanguage]
            || (usesPrimaryReportLanguage ? report.summary : '');
          const confidenceBasis = report.verdict.analytic_confidence.basis_i18n?.[reportContentLanguage]
            || (usesPrimaryReportLanguage ? report.verdict.analytic_confidence.basis : '');
          const confidenceLevel = translateReportCopy(
            `result.report.confidence_level.${report.verdict.analytic_confidence.level}`,
            report.verdict.analytic_confidence.level,
          );
          const statusText = reportContentIsZh
              ? ({
                complete: '已完成',
                partial: '部分完成（旧版报告，已保存内容可能不完整）',
                failed: '失败（仅包含已保存章节）',
                cancelled: '已取消（仅包含已保存章节）',
              } as const)[report.status as 'complete' | 'partial' | 'failed' | 'cancelled']
            : ({
                complete: 'complete',
                partial: 'partial (legacy report; saved content may be incomplete)',
                failed: 'failed (saved sections only)',
                cancelled: 'cancelled (saved sections only)',
              } as const)[report.status as 'complete' | 'partial' | 'failed' | 'cancelled'];
          const sections = report.sections.map((section, index) => {
            const sectionTitle = section.title_i18n?.[reportContentLanguage]
              || (usesPrimaryReportLanguage
                ? section.title
                : `${reportContentIsZh ? '章节' : 'Section'} ${index + 1}`);
            const body = section.body_md_i18n?.[reportContentLanguage] || '';
            return `\n## ${sectionTitle}\n\n${body}`;
          });
          const evidence = report.evidence.map((ev) => (
            `- [${ev.id}] ${ev.agent_name}, ${reportContentIsZh ? '第' : 'round '} ${ev.round_number}: “${ev.quote}”`
          ));
          const indicators = usesPrimaryReportLanguage
            ? report.indicators_to_watch.map((item) => (
                `- ${item.signal}: ${item.note}${item.rationale ? ` (${item.rationale})` : ''}`
              ))
            : [];
          const premortem = formatPremortemMarkdown(
            report.premortem_analysis,
            reportContentLanguage,
            translateReportCopy,
            report.evidence,
          );
          const disclaimerText = getReportDisclaimerText(
            usesPrimaryReportLanguage ? report.verdict.disclaimer : null,
            translateReportCopy,
          );
          const reportMd = [
            `\n\n# ${title}`,
            `\n**${reportContentIsZh ? '报告状态' : 'Report status'}**: ${statusText}`,
            summary ? `\n**${reportContentIsZh ? '摘要' : 'Summary'}**: ${summary}` : '',
            usesPrimaryReportLanguage
              ? `\n**${reportContentIsZh ? '结论' : 'Verdict'}**: ${report.verdict.headline_answer}`
              : '',
            `\n**${reportContentIsZh ? '置信度' : 'Confidence'}**: ${confidenceLevel}${confidenceBasis ? ` — ${confidenceBasis}` : ''}`,
            `\n**${reportContentIsZh ? '免责声明' : 'Disclaimer'}**: ${disclaimerText}`,
            sections.join('\n'),
            evidence.length ? `\n## ${reportContentIsZh ? '证据' : 'Evidence'}\n\n${evidence.join('\n')}` : '',
            indicators.length ? `\n## ${reportContentIsZh ? '观察指标' : 'Indicators to Watch'}\n\n${indicators.join('\n')}` : '',
            `\n${premortem}`,
            usesPrimaryReportLanguage && report.limitations.trim()
              ? `\n## ${reportContentIsZh ? '限制' : 'Limitations'}\n\n${report.limitations}`
              : '',
          ].join('\n');
          markdown += reportMd;
        }
      }

      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      if (exportResetTimerRef.current) {
        clearTimeout(exportResetTimerRef.current);
      }
      exportResetTimerRef.current = window.setTimeout(() => {
        exportResetTimerRef.current = null;
        setExporting(false);
      }, 250);
    }
  };

  const handleScore = async () => {
    if (!id || scoring || isReplayMode) return;
    const providerPolicy = loadLlmProviderPolicy();
    const validation = validateByok({
      apiKey: providerPolicy.apiKey,
      baseUrl: providerPolicy.baseUrl,
    });
    if (!validation.valid) {
      setScoreError(getLocalizedApiErrorMessage({ code: validation.errorCode }, t, t('conversation.error.byok_invalid')));
      return;
    }
    setScoring(true);
    setScoreError('');
    try {
      const scoreRes = await scorePredictions(id, {
        llmApiKey: providerPolicy.apiKey || undefined,
        llmBaseUrl: providerPolicy.baseUrl || undefined,
        llmModel: providerPolicy.model || undefined,
        llmRequestsPerMinute: providerPolicy.requestsPerMinute ?? undefined,
        llmTokensPerMinute: providerPolicy.tokensPerMinute ?? undefined,
        userId: apiUserId,
      });
      if (scoreRes && scoreRes.results) {
        setScoreResults(scoreRes.results);
      }
      // Reload predictions to show scores
      const preds = await listPredictions(id);
      setPredictions(preds);
    } catch (err) {
      setScoreError(err instanceof Error ? err.message : 'Scoring failed');
    } finally {
      setScoring(false);
    }
  };

  const handleShareChallenge = async () => {
    if (!scenario) return;
    const url = buildSharedChallengeUrl(window.location.origin, {
      question: scenario.question,
      rounds: scenario.total_rounds ?? 5,
      numAgents: scenario.agents.length || agents.length || 3,
      mode: scenario.mode ?? 'blackboard',
      visualizationEnabled: scenario.visualization_enabled ?? false,
      profileId: inferGameplayProfile(scenario.question, scenario.scene_theme)?.id ?? null,
      runtimePreset: activeRuntimePreset,
    });
    await copyText(url);
    setChallengeLinkCopied(true);
    resetCopiedStateAfter(
      challengeLinkCopiedTimerRef,
      () => setChallengeLinkCopied(false),
      2000,
    );
  };

  const handleImportReplay = async () => {
    if (!replayPayload || importingReplay) return;
    setImportingReplay(true);
    setImportError('');
    try {
      const imported = await importReplayScenario(replayPayload.scenario);
      navigate(`/sim/${imported.id}`);
    } catch (nextError) {
      setImportError(
        getLocalizedApiErrorMessage(
          nextError,
          t,
          t('result.import_replay_failed'),
        ),
      );
    } finally {
      setImportingReplay(false);
    }
  };

  const branchEndingRoomCandidates = useMemo(() => {
    return buildBranchEndingRoomCandidates({
      agents,
      branches: storyData?.branches ?? [],
      messages: scenario?.messages ?? [],
      isZh,
    });
  }, [agents, isZh, scenario?.messages, storyData?.branches]);

  const openEndingRoomDirect = useCallback((
    branchId: string,
    roomType: 'ending_chamber' | 'one_move_only' | 'crossline_gallery',
    selectedAgentIds: string[] = [],
    roomModelProfileId: string = '',
  ) => {
    setActiveEndingRoomBranchId(branchId);
    setActiveEndingRoomMode(roomType);
    setActiveEndingRoomSelectedAgentIds(selectedAgentIds);
    setActiveEndingRoomModelProfileId(roomModelProfileId);
    setPendingEndingRoomPicker(null);
    setEndingRoomAutomation(null);
  }, [setEndingRoomAutomation]);

  const normalizeEndingRoomSelection = useCallback((
    branchId: string,
    roomType: 'ending_chamber' | 'one_move_only',
    selectedAgentIds: string[],
  ) => {
    const candidates = branchEndingRoomCandidates[branchId] ?? [];
    if (candidates.length === 0) {
      return [];
    }

    const maxSelectable = roomType === 'one_move_only' ? 1 : Math.min(3, candidates.length);
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const kept = selectedAgentIds
      .filter((agentId) => candidateIds.has(agentId))
      .slice(0, maxSelectable);

    if (kept.length > 0) {
      return kept;
    }

    const defaultCount = roomType === 'one_move_only' ? 1 : Math.min(2, maxSelectable);
    return candidates
      .slice(0, defaultCount)
      .map((candidate) => candidate.id);
  }, [branchEndingRoomCandidates]);

  const handleOpenEndingRoom = useCallback((
    branchId: string,
    roomType: 'ending_chamber' | 'one_move_only' | 'crossline_gallery',
  ) => {
    if (roomType === 'crossline_gallery') {
      openEndingRoomDirect(branchId, roomType, []);
      return;
    }
    const candidates = branchEndingRoomCandidates[branchId] ?? [];
    if (isReplayMode || candidates.length === 0) {
      openEndingRoomDirect(branchId, roomType, []);
      return;
    }
    const maxSelectable = roomType === 'one_move_only' ? 1 : Math.min(3, candidates.length);
    const defaultCount = roomType === 'one_move_only' ? 1 : Math.min(2, candidates.length);
    setPendingEndingRoomPicker({
      branchId,
      roomType,
      selectedAgentIds: candidates.slice(0, defaultCount).map((candidate) => candidate.id),
      maxSelectable,
    });
  }, [branchEndingRoomCandidates, isReplayMode, openEndingRoomDirect]);

  const handleCloseEndingRoom = useCallback(() => {
    setActiveEndingRoomBranchId(null);
    setActiveEndingRoomSelectedAgentIds([]);
    setEndingRoomAutomation(null);
    setActiveEndingRoomModelProfileId('');
  }, [setEndingRoomAutomation]);

  const handleEndingRoomModeChange = useCallback((nextMode: 'ending_chamber' | 'one_move_only') => {
    if (!activeEndingRoomBranchId) {
      setActiveEndingRoomMode(nextMode);
      return;
    }

    setActiveEndingRoomSelectedAgentIds((current) => (
      normalizeEndingRoomSelection(activeEndingRoomBranchId, nextMode, current)
    ));
    setActiveEndingRoomMode(nextMode);
    setEndingRoomAutomation(null);
  }, [activeEndingRoomBranchId, normalizeEndingRoomSelection, setEndingRoomAutomation]);

  const branches = useMemo(
    () => storyData?.branches ?? [],
    [storyData?.branches],
  );

  useEffect(() => {
    if (import.meta.env.DEV) {
      if (debugEndingRoomAppliedRef.current) return;
      if (isReplayMode) return;
      if (!debugEndingRoomBranch) return;
      if (!branches.some((branch) => branch.id === debugEndingRoomBranch)) return;

      const requestedMode = debugEndingRoomMode === 'one_move_only'
        || debugEndingRoomMode === 'crossline_gallery'
        ? debugEndingRoomMode
        : 'ending_chamber';
      const requestedAgentIds = debugEndingRoomAgents
        ? debugEndingRoomAgents.split(',').map((item) => item.trim()).filter(Boolean)
        : [];
      const normalizedAgentIds = requestedMode === 'crossline_gallery'
        ? []
        : normalizeEndingRoomSelection(
            debugEndingRoomBranch,
            requestedMode,
            requestedAgentIds,
          );

      openEndingRoomDirect(
        debugEndingRoomBranch,
        requestedMode,
        normalizedAgentIds,
      );
      debugEndingRoomAppliedRef.current = true;
    }
  }, [
    branches,
    debugEndingRoomAgents,
    debugEndingRoomBranch,
    debugEndingRoomMode,
    isReplayMode,
    normalizeEndingRoomSelection,
    openEndingRoomDirect,
  ]);
  const fallbackScenarioMeta = useMemo(() => {
    if (!id || derivedScenarioMeta || replayPayload?.scenarioMeta) {
      return null;
    }
    // Re-read local cached meta when an in-view action bumps the revision.
    void localMetaRevision;
    return loadScenarioMeta(id);
  }, [derivedScenarioMeta, id, localMetaRevision, replayPayload?.scenarioMeta]);
  const storedScenarioMeta = derivedScenarioMeta ?? replayPayload?.scenarioMeta ?? fallbackScenarioMeta;
  const inferredProfile = useMemo(
    () => (scenario ? inferGameplayProfile(scenario.question, scenario.scene_theme) : null),
    [scenario],
  );
  const scenarioMeta = useMemo(() => {
    if (!storedScenarioMeta) return null;
    if (derivedScenarioMeta) {
      return derivedScenarioMeta;
    }

    return mergeScenarioMetaAuthority(
      storedScenarioMeta,
      scenario?.gameplay_state ?? null,
      scenario?.director_state ?? null,
      { resetGameplayCompat: true },
    );
  }, [derivedScenarioMeta, scenario?.director_state, scenario?.gameplay_state, storedScenarioMeta]);
  const resolvedProfileId =
    (
      campaignScenarioSummary?.profile_id
      ?? inferredProfile?.id
      ?? scenarioMeta?.archive.profileId
      ?? null
    ) as typeof scenarioMeta extends null ? null : ScenarioMeta['archive']['profileId'] | null;
  const gameplayProfileLabel =
    resolvedProfileId
      ? getGameplayProfileLabel(
          resolvedProfileId as Parameters<typeof getGameplayProfileLabel>[0],
          isZh,
        )
      : null;
  const gameplayProfileHooks = useMemo(
    () => (
      resolvedProfileId
        ? getGameplayProfileSignatureHooks(
            resolvedProfileId as Parameters<typeof getGameplayProfileSignatureHooks>[0],
            isZh,
          )
        : EMPTY_GAMEPLAY_PROFILE_HOOKS
    ),
    [isZh, resolvedProfileId],
  );
  const dominantBranchFromStory = useMemo(
    () => [...branches].sort((a, b) => b.probability - a.probability)[0] ?? null,
    [branches],
  );
  const factionTimelineBranch = useMemo(
    () => branches.find((branch) => branch.id === expandedBranch) ?? dominantBranchFromStory ?? branches[0] ?? null,
    [branches, dominantBranchFromStory, expandedBranch],
  );
  const analysisBranch = factionTimelineBranch;
  const profileObservation = useMemo(
    () => (
      profileTarget
        ? buildAgentProfileObservation({
            agent: profileTarget,
            messages: scenario?.messages ?? [],
            branches: scenario?.branches ?? [],
            selection: {
              kind: 'result',
              branchId: analysisBranch?.id ?? null,
              branchTitle: analysisBranch?.title ?? null,
            },
          })
        : undefined
    ),
    [analysisBranch?.id, analysisBranch?.title, profileTarget, scenario?.branches, scenario?.messages],
  );
  const resultConversationContext = useMemo(() => {
    if (!analysisBranch) return null;

    const comparisonTitles = [...branches]
      .filter((branch) => branch.id !== analysisBranch.id)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 2)
      .map((branch) => branch.title)
      .filter(Boolean);

    return {
      branchId: analysisBranch.id,
      title: analysisBranch.title,
      insight: analysisBranch.insight,
      forkReason: analysisBranch.fork_reason,
      keyMoments: analysisBranch.key_moments,
      comparisonTitles,
    };
  }, [analysisBranch, branches]);
  const factionTimelineLead = factionTimelineBranch
    ? (
        expandedBranch === factionTimelineBranch.id
          ? t('result.faction_timeline_lead_expanded', {
              defaultValue: 'Currently following the expanded ending branch "{{title}}".',
              title: factionTimelineBranch.title,
            })
          : branches.length > 1
            ? t('result.faction_timeline_lead_dominant', {
                defaultValue: 'Currently showing the highest-probability branch "{{title}}", not every ending.',
                title: factionTimelineBranch.title,
              })
            : t('result.faction_timeline_lead_single', {
                defaultValue: 'Showing faction evolution for branch "{{title}}".',
                title: factionTimelineBranch.title,
              })
      )
    : '';
  const hasLocalDirectorState = Boolean(
    scenarioMeta?.director.lastUpdatedAt
    || (scenarioMeta?.director.spentPoints ?? 0) > 0
    || (scenarioMeta?.cards.usageLog.length ?? 0) > 0
    || (scenarioMeta?.betting.bets.length ?? 0) > 0,
  );
  const signatureArcState = useMemo(() => {
    if (!scenarioMeta || !resolvedProfileId) return null;
    return getGameplaySignatureArcState(
      resolvedProfileId as Parameters<typeof getGameplaySignatureArcState>[0],
      scenarioMeta.cards.usageLog,
      isZh,
    );
  }, [isZh, resolvedProfileId, scenarioMeta]);
  const systemTracks = useMemo(() => {
    if (!scenarioMeta || !resolvedProfileId) return null;
    return getScenarioSystemTrackState(
      resolvedProfileId as Parameters<typeof getScenarioSystemTrackState>[0],
      scenarioMeta.cards.usageLog,
      scenarioMeta.commitment,
      isZh,
    );
  }, [isZh, resolvedProfileId, scenarioMeta]);
  const tacticalState = useMemo(() => {
    if (!scenarioMeta || !resolvedProfileId) return null;
    return getGameplayProfileTacticalState(
      resolvedProfileId as Parameters<typeof getGameplayProfileTacticalState>[0],
      scenarioMeta.cards.usageLog,
      scenarioMeta.commitment,
      isZh,
    );
  }, [isZh, resolvedProfileId, scenarioMeta]);
  const evaluatedObjectives = useMemo(() => (
    scenarioMeta
      ? evaluateDirectorObjectives({
          objectives: scenarioMeta.objectives.goals,
          meta: scenarioMeta,
          dominantBranch: dominantBranchFromStory,
          isZh,
          isFinal: true,
          t,
        })
      : []
  ), [dominantBranchFromStory, isZh, scenarioMeta, t]);
  const completedObjectiveCount = useMemo(
    () => countCompletedObjectives(evaluatedObjectives),
    [evaluatedObjectives],
  );
  const archiveKeyMoments = useMemo(
    () => (scenarioMeta ? getScenarioArchiveKeyMoments(scenarioMeta) : []),
    [scenarioMeta],
  );
  const hasAuthoritativeBranchSnapshots = useMemo(() => {
    const archive = scenario?.gameplay_state?.archive;
    return typeof archive === 'object'
      && archive !== null
      && Object.prototype.hasOwnProperty.call(archive, 'branch_snapshots');
  }, [scenario?.gameplay_state]);
  const displayBranchSnapshots = useMemo(() => {
    const archiveSnapshots = scenarioMeta?.archive.branchSnapshots ?? [];
    const storySnapshots = storyData?.branches.map((branch) => ({
      branchId: branch.id,
      title: branch.title,
      probability: branch.probability,
    })) ?? [];

    if (hasAuthoritativeBranchSnapshots) {
      return archiveSnapshots;
    }

    if (storySnapshots.length > 0) {
      return storySnapshots;
    }

    return archiveSnapshots;
  }, [hasAuthoritativeBranchSnapshots, scenarioMeta?.archive.branchSnapshots, storyData?.branches]);
  const localCommitmentOutcome = !scenarioMeta?.commitment.active
    ? null
    : dominantBranchFromStory?.id
      ? dominantBranchFromStory.id === scenarioMeta.commitment.branchId
        ? 'hit'
        : 'miss'
      : scenarioMeta.archive.commitmentOutcome ?? null;
  const localArchiveSummary = useMemo(() => {
    if (!scenarioMeta) return null;
    return buildArchiveSummary({
      branches,
      usages: scenarioMeta.cards.usageLog,
      bets: scenarioMeta.betting.bets,
      keyMomentCount: archiveKeyMoments.length,
      isDailyChallenge,
      profileId: resolvedProfileId ?? undefined,
      objectiveCompletedCount: completedObjectiveCount,
      objectiveTotalCount: evaluatedObjectives.length,
      commitmentOutcome: localCommitmentOutcome,
    });
  }, [
    archiveKeyMoments.length,
    branches,
    completedObjectiveCount,
    evaluatedObjectives.length,
    isDailyChallenge,
    localCommitmentOutcome,
    resolvedProfileId,
    scenarioMeta,
  ]);
  const displayArchive = useMemo(() => {
    if (!scenarioMeta) return null;
    return {
      profileId: resolvedProfileId ?? null,
      dominantBranchTitle: localArchiveSummary?.dominantBranchTitle ?? null,
      dominantTone: localArchiveSummary?.dominantTone ?? null,
      mostUsedCard: campaignScenarioSummary?.most_used_card ?? localArchiveSummary?.mostUsedCard ?? null,
      bettingHit: campaignScenarioSummary?.betting_hit ?? localArchiveSummary?.bettingHit ?? null,
      archiveGrade: campaignScenarioSummary?.archive_grade ?? localArchiveSummary?.archiveGrade ?? null,
      directorStyleTag: localArchiveSummary?.directorStyleTag ?? null,
      profileResonance: campaignScenarioSummary?.profile_resonance ?? localArchiveSummary?.profileResonance ?? null,
      objectiveCompletedCount: campaignScenarioSummary?.objective_completed_count ?? completedObjectiveCount,
      objectiveTotalCount: campaignScenarioSummary?.objective_total_count ?? evaluatedObjectives.length,
      commitmentOutcome: campaignScenarioSummary?.commitment_outcome ?? localCommitmentOutcome,
      counterplayCardCount: localArchiveSummary?.counterplayCardCount ?? 0,
      lastCounterplayCard: localArchiveSummary?.lastCounterplayCard ?? null,
      riskValue: systemTracks?.riskValue ?? null,
      resourceValue: systemTracks?.resourceValue ?? null,
    };
  }, [
    campaignScenarioSummary,
    completedObjectiveCount,
    evaluatedObjectives.length,
    localArchiveSummary,
    localCommitmentOutcome,
    resolvedProfileId,
    scenarioMeta,
    systemTracks?.resourceValue,
    systemTracks?.riskValue,
  ]);
  const profileResonanceLabel = displayArchive?.profileResonance
    ? t(`result.archive_resonance_${displayArchive.profileResonance}`)
    : t('result.archive_unset');
  const challengeFeedbackLabel = challengeProgress?.profileResonance
    ? `${gameplayProfileLabel ?? ''} · ${t(`result.archive_resonance_${challengeProgress.profileResonance}`)}`
    : null;
  const directorStyleLabel = displayArchive?.directorStyleTag
    ? getDirectorStyleLabel(
        displayArchive.directorStyleTag as Parameters<typeof getDirectorStyleLabel>[0],
        isZh,
      )
    : null;
  const commitmentOutcomeLabel = displayArchive?.commitmentOutcome
    ? displayArchive.commitmentOutcome === 'hit'
      ? t('result.archive_commitment_hit')
      : displayArchive.commitmentOutcome === 'miss'
        ? t('result.archive_commitment_missed')
        : t('result.archive_commitment_pending')
    : t('result.archive_no_commitment');
  const lastCounterplayCardLabel = displayArchive?.lastCounterplayCard
    ? (
      isZh
        ? getGameplayCardDefinition(
            displayArchive.lastCounterplayCard as Parameters<typeof getGameplayCardDefinition>[0],
          ).labelZh
        : getGameplayCardDefinition(
            displayArchive.lastCounterplayCard as Parameters<typeof getGameplayCardDefinition>[0],
          ).labelEn
    )
    : t('result.archive_no_counterplay');
  const counterplaySummaryLabel =
    !displayArchive || (displayArchive.counterplayCardCount ?? 0) === 0
      ? t('result.archive_no_counterplay')
      : t('result.archive_counterplay_count', {
          count: displayArchive.counterplayCardCount ?? 0,
        });
  const replaySnapshot = useMemo<ScenarioResultReplayPayload | null>(() => {
    if (!scenario || !storyData || !scenarioMeta) return null;
    return {
      scenario,
      storyData,
      agents,
      predictions,
      scenarioMeta,
      campaignScenarioSummary,
      campaignSummary,
      isDailyChallenge,
    };
  }, [agents, campaignScenarioSummary, campaignSummary, isDailyChallenge, predictions, scenario, scenarioMeta, storyData]);
  const replayIdentityScenarioId = isReplayMode
    ? replaySnapshot?.scenario.id ?? null
    : id ?? replaySnapshot?.scenario.id ?? null;

  useEffect(() => {
    replayUrlGenerationRef.current = {
      epoch: replayUrlGenerationRef.current.epoch + 1,
      scenarioId: replayIdentityScenarioId,
    };
    replayUrlPromiseRef.current = null;
    setShowShare(false);
    setShareAutomation(null);
    setReplayUrl(isReplayMode
      ? window.location.href
      : id
        ? `${window.location.origin.replace(/\/$/, '')}/result/${id}`
        : null);
  }, [id, isReplayMode, replayIdentityScenarioId]);

  const ensureReplayUrl = useCallback((): Promise<string | null> => {
    const routeFallbackUrl = id
      ? `${window.location.origin.replace(/\/$/, '')}/result/${id}`
      : null;
    if (isReplayMode) return Promise.resolve(window.location.href);
    if (!replaySnapshot) return Promise.resolve(routeFallbackUrl);
    if (replayUrlPromiseRef.current) return replayUrlPromiseRef.current;
    const requestGeneration = replayUrlGenerationRef.current;
    const requestScenarioId = replaySnapshot.scenario.id;
    const isCurrentRequest = () => (
      replayUrlGenerationRef.current.epoch === requestGeneration.epoch
      && replayUrlGenerationRef.current.scenarioId === requestScenarioId
    );

    replayUrlPromiseRef.current = (async () => {
      const fallbackUrl = `${window.location.origin.replace(/\/$/, '')}/result/${replaySnapshot.scenario.id}`;
      const {
        buildScenarioReplayUrl,
        compactScenarioMetaForReplay,
        sanitizeScenarioResultReplayPayload,
      } = await loadScenarioReplayHelpers();
      const compactReplaySnapshot = {
        ...replaySnapshot,
        scenarioMeta: compactScenarioMetaForReplay(replaySnapshot.scenarioMeta, {
          stripDirectorAuthority: hasScenarioDirectorAuthority(replaySnapshot.scenario.director_state ?? null),
          stripGameplayAuthority: hasScenarioGameplayAuthority(replaySnapshot.scenario.gameplay_state ?? null),
        }),
      };
      const encodedReplaySnapshot = sanitizeScenarioResultReplayPayload(compactReplaySnapshot);
      const artifact = await Promise.resolve()
        .then(() => createReplayArtifact(
          'scenario_result_v1',
          encodedReplaySnapshot as unknown as Record<string, unknown>,
          replaySnapshot.scenario.id,
        ))
        .catch(() => null);
      if (!artifact && isReplayEnvelopeLikelyTooLarge('scenario_result_v1', encodedReplaySnapshot)) {
        return isCurrentRequest() ? fallbackUrl : null;
      }
      try {
        const url = artifact
          ? `${window.location.origin.replace(/\/$/, '')}/result/replay?share=${artifact.id}`
          : await buildScenarioReplayUrl(window.location.origin, encodedReplaySnapshot);
        if (!isCurrentRequest()) return null;
        setReplayUrl(url);
        return url;
      } catch (error) {
        if (!isCurrentRequest()) return null;
        console.warn('[ResultView] Failed to build replay URL', error);
        return fallbackUrl;
      }
    })().catch((error) => {
      if (!isCurrentRequest()) return null;
      console.warn('[ResultView] Failed to prepare replay URL', error);
      return routeFallbackUrl;
    });
    return replayUrlPromiseRef.current;
  }, [id, isReplayMode, replaySnapshot]);

  const handleCopyPermalink = async () => {
    const url = await ensureReplayUrl();
    if (!url) return;
    await copyText(url);
    setPermalinkCopied(true);
    resetCopiedStateAfter(permalinkCopiedTimerRef, () => setPermalinkCopied(false), 2000);
  };

  const handleSetShowShare = useCallback((next: boolean) => {
    if (!next) {
      setShowShare(false);
      return;
    }
    setShowShare(true);
    void ensureReplayUrl();
  }, [ensureReplayUrl]);

  const shareFlavorContext = useMemo<ShareFlavorContext>(() => ({
    question: storyData?.question ?? null,
    profileLabel: gameplayProfileLabel,
    runtimePresetLabel: activeRuntimePresetLabel,
    profileHooks: gameplayProfileHooks,
    resonanceLabel: profileResonanceLabel,
    directorStyleLabel,
    dominantBranchTitle: displayArchive?.dominantBranchTitle ?? null,
    counterplaySummary:
      displayArchive && (displayArchive.counterplayCardCount ?? 0) > 0
        ? `${counterplaySummaryLabel} · ${t('result.archive_last_counterplay')}: ${lastCounterplayCardLabel}`
        : null,
    commitmentSummary:
      scenarioMeta?.commitment.active && scenarioMeta.commitment.branchTitle
        ? `${commitmentOutcomeLabel} · ${scenarioMeta.commitment.branchTitle}`
        : null,
    permalinkUrl: replayUrl,
  }), [
    storyData?.question,
    gameplayProfileLabel,
    activeRuntimePresetLabel,
    gameplayProfileHooks,
    profileResonanceLabel,
    directorStyleLabel,
    displayArchive,
    scenarioMeta?.commitment.active,
    scenarioMeta?.commitment.branchTitle,
    counterplaySummaryLabel,
    lastCounterplayCardLabel,
    commitmentOutcomeLabel,
    replayUrl,
    t,
  ]);
  const activeEndingRoomBranch = useMemo<StoryData['branches'][number] | null>(
    () => branches.find((branch) => branch.id === activeEndingRoomBranchId) ?? null,
    [activeEndingRoomBranchId, branches],
  );
  const activeEndingRoomReplayPayload = useMemo(
    () => (
      activeEndingRoomBranch
      && replayEndingRoomPayload
      && replayEndingRoomPayload.branchId === activeEndingRoomBranch.id
    )
      ? replayEndingRoomPayload
      : null,
    [activeEndingRoomBranch, replayEndingRoomPayload],
  );
  const liveEndingRoomReplayPayload = useMemo<OracleReplayPayload | null>(() => {
    if (
      !activeEndingRoomBranch
      || !replaySnapshot
      || !endingRoomLiveSnapshot
      || !endingRoomLiveResult
      || endingRoomLiveSnapshot.room_type === 'worldline_roundtable'
    ) {
      return null;
    }
    return {
      kind: 'ending_room_v1',
      scenarioReplay: replaySnapshot,
      roomSnapshot: endingRoomLiveSnapshot,
      roomResult: endingRoomLiveResult,
      branchId: activeEndingRoomBranch.id,
      selectedAgentIds: activeEndingRoomSelectedAgentIds,
      activeThreadId: endingRoomLiveActiveThreadId,
    };
  }, [
    activeEndingRoomBranch,
    activeEndingRoomSelectedAgentIds,
    endingRoomLiveActiveThreadId,
    endingRoomLiveResult,
    endingRoomLiveSnapshot,
    replaySnapshot,
  ]);
  const effectiveEndingRoomReplayPayload = activeEndingRoomReplayPayload ?? liveEndingRoomReplayPayload;
  const canImportActiveEndingRoomReplay = Boolean(activeEndingRoomReplayPayload);
  const showResultReplayImportAction = isReplayMode && !activeEndingRoomBranch;
  const sourceFamilyContext = (
    scenario?.web_search_context?.family_context ?? EMPTY_SOURCE_FAMILY_CONTEXT
  ) as SourceFamilyContext;
  const shareSourceFamilies = useMemo(() => {
    const families = Object.entries(sourceFamilyContext)
      .filter(([, entry]) => Array.isArray(entry?.items) && entry.items.length > 0)
      .map(([family]) => family);
    return families.length > 0 ? families : undefined;
  }, [sourceFamilyContext]);
  const handleOpenRoundtable = useCallback(() => {
    if (!scenario?.id || isReplayMode || branches.length < 2) {
      return;
    }
    navigate(`/roundtable/${scenario.id}`);
  }, [branches.length, isReplayMode, navigate, scenario?.id]);
  const handleCopyEndingRoomReplayLink = useCallback(async () => {
    if (!effectiveEndingRoomReplayPayload) return;
    const copyWindowMs = 1800;
    const finalizeCopyState = (usedLocalFallback: boolean) => {
      setEndingRoomPermalinkCopied(true);
      resetCopiedStateAfter(
        endingRoomPermalinkCopiedTimerRef,
        () => setEndingRoomPermalinkCopied(false),
        copyWindowMs,
      );
      if (usedLocalFallback) {
        setEndingRoomLocalCopySaved(true);
        resetCopiedStateAfter(
          endingRoomLocalCopySavedTimerRef,
          () => setEndingRoomLocalCopySaved(false),
          copyWindowMs,
        );
      }
    };

    try {
      const sanitizedReplayPayload = sanitizeOracleReplayPayload(effectiveEndingRoomReplayPayload);
      const artifact = await createReplayArtifact(
        sanitizedReplayPayload.kind,
        sanitizedReplayPayload as unknown as Record<string, unknown>,
        effectiveEndingRoomReplayPayload.roomSnapshot.scenario_id,
      ).catch(() => null);
      let url: string;
      let usedLocalFallback = false;
      if (artifact) {
        url = buildOracleReplayShareUrl(window.location.origin, sanitizedReplayPayload, artifact.id);
      } else if (isReplayEnvelopeLikelyTooLarge(
        sanitizedReplayPayload.kind,
        sanitizedReplayPayload,
      )) {
        const localId = saveOracleReplayLocalCopy(sanitizedReplayPayload);
        url = buildOracleReplayLocalUrl(window.location.origin, sanitizedReplayPayload, localId);
        usedLocalFallback = true;
      } else {
        url = await buildOracleReplayUrl(window.location.origin, sanitizedReplayPayload);
      }
      await copyText(url);
      finalizeCopyState(usedLocalFallback);
    } catch (error) {
      console.warn('[ResultView] Falling back to local ending-room replay copy', error);
      const localId = saveOracleReplayLocalCopy(effectiveEndingRoomReplayPayload);
      await copyText(buildOracleReplayLocalUrl(window.location.origin, effectiveEndingRoomReplayPayload, localId));
      finalizeCopyState(true);
    }
  }, [effectiveEndingRoomReplayPayload, resetCopiedStateAfter]);
  const handleSaveEndingRoomReadonlyCopy = useCallback(() => {
    if (!effectiveEndingRoomReplayPayload) return;
    const localId = saveOracleReplayLocalCopy(effectiveEndingRoomReplayPayload);
    applyEndingRoomReplay({
      ...effectiveEndingRoomReplayPayload,
      selectedAgentIds: [...(effectiveEndingRoomReplayPayload.selectedAgentIds ?? [])],
    });
    navigate(`/result/replay?roomLocal=${localId}`, { replace: true });
    setEndingRoomLocalCopySaved(true);
    resetCopiedStateAfter(
      endingRoomLocalCopySavedTimerRef,
      () => setEndingRoomLocalCopySaved(false),
      1800,
    );
  }, [applyEndingRoomReplay, effectiveEndingRoomReplayPayload, navigate, resetCopiedStateAfter]);
  const handleImportEndingRoomReplay = useCallback(async () => {
    const scenarioReplay = effectiveEndingRoomReplayPayload?.scenarioReplay;
    if (!scenarioReplay || importingEndingRoomReplay) return;
    setImportingEndingRoomReplay(true);
    setImportError('');
    try {
      const imported = await importReplayScenario(scenarioReplay.scenario);
      navigate(`/sim/${imported.id}`);
    } catch (nextError) {
      setImportError(
        getLocalizedApiErrorMessage(
          nextError,
          t,
          t('result.import_chamber_replay_failed'),
        ),
      );
    } finally {
      setImportingEndingRoomReplay(false);
    }
  }, [effectiveEndingRoomReplayPayload?.scenarioReplay, importingEndingRoomReplay, navigate, t]);
  const pendingEndingRoomBranch = useMemo<StoryData['branches'][number] | null>(
    () => branches.find((branch) => branch.id === pendingEndingRoomPicker?.branchId) ?? null,
    [branches, pendingEndingRoomPicker?.branchId],
  );
  const pendingEndingRoomCandidates = pendingEndingRoomPicker
    ? (branchEndingRoomCandidates[pendingEndingRoomPicker.branchId] ?? [])
    : [];
  const endingRoomPickerOpen = Boolean(pendingEndingRoomPicker && pendingEndingRoomBranch);
  useFocusTrap(endingRoomPickerDialogRef, endingRoomPickerOpen);
  useEffect(() => {
    if (!endingRoomPickerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPendingEndingRoomPicker(null);
      }
    };
    window.addEventListener('keydown', onKey);
    endingRoomPickerCloseRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [endingRoomPickerOpen]);
  const activeEndingRoomSelectedBranchIds = useMemo(
    () => {
      if (!activeEndingRoomBranch) return [];
      if (activeEndingRoomMode === 'crossline_gallery') {
        return branches
          .filter((candidate) => candidate.id !== activeEndingRoomBranch.id)
          .map((candidate) => candidate.id);
      }
      return [activeEndingRoomBranch.id];
    },
    [activeEndingRoomBranch, activeEndingRoomMode, branches],
  );
  const endingRoomHeaderActions = useMemo(() => {
    if (!effectiveEndingRoomReplayPayload) return null;
    return (
      <>
        <button
          type="button"
          className="ending-chat-inline-button"
          onClick={() => void handleCopyEndingRoomReplayLink()}
        >
          {endingRoomPermalinkCopied
            ? t('result.replay_copied')
            : t('result.copy_replay')}
        </button>
        <button
          type="button"
          className="ending-chat-inline-button"
          onClick={handleSaveEndingRoomReadonlyCopy}
        >
          {endingRoomLocalCopySaved
            ? t('result.saved_local_readonly_copy')
            : t('result.save_local_readonly_copy')}
        </button>
        {canImportActiveEndingRoomReplay && (
          <button
            type="button"
            className="ending-chat-inline-button"
            onClick={() => void handleImportEndingRoomReplay()}
            disabled={importingEndingRoomReplay}
          >
            {importingEndingRoomReplay
              ? t('sim.replay.importing')
              : t('sim.replay.import_local')}
          </button>
        )}
      </>
    );
  }, [
    canImportActiveEndingRoomReplay,
    effectiveEndingRoomReplayPayload,
    endingRoomLocalCopySaved,
    endingRoomPermalinkCopied,
    handleCopyEndingRoomReplayLink,
    handleImportEndingRoomReplay,
    handleSaveEndingRoomReadonlyCopy,
    importingEndingRoomReplay,
    t,
  ]);
  const betOutcomeContext = useMemo(() => ({
    dominantBranchId: dominantBranchFromStory?.id ?? null,
    dominantBranchTitle: displayArchive?.dominantBranchTitle ?? null,
    dominantTone: displayArchive?.dominantTone ?? null,
    profileResonance: displayArchive?.profileResonance ?? null,
  }), [
    dominantBranchFromStory?.id,
    displayArchive?.dominantBranchTitle,
    displayArchive?.dominantTone,
    displayArchive?.profileResonance,
  ]);
  const localBetOutcomes = useMemo(() => (
    scenarioMeta?.betting.bets.map((bet) => ({
      bet,
      outcome: resolveStructuredBetOutcome(bet, betOutcomeContext),
    })) ?? []
  ), [betOutcomeContext, scenarioMeta?.betting.bets]);
  const formattedArchiveKeyMoments = useMemo(
    () => scenarioMeta ? getScenarioArchiveKeyMoments(scenarioMeta).map((moment) => formatArchiveKeyMoment(moment, isZh, t)) : [],
    [isZh, scenarioMeta, t],
  );
  const directorMomentHighlights = useMemo(
    () => buildMomentHighlights(archiveKeyMoments, isZh, 5, t),
    [archiveKeyMoments, isZh, t],
  );
  const directorBetHighlights = useMemo(() => (
    localBetOutcomes.slice(0, 3).map(({ bet, outcome }) => ({
      targetLabel: bet.targetLabel,
      confidence: bet.confidence,
      placedAtRound: bet.placedAtRound,
      outcome,
    }))
  ), [localBetOutcomes]);
  const directorInterventionSummary = useMemo(() => {
    const usage = scenarioMeta?.cards.usageLog.slice(-1)[0];
    if (!usage) return null;
    const definition = getGameplayCardDefinition(usage.cardId);
    return {
      cardLabel: isZh ? definition.labelZh : definition.labelEn,
      branchTitle: usage.branchTitle,
      round: usage.round,
      directive: usage.directive,
    };
  }, [isZh, scenarioMeta?.cards.usageLog]);
  const newlyUnlockedBadges = useMemo(() => (
    campaignSummary?.newly_unlocked_badges.map((badge) => ({
      badge,
      copy: getCampaignBadgeCopy(badge.badge_id, t),
    })) ?? []
  ), [campaignSummary?.newly_unlocked_badges, t]);
  const hitBetCount = localBetOutcomes.filter((entry) => entry.outcome === 'hit').length;
  const resolvedBetCount = localBetOutcomes.filter((entry) => entry.outcome !== 'pending').length;

  useEffect(() => {
    const win = window as AutomationWindow;
    const render = () => stringifyAutomationPayload(
      {
        question: storyData?.question ?? null,
        status: loading ? 'loading' : error ? 'error' : 'done',
        currentRound: 0,
        totalRounds: null,
        viewMode: 'classic',
        visualizationEnabled: false,
        isSimulationComplete: !loading && !error,
        messageCount: 0,
        agentCount: agents.length,
        branchCount: storyData?.branches.length ?? 0,
      },
      null,
      {
        route: window.location.pathname,
        kind: 'result',
        replay_source: isReplayMode ? 'token' : 'api',
        loading,
        error: buildAutomationErrorState(errorCode, error),
        question: storyData?.question ?? null,
        report_status: storyData?.full_report?.status ?? null,
        branch_titles: (storyData?.branches ?? []).map((branch) => branch.title),
        predictions_count: predictions.length,
        has_unscored: hasUnscored,
        runtime_preset: {
          id: activeRuntimePreset,
          label: activeRuntimePresetLabel,
          source: scenarioRuntimePreset ? 'scenario' : 'session',
          branch_sensitivity: activeRuntimePresetConfig.branchSensitivity,
          fork_prompt_variant: activeRuntimePresetConfig.forkPromptVariant,
          fork_detector_active_branch_limit: activeRuntimePresetConfig.forkDetectorActiveBranchLimit,
        },
        archive_summary: storyData && scenarioMeta && displayArchive
          ? {
              most_used_card: displayArchive.mostUsedCard ?? null,
              betting_hit: displayArchive.bettingHit ?? null,
              archive_grade: displayArchive.archiveGrade ?? null,
              dominant_branch_title: displayArchive.dominantBranchTitle ?? null,
              dominant_tone: displayArchive.dominantTone ?? null,
              profile_id: displayArchive.profileId ?? null,
              profile_resonance: displayArchive.profileResonance ?? null,
              objective_completed_count: displayArchive.objectiveCompletedCount ?? 0,
              objective_total_count: displayArchive.objectiveTotalCount ?? 0,
              commitment_outcome: displayArchive.commitmentOutcome ?? null,
              counterplay_card_count: displayArchive.counterplayCardCount ?? 0,
              last_counterplay_card: displayArchive.lastCounterplayCard ?? null,
              risk_value: displayArchive.riskValue ?? null,
              resource_value: displayArchive.resourceValue ?? null,
              completed_daily_challenge: isDailyChallenge,
            }
          : null,
        result_bet_list: localBetOutcomes.map(({ bet, outcome }) => ({
          bet_id: bet.betId,
          kind: bet.kind,
          target_label: bet.targetLabel,
          placed_at_round: bet.placedAtRound,
          confidence: bet.confidence,
          outcome,
        })),
        result_key_moments: formattedArchiveKeyMoments,
        result_branch_snapshots: displayBranchSnapshots.map((snapshot) => ({
          branch_id: snapshot.branchId,
          title: snapshot.title,
          probability: snapshot.probability,
        })) ?? [],
        campaign_summary: campaignSummary
          ? {
              already_finalized: campaignSummary.already_finalized,
              campaign_score_delta: campaignSummary.campaign_score_delta,
              score_breakdown: campaignSummary.score_breakdown ?? [],
              level: campaignSummary.mastery.level,
              score_to_next_level: campaignSummary.mastery.score_to_next_level,
              badge_count: campaignSummary.badges.length,
              newly_unlocked_badges: campaignSummary.newly_unlocked_badges.map((badge) => badge.badge_id),
            }
          : null,
        director_debrief: campaignSummary
          ? {
              question: storyData?.question ?? scenario?.question ?? null,
              worldline_title: displayArchive?.dominantBranchTitle ?? analysisBranch?.title ?? null,
              commitment: {
                active: Boolean((scenarioMeta?.commitment.active ?? false) || displayArchive?.commitmentOutcome),
                branch_title: scenarioMeta?.commitment.branchTitle
                  ?? (displayArchive?.commitmentOutcome ? displayArchive.dominantBranchTitle : null),
                outcome: displayArchive?.commitmentOutcome ?? null,
                committed_at_round: scenarioMeta?.commitment.committedAtRound ?? null,
              },
              bet_highlights: directorBetHighlights,
              moment_highlights: directorMomentHighlights.map((moment) => ({
                kind: moment.kind,
                label: moment.label,
                round: moment.round ?? null,
              })),
              intervention: directorInterventionSummary,
            }
          : null,
        controls: {
          can_go_back_to_simulation: !isReplayMode && Boolean(id),
          can_export_markdown: !exporting && !isReplayMode,
          can_open_share_modal: !isReplayMode && Boolean(replayUrl),
          can_open_leaderboard: true,
          can_score_predictions: hasUnscored && !scoring && !isReplayMode,
          active_modal: showShare ? 'share' : activeEndingRoomBranch ? 'ending_room' : null,
          modal_state: showShare ? shareAutomation : activeEndingRoomBranch ? endingRoomAutomationRef.current : null,
          expanded_branch_id: expandedBranch,
        },
        branches: (storyData?.branches ?? []).slice(0, 8).map((branch) => ({
          id: branch.id,
          title: branch.title,
          probability: branch.probability,
          has_story: Boolean(branch.story),
          can_expand_story: Boolean(branch.story && branch.story.length > 150),
          can_open_ending_room: Boolean(branch.story || branch.insight),
          expanded: expandedBranch === branch.id,
        })),
      },
    );

    win.render_game_to_text = render;
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
    };
  }, [activeEndingRoomBranch, agents.length, analysisBranch?.title, campaignSummary, completedObjectiveCount, directorBetHighlights, directorInterventionSummary, directorMomentHighlights, displayArchive, displayBranchSnapshots, error, errorCode, evaluatedObjectives.length, expandedBranch, exporting, formattedArchiveKeyMoments, hasUnscored, id, isDailyChallenge, isReplayMode, loading, localBetOutcomes, predictions, replayUrl, scenario?.question, scenarioMeta, scoring, shareAutomation, showShare, storyData, systemTracks?.resourceValue, systemTracks?.riskValue, activeRuntimePreset, activeRuntimePresetConfig.branchSensitivity, activeRuntimePresetConfig.forkDetectorActiveBranchLimit, activeRuntimePresetConfig.forkPromptVariant, activeRuntimePresetLabel, scenarioRuntimePreset]);

  if (loading) {
    // multi-run 等待态：展示多世界线推演进度（自轮询 run-group）+ 观看首条入口 + 本地慢提示，
    // 替代单场景那行干巴巴的 loading_narration，避免“看起来跳过推演 / 卡死”的误判。
    // capability 明确关闭（kill-switch）时回退 loading_narration，避免对已禁用的 run-group 端点
    // 持续打 404；undefined（capability 加载中）仍渲染面板，规避时序 bug。codex 审查 M4。
    if (scenario?.run_group_id && capabilities?.multi_run?.enabled !== false) {
      return (
        <div className="result-view">
          <ProgressIndicator currentStep={3} />
          <MultiRunWaitingPanel runGroupId={scenario.run_group_id} firstRunId={id} />
        </div>
      );
    }
    return (
      <div className="result-view">
        <p className="result-loading">
          {scenario?.status && scenario.status !== 'done'
            ? t('result.loading_narration')
            : t('sim.status.loading')}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="result-view">
        <p className="result-error">{error}</p>
        <button className="btn" onClick={() => navigate('/')}>
          {t('sim.status.back')}
        </button>
      </div>
    );
  }

  const contextValue: ResultViewContextValue = {
    id,
    activeScenarioId,
    navigate,
    t,
    isZh,
    resultViewMode,
    setResultViewMode,
    isWorkbenchMode,
    isReplayMode,
    capabilities,
    capLoading,
    capError,
    reloadCapabilities,
    scenario,
    storyData,
    agents,
    predictions,
    branches,
    analysisBranch,
    primaryAgentIdentityId,
    notebookOpen,
    setNotebookOpen,
    debriefOpen,
    setDebriefOpen,
    webSourcesOpen,
    setWebSourcesOpen,
    blurCollapsedPanelFocus,
    expandedBranch,
    setExpandedBranch,
    exporting,
    exportError,
    importError,
    importingReplay,
    showResultReplayImportAction,
    handleExport,
    handleImportReplay,
    replayUrl,
    permalinkCopied,
    handleCopyPermalink,
    challengeLinkCopied,
    handleShareChallenge,
    showShare,
    setShowShare: handleSetShowShare,
    showSnapshotExport,
    setShowSnapshotExport,
    handleOpenEndingRoom,
    handleOpenRoundtable,
    scoring,
    scoreError,
    hasUnscored,
    handleScore,
    activeRuntimePresetLabel,
    cfBranchId,
    setCfBranchId,
    cfInitialRound,
    setCfInitialRound,
    scenarioMeta,
    campaignSummary,
    campaignScenarioSummary,
    campaignError,
    campaignNotice,
    isDailyChallenge,
    resolvedProfileId,
    gameplayProfileLabel,
    gameplayProfileHooks,
    shareSourceFamilies,
    agentFollowupTarget,
    setAgentFollowupTarget,
    profileTarget,
    setProfileTarget,
    directorUserId: apiUserId,
  };

  return (
    <ResultContextProvider value={contextValue}>

    <div className="result-view">
      <ProgressIndicator currentStep={4} />
      <ResultHeader />

      {scenario?.run_group_id && (
        <MultiRunDistributionPanel
          runGroupId={scenario.run_group_id}
          onRefresh={refresh}
        />
      )}

      {resultVerdictEnabled && (
        <ResultVerdictPanel
          verdict={storyData?.verdict ?? null}
          confidence={storyData?.verdict_confidence ?? null}
          confidenceKind={storyData?.verdict_confidence_kind}
          question={storyData?.question ?? ''}
        />
      )}

      <DomainWorldStrip
        domainWorld={scenario?.domain_world ?? null}
        branchId={branches[0]?.id ?? null}
        readOnly
      />

      <WorldOutcomesSection
        worldOutcomes={storyData?.world_outcomes ?? null}
        branchTitles={Object.fromEntries(
          (storyData?.branches ?? []).map((branch) => [branch.id, branch.title]),
        )}
      />

      <YouVsOracleCard
        scoreResults={scoreResults}
        hasVerdict={!!storyData?.verdict}
      />

      {scenario?.id && (
        <SocialFeedPanel scenarioId={scenario.id} />
      )}

      <ResultReportPanel onRefresh={refreshReportData} />

      {/* HOPs probability sampling animation */}
      {branches.length >= 2 && (
        <HOPsAnimation
          branches={branches}
          isPlaying={!isReplayMode}
        />
      )}

      <EndingCardsGrid />

      <ExploreDeeperBridge />

      {/* Hook Summary Panel */}
      {isWorkbenchMode && activeScenarioId && !loading && !capLoading && (
        <HookSummaryPanel
          scenarioId={activeScenarioId}
          branchId={branches[0]?.id}
          identityId={primaryAgentIdentityId ?? undefined}
          userId={apiUserId}
        />
      )}

      <UnifiedSourceFeed target="desktop" />

      <PredictionsSection betOutcomeContext={betOutcomeContext} />

      <DirectorNotebook
        displayArchive={displayArchive}
        hasLocalDirectorState={hasLocalDirectorState}
        resolvedBetCount={resolvedBetCount}
        hitBetCount={hitBetCount}
        formattedArchiveKeyMoments={formattedArchiveKeyMoments}
        localBetOutcomes={localBetOutcomes}
        evaluatedObjectives={evaluatedObjectives}
        signatureArcState={signatureArcState}
        systemTracks={systemTracks}
        challengeProgress={challengeProgress}
        challengeFeedbackLabel={challengeFeedbackLabel}
        lastCounterplayCardLabel={lastCounterplayCardLabel}
        commitmentOutcomeLabel={commitmentOutcomeLabel}
        counterplaySummaryLabel={counterplaySummaryLabel}
        completedObjectiveCount={completedObjectiveCount}
        displayBranchSnapshots={displayBranchSnapshots}
        directorStyleLabel={directorStyleLabel}
        profileResonanceLabel={profileResonanceLabel}
        resultConversationContext={resultConversationContext}
      />

      {campaignSummary && (
        <DirectorDebriefPanel
          campaignSummary={campaignSummary}
          scenarioQuestion={storyData?.question ?? scenario?.question ?? null}
          worldlineSummary={{
            title: displayArchive?.dominantBranchTitle ?? analysisBranch?.title ?? null,
            insight: resultConversationContext?.insight ?? null,
            forkReason: resultConversationContext?.forkReason ?? null,
            comparisonTitles: resultConversationContext?.comparisonTitles ?? [],
          }}
          commitmentSummary={{
            active: Boolean((scenarioMeta?.commitment.active ?? false) || displayArchive?.commitmentOutcome),
            branchTitle: scenarioMeta?.commitment.branchTitle
              ?? (displayArchive?.commitmentOutcome ? displayArchive.dominantBranchTitle : null),
            committedAtRound: scenarioMeta?.commitment.committedAtRound ?? null,
            outcome: displayArchive?.commitmentOutcome ?? null,
          }}
          betHighlights={directorBetHighlights}
          momentHighlights={directorMomentHighlights}
          interventionSummary={directorInterventionSummary}
          profileLabel={gameplayProfileLabel}
          profileHooks={gameplayProfileHooks}
          archiveGrade={displayArchive?.archiveGrade ?? null}
          profileResonance={displayArchive?.profileResonance ?? null}
          profileResonanceLabel={profileResonanceLabel}
          directorStyleLabel={directorStyleLabel}
          objectiveCompletedCount={displayArchive?.objectiveCompletedCount ?? 0}
          objectiveTotalCount={displayArchive?.objectiveTotalCount ?? 0}
          commitmentOutcome={displayArchive?.commitmentOutcome ?? null}
          commitmentOutcomeLabel={commitmentOutcomeLabel}
          commitmentBranchTitle={scenarioMeta?.commitment.branchTitle ?? null}
          isDailyChallenge={isDailyChallenge}
          betCount={scenarioMeta?.betting.bets.length ?? 0}
          bettingHit={displayArchive?.bettingHit ?? null}
          signatureArc={signatureArcState}
          systemTracks={systemTracks}
          tacticalState={tacticalState}
          dominantBranchTitle={displayArchive?.dominantBranchTitle ?? analysisBranch?.title ?? null}
          keyMoments={formattedArchiveKeyMoments.slice(0, 2)}
          notebookHref="#result-director-notebook"
          analysisHref={!capLoading && activeScenarioId && branches.length > 0 ? '#result-bridge' : null}
          conversationHref={
            !isReplayMode && activeScenarioId && (capabilities?.agent_conversation?.enabled ?? false)
              ? '#result-conversation'
              : null
          }
          newlyUnlockedBadges={newlyUnlockedBadges.map(({ badge, copy }) => ({
            id: badge.id,
            unlockedAt: badge.unlocked_at,
            label: copy.label,
            description: copy.description,
          }))}
        />
      )}

      {campaignSummary && (weeklySummaryLoading || weeklySummaryError || weeklySummary?.weekly_track_id) && (
        <div style={{ marginTop: '1rem' }}>
          <WeeklyLeaderboard
            entries={weeklySummary?.leaderboard_entries ?? []}
            currentUserRank={weeklySummary?.rank}
            loading={weeklySummaryLoading}
            error={weeklySummaryError}
          />
        </div>
      )}

      {campaignNotice && (
        <p className="result-note result-note--spaced">{campaignNotice}</p>
      )}

      {campaignError && (
        <p className="result-error result-error--spaced">{campaignError}</p>
      )}

      <AgentRoster
        factionTimelineBranch={factionTimelineBranch}
        factionTimelineLead={factionTimelineLead}
      />

      <AgentProfileSheet
        agent={profileTarget}
        observation={profileObservation}
        userId={apiUserId}
        onClose={() => setProfileTarget(null)}
        onStartConversation={handleStartConversationFromProfile}
      />

      <ResultModals
        shareFlavorContext={shareFlavorContext}
        setShareAutomation={setShareAutomation}
        pendingEndingRoomPicker={pendingEndingRoomPicker}
        setPendingEndingRoomPicker={setPendingEndingRoomPicker}
        pendingEndingRoomBranch={pendingEndingRoomBranch}
        pendingEndingRoomCandidates={pendingEndingRoomCandidates}
        endingRoomPickerDialogRef={endingRoomPickerDialogRef}
        endingRoomPickerCloseRef={endingRoomPickerCloseRef}
        openEndingRoomDirect={openEndingRoomDirect}
        activeEndingRoomBranch={activeEndingRoomBranch}
        activeEndingRoomMode={activeEndingRoomMode}
        activeEndingRoomSelectedBranchIds={activeEndingRoomSelectedBranchIds}
        activeEndingRoomSelectedAgentIds={activeEndingRoomSelectedAgentIds}
        activeEndingRoomReplayPayload={activeEndingRoomReplayPayload}
        endingRoomHeaderActions={endingRoomHeaderActions}
        setEndingRoomAutomation={setEndingRoomAutomation}
        handleEndingRoomModeChange={handleEndingRoomModeChange}
        handleCloseEndingRoom={handleCloseEndingRoom}
        sourceFamilyContext={sourceFamilyContext}
        mobileSourceSheetOpen={mobileSourceSheetOpen}
        setMobileSourceSheetOpen={setMobileSourceSheetOpen}
        resultConversationContext={resultConversationContext}
        activeEndingRoomModelProfileId={activeEndingRoomModelProfileId}
      />
    </div>
    </ResultContextProvider>
  );
}

interface YouVsOracleCardProps {
  scoreResults: ScorePredictionResultItem[];
  hasVerdict: boolean;
}

function YouVsOracleCard({ scoreResults, hasVerdict }: YouVsOracleCardProps) {
  const { t } = useTranslation();
  const { enabled, loading: capLoading, error, reload } = useCapabilityCheck('you_vs_oracle');
  const titleId = useId();

  if (capLoading) return null;

  if (error) {
    return (
      <div
        className="you-vs-oracle-error-placeholder"
        role="alert"
        style={{
          padding: '1rem',
          border: '1px solid #f5c6cb',
          backgroundColor: '#fdf3f4',
          borderRadius: '8px',
          margin: '1rem 0',
          textAlign: 'center'
        }}
      >
        <h4 style={{ margin: '0 0 0.5rem 0', color: '#721c24' }}>{t('common.capability_error_title')}</h4>
        <p style={{ margin: '0 0 1rem 0', color: '#721c24', fontSize: '0.9rem' }}>{t('common.capability_error')}</p>
        <button
          type="button"
          className="btn btn-ghost"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #c61583',
            color: '#c61583',
            padding: '0.5rem 1rem',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
          onClick={() => {
            if (reload) {
              void reload();
            }
          }}
          aria-label={t('common.retry')}
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="you-vs-oracle-disabled-placeholder" style={{ padding: '1rem', border: '1px dashed var(--color-border, #ccc)', borderRadius: '8px', margin: '1rem 0', textAlign: 'center', color: 'var(--color-text-secondary, #666)' }}>
        {t('you_vs_oracle.disabled_placeholder')}
      </div>
    );
  }

  const youVsOracleData = scoreResults.find(r => r?.you_vs_oracle !== undefined)?.you_vs_oracle;

  if (!hasVerdict || !youVsOracleData) {
    if (!hasVerdict) {
      return null;
    }
    return (
      <section
        className="you-vs-oracle-card"
        role="region"
        aria-labelledby={titleId}
        style={{
          padding: '1.5rem',
          border: '1px solid var(--color-border, #ccc)',
          borderRadius: '8px',
          margin: '1rem 0',
          backgroundColor: 'var(--color-bg-card, #fff)',
          boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
        }}
      >
        <h3 id={titleId} style={{ marginTop: 0, marginBottom: '1rem', color: 'var(--color-text-primary, #111)', fontSize: '1.25rem' }}>
          {t('you_vs_oracle.card_title')}
        </h3>
        <div className="you-vs-oracle-empty" style={{ padding: '1rem', textAlign: 'center', color: 'var(--color-text-secondary, #666)' }}>
          {t('you_vs_oracle.empty_state')}
        </div>
      </section>
    );
  }

  if (youVsOracleData.status === 'not_scorable') {
    const msg = youVsOracleData.reason === 'actual_outcome_unavailable'
      ? t('you_vs_oracle.not_scorable_actual_outcome_unavailable')
      : t('you_vs_oracle.not_scorable_generic');
    return (
      <section
        className="you-vs-oracle-card"
        role="region"
        aria-labelledby={titleId}
        style={{
          padding: '1.5rem',
          border: '1px solid var(--color-border, #ccc)',
          borderRadius: '8px',
          margin: '1rem 0',
          backgroundColor: 'var(--color-bg-card, #fff)',
          boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
        }}
      >
        <h3 id={titleId} style={{ marginTop: 0, marginBottom: '1rem', color: 'var(--color-text-primary, #111)', fontSize: '1.25rem' }}>
          {t('you_vs_oracle.card_title')}
        </h3>
        <div className="you-vs-oracle-empty" style={{ padding: '1rem', textAlign: 'center', color: 'var(--color-text-secondary, #666)' }}>
          {msg}
        </div>
      </section>
    );
  }

  const { predicted_probability, ai_actual_outcome, brier_score } = youVsOracleData;

  if (
    typeof predicted_probability !== 'number' ||
    typeof brier_score !== 'number' ||
    isNaN(predicted_probability) ||
    isNaN(brier_score)
  ) {
    return null;
  }

  const formattedProbability = `${Math.round(predicted_probability * 100)}%`;
  const formattedOutcome = ai_actual_outcome ? t('you_vs_oracle.outcome_true') : t('you_vs_oracle.outcome_false');

  return (
    <section
      className="you-vs-oracle-card"
      role="region"
      aria-labelledby={titleId}
      style={{
        padding: '1.5rem',
        border: '1px solid var(--color-border, #ccc)',
        borderRadius: '8px',
        margin: '1rem 0',
        backgroundColor: 'var(--color-bg-card, #fff)',
        boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
      }}
    >
      <h3 id={titleId} style={{ marginTop: 0, marginBottom: '1rem', color: 'var(--color-text-primary, #111)', fontSize: '1.25rem' }}>
        {t('you_vs_oracle.card_title')}
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
        <div style={{ padding: '1rem', background: 'var(--color-bg-secondary, #f9f9f9)', borderRadius: '6px' }}>
          <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary, #666)', display: 'block', marginBottom: '0.25rem' }}>
            {t('you_vs_oracle.predicted_probability')}
          </span>
          <strong style={{ fontSize: '1.5rem', color: 'var(--color-primary, #c61583)' }}>
            {formattedProbability}
          </strong>
        </div>
        <div style={{ padding: '1rem', background: 'var(--color-bg-secondary, #f9f9f9)', borderRadius: '6px' }}>
          <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary, #666)', display: 'block', marginBottom: '0.25rem' }}>
            {t('you_vs_oracle.actual_outcome')}
          </span>
          <strong style={{ fontSize: '1.5rem', color: 'var(--color-text-primary, #111)' }}>
            {formattedOutcome}
          </strong>
        </div>
        <div style={{ padding: '1rem', background: 'var(--color-bg-secondary, #f9f9f9)', borderRadius: '6px' }}>
          <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary, #666)', display: 'block', marginBottom: '0.25rem' }}>
            {t('you_vs_oracle.brier_score')}
          </span>
          <strong style={{ fontSize: '1.5rem', color: 'var(--color-text-primary, #111)' }}>
            {brier_score.toFixed(4)}
          </strong>
        </div>
      </div>
      <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--color-text-secondary, #666)', fontStyle: 'italic' }}>
        {t('you_vs_oracle.brier_hint')}
      </p>
    </section>
  );
}
