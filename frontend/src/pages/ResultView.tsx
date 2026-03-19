/* ═══════════════════════════════════════════════════════════
   SwarmOracle — ResultView (Multi-Ending Comparison)
   ═══════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  exportScenario,
  createReplayArtifact,
  finalizeCampaign,
  getAgents,
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
import { buildSharedChallengeUrl } from '../lib/challengeShare';
import { copyText } from '../lib/copyText';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';
import {
  findChallengeProgressByScenarioId,
  markChallengeCompleted,
} from '../lib/dailyChallenge';
import { buildArchiveSummary, getDirectorStyleLabel } from '../lib/archiveSummary';
import {
  ensureScenarioObjectivesInMemory,
  loadScenarioMeta,
  mergeScenarioArchive,
  parseScenarioMoment,
  type ScenarioMeta,
} from '../lib/scenarioMeta';
import {
  mergeScenarioMetaWithDirectorState,
} from '../lib/scenarioDirectorState';
import {
  mergeScenarioMetaWithGameplayState,
} from '../lib/scenarioGameplayState';
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
  type StructuredBetOutcome,
} from '../lib/predictionBetting';
import { buildExportArchivePreface, type ShareFlavorContext } from '../lib/shareEnvelope';
import { getTheaterThemeLabel } from '../lib/themeLabels';
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
  buildScenarioReplayUrl,
  readScenarioReplayPayload,
  type ScenarioResultReplayPayload,
} from '../lib/scenarioReplay';
import type {
  AgentInfo,
  CampaignFinalizeResult,
  CampaignScenarioSummary,
  PredictionInfo,
  Scenario,
  StoryData,
} from '../types';
import ShareModal from '../components/ShareModal';
import './ResultView.css';

function hasOwnKey(value: unknown, key: string): boolean {
  return typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, key);
}

function getBetOutcomeLabel(
  outcome: StructuredBetOutcome,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (outcome === 'hit') return t('result.bet_status_hit');
  if (outcome === 'miss') return t('result.bet_status_miss');
  return t('result.bet_status_pending');
}

function getBetOutcomeClass(outcome: StructuredBetOutcome) {
  return `bet-outcome-chip bet-outcome-chip--${outcome}`;
}

function getCampaignBadgeCopy(badgeId: string, isZh: boolean) {
  const badges = {
    daily_challenge: {
      zh: {
        label: '每日挑战',
        description: '完成至少一场每日挑战。',
      },
      en: {
        label: 'Daily Challenge',
        description: 'Complete at least one daily challenge run.',
      },
    },
    archive_record: {
      zh: {
        label: '档案留痕',
        description: '拿到 A 或 S 级因果档案。',
      },
      en: {
        label: 'Archive Record',
        description: 'Earn an A or S causal archive grade.',
      },
    },
    bet_winner: {
      zh: {
        label: '押注命中',
        description: '至少命中一次已结算下注。',
      },
      en: {
        label: 'Bet Winner',
        description: 'Hit at least one resolved prediction bet.',
      },
    },
  } as const;

  const fallback = isZh
    ? { label: badgeId, description: '新徽章已解锁。' }
    : { label: badgeId, description: 'A new badge has been unlocked.' };
  return badges[badgeId as keyof typeof badges]?.[isZh ? 'zh' : 'en'] ?? fallback;
}

function resetScenarioMetaGameplayCompat(
  meta: ScenarioMeta,
  remoteGameplayState: Scenario['gameplay_state'] | null | undefined,
): ScenarioMeta {
  const remoteCards = hasOwnKey(remoteGameplayState, 'cards') && remoteGameplayState?.cards
    ? remoteGameplayState.cards
    : null;
  const remoteBetting = hasOwnKey(remoteGameplayState, 'betting') && remoteGameplayState?.betting
    ? remoteGameplayState.betting
    : null;
  const remoteArchive = hasOwnKey(remoteGameplayState, 'archive') && remoteGameplayState?.archive
    ? remoteGameplayState.archive
    : null;
  const hasRemoteUsageAuthority = hasOwnKey(remoteCards, 'usage_log');
  const hasRemoteBetAuthority = hasOwnKey(remoteBetting, 'bets');
  const hasRemoteKeyMomentAuthority = hasOwnKey(remoteArchive, 'key_moments');
  const hasRemoteBranchSnapshotAuthority = hasOwnKey(remoteArchive, 'branch_snapshots');

  if (
    !hasRemoteUsageAuthority
    && !hasRemoteBetAuthority
    && !hasRemoteKeyMomentAuthority
    && !hasRemoteBranchSnapshotAuthority
  ) {
    return meta;
  }

  return {
    ...meta,
    director: hasRemoteUsageAuthority
      ? {
          maxPoints: meta.director.maxPoints,
          remainingPoints: meta.director.maxPoints,
          spentPoints: 0,
          lastUpdatedAt: undefined,
        }
      : meta.director,
    cooldowns: hasRemoteUsageAuthority ? {} : meta.cooldowns,
    cards: {
      usageLog: hasRemoteUsageAuthority ? [] : meta.cards.usageLog,
    },
    betting: {
      bets: hasRemoteBetAuthority ? [] : meta.betting.bets,
    },
    archive: {
      ...meta.archive,
      profileId: hasRemoteUsageAuthority ? undefined : meta.archive.profileId,
      mostUsedCard: hasRemoteUsageAuthority ? null : meta.archive.mostUsedCard,
      counterplayCardCount: hasRemoteUsageAuthority ? null : meta.archive.counterplayCardCount,
      lastCounterplayCard: hasRemoteUsageAuthority ? null : meta.archive.lastCounterplayCard,
      updatedAt: hasRemoteUsageAuthority ? undefined : meta.archive.updatedAt,
      branchSnapshots: hasRemoteBranchSnapshotAuthority ? [] : meta.archive.branchSnapshots,
      keyMoments: hasRemoteKeyMomentAuthority ? [] : meta.archive.keyMoments,
    },
  };
}

function mergeResultScenarioMetaAuthority(
  localMeta: ScenarioMeta,
  remoteGameplayState: Scenario['gameplay_state'] | null | undefined,
  remoteDirectorState: Scenario['director_state'] | null | undefined,
): ScenarioMeta {
  const gameplayBase = resetScenarioMetaGameplayCompat(localMeta, remoteGameplayState);

  return mergeScenarioMetaWithDirectorState(
    mergeScenarioMetaWithGameplayState(gameplayBase, remoteGameplayState),
    remoteDirectorState,
  );
}

function classifyCampaignFinalizeError(err: unknown): 'missing' | 'conflict' | 'other' {
  if (!(err instanceof Error)) return 'other';
  if (err.message.includes('API 404:')) return 'missing';
  if (err.message.includes('API 409:')) return 'conflict';
  return 'other';
}

function getCampaignBoundaryMessage(kind: 'missing' | 'conflict', isZh: boolean): string {
  if (kind === 'missing') {
    return isZh
      ? '当前结果来自临时或模拟数据源，本地导演生涯未写入。'
      : 'This result comes from a temporary or mocked data source, so campaign progress was not persisted locally.';
  }

  return isZh
    ? '这条历史结果已归属于另一位导演档案，本设备不会重复计入生涯进展。'
    : 'This archived run already belongs to another director profile, so it will not be counted again on this device.';
}

function buildStoryKeyMoments(story: StoryData): string[] {
  return Array.from(new Set(
    story.branches
      .flatMap((branch) => branch.key_moments ?? [])
      .map((moment) => moment.trim())
      .filter(Boolean),
  ));
}

function formatArchiveKeyMoment(moment: string, isZh: boolean): string {
  const parsed = parseScenarioMoment(moment);
  if (!parsed) return moment;

  if (parsed.kind === 'card') {
    const definition = getGameplayCardDefinition(
      parsed.value as Parameters<typeof getGameplayCardDefinition>[0],
    );
    const label = isZh ? definition.labelZh : definition.labelEn;
    return isZh
      ? `R${parsed.round} 使用 ${label}`
      : `R${parsed.round} played ${label}`;
  }

  if (parsed.kind === 'bet') {
    return isZh
      ? `R${parsed.round} 下了 ${parsed.value}`
      : `R${parsed.round} placed a bet on ${parsed.value}`;
  }

  return isZh
    ? `R${parsed.round} 承诺世界线 ${parsed.value}`
    : `R${parsed.round} committed to ${parsed.value}`;
}

export default function ResultView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const replayToken = searchParams.get('replay');
  const replayShareId = searchParams.get('share');
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const directorIdentity = getDirectorIdentity();

  const [storyData, setStoryData] = useState<StoryData | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [predictions, setPredictions] = useState<PredictionInfo[]>([]);
  const [expandedBranch, setExpandedBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [challengeLinkCopied, setChallengeLinkCopied] = useState(false);
  const [permalinkCopied, setPermalinkCopied] = useState(false);
  const [replayUrl, setReplayUrl] = useState<string | null>(null);
  const [replayPayload, setReplayPayload] = useState<ScenarioResultReplayPayload | null>(null);
  const [shareAutomation, setShareAutomation] = useState<Record<string, unknown> | null>(null);
  const [importingReplay, setImportingReplay] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState('');
  const [campaignSummary, setCampaignSummary] = useState<CampaignFinalizeResult | null>(null);
  const [campaignScenarioSummary, setCampaignScenarioSummary] = useState<CampaignScenarioSummary | null>(null);
  const [campaignError, setCampaignError] = useState('');
  const [campaignNotice, setCampaignNotice] = useState('');
  const [derivedScenarioMeta, setDerivedScenarioMeta] = useState<ScenarioMeta | null>(null);
  const isReplayMode = Boolean(replayPayload);
  const hasUnscored = predictions.some((p) => p.score == null);
  const challengeMatch = id ? findChallengeProgressByScenarioId(id) : null;
  const replayInvalidMessage = isZh
    ? '这个回放链接无效或内容不完整。'
    : 'This replay link is invalid or incomplete.';
  const loadResultErrorMessage = isZh
    ? '加载结果失败'
    : 'Failed to load results';
  const isDailyChallenge = Boolean(
    challengeMatch
    || campaignScenarioSummary?.completed_daily_challenge
    || replayPayload?.isDailyChallenge,
  );
  const challengeProgress = challengeMatch?.progress ?? null;

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | null = null;

    const load = async () => {
      if (replayShareId) {
        const artifact = await getReplayArtifact(replayShareId).catch(() => null);
        if (cancelled) return;
        if (!artifact || artifact.kind !== 'scenario_result_v1' || !artifact.payload) {
          setError(replayInvalidMessage);
          setLoading(false);
          return;
        }
        const replay = artifact.payload as unknown as ScenarioResultReplayPayload;
        setReplayPayload(replay);
        setStoryData(replay.storyData);
        setScenario(replay.scenario);
        setAgents(replay.agents);
        setPredictions(replay.predictions);
        setCampaignSummary(replay.campaignSummary ?? null);
        setCampaignScenarioSummary(replay.campaignScenarioSummary ?? null);
        setCampaignError('');
        setCampaignNotice('');
        setLoading(false);
        return;
      }
      if (replayToken) {
        const replayParams = new URLSearchParams();
        replayParams.set('replay', replayToken);
        const replay = await readScenarioReplayPayload(replayParams);
        if (cancelled) return;
        if (!replay) {
          setError(replayInvalidMessage);
          setLoading(false);
          return;
        }
        setReplayPayload(replay);
        setStoryData(replay.storyData);
        setScenario(replay.scenario);
        setAgents(replay.agents);
        setPredictions(replay.predictions);
        setCampaignSummary(replay.campaignSummary ?? null);
        setCampaignScenarioSummary(replay.campaignScenarioSummary ?? null);
        setCampaignError('');
        setCampaignNotice('');
        setLoading(false);
        return;
      }

      setReplayPayload(null);
      if (!id) {
        setError(loadResultErrorMessage);
        setLoading(false);
        return;
      }

      try {
        // Fetch story and scenario in parallel, handle prediction API failure gracefully
        const [story, agentList, scenario, preds, persistedCampaignSummary] = await Promise.all([
          getStory(id),
          getAgents(id),
          getScenario(id),
          listPredictions(id).catch(() => [] as PredictionInfo[]),
          getCampaignScenarioSummary(id).catch(() => null),
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
        const remoteDirectorState = scenario.director_state ?? null;
        const remoteGameplayState = scenario.gameplay_state ?? null;
        const localMeta = loadScenarioMeta(id);
        let workingMeta = mergeResultScenarioMetaAuthority(
          localMeta,
          remoteGameplayState,
          remoteDirectorState,
        );
        const storyKeyMoments = buildStoryKeyMoments(story);
        const storyBranchSnapshots = story.branches.map((branch) => ({
          branchId: branch.id,
          title: branch.title,
          probability: branch.probability,
        }));
        workingMeta = mergeScenarioArchive(workingMeta, {
          question: scenario.question,
          sceneTheme: scenario.scene_theme,
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
            isZh,
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
          isZh,
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
          isZh,
        );
        const archiveSummary = buildArchiveSummary({
          branches: story.branches,
          usages: workingMeta.cards.usageLog,
          bets: workingMeta.betting.bets,
          keyMomentCount: workingMeta.archive.keyMoments.length,
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

        const campaign = await finalizeCampaign(id, {
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
              setCampaignNotice(getCampaignBoundaryMessage(kind, isZh));
            } else {
              setCampaignError(err instanceof Error ? err.message : 'Failed to finalize campaign');
            }
          }
          return null;
        });
        if (!cancelled) {
          setCampaignSummary(campaign);
          if (campaign) {
            setCampaignScenarioSummary({
              scenario_id: id,
              profile_id: profile.id,
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
            });
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load results');
      } finally {
        if (!cancelled && retryTimer == null) {
          setLoading(false);
        }
      }
    };

    setLoading(true);
    setError('');
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
  }, [directorIdentity.userId, directorIdentity.userName, id, isZh, loadResultErrorMessage, replayInvalidMessage, replayShareId, replayToken]);

  const handleExport = async () => {
    if (!id || exporting || isReplayMode) return;
    setExporting(true);
    setExportError('');
    try {
      const markdown = await exportScenario(id);
      const themedMarkdown = buildExportArchivePreface(markdown, shareFlavorContext, isZh);
      const blob = new Blob([themedMarkdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `swarmoracle-${id.slice(0, 8)}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
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
    try {
      const imported = await importReplayScenario(replayPayload.scenario);
      navigate(`/sim/${imported.id}`);
    } finally {
      setImportingReplay(false);
    }
  };

  const branches = storyData?.branches ?? [];
  const fallbackScenarioMeta = id ? loadScenarioMeta(id) : null;
  const storedScenarioMeta = derivedScenarioMeta ?? replayPayload?.scenarioMeta ?? fallbackScenarioMeta;
  const inferredProfile = useMemo(
    () => (scenario ? inferGameplayProfile(scenario.question, scenario.scene_theme) : null),
    [scenario],
  );
  const scenarioMeta = useMemo(() => {
    if (!storedScenarioMeta) return null;

    const baseMeta = derivedScenarioMeta || replayPayload?.scenarioMeta
      ? storedScenarioMeta
      : mergeResultScenarioMetaAuthority(
          storedScenarioMeta,
          scenario?.gameplay_state ?? null,
          scenario?.director_state ?? null,
        );

    return {
      ...baseMeta,
      archive: {
        ...baseMeta.archive,
        profileId:
          (
            baseMeta.archive.profileId
            ?? campaignScenarioSummary?.profile_id
            ?? inferredProfile?.id
          ) as typeof baseMeta.archive.profileId,
        mostUsedCard:
          (
            campaignScenarioSummary?.most_used_card
            ?? baseMeta.archive.mostUsedCard
            ?? null
          ) as typeof baseMeta.archive.mostUsedCard,
        bettingHit:
          campaignScenarioSummary?.betting_hit
          ?? baseMeta.archive.bettingHit
          ?? null,
        archiveGrade:
          (
            campaignScenarioSummary?.archive_grade
            ?? baseMeta.archive.archiveGrade
            ?? null
          ) as typeof baseMeta.archive.archiveGrade,
        profileResonance:
          campaignScenarioSummary?.profile_resonance
          ?? baseMeta.archive.profileResonance
          ?? null,
        objectiveCompletedCount:
          campaignScenarioSummary?.objective_completed_count
          ?? baseMeta.archive.objectiveCompletedCount
          ?? null,
        objectiveTotalCount:
          campaignScenarioSummary?.objective_total_count
          ?? baseMeta.archive.objectiveTotalCount
          ?? null,
        commitmentOutcome:
          campaignScenarioSummary?.commitment_outcome
          ?? baseMeta.archive.commitmentOutcome
          ?? null,
      },
    };
  }, [campaignScenarioSummary, derivedScenarioMeta, inferredProfile?.id, replayPayload?.scenarioMeta, scenario?.director_state, scenario?.gameplay_state, storedScenarioMeta]);
  const gameplayProfileLabel =
    scenarioMeta?.archive.profileId
      ? getGameplayProfileLabel(
          scenarioMeta.archive.profileId as Parameters<typeof getGameplayProfileLabel>[0],
          isZh,
        )
      : null;
  const gameplayProfileHooks = scenarioMeta?.archive.profileId
    ? getGameplayProfileSignatureHooks(
        scenarioMeta.archive.profileId as Parameters<typeof getGameplayProfileSignatureHooks>[0],
        isZh,
      )
    : [];
  const dominantBranch = useMemo(() => (
    scenarioMeta?.archive.dominantBranchTitle
      ? branches.find((branch) => branch.title === scenarioMeta.archive.dominantBranchTitle) ?? null
      : null
  ), [branches, scenarioMeta?.archive.dominantBranchTitle]);
  const hasLocalDirectorState = Boolean(
    scenarioMeta?.director.lastUpdatedAt
    || (scenarioMeta?.director.spentPoints ?? 0) > 0
    || (scenarioMeta?.cards.usageLog.length ?? 0) > 0
    || (scenarioMeta?.betting.bets.length ?? 0) > 0,
  );
  const profileResonanceLabel = scenarioMeta?.archive.profileResonance
    ? t(`result.archive_resonance_${scenarioMeta.archive.profileResonance}`)
    : t('result.archive_unset');
  const challengeFeedbackLabel = challengeProgress?.profileResonance
    ? `${gameplayProfileLabel ?? ''} · ${t(`result.archive_resonance_${challengeProgress.profileResonance}`)}`
    : null;
  const directorStyleLabel = scenarioMeta?.archive.directorStyleTag
    ? getDirectorStyleLabel(
        scenarioMeta.archive.directorStyleTag as Parameters<typeof getDirectorStyleLabel>[0],
        isZh,
      )
    : null;
  const signatureArcState = useMemo(() => (
    scenarioMeta?.archive.profileId
      ? getGameplaySignatureArcState(
          scenarioMeta.archive.profileId as Parameters<typeof getGameplaySignatureArcState>[0],
          scenarioMeta.cards.usageLog,
          isZh,
        )
      : null
  ), [isZh, scenarioMeta?.archive.profileId, scenarioMeta?.cards.usageLog]);
  const systemTracks = useMemo(() => (
    scenarioMeta?.archive.profileId
      ? getScenarioSystemTrackState(
          scenarioMeta.archive.profileId as Parameters<typeof getScenarioSystemTrackState>[0],
          scenarioMeta.cards.usageLog,
          scenarioMeta.commitment,
          isZh,
        )
      : null
  ), [isZh, scenarioMeta?.archive.profileId, scenarioMeta?.cards.usageLog, scenarioMeta?.commitment]);
  const evaluatedObjectives = useMemo(() => (
    scenarioMeta
      ? evaluateDirectorObjectives({
          objectives: scenarioMeta.objectives.goals,
          meta: scenarioMeta,
          dominantBranch,
          isZh,
          isFinal: true,
        })
      : []
  ), [dominantBranch, isZh, scenarioMeta]);
  const completedObjectiveCount = useMemo(
    () => countCompletedObjectives(evaluatedObjectives),
    [evaluatedObjectives],
  );
  const commitmentOutcomeLabel = scenarioMeta?.archive.commitmentOutcome
    ? scenarioMeta.archive.commitmentOutcome === 'hit'
      ? (isZh ? '承诺命中' : 'Commitment hit')
      : scenarioMeta.archive.commitmentOutcome === 'miss'
        ? (isZh ? '承诺落空' : 'Commitment missed')
        : (isZh ? '承诺进行中' : 'Commitment pending')
    : (isZh ? '未承诺' : 'No commitment');
  const lastCounterplayCardLabel = scenarioMeta?.archive.lastCounterplayCard
    ? (
      isZh
        ? getGameplayCardDefinition(
            scenarioMeta.archive.lastCounterplayCard as Parameters<typeof getGameplayCardDefinition>[0],
          ).labelZh
        : getGameplayCardDefinition(
            scenarioMeta.archive.lastCounterplayCard as Parameters<typeof getGameplayCardDefinition>[0],
          ).labelEn
    )
    : t('result.archive_no_counterplay');
  const counterplaySummaryLabel =
    !scenarioMeta || (scenarioMeta.archive.counterplayCardCount ?? 0) === 0
      ? t('result.archive_no_counterplay')
      : t('result.archive_counterplay_count', {
          count: scenarioMeta.archive.counterplayCardCount ?? 0,
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
      if (isReplayMode) {
        setReplayUrl(window.location.href);
        return;
      }
      if (!replaySnapshot) {
        setReplayUrl(null);
        return;
      }
      const artifact = await createReplayArtifact('scenario_result_v1', replaySnapshot as unknown as Record<string, unknown>).catch(() => null);
      const url = artifact
        ? `${window.location.origin.replace(/\/$/, '')}/result/replay?share=${artifact.id}`
        : await buildScenarioReplayUrl(window.location.origin, replaySnapshot);
      if (!cancelled) {
        setReplayUrl(url);
      }
    };

    void buildReplay();
    return () => {
      cancelled = true;
    };
  }, [isReplayMode, replaySnapshot]);

  const shareFlavorContext = useMemo<ShareFlavorContext>(() => ({
    question: storyData?.question ?? null,
    profileLabel: gameplayProfileLabel,
    profileHooks: gameplayProfileHooks,
    resonanceLabel: profileResonanceLabel,
    directorStyleLabel,
    dominantBranchTitle: scenarioMeta?.archive.dominantBranchTitle ?? null,
    counterplaySummary:
      scenarioMeta && (scenarioMeta.archive.counterplayCardCount ?? 0) > 0
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
    gameplayProfileHooks,
    profileResonanceLabel,
    directorStyleLabel,
    scenarioMeta?.archive.dominantBranchTitle,
    scenarioMeta?.archive.counterplayCardCount,
    scenarioMeta?.commitment.active,
    scenarioMeta?.commitment.branchTitle,
    counterplaySummaryLabel,
    lastCounterplayCardLabel,
    commitmentOutcomeLabel,
    replayUrl,
    t,
  ]);
  const betOutcomeContext = useMemo(() => ({
    dominantBranchId: dominantBranch?.id ?? null,
    dominantBranchTitle: scenarioMeta?.archive.dominantBranchTitle ?? null,
    dominantTone: scenarioMeta?.archive.dominantTone ?? null,
    profileResonance: scenarioMeta?.archive.profileResonance ?? null,
  }), [
    dominantBranch?.id,
    scenarioMeta?.archive.dominantBranchTitle,
    scenarioMeta?.archive.dominantTone,
    scenarioMeta?.archive.profileResonance,
  ]);
  const localBetOutcomes = useMemo(() => (
    scenarioMeta?.betting.bets.map((bet) => ({
      bet,
      outcome: resolveStructuredBetOutcome(bet, betOutcomeContext),
    })) ?? []
  ), [betOutcomeContext, scenarioMeta?.betting.bets]);
  const formattedArchiveKeyMoments = useMemo(
    () => scenarioMeta?.archive.keyMoments.map((moment) => formatArchiveKeyMoment(moment, isZh)) ?? [],
    [isZh, scenarioMeta?.archive.keyMoments],
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
        error: error || null,
        question: storyData?.question ?? null,
        branch_titles: (storyData?.branches ?? []).map((branch) => branch.title),
        predictions_count: predictions.length,
        has_unscored: hasUnscored,
        archive_summary: storyData && scenarioMeta
          ? {
              most_used_card: scenarioMeta.archive.mostUsedCard ?? null,
              betting_hit: scenarioMeta.archive.bettingHit ?? null,
              archive_grade: scenarioMeta.archive.archiveGrade ?? null,
              dominant_branch_title: scenarioMeta.archive.dominantBranchTitle ?? null,
              dominant_tone: scenarioMeta.archive.dominantTone ?? null,
              profile_id: scenarioMeta.archive.profileId ?? null,
              profile_resonance: scenarioMeta.archive.profileResonance ?? null,
              objective_completed_count:
                evaluatedObjectives.length > 0
                  ? completedObjectiveCount
                  : scenarioMeta.archive.objectiveCompletedCount ?? 0,
              objective_total_count:
                evaluatedObjectives.length > 0
                  ? evaluatedObjectives.length
                  : scenarioMeta.archive.objectiveTotalCount ?? 0,
              commitment_outcome: scenarioMeta.archive.commitmentOutcome ?? null,
              counterplay_card_count: scenarioMeta.archive.counterplayCardCount ?? 0,
              last_counterplay_card: scenarioMeta.archive.lastCounterplayCard ?? null,
              risk_value: systemTracks?.riskValue ?? scenarioMeta.archive.riskValue ?? null,
              resource_value: systemTracks?.resourceValue ?? scenarioMeta.archive.resourceValue ?? null,
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
        result_branch_snapshots: scenarioMeta?.archive.branchSnapshots.map((snapshot) => ({
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
          active_modal: showShare ? 'share' : null,
          modal_state: showShare ? shareAutomation : null,
          expanded_branch_id: expandedBranch,
        },
        branches: (storyData?.branches ?? []).slice(0, 8).map((branch) => ({
          id: branch.id,
          title: branch.title,
          probability: branch.probability,
          has_story: Boolean(branch.story),
          can_expand_story: Boolean(branch.story && branch.story.length > 150),
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
  }, [agents.length, campaignSummary, completedObjectiveCount, error, evaluatedObjectives.length, expandedBranch, exporting, formattedArchiveKeyMoments, hasUnscored, id, isDailyChallenge, isReplayMode, loading, localBetOutcomes, predictions, replayUrl, scenarioMeta, scoring, shareAutomation, showShare, storyData, systemTracks?.resourceValue, systemTracks?.riskValue]);

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

  const mostUsedCardLabel = scenarioMeta?.archive.mostUsedCard
    ? (isZh
      ? getGameplayCardDefinition(
          scenarioMeta.archive.mostUsedCard as Parameters<typeof getGameplayCardDefinition>[0],
        ).labelZh
      : getGameplayCardDefinition(
          scenarioMeta.archive.mostUsedCard as Parameters<typeof getGameplayCardDefinition>[0],
        ).labelEn)
    : t('result.archive_no_cards');
  const bettingHitLabel =
    !scenarioMeta
      ? t('result.archive_no_bets')
      : scenarioMeta.betting.bets.length > 0
        ? resolvedBetCount === 0
          ? t('result.archive_pending')
          : t('result.archive_hit_ratio', { hit: hitBetCount, total: scenarioMeta.betting.bets.length })
        : scenarioMeta.archive.bettingHit == null
          ? t('result.archive_no_bets')
          : scenarioMeta.archive.bettingHit
            ? t('result.archive_bet_hit')
            : t('result.archive_bet_miss');
  const dominantToneLabel = scenarioMeta?.archive.dominantTone
    ? getEndingToneLabel(scenarioMeta.archive.dominantTone, isZh)
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
          {t('result.subtitle')} — {branches.length} {t('result.ending_card').toLowerCase()}
          {branches.length !== 1 ? 's' : ''}
        </p>
        <div className="result-actions">
          <button
            className="btn"
            onClick={handleExport}
            disabled={exporting}
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
          <button
            className="btn btn-ghost"
            onClick={() => void handleShareChallenge()}
            disabled={!scenario}
          >
            {challengeLinkCopied ? t('result.challenge_link_copied') : t('result.share_challenge_btn')}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => navigate('/leaderboard')}
          >
            {t('result.leaderboard_link')}
          </button>
        </div>
        {exportError && <p className="result-error result-error--spaced">{exportError}</p>}
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
              className={`ending-card ${expandedBranch === branch.id ? 'expanded' : ''}`}
              ref={(el) => { if (el) el.style.setProperty('--card-delay', `${index * 0.1}s`); }}
            >
              <div className="ending-header">
                <span className="ending-index">
                  {t('result.ending_card')} {index + 1}
                </span>
                <h2 className="ending-title">{branch.title}</h2>
              </div>

              {/* Probability Bar */}
              <div className="probability-section">
                <div className="probability-label">
                  <span>{t('result.probability')}</span>
                  <span className="probability-value">
                    {((branch.probability ?? 0) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="probability-bar">
                  <div
                    className="probability-fill"
                    ref={(el) => { if (el) el.style.setProperty('--prob-fill', `${Math.max((branch.probability ?? 0) * 100, 2)}%`); }}
                  />
                </div>
              </div>

              {/* Fork Reason */}
              {branch.fork_reason && (
                <div className="fork-reason">
                  <span className="fork-label">{t('result.fork_reason')}</span>
                  <p>{branch.fork_reason}</p>
                </div>
              )}

              {/* Story Preview / Full */}
              <div className="story-section">
                <h3 className="section-label">{t('result.story')}</h3>
                <p className={`story-text ${expandedBranch === branch.id ? 'full' : 'preview'}`}>
                  {branch.story || '—'}
                </p>
                {branch.story && branch.story.length > 150 && (
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
              </div>

              {/* Insight */}
              {branch.insight && (
                <div className="insight-section">
                  <h3 className="section-label">{t('result.insight')}</h3>
                  <blockquote className="insight-quote">{branch.insight}</blockquote>
                </div>
              )}

              {/* Key Moments */}
              {branch.key_moments && branch.key_moments.length > 0 && (
                <div className="moments-section">
                  <h3 className="section-label">{t('result.key_moments')}</h3>
                  <ol className="moments-list">
                    {branch.key_moments.map((moment, mi) => (
                      <li key={mi}>{moment}</li>
                    ))}
                  </ol>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {/* Predictions Section (P5-B) */}
      {predictions.length > 0 && (
        <section className="result-predictions">
          <h2 className="result-predictions-title">{t('result.predictions_title')}</h2>
          {hasUnscored && (
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
            style={{ backgroundImage: 'url(/assets/ui/generated/archive_panel.png)' }}
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
            {scenarioMeta.archive.bettingHit === true && (
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
              <strong>{scenarioMeta.archive.dominantBranchTitle ?? t('result.archive_unset')}</strong>
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
              {(scenarioMeta.archive.counterplayCardCount ?? 0) > 0 && (
                <small>
                  {t('result.archive_last_counterplay')}
                  {': '}
                  {lastCounterplayCardLabel}
                </small>
              )}
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_grade')}</span>
              <strong>{scenarioMeta.archive.archiveGrade ?? 'C'}</strong>
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

          {scenarioMeta.archive.keyMoments.length > 0 && (
            <div className="result-archive__section">
              <h3>{t('result.archive_moments_section')}</h3>
              <ul className="archive-moments">
                {formattedArchiveKeyMoments.map((moment, index) => (
                  <li key={`${moment}-${index}`}>{moment}</li>
                ))}
              </ul>
            </div>
          )}

          {scenarioMeta.archive.branchSnapshots.length > 0 && (
            <div className="result-archive__section">
              <h3>{t('result.archive_branches_section')}</h3>
              <div className="archive-list">
                {scenarioMeta.archive.branchSnapshots.map((snapshot) => (
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
              </div>
            ))}
          </div>
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
    </div>
  );
}
