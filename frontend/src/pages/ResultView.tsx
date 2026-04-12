/* ═══════════════════════════════════════════════════════════
   SwarmOracle — ResultView (Multi-Ending Comparison)
   ═══════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  getReplayArtifact,
  getScenario,
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
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';
import {
  buildOracleReplayLocalUrl,
  buildOracleReplayShareUrl,
  buildOracleReplayUrl,
  loadOracleReplayLocalCopy,
  normalizeOracleReplayPayload,
  readOracleReplayPayload,
  saveOracleReplayLocalCopy,
  type OracleReplayPayload,
} from '../lib/oracleReplay';
import { isReplayEnvelopeLikelyTooLarge } from '../lib/replayCodec';
import {
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
  getEndingToneLabel,
  getPredictionRationale,
  getStructuredBetKindLabel,
  parseStructuredPredictionText,
  resolveStructuredBetOutcome,
} from '../lib/predictionBetting';
import { type ShareFlavorContext } from '../lib/shareEnvelope';
import { getTheaterThemeLabel } from '../lib/themeLabels';
import { getThemeAssetPath, isSceneThemeId } from '../lib/themeRegistry';
import {
  getScenarioRuntimePresetConfig,
  loadScenarioRuntimePreset,
  matchScenarioRuntimePreset,
} from '../lib/runtimePreset';
import {
  getGameplayBadgeSrc,
  getGameplayCardDefinition,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
  getScenarioSystemTrackState,
  getGameplaySignatureArcState,
  inferGameplayProfile,
} from '../components/gameplayCards';
import {
  type ScenarioResultReplayPayload,
} from '../lib/scenarioReplay';
import { useEndingRoomStore } from '../stores/endingRoomStore';
import type {
  AgentInfo,
  CampaignFinalizeResult,
  CampaignScenarioSummary,
  PredictionInfo,
  Scenario,
  StoryData,
} from '../types';
import ShareModal from '../components/ShareModal';
import EndingChatModal from '../components/EndingChatModal';
import {
  buildCampaignSummaryFromExistingData,
  buildStoryKeyMoments,
  classifyCampaignFinalizeError,
  formatArchiveKeyMoment,
  getBetOutcomeClass,
  getBetOutcomeLabel,
  getCampaignBadgeCopy,
  getCampaignBoundaryMessage,
  getEndingRoomCandidateAvatar,
  readCachedCampaignFinalizeResult,
  writeCachedCampaignFinalizeResult,
} from './resultHelpers';
import './ResultView.css';
import { CounterfactualPanel } from '../components/CounterfactualPanel';
import { FactionTimeline } from '../components/FactionTimeline';
import { ResumePanel } from '../components/ResumePanel';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { ReturningBadge } from '../components/ReturningBadge';

const loadScenarioReplayHelpers = () => import('../lib/scenarioReplay');
const EMPTY_GAMEPLAY_PROFILE_HOOKS: string[] = [];

export default function ResultView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const replayToken = searchParams.get('replay');
  const replayShareId = searchParams.get('share');
  const roomReplayShareId = searchParams.get('roomShare');
  const roomReplayLocalId = searchParams.get('roomLocal');
  const debugEndingRoomBranch = searchParams.get('debugEndingRoomBranch');
  const debugEndingRoomMode = searchParams.get('debugEndingRoomMode');
  const debugEndingRoomAgents = searchParams.get('debugEndingRoomAgents');
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const directorIdentity = getDirectorIdentity();

  const { capabilities } = useCapabilityCheck('causal_graph');
  const [cfBranchId, setCfBranchId] = useState<string | null>(null);
  const [notebookOpen, setNotebookOpen] = useState(true);
  const [webSourcesOpen, setWebSourcesOpen] = useState(false);
  const [storyData, setStoryData] = useState<StoryData | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [predictions, setPredictions] = useState<PredictionInfo[]>([]);
  const [expandedBranch, setExpandedBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [activeEndingRoomBranchId, setActiveEndingRoomBranchId] = useState<string | null>(null);
  const [activeEndingRoomMode, setActiveEndingRoomMode] = useState<'ending_chamber' | 'one_move_only' | 'crossline_gallery'>('ending_chamber');
  const [activeEndingRoomSelectedAgentIds, setActiveEndingRoomSelectedAgentIds] = useState<string[]>([]);
  const [pendingEndingRoomPicker, setPendingEndingRoomPicker] = useState<{
    branchId: string;
    roomType: 'ending_chamber' | 'one_move_only';
    selectedAgentIds: string[];
    maxSelectable: number;
  } | null>(null);
  const endingRoomAutomationRef = useRef<Record<string, unknown> | null>(null);
  const debugEndingRoomAppliedRef = useRef(false);
  const setEndingRoomAutomation = useCallback((value: Record<string, unknown> | null) => {
    endingRoomAutomationRef.current = value;
  }, []);
  const [challengeLinkCopied, setChallengeLinkCopied] = useState(false);
  const [permalinkCopied, setPermalinkCopied] = useState(false);
  const [endingRoomPermalinkCopied, setEndingRoomPermalinkCopied] = useState(false);
  const [endingRoomLocalCopySaved, setEndingRoomLocalCopySaved] = useState(false);
  const [importingEndingRoomReplay, setImportingEndingRoomReplay] = useState(false);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [replayPayload, setReplayPayload] = useState<ScenarioResultReplayPayload | null>(null);
  const [replayEndingRoomPayload, setReplayEndingRoomPayload] = useState<OracleReplayPayload | null>(null);
  const [shareAutomation, setShareAutomation] = useState<Record<string, unknown> | null>(null);
  const [importingReplay, setImportingReplay] = useState(false);
  const [importError, setImportError] = useState('');
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState('');
  const [campaignSummary, setCampaignSummary] = useState<CampaignFinalizeResult | null>(null);
  const [campaignScenarioSummary, setCampaignScenarioSummary] = useState<CampaignScenarioSummary | null>(null);
  const [campaignError, setCampaignError] = useState('');
  const [campaignNotice, setCampaignNotice] = useState('');
  const [derivedScenarioMeta, setDerivedScenarioMeta] = useState<ScenarioMeta | null>(null);
  const [localMetaRevision, setLocalMetaRevision] = useState(0);
  const endingRoomLiveSnapshot = useEndingRoomStore((state) => state.snapshot);
  const endingRoomLiveResult = useEndingRoomStore((state) => state.result);
  const endingRoomLiveActiveThreadId = useEndingRoomStore((state) => state.activeThreadId);
  const isReplayMode = Boolean(replayPayload);
  const hasUnscored = predictions.some((p) => p.score == null);
  const fallbackRuntimePreset = useMemo(() => loadScenarioRuntimePreset(), []);
  const scenarioRuntimePreset = useMemo(
    () => matchScenarioRuntimePreset(scenario?.fork_debug?.round_checks ?? null),
    [scenario?.fork_debug?.round_checks],
  );
  const activeRuntimePreset = scenarioRuntimePreset ?? fallbackRuntimePreset;
  const activeRuntimePresetConfig = useMemo(
    () => getScenarioRuntimePresetConfig(activeRuntimePreset),
    [activeRuntimePreset],
  );
  const activeRuntimePresetLabel = t(`home.runtime_preset_${activeRuntimePreset}`);
  const challengeMatch = id ? findChallengeProgressByScenarioId(id) : null;
  const replayInvalidMessage = isZh
    ? '这个回放链接无效或内容不完整。'
    : 'This replay link is invalid or incomplete.';
  const loadResultErrorMessage = isZh
    ? '加载结果失败'
    : 'Failed to load results';
  const replayInvalidMessageRef = useRef(replayInvalidMessage);
  const loadResultErrorMessageRef = useRef(loadResultErrorMessage);
  const isZhRef = useRef(isZh);
  const translationRef = useRef(t);
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
      if (roomReplayShareId || roomReplayLocalId || searchParams.get('roomReplay')) {
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
        const [story, agentList, scenario, preds, persistedCampaignSummary] = await Promise.all([
          getStory(id),
          getAgents(id),
          getScenario(id),
          Promise.resolve()
            .then(() => listPredictions(id))
            .catch(() => [] as PredictionInfo[]),
          Promise.resolve()
            .then(() => getCampaignScenarioSummary(id))
            .catch(() => null),
        ]);
        if (cancelled) return;

        setScenario(scenario);
        setAgents(agentList);
        setPredictions(preds);
        setCampaignScenarioSummary(persistedCampaignSummary);

        if (scenario.status !== 'done') {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void load();
          }, 1500);
          return;
        }

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
          ? readCachedCampaignFinalizeResult(id, directorIdentity.userId, finalizedProfileId)
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
            getCampaignProfile(directorIdentity.userId).catch(() => null),
            getCampaignMastery(directorIdentity.userId).catch(() => []),
            getCampaignBadges(directorIdentity.userId).catch(() => []),
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
        const shouldFinalizeCampaign = !persistedCampaignSummary?.finalized_at;
        if (!campaign && shouldFinalizeCampaign) {
          campaign = await finalizeCampaign(id, {
            user_id: directorIdentity.userId,
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
                setCampaignNotice(getCampaignBoundaryMessage(kind, isZhRef.current));
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
              directorIdentity.userId,
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
                    finalized_at: null,
                  },
            );
          }
        }
      } catch (err) {
        if (cancelled) return;
        setErrorCode(getApiErrorCode(err) ?? 'RESULT_LOAD_FAILED');
        setError(getLocalizedApiErrorMessage(err, translationRef.current, 'Failed to load results'));
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
    directorIdentity.userId,
    directorIdentity.userName,
    id,
    replayShareId,
    replayToken,
    searchParams,
    roomReplayLocalId,
    roomReplayShareId,
  ]);

  const handleExport = async () => {
    if (!id || exporting || isReplayMode) return;
    setExporting(true);
    setExportError('');
    try {
      const filename = `swarmoracle-${id.slice(0, 8)}.md`;
      const markdown = await exportScenario(id);
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
      window.setTimeout(() => setExporting(false), 250);
    }
  };

  const handleScore = async () => {
    if (!id || scoring || isReplayMode) return;
    setScoring(true);
    setScoreError('');
    try {
      const providerPolicy = loadLlmProviderPolicy();
      await scorePredictions(id, {
        llmApiKey: providerPolicy.apiKey || undefined,
        llmBaseUrl: providerPolicy.baseUrl || undefined,
        llmModel: providerPolicy.model || undefined,
        llmRequestsPerMinute: providerPolicy.requestsPerMinute ?? undefined,
        llmTokensPerMinute: providerPolicy.tokensPerMinute ?? undefined,
        userId: directorIdentity.userId,
      });
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
    window.setTimeout(() => setChallengeLinkCopied(false), 2000);
  };

  const handleCopyPermalink = async () => {
    if (!replayUrl) return;
    await copyText(replayUrl);
    setPermalinkCopied(true);
    window.setTimeout(() => setPermalinkCopied(false), 2000);
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
          isZh ? '导入回放失败' : 'Failed to import replay',
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
  ) => {
    setActiveEndingRoomBranchId(branchId);
    setActiveEndingRoomMode(roomType);
    setActiveEndingRoomSelectedAgentIds(selectedAgentIds);
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
  const evaluatedObjectives = useMemo(() => (
    scenarioMeta
      ? evaluateDirectorObjectives({
          objectives: scenarioMeta.objectives.goals,
          meta: scenarioMeta,
          dominantBranch: dominantBranchFromStory,
          isZh,
          isFinal: true,
        })
      : []
  ), [dominantBranchFromStory, isZh, scenarioMeta]);
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
      ? (isZh ? '承诺命中' : 'Commitment hit')
      : displayArchive.commitmentOutcome === 'miss'
        ? (isZh ? '承诺落空' : 'Commitment missed')
        : (isZh ? '承诺进行中' : 'Commitment pending')
    : (isZh ? '未承诺' : 'No commitment');
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

  useEffect(() => {
    let cancelled = false;

    const buildReplay = async () => {
      const routeFallbackUrl = id
        ? `${window.location.origin.replace(/\/$/, '')}/result/${id}`
        : null;
      if (isReplayMode) {
        setReplayUrl(window.location.href);
        return;
      }
      if (!replaySnapshot) {
        setReplayUrl(routeFallbackUrl);
        return;
      }
      const fallbackUrl = `${window.location.origin.replace(/\/$/, '')}/result/${replaySnapshot.scenario.id}`;
      if (!cancelled) {
        setReplayUrl(fallbackUrl);
      }
      const {
        buildScenarioReplayUrl,
        compactScenarioMetaForReplay,
      } = await loadScenarioReplayHelpers();
      const compactReplaySnapshot = {
        ...replaySnapshot,
        scenarioMeta: compactScenarioMetaForReplay(replaySnapshot.scenarioMeta, {
          stripDirectorAuthority: hasScenarioDirectorAuthority(replaySnapshot.scenario.director_state ?? null),
          stripGameplayAuthority: hasScenarioGameplayAuthority(replaySnapshot.scenario.gameplay_state ?? null),
        }),
      };
      const artifact = await Promise.resolve()
        .then(() => createReplayArtifact(
          'scenario_result_v1',
          compactReplaySnapshot as unknown as Record<string, unknown>,
        ))
        .catch(() => null);
      if (!artifact && isReplayEnvelopeLikelyTooLarge('scenario_result_v1', compactReplaySnapshot)) {
        return;
      }
      try {
        const url = artifact
          ? `${window.location.origin.replace(/\/$/, '')}/result/replay?share=${artifact.id}`
          : await buildScenarioReplayUrl(window.location.origin, compactReplaySnapshot);
        if (!cancelled) {
          setReplayUrl(url);
        }
      } catch (error) {
        console.warn('[ResultView] Failed to build replay URL', error);
      }
    };

    void buildReplay();
    return () => {
      cancelled = true;
    };
  }, [id, isReplayMode, replaySnapshot]);

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
      window.setTimeout(() => setEndingRoomPermalinkCopied(false), copyWindowMs);
      if (usedLocalFallback) {
        setEndingRoomLocalCopySaved(true);
        window.setTimeout(() => setEndingRoomLocalCopySaved(false), copyWindowMs);
      }
    };

    try {
      const artifact = await createReplayArtifact(
        effectiveEndingRoomReplayPayload.kind,
        effectiveEndingRoomReplayPayload as unknown as Record<string, unknown>,
      ).catch(() => null);
      let url: string;
      let usedLocalFallback = false;
      if (artifact) {
        url = buildOracleReplayShareUrl(window.location.origin, effectiveEndingRoomReplayPayload, artifact.id);
      } else if (isReplayEnvelopeLikelyTooLarge(
        effectiveEndingRoomReplayPayload.kind,
        effectiveEndingRoomReplayPayload,
      )) {
        const localId = saveOracleReplayLocalCopy(effectiveEndingRoomReplayPayload);
        url = buildOracleReplayLocalUrl(window.location.origin, effectiveEndingRoomReplayPayload, localId);
        usedLocalFallback = true;
      } else {
        url = await buildOracleReplayUrl(window.location.origin, effectiveEndingRoomReplayPayload);
      }
      await copyText(url);
      finalizeCopyState(usedLocalFallback);
    } catch (error) {
      console.warn('[ResultView] Falling back to local ending-room replay copy', error);
      const localId = saveOracleReplayLocalCopy(effectiveEndingRoomReplayPayload);
      await copyText(buildOracleReplayLocalUrl(window.location.origin, effectiveEndingRoomReplayPayload, localId));
      finalizeCopyState(true);
    }
  }, [effectiveEndingRoomReplayPayload]);
  const handleSaveEndingRoomReadonlyCopy = useCallback(() => {
    if (!effectiveEndingRoomReplayPayload) return;
    const localId = saveOracleReplayLocalCopy(effectiveEndingRoomReplayPayload);
    applyEndingRoomReplay({
      ...effectiveEndingRoomReplayPayload,
      selectedAgentIds: [...(effectiveEndingRoomReplayPayload.selectedAgentIds ?? [])],
    });
    navigate(`/result/replay?roomLocal=${localId}`, { replace: true });
    setEndingRoomLocalCopySaved(true);
    window.setTimeout(() => setEndingRoomLocalCopySaved(false), 1800);
  }, [applyEndingRoomReplay, effectiveEndingRoomReplayPayload, navigate]);
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
          isZh ? '导入会客厅回放失败' : 'Failed to import chamber replay',
        ),
      );
    } finally {
      setImportingEndingRoomReplay(false);
    }
  }, [effectiveEndingRoomReplayPayload?.scenarioReplay, importingEndingRoomReplay, isZh, navigate, t]);
  const pendingEndingRoomBranch = useMemo<StoryData['branches'][number] | null>(
    () => branches.find((branch) => branch.id === pendingEndingRoomPicker?.branchId) ?? null,
    [branches, pendingEndingRoomPicker?.branchId],
  );
  const pendingEndingRoomCandidates = pendingEndingRoomPicker
    ? (branchEndingRoomCandidates[pendingEndingRoomPicker.branchId] ?? [])
    : [];
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
            ? (isZh ? '回放已复制' : 'Replay copied')
            : (isZh ? '复制回放' : 'Copy replay')}
        </button>
        <button
          type="button"
          className="ending-chat-inline-button"
          onClick={handleSaveEndingRoomReadonlyCopy}
        >
          {endingRoomLocalCopySaved
            ? (isZh ? '已保存本地只读副本' : 'Saved local read-only copy')
            : (isZh ? '保存只读副本' : 'Save local read-only copy')}
        </button>
        {canImportActiveEndingRoomReplay && (
          <button
            type="button"
            className="ending-chat-inline-button"
            onClick={() => void handleImportEndingRoomReplay()}
            disabled={importingEndingRoomReplay}
          >
            {importingEndingRoomReplay
              ? (isZh ? '导入中…' : 'Importing…')
              : (isZh ? '导入本地运行' : 'Import local run')}
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
    isZh,
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
    () => scenarioMeta ? getScenarioArchiveKeyMoments(scenarioMeta).map((moment) => formatArchiveKeyMoment(moment, isZh)) : [],
    [isZh, scenarioMeta],
  );
  const newlyUnlockedBadges = useMemo(() => (
    campaignSummary?.newly_unlocked_badges.map((badge) => ({
      badge,
      copy: getCampaignBadgeCopy(badge.badge_id, isZh),
    })) ?? []
  ), [campaignSummary?.newly_unlocked_badges, isZh]);
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
              level: campaignSummary.mastery.level,
              score_to_next_level: campaignSummary.mastery.score_to_next_level,
              badge_count: campaignSummary.badges.length,
              newly_unlocked_badges: campaignSummary.newly_unlocked_badges.map((badge) => badge.badge_id),
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
  }, [activeEndingRoomBranch, agents.length, campaignSummary, completedObjectiveCount, displayArchive, displayBranchSnapshots, error, errorCode, evaluatedObjectives.length, expandedBranch, exporting, formattedArchiveKeyMoments, hasUnscored, id, isDailyChallenge, isReplayMode, loading, localBetOutcomes, predictions, replayUrl, scenarioMeta, scoring, shareAutomation, showShare, storyData, systemTracks?.resourceValue, systemTracks?.riskValue, activeRuntimePreset, activeRuntimePresetConfig.branchSensitivity, activeRuntimePresetConfig.forkDetectorActiveBranchLimit, activeRuntimePresetConfig.forkPromptVariant, activeRuntimePresetLabel, scenarioRuntimePreset]);

  if (loading) {
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

  const mostUsedCardLabel = displayArchive?.mostUsedCard
    ? (isZh
      ? getGameplayCardDefinition(
          displayArchive.mostUsedCard as Parameters<typeof getGameplayCardDefinition>[0],
        ).labelZh
      : getGameplayCardDefinition(
          displayArchive.mostUsedCard as Parameters<typeof getGameplayCardDefinition>[0],
        ).labelEn)
    : t('result.archive_no_cards');
  const bettingHitLabel =
    !scenarioMeta
      ? t('result.archive_no_bets')
      : scenarioMeta.betting.bets.length > 0
        ? resolvedBetCount === 0
          ? t('result.archive_pending')
          : t('result.archive_hit_ratio', { hit: hitBetCount, total: scenarioMeta.betting.bets.length })
        : displayArchive?.bettingHit == null
          ? t('result.archive_no_bets')
          : displayArchive.bettingHit
            ? t('result.archive_bet_hit')
            : t('result.archive_bet_miss');
  const dominantToneLabel = displayArchive?.dominantTone
    ? getEndingToneLabel(displayArchive.dominantTone, isZh)
    : t('result.archive_unset');

  return (
    <div className="result-view">
      {/* Header */}
      <header className="result-header">
        <button
          className="btn btn-ghost result-back"
          onClick={() => navigate(!isReplayMode && id ? `/sim/${id}` : '/')}
        >
          {t('result.back')}
        </button>
        <h1 className="result-title">{t('result.title')}</h1>
        {storyData?.question && (
          <p className="result-question">{storyData.question}</p>
        )}
        <p className="result-subtitle">
          {t('result.subtitle')} — {branches.length} {isZh
            ? '结局'
            : branches.length === 1
              ? 'ending'
              : 'endings'}
        </p>
        <div className="result-archive__chips">
          <span className="archive-chip archive-chip--primary">
            {t('common.runtime_preset_label')} · {activeRuntimePresetLabel}
          </span>
        </div>
        <div className="result-actions">
          <div className="result-actions__primary">
            {branches.length > 1 && (
              <button
                className="btn"
                onClick={handleOpenRoundtable}
                disabled={isReplayMode || scenario?.status !== 'done'}
              >
                {t('roundtable.entry_cta')}
              </button>
            )}
            {isReplayMode && (
              <button
                className="btn btn-primary"
                onClick={() => void handleImportReplay()}
                disabled={importingReplay}
              >
                {importingReplay
                  ? (isZh ? '导入中...' : 'Importing...')
                  : (isZh ? '导入为本地运行' : 'Import as Local Run')}
              </button>
            )}
          </div>
          <div className="result-actions__secondary">
            <button
              className="btn"
              onClick={handleExport}
              disabled={exporting || isReplayMode}
            >
              {exporting ? t('result.exporting') : t('result.export')}
            </button>
            <button
              className="btn"
              onClick={() => setShowShare(true)}
              disabled={isReplayMode || !replayUrl}
            >
              {t('result.share_btn')}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => void handleCopyPermalink()}
              disabled={!replayUrl}
            >
              {permalinkCopied ? t('result.permalink_copied') : t('result.copy_permalink_btn')}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => void handleShareChallenge()}
              disabled={!scenario}
            >
              {challengeLinkCopied ? t('result.challenge_link_copied') : t('result.share_challenge_btn')}
            </button>
          </div>
          <div className="result-actions__overflow">
            <button
              className="btn btn-ghost"
              onClick={() => navigate('/leaderboard')}
            >
              {t('result.leaderboard_link')}
            </button>
            {id && !isReplayMode && capabilities?.causal_graph?.enabled && (
              <a
                className="btn btn-ghost"
                href={`/sim/${id}/causal-map`}
              >
                {t('result.causal_graph_link', 'View Causal Graph')}
              </a>
            )}
            {id && !isReplayMode && cfBranchId && (
              <a
                className="btn btn-ghost"
                href={`/result/${id}/compare?branch_a=${branches[0]?.id ?? ''}&branch_b=${cfBranchId}`}
              >
                {t('result.compare_link', 'Compare branches')}
              </a>
            )}
          </div>
        </div>
        {exportError && <p className="result-error result-error--spaced">{exportError}</p>}
        {importError && <p className="result-error result-error--spaced">{importError}</p>}
      </header>

      {/* Ending Cards Grid */}
      {branches.length === 0 ? (
        <div className="result-empty">
          <p>{t('result.no_stories')}</p>
        </div>
      ) : (
        <div className="endings-grid">
          {branches.map((branch, index) => (
            <article
              key={branch.id}
              className={`ending-card ${expandedBranch === branch.id ? 'expanded' : ''} ${index === 0 ? 'ending-card--primary' : ''}`}
              ref={(el) => { if (el) el.style.setProperty('--card-delay', `${index * 0.1}s`); }}
            >
              {/* Summary-First: always visible */}
              <div className="ending-header">
                <span className="ending-index">
                  {t('result.ending_card')} {index + 1}
                </span>
                <h2 className="ending-title">{branch.title}</h2>
              </div>

              <div className="probability-section">
                <div className="probability-label">
                  <span>{t('result.probability')}</span>
                  <span className="probability-value">
                    {((branch.probability ?? 0) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="probability-bar">
                  <div
                    className={`probability-fill ${(branch.probability ?? 0) > 0.6 ? 'probability-fill--high' : (branch.probability ?? 0) < 0.3 ? 'probability-fill--low' : 'probability-fill--mid'}`}
                    ref={(el) => { if (el) el.style.setProperty('--prob-fill', `${Math.max((branch.probability ?? 0) * 100, 2)}%`); }}
                  />
                </div>
              </div>

              {/* Insight always visible as the card's key takeaway */}
              {branch.insight && (
                <blockquote className="insight-quote">{branch.insight}</blockquote>
              )}

              {/* Collapsible detail section */}
              <div className={`ending-detail ${expandedBranch === branch.id ? 'ending-detail--open' : ''}`}>
                <div className="ending-detail__inner">
                  {branch.fork_reason && (
                    <div className="fork-reason">
                      <span className="fork-label">{t('result.fork_reason')}</span>
                      <p>{branch.fork_reason}</p>
                    </div>
                  )}

                  <div className="story-section">
                    <h3 className="section-label">{t('result.story')}</h3>
                    <p className="story-text full">
                      {branch.story || '\u2014'}
                    </p>
                  </div>

                  {branch.key_moments && branch.key_moments.length > 0 && (
                    <div className="moments-section">
                      <h3 className="section-label">{t('result.key_moments')}</h3>
                      <ol className="moments-timeline">
                        {branch.key_moments.map((moment, mi) => (
                          <li key={mi}>{moment}</li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              </div>

              {/* Expand/collapse toggle */}
              {(branch.story || branch.fork_reason || (branch.key_moments && branch.key_moments.length > 0)) && (
                <button
                  className="btn btn-ghost expand-btn"
                  onClick={() =>
                    setExpandedBranch(
                      expandedBranch === branch.id ? null : branch.id,
                    )
                  }
                >
                  {expandedBranch === branch.id
                    ? t('result.collapse')
                    : t('result.read_full')}
                </button>
              )}

              <div className="ending-room-actions ending-action-band">
                <button
                  type="button"
                  className="btn"
                  onClick={() => void handleOpenEndingRoom(branch.id, 'ending_chamber')}
                  disabled={!isReplayMode && scenario?.status !== 'done'}
                >
                  {t('ending_room.entry_cta')}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => void handleOpenEndingRoom(branch.id, 'one_move_only')}
                  disabled={!isReplayMode && scenario?.status !== 'done'}
                >
                  {t('ending_room.one_move_cta')}
                </button>
                {branches.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void handleOpenEndingRoom(branch.id, 'crossline_gallery')}
                    disabled={!isReplayMode && scenario?.status !== 'done'}
                  >
                    {t('roundtable.gallery_title')}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Web Sources Section */}
      {scenario?.web_search_context
        && typeof scenario.web_search_context.query === 'string'
        && Array.isArray(scenario.web_search_context.snippets)
        && scenario.web_search_context.snippets.length > 0 && (
        <section className="result-web-sources">
          <button
            type="button"
            className="result-web-sources__trigger"
            aria-expanded={webSourcesOpen}
            onClick={() => setWebSourcesOpen((prev) => !prev)}
          >
            <span>{t('result.web_sources_title')}</span>
            <span aria-hidden="true">{webSourcesOpen ? '\u25B2' : '\u25BC'}</span>
          </button>
          <div className={`result-web-sources__body ${webSourcesOpen ? 'is-open' : ''}`} inert={!webSourcesOpen || undefined}>
            <div className="result-web-sources__inner">
              <div className="result-web-sources__meta">
                <span>{t('result.web_sources_query')}: {scenario.web_search_context.query}</span>
                {typeof scenario.web_search_context.provider === 'string' && (
                  <span>{t('result.web_sources_provider')}: {scenario.web_search_context.provider}</span>
                )}
                {scenario.web_search_context.cached && (
                  <span>{t('result.web_sources_cached')}</span>
                )}
              </div>
              <div className="result-web-sources__list">
                {scenario.web_search_context.snippets
                  .filter((s): s is { text: string; source_url: string } =>
                    s != null && typeof s.text === 'string')
                  .map((snippet, idx) => (
                  <article key={idx} className="result-web-sources__item">
                    <p className="result-web-sources__item-text">{snippet.text}</p>
                    {snippet.source_url && /^https?:\/\//i.test(snippet.source_url) && (
                      <a
                        className="result-web-sources__item-url"
                        href={snippet.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={t('result.web_sources_visit')}
                      >
                        {snippet.source_url}
                      </a>
                    )}
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Predictions Section (P5-B) */}
      {predictions.length > 0 && (
        <section className="result-predictions">
          <h2 className="result-predictions-title">{t('result.predictions_title')}</h2>
          {hasUnscored && !isReplayMode && (
            <button
              className="btn result-score-btn"
              onClick={handleScore}
              disabled={scoring}
            >
              {scoring ? t('result.scoring') : t('result.score_predictions')}
            </button>
          )}
          {scoreError && <p className="result-error">{scoreError}</p>}
          <div className="predictions-grid">
            {predictions.map((p) => (
              <div key={p.id} className="prediction-card">
                {(() => {
                  const structuredBet = parseStructuredPredictionText(p.prediction_text);
                  const structuredOutcome = structuredBet
                    ? resolveStructuredBetOutcome(structuredBet.meta, betOutcomeContext)
                    : null;
                  return (
                    <>
                <div className="prediction-card__header">
                  <span className="prediction-card__user">{p.user_name}</span>
                  <span className="prediction-card__confidence">
                    {Math.round((p.confidence ?? 0) * 100)}%
                  </span>
                </div>
                {structuredBet && (
                  <div className="prediction-card__bet-row">
                    <p className="prediction-card__bet-kind">
                      {getStructuredBetKindLabel(structuredBet.meta.kind, isZh)}
                      {' · '}
                      {structuredBet.meta.targetLabel}
                    </p>
                    {structuredOutcome && (
                      <span className={getBetOutcomeClass(structuredOutcome)}>
                        {getBetOutcomeLabel(structuredOutcome, t)}
                      </span>
                    )}
                  </div>
                )}
                <p className="prediction-card__text">{getPredictionRationale(p.prediction_text)}</p>
                {p.score != null && (
                  <div className="prediction-card__score">
                    <span className="score-value">{p.score.toFixed(0)}</span>
                    <span className="score-label">/ 100</span>
                    {p.score_reason && (
                      <p className="score-reason">{p.score_reason}</p>
                    )}
                  </div>
                )}
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Director's Notebook fold */}
      <section className="result-director-notebook">
        <button
          type="button"
          className="result-director-notebook__trigger"
          aria-expanded={notebookOpen}
          onClick={() => setNotebookOpen((prev) => !prev)}
        >
          <span>{t('result_ux.director_notebook')}</span>
          <span aria-hidden="true">{notebookOpen ? '\u25B2' : '\u25BC'}</span>
        </button>
        <div className={`result-director-notebook__body ${notebookOpen ? 'is-open' : ''}`} inert={!notebookOpen || undefined}>
          <div className="result-director-notebook__inner">

      {scenarioMeta && (
        <section className="result-archive">
          <h2 className="result-archive__title">
            <img src={getGameplayBadgeSrc('archive_record')} alt="" aria-hidden="true" />
            <span>{t('result.archive_title')}</span>
          </h2>
          <div
            className="result-archive__art"
            role="img"
            aria-label={t('common.archive_seal_alt')}
            style={{
              backgroundImage: scenario?.scene_theme && isSceneThemeId(scenario.scene_theme)
                ? `linear-gradient(180deg, transparent 40%, oklch(98% 0.005 80 / 0.85)), url(${getThemeAssetPath(scenario.scene_theme)})`
                : 'repeating-linear-gradient(135deg, oklch(50% 0.01 60 / 0.04) 0 1px, transparent 1px 12px), radial-gradient(ellipse at 30% 30%, oklch(55% 0.22 350 / 0.08), transparent 60%)',
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          />
          <div className="result-archive__meta">
            {gameplayProfileLabel && (
              <span className="archive-chip archive-chip--primary">{gameplayProfileLabel}</span>
            )}
            {scenario?.scene_theme && (
              <span className="archive-chip">{getTheaterThemeLabel(scenario.scene_theme, isZh)}</span>
            )}
            {isDailyChallenge && (
              <span className="archive-chip archive-chip--challenge">
                <img src={getGameplayBadgeSrc('daily_challenge')} alt="" aria-hidden="true" />
                <span>{t('result.archive_daily_challenge')}</span>
              </span>
            )}
            {hasLocalDirectorState && (
              <span className="archive-chip">
                {t('result.archive_director_points', {
                  remaining: scenarioMeta.director.remainingPoints,
                  max: scenarioMeta.director.maxPoints,
                })}
              </span>
            )}
            {displayArchive?.bettingHit === true && (
              <span className="archive-chip archive-chip--winner">
                <img src={getGameplayBadgeSrc('bet_winner')} alt="" aria-hidden="true" />
                <span>{t('result.archive_bet_hit')}</span>
              </span>
            )}
            {directorStyleLabel && (
              <span className="archive-chip">
                {directorStyleLabel}
              </span>
            )}
          </div>
          {gameplayProfileHooks.length > 0 && (
            <div className="result-archive__hooks" aria-label={t('common.theme_hooks_aria')}>
              {gameplayProfileHooks.map((hook) => (
                <span key={hook} className="archive-chip archive-chip--hook">
                  {hook}
                </span>
              ))}
            </div>
          )}

          <div className="archive-summary-grid">
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_dominant_branch')}</span>
              <strong>{displayArchive?.dominantBranchTitle ?? t('result.archive_unset')}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_dominant_tone')}</span>
              <strong>{dominantToneLabel}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_most_used_card')}</span>
              <strong>{mostUsedCardLabel}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_bet_result')}</span>
              <strong>{bettingHitLabel}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_counterplay')}</span>
              <strong>{counterplaySummaryLabel}</strong>
              {(displayArchive?.counterplayCardCount ?? 0) > 0 && (
                <small>
                  {t('result.archive_last_counterplay')}
                  {': '}
                  {lastCounterplayCardLabel}
                </small>
              )}
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_grade')}</span>
              <strong>{displayArchive?.archiveGrade ?? 'C'}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_resonance')}</span>
              <strong>{profileResonanceLabel}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{isZh ? '导演目标' : 'Director Goals'}</span>
              <strong>{completedObjectiveCount}/{evaluatedObjectives.length || 0}</strong>
              {evaluatedObjectives.length > 0 && (
                <small>
                  {evaluatedObjectives
                    .map((objective) => `${objective.title} · ${objective.progress}`)
                    .join(' / ')}
                </small>
              )}
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{isZh ? '世界线承诺' : 'Worldline Commitment'}</span>
              <strong>{commitmentOutcomeLabel}</strong>
              {scenarioMeta.commitment.active && scenarioMeta.commitment.branchTitle && (
                <small>{scenarioMeta.commitment.branchTitle}</small>
              )}
            </div>
            {signatureArcState && (
              <div className="archive-summary-card">
                <span className="archive-summary-card__label">{isZh ? '题材连锁' : 'Signature Arc'}</span>
                <strong>{signatureArcState.label}</strong>
                <small>
                  {signatureArcState.sequenceLabels.join(' → ')}
                  {' · '}
                  {signatureArcState.completedSteps}/{signatureArcState.totalSteps}
                </small>
              </div>
            )}
            {systemTracks && (
              <div className="archive-summary-card">
                <span className="archive-summary-card__label">{isZh ? '情势轨道' : 'System Tracks'}</span>
                <strong>{systemTracks.riskLabel} {systemTracks.riskValue}/6</strong>
                <small>{systemTracks.resourceLabel} {systemTracks.resourceValue}/6 · {systemTracks.pressure}</small>
              </div>
            )}
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_challenge_feedback')}</span>
              <strong>
                {challengeProgress
                  ? `${challengeProgress.completed ? t('result.archive_completed') : t('result.archive_in_progress')} · ${challengeFeedbackLabel ?? t('result.archive_cards_used', { count: challengeProgress.usedCards.length })}`
                  : isDailyChallenge
                    ? `${gameplayProfileLabel ? `${gameplayProfileLabel} · ` : ''}${t('result.archive_completed')}`
                  : t('result.archive_regular_run')}
              </strong>
            </div>
          </div>

          {scenarioMeta.cards.usageLog.length > 0 && (
            <div className="result-archive__section">
              <h3>{t('result.archive_cards_section')}</h3>
              <div className="archive-list">
                {scenarioMeta.cards.usageLog.map((usage, index) => (
                  <div key={`${usage.usedAt}-${index}`} className="archive-item">
                    <strong>{isZh ? getGameplayCardDefinition(usage.cardId).labelZh : getGameplayCardDefinition(usage.cardId).labelEn}</strong>
                    <span>R{usage.round} · {usage.branchTitle}</span>
                    <p>{usage.directive}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {scenarioMeta.betting.bets.length > 0 && (
            <div className="result-archive__section">
              <h3>{t('result.archive_bets_section')}</h3>
              <div className="archive-list">
                {localBetOutcomes.map(({ bet, outcome }) => (
                  <div key={bet.betId} className="archive-item">
                    <div className="archive-item__top">
                      <strong>{bet.targetLabel}</strong>
                      <span className={getBetOutcomeClass(outcome)}>
                        {getBetOutcomeLabel(outcome, t)}
                      </span>
                    </div>
                    <span>R{bet.placedAtRound} · {Math.round(bet.confidence * 100)}%</span>
                    <p>{getStructuredBetKindLabel(bet.kind, isZh)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {formattedArchiveKeyMoments.length > 0 && (
            <div className="result-archive__section">
              <h3>{t('result.archive_moments_section')}</h3>
              <ul className="archive-moments">
                {formattedArchiveKeyMoments.map((moment, index) => (
                  <li key={`${moment}-${index}`}>{moment}</li>
                ))}
              </ul>
            </div>
          )}

          {displayBranchSnapshots.length > 0 && (
            <div className="result-archive__section">
              <h3>{t('result.archive_branches_section')}</h3>
              <div className="archive-list">
                {displayBranchSnapshots.map((snapshot) => (
                  <div key={snapshot.branchId} className="archive-item">
                    <strong>{snapshot.title}</strong>
                    <span>{t('result.archive_branch_probability', { percent: Math.round(snapshot.probability * 100) })}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

          </div>{/* end .result-director-notebook__inner */}
        </div>{/* end .result-director-notebook__body */}
      </section>{/* end .result-director-notebook */}

      {campaignSummary && (
        <section className="result-campaign">
          <h2 className="result-campaign__title">{t('result.campaign_title')}</h2>
          <div className="result-campaign__grid">
            <div className="result-campaign__card">
              <span>{t('result.campaign_delta')}</span>
              <strong>+{campaignSummary.campaign_score_delta}</strong>
            </div>
            <div className="result-campaign__card">
              <span>{t('result.campaign_level')}</span>
              <strong>{t('home.campaign_mastery_level', { level: campaignSummary.mastery.level })}</strong>
            </div>
            <div className="result-campaign__card">
              <span>{t('result.campaign_next')}</span>
              <strong>
                {(campaignSummary.mastery.score_to_next_level ?? 0) > 0
                  ? t('home.campaign_next_unlock', { count: campaignSummary.mastery.score_to_next_level ?? 0 })
                  : t('home.campaign_mastered')}
              </strong>
            </div>
            <div className="result-campaign__card">
              <span>{t('result.campaign_badges')}</span>
              <strong>{campaignSummary.badges.length}</strong>
            </div>
          </div>
          <div className="result-campaign__badges">
            {newlyUnlockedBadges.length > 0 ? (
              newlyUnlockedBadges.map(({ badge, copy }) => (
                <article key={`${badge.id}-${badge.unlocked_at}`} className="result-campaign__badge">
                  <strong>{copy.label}</strong>
                  <small>{copy.description}</small>
                </article>
              ))
            ) : (
              <p className="result-campaign__empty">{t('result.campaign_badges_none')}</p>
            )}
          </div>
        </section>
      )}

      {campaignNotice && (
        <p className="result-note result-note--spaced">{campaignNotice}</p>
      )}

      {campaignError && (
        <p className="result-error result-error--spaced">{campaignError}</p>
      )}

      {/* Agent Roster */}
      {agents.length > 0 && (
        <section className="result-agents">
          <h2 className="result-agents-title">{t('result.agents')}</h2>
          <div className="result-agents-grid">
            {agents.map((agent) => (
              <div key={agent.id} className="result-agent-card">
                <span className="result-agent-name">{agent.name}</span>
                <span className="result-agent-role">{agent.role}</span>
                {agent.tier && (
                  <span className={`tier-badge tier-${agent.tier.toLowerCase()}`}>
                    {agent.tier}
                  </span>
                )}
                {capabilities?.agent_identity?.enabled && (
                  <ReturningBadge isReturning={!!agent.is_returning} displayName={agent.name} />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Phase 3 Integration ──────────────────────────── */}
      {id && !isReplayMode && (
        <section style={{ marginTop: '1.5rem' }}>
          {capabilities?.causal_graph?.enabled && (
            <div style={{ marginBottom: '1rem' }}>
              <a
                href={`/sim/${id}/causal-map`}
                style={{ color: '#8ab4f8', textDecoration: 'none', fontWeight: 600, fontSize: '0.9rem' }}
              >
                {t('result.causal_graph_link', 'View Causal Graph →')}
              </a>
            </div>
          )}
          {capabilities?.counterfactual_replay?.enabled && branches.length > 0 && (
            <>
              <CounterfactualPanel
                scenarioId={id}
                branchId={branches[0]?.id ?? ''}
                agents={agents}
                totalRounds={scenario?.total_rounds ?? 10}
                onCreated={(branchId) => setCfBranchId(branchId)}
              />
              {cfBranchId && (
                <div style={{ marginTop: '0.5rem' }}>
                  <a
                    href={`/result/${id}/compare?branch_a=${branches[0]?.id ?? ''}&branch_b=${cfBranchId}`}
                    style={{ color: '#8ab4f8', fontSize: '0.85rem' }}
                  >
                    {t('result.compare_link', 'Compare branches →')}
                  </a>
                </div>
              )}
            </>
          )}
          {capabilities?.counterfactual_replay?.enabled && branches.length > 0 && (
            <ResumePanel
              scenarioId={id}
              branches={branches}
              totalRounds={scenario?.total_rounds ?? 10}
            />
          )}
          {capabilities?.factions?.enabled && branches.length > 0 && (
            <FactionTimeline
              scenarioId={id}
              branchId={branches[0]?.id ?? ''}
              visible={true}
            />
          )}
        </section>
      )}

      {/* Share Modal (P6) */}
      {showShare && id && !isReplayMode && (
        <ShareModal
          scenarioId={id}
          shareContext={shareFlavorContext}
          onAutomationStateChange={setShareAutomation}
          onClose={() => setShowShare(false)}
        />
      )}
      {pendingEndingRoomPicker && pendingEndingRoomBranch && (
        <div className="ending-room-picker-overlay" onClick={() => setPendingEndingRoomPicker(null)}>
          <div
            className="ending-room-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ending-room-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="ending-room-picker__header">
              <div>
                <p className="ending-room-picker__kicker">
                  {pendingEndingRoomPicker.roomType === 'one_move_only'
                    ? t('ending_room.one_move_cta')
                    : t('ending_room.entry_cta')}
                </p>
                <h3 id="ending-room-picker-title">
                  {isZh ? '选择进入会客厅的当前世界线参与者' : 'Pick visible participants for this worldline'}
                </h3>
                <p>
                  {pendingEndingRoomBranch.title}
                  {' · '}
                  {isZh
                    ? `最多选择 ${pendingEndingRoomPicker.maxSelectable} 位`
                    : `Select up to ${pendingEndingRoomPicker.maxSelectable}`}
                </p>
              </div>
              <button
                type="button"
                className="ending-room-picker__close"
                onClick={() => setPendingEndingRoomPicker(null)}
                aria-label={t('common.close')}
              >
                ×
              </button>
            </header>

            <div className="ending-room-picker__body">
              {pendingEndingRoomCandidates.length === 0 ? (
                <p className="ending-room-picker__empty">
                  {isZh
                    ? '当前结果页没有可用于手动选人的世界线发言记录，将按默认房间规则继续。'
                    : 'No visible worldline roster is available here yet. The chamber will fall back to the default room selection.'}
                </p>
              ) : (
                pendingEndingRoomCandidates.map((candidate) => {
                  const selected = pendingEndingRoomPicker.selectedAgentIds.includes(candidate.id);
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      className={`ending-room-picker__card ${selected ? 'is-selected' : ''}`}
                      onClick={() => {
                        setPendingEndingRoomPicker((current) => {
                          if (!current || current.branchId !== pendingEndingRoomBranch.id) {
                            return current;
                          }
                          const alreadySelected = current.selectedAgentIds.includes(candidate.id);
                          if (alreadySelected) {
                            return {
                              ...current,
                              selectedAgentIds: current.selectedAgentIds.filter((item) => item !== candidate.id),
                            };
                          }
                          if (current.maxSelectable === 1) {
                            return { ...current, selectedAgentIds: [candidate.id] };
                          }
                          if (current.selectedAgentIds.length >= current.maxSelectable) {
                            return current;
                          }
                          return {
                            ...current,
                            selectedAgentIds: [...current.selectedAgentIds, candidate.id],
                          };
                        });
                      }}
                    >
                      <img
                        className="ending-room-picker__avatar"
                        src={getEndingRoomCandidateAvatar(candidate.role, candidate.name)}
                        alt=""
                        aria-hidden="true"
                      />
                      <div className="ending-room-picker__card-copy">
                        <strong>{candidate.name}</strong>
                        <span>{candidate.role}</span>
                        {candidate.persona && <small>{candidate.persona}</small>}
                        <em>
                          {candidate.contributionCount > 0
                            ? (
                              isZh
                                ? `影响 ${Math.round(candidate.impactScore * 100)} · 发言 ${candidate.contributionCount} 次 · 转折命中 ${candidate.keyMomentHits} · 最近 R${candidate.lastRound}`
                                : `Impact ${Math.round(candidate.impactScore * 100)} · ${candidate.contributionCount} turns · ${candidate.keyMomentHits} hinge hits · latest R${candidate.lastRound}`
                            )
                            : (
                              isZh
                                ? '当前世界线缺少逐条发言记录，按当前可见 roster 兜底'
                                : 'No branch transcript roster yet, using the visible fallback cast'
                            )}
                        </em>
                        {candidate.fallbackCast && (
                          <em className="ending-room-picker__fallback">
                            {isZh ? '兜底阵容' : 'Fallback lineup'}
                          </em>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <footer className="ending-room-picker__footer">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setPendingEndingRoomPicker(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => openEndingRoomDirect(
                  pendingEndingRoomPicker.branchId,
                  pendingEndingRoomPicker.roomType,
                  pendingEndingRoomPicker.selectedAgentIds,
                )}
                disabled={
                  pendingEndingRoomCandidates.length > 0
                  && pendingEndingRoomPicker.selectedAgentIds.length === 0
                }
              >
                {isZh ? '进入会客厅' : 'Enter chamber'}
              </button>
            </footer>
          </div>
        </div>
      )}
      {activeEndingRoomBranch && scenario && (
        <EndingChatModal
          open={Boolean(activeEndingRoomBranch)}
          scenarioId={scenario.id}
          branch={activeEndingRoomBranch}
          roomType={activeEndingRoomMode}
          selectedBranchIds={activeEndingRoomSelectedBranchIds}
          profileId={resolvedProfileId}
          profileLabel={gameplayProfileLabel}
          profileHooks={gameplayProfileHooks}
          selectedAgentIds={activeEndingRoomSelectedAgentIds}
          galleryBranches={branches}
          language={isZh ? 'zh' : 'en'}
          readOnly={isReplayMode || Boolean(activeEndingRoomReplayPayload)}
          fallbackMessages={
            activeEndingRoomBranch
              ? (scenario?.messages ?? []).filter((message) => message.branch === activeEndingRoomBranch.id)
              : []
          }
          replayState={activeEndingRoomReplayPayload ? {
            snapshot: activeEndingRoomReplayPayload.roomSnapshot,
            result: activeEndingRoomReplayPayload.roomResult,
            activeThreadId: activeEndingRoomReplayPayload.activeThreadId,
            selectedAgentIds: activeEndingRoomReplayPayload.selectedAgentIds,
          } : null}
          headerActions={endingRoomHeaderActions}
          onAutomationStateChange={setEndingRoomAutomation}
          onModeChange={handleEndingRoomModeChange}
          onClose={handleCloseEndingRoom}
        />
      )}
    </div>
  );
}
