/* ═══════════════════════════════════════════════════════════
   SwarmOracle — InputView (Landing Page)
   ═══════════════════════════════════════════════════════════ */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import gsap from 'gsap';
import { useTranslation } from 'react-i18next';
import { useSimulationStore } from '../stores/simulationStore';
import {
  createDebate,
  identityContinuityPreflight,
  type ContinuityOverride,
  type CreateScenarioOptions,
  type IdentityContinuityMatch,
} from '../api/client';
import { getDirectorIdentity } from '../lib/directorIdentity';
import { useAgentStore } from '../stores/agentStore';
import { AgentAttachPanel } from '../components/AgentAttachPanel';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import {
  markChallengeStarted,
} from '../lib/dailyChallenge';
import { stringifyAutomationPayload } from '../game/automation';
import { buildAutomationErrorState } from '../lib/apiErrorMessage';
import {
  getGameplayBadgeSrc,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
} from '../lib/gameplayProfileSummary';
import {
  buildScenarioRuntimePresetOptions,
  getScenarioRuntimePresetConfig,
  loadScenarioRuntimePreset,
  saveScenarioRuntimePreset,
  type ScenarioRuntimePresetId,
} from '../lib/runtimePreset';
import {
  useInputByokSettings,
  useInputCampaignState,
  useSharedChallengePrefill,
} from '../hooks/useInputViewState';
import { QuickStartCards, type QuickStartPreset } from '../components/QuickStartCards';
import { predictTextareaHeight } from '../lib/textLayout/inputPredict';
import './InputView.css';

function estimateSimulationMinutes(rounds: number, numAgents: number) {
  return Math.max(1, Math.round(rounds * (0.75 + numAgents * 0.0225)));
}

const HOME_DEFAULT_ROUNDS = 5;
const HOME_DEFAULT_AGENTS = 5;
const HOME_MAX_ROUNDS = 40;
const HOME_MAX_AGENTS = 40;
const BYOK_BUDGET_MINUTES = 3;
const BYOK_REQUEST_BUFFER = 3;
const BYOK_TOKEN_BUFFER = 8_000;
const BYOK_ESTIMATED_TOKENS_PER_TURN = 1_600;

function parseOptionalRuntimeLimit(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.trunc(parsed);
}

/* ── Loading Step Component ───────────────────────────────── */
function LoadingStep({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className={`loading-step ${done ? 'loading-step--done' : ''} ${active ? 'loading-step--active' : ''}`}>
      <span className="loading-step__icon">
        {done ? '✓' : active ? <span className="loading-step__spinner" /> : '○'}
      </span>
      <span className="loading-step__label">{label}</span>
    </div>
  );
}

type PendingSimulationLaunch = {
  nextQuestion: string;
  nextRounds: number;
  nextAgents: number;
  nextMode: 'raw' | 'blackboard';
  nextVisualization: boolean;
  challengeId?: string;
};

export function InputView() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const [question, setQuestion] = useState('');
  const [rounds, setRounds] = useState(HOME_DEFAULT_ROUNDS);
  const [numAgents, setNumAgents] = useState(HOME_DEFAULT_AGENTS);
  const [mode, setMode] = useState<'raw' | 'blackboard'>('blackboard');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [placeholder, setPlaceholder] = useState('');
  const [continuityMatches, setContinuityMatches] = useState<IdentityContinuityMatch[]>([]);
  const [continuityChoices, setContinuityChoices] = useState<Record<string, ContinuityOverride['action']>>({});
  const [continuityError, setContinuityError] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<PendingSimulationLaunch | null>(null);
  // V2: Pixel Theater visualization
  const [vizEnabled, setVizEnabled] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [runtimePreset, setRuntimePreset] = useState<ScenarioRuntimePresetId>(() => loadScenarioRuntimePreset());
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const directorIdentity = getDirectorIdentity();
  const { capabilities: caps } = useCapabilityCheck('custom_agents');
  const agentSelectedIds = useAgentStore((s) => s.selectedIds);
  const startSimulation = useSimulationStore((s) => s.startSimulation);
  const submitError = useSimulationStore((s) => s.error);
  const submitErrorCode = useSimulationStore((s) => s.errorCode);
  const reset = useSimulationStore((s) => s.reset);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const typewriterTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    showByok,
    setShowByok,
    llmApiKey,
    setLlmApiKey,
    llmBaseUrl,
    setLlmBaseUrl,
    llmModel,
    setLlmModel,
    llmRequestsPerMinute,
    setLlmRequestsPerMinute,
    llmTokensPerMinute,
    setLlmTokensPerMinute,
    disableUserQuota,
    setDisableUserQuota,
    testStatus,
    testError,
    probeResult,
    hasFreshProbe,
    reasoningEffort,
    setReasoningEffort,
    handleTestConnection,
    webSearchEnabled,
    setWebSearchEnabled,
    webSearchServerEnabled,
    webSearchServerProvider,
    webSearchMode,
    setWebSearchMode,
    webSearchProvider,
    setWebSearchProvider,
    webSearchApiKey,
    setWebSearchApiKey,
    webSearchBaseUrl,
    setWebSearchBaseUrl,
    webSearchAvailable,
    webSearchStatus,
    setWebSearchStatus,
  } = useInputByokSettings(t);
  const {
    campaignProfile,
    campaignBadges,
    campaignWeeklySummary,
    campaignChallengeRotation,
    todayChallenge,
    weeklyChallenges,
    todayChallengeProgress,
    dailyMastery,
    topMasteries,
  } = useInputCampaignState({
    directorUserId: directorIdentity.userId,
  });
  const { sharedChallenge, sharedChallengeBanner } = useSharedChallengePrefill(searchParams);
  const todayChallengeQuestion = todayChallenge
    ? (isZh ? todayChallenge.question : todayChallenge.questionEn)
    : '';
  const challengeProfileLabel = todayChallenge
    ? getGameplayProfileLabel(todayChallenge.profileId, isZh)
    : null;
  const challengeProfileId = todayChallenge?.profileId ?? null;
  const challengeHooks = useMemo(
    () => (
      challengeProfileId
        ? getGameplayProfileSignatureHooks(challengeProfileId, isZh).slice(0, 2)
        : []
    ),
    [challengeProfileId, isZh],
  );
  const nextUnlockLabel = dailyMastery?.score_to_next_level != null
    ? t('home.campaign_next_unlock', { count: dailyMastery.score_to_next_level })
    : t('home.campaign_mastered');
  const sharedChallengeProfileLabel = sharedChallengeBanner?.profileId
    ? getGameplayProfileLabel(sharedChallengeBanner.profileId as never, isZh)
    : null;
  const weeklyTopProfileLabel = campaignWeeklySummary?.top_profile_id
    ? getGameplayProfileLabel(campaignWeeklySummary.top_profile_id as never, isZh)
    : null;
  const byokRequestsPerMinute = parseOptionalRuntimeLimit(llmRequestsPerMinute);
  const byokTokensPerMinute = parseOptionalRuntimeLimit(llmTokensPerMinute);
  const hasDirectorGrowth =
    (campaignProfile?.total_runs ?? 0) > 0
    || campaignBadges.length > 0
    || topMasteries.length > 0;
  const weeklyChallengeEntries = weeklyChallenges.map((challenge) => ({
    challenge_id: challenge.id,
    profile_id: challenge.profileId,
    profile_label: getGameplayProfileLabel(challenge.profileId, isZh),
    runs: campaignWeeklySummary?.profile_runs?.[challenge.profileId] ?? 0,
  }));
  const dailyChallengeActionState = todayChallengeProgress?.completed
    ? 'replay'
    : todayChallengeProgress
      ? 'continue'
      : 'start';
  const dailyChallengeProgressStatus = todayChallengeProgress?.completed
    ? 'completed'
    : todayChallengeProgress
      ? 'in_progress'
      : 'not_started';
  const topMasteryEntries = topMasteries.map((mastery) => ({
    profile_id: mastery.profile_id,
    profile_label: getGameplayProfileLabel(mastery.profile_id as never, isZh),
    level: mastery.level,
    score_to_next_level: mastery.score_to_next_level ?? null,
  }));
  const byokRecommendation = useMemo(() => {
    if (!probeResult?.recommended) return null;

    const recommendation = probeResult.recommended;
    return {
      ...recommendation,
      exceedsAgents: numAgents > recommendation.agents_max,
      exceedsRounds: rounds > recommendation.rounds_max,
    };
  }, [numAgents, probeResult, rounds]);
  const webSearchBaseUrlPlaceholder = useMemo(() => {
    switch (webSearchProvider) {
      case 'exa':
        return 'https://api.exa.ai/search';
      case 'xai':
        return 'https://api.x.ai/v1/responses';
      case 'searxng':
        return 'http://localhost:8888';
      case 'tavily':
      default:
        return 'https://api.tavily.com/search';
    }
  }, [webSearchProvider]);
  const webSearchUsesCustomOverride = webSearchEnabled && webSearchMode === 'custom_override';
  const byokBudgetRecommendation = useMemo(() => {
    if (byokRequestsPerMinute == null && byokTokensPerMinute == null) return null;

    const requestTurnBudget = byokRequestsPerMinute != null
      ? Math.max(1, byokRequestsPerMinute * BYOK_BUDGET_MINUTES - BYOK_REQUEST_BUFFER)
      : Number.POSITIVE_INFINITY;
    const tokenTurnBudget = byokTokensPerMinute != null
      ? Math.max(
        1,
        Math.floor(
          Math.max(0, byokTokensPerMinute * BYOK_BUDGET_MINUTES - BYOK_TOKEN_BUFFER)
          / BYOK_ESTIMATED_TOKENS_PER_TURN,
        ),
      )
      : Number.POSITIVE_INFINITY;
    const turnBudget = Math.max(1, Math.floor(Math.min(requestTurnBudget, tokenTurnBudget)));
    const agentsMax = Math.max(1, Math.min(HOME_MAX_AGENTS, Math.floor(turnBudget / Math.max(1, rounds))));
    const roundsMax = Math.max(1, Math.min(HOME_MAX_ROUNDS, Math.floor(turnBudget / Math.max(1, numAgents))));

    return {
      agentsMax,
      roundsMax,
      overBudget: numAgents > agentsMax || rounds > roundsMax,
    };
  }, [byokRequestsPerMinute, byokTokensPerMinute, numAgents, rounds]);
  const isSimulationBudgetBlocked = Boolean(byokBudgetRecommendation?.overBudget);
  const runtimePresetConfig = useMemo(
    () => getScenarioRuntimePresetConfig(runtimePreset),
    [runtimePreset],
  );
  const runtimePresetDescription = useMemo(
    () => t(`home.runtime_preset_${runtimePreset}_desc`),
    [runtimePreset, t],
  );
  const estimatedSimulationMinutes = useMemo(
    () => estimateSimulationMinutes(rounds, numAgents),
    [numAgents, rounds],
  );
  const simulationEtaHint = useMemo(
    () => t('home.simulation_eta_hint', {
      agents: numAgents,
      rounds,
      minutes: estimatedSimulationMinutes,
    }),
    [estimatedSimulationMinutes, numAgents, rounds, t],
  );
  const continuityCopy = useMemo(() => (
    isZh
      ? {
        title: '确认身份连续性',
        subtitle: '检测到以下角色可能对应你已有的跨场景身份。请选择是复用旧身份，还是为这次推演创建新身份。',
        reuse: '复用已有身份',
        createNew: '创建新身份',
        candidateLabel: '候选身份',
        similarityLabel: '相似度',
        cancel: '取消',
        confirm: '继续开始',
      }
      : {
        title: 'Confirm identity continuity',
        subtitle: 'These proposed agents may match identities from your earlier runs. Choose whether to reuse the existing identity or create a new one for this simulation.',
        reuse: 'Reuse existing identity',
        createNew: 'Create new identity',
        candidateLabel: 'Candidate identity',
        similarityLabel: 'Similarity',
        cancel: 'Cancel',
        confirm: 'Continue',
      }
  ), [isZh]);
  const continuityPreflightErrorCopy = useMemo(
    () => (isZh ? '身份连续性预检失败，请重试。' : 'Identity continuity preflight failed. Please retry.'),
    [isZh],
  );

  const resizeQuestionField = useCallback(() => {
    const el = questionRef.current;
    if (!el) return;

    const isMobile = window.innerWidth <= 640;
    const minHeight = isMobile ? 96 : 76;
    const maxHeight = isMobile ? 220 : 180;
    const containerWidth = el.clientWidth || el.offsetWidth || 700;

    // Use pretext prediction to avoid DOM reflow (reset to 0 + read scrollHeight)
    const displayText = el.value || el.placeholder || '';
    const { height: predicted } = predictTextareaHeight(displayText, containerWidth, {
      viewportWidth: window.innerWidth,
      locale: i18n.language,
    });

    // Pretext prediction with DOM fallback for edge cases
    let contentHeight = predicted;
    if (contentHeight <= 0) {
      el.style.height = '0px';
      contentHeight = el.scrollHeight;
    }

    const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
  }, [i18n.language]);

  // Dynamic placeholders from i18n
  const placeholders = useMemo(() => {
    void i18n.language;
    return [
      t('home.placeholder_1'),
      t('home.placeholder_2'),
      t('home.placeholder_3')
    ];
  }, [i18n.language, t]);

  const loadingSteps = [
    t('home.loading_step_1'),
    t('home.loading_step_2'),
    t('home.loading_step_3'),
    t('home.loading_step_4'),
  ];

  // Reset store on mount
  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    if (!sharedChallenge) return;
    setQuestion(sharedChallenge.question);
    setRounds(sharedChallenge.rounds);
    setNumAgents(sharedChallenge.numAgents);
    setMode(sharedChallenge.mode);
    setVizEnabled(sharedChallenge.visualizationEnabled);
    if (sharedChallenge.runtimePreset) {
      setRuntimePreset(sharedChallenge.runtimePreset);
    }
  }, [sharedChallenge]);

  useEffect(() => {
    saveScenarioRuntimePreset(runtimePreset);
  }, [runtimePreset]);

  // BYOK auto-expand: open advanced config when sessionStorage has a saved BYOK key
  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem('swarmoracle.llm-provider-policy.v1');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.apiKey) {
          setIsConfigOpen(true);
        }
      }
    } catch { /* ignore parse errors */ }
  }, []);

  // Animate loading steps while submitting
  useEffect(() => {
    if (!isSubmitting) {
      setLoadingStep(0);
      return;
    }
    // Step through loading stages at intervals
    const intervals = [2000, 4000, 6000]; // advance at 2s, 4s, 6s
    const timers = intervals.map((delay, i) =>
      setTimeout(() => setLoadingStep(i + 1), delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [isSubmitting]);

  // Typewriter placeholder effect
  useEffect(() => {
    let textIdx = 0;
    let charIdx = 0;
    let isDeleting = false;

    if (typewriterTimeoutRef.current) {
      clearTimeout(typewriterTimeoutRef.current);
      typewriterTimeoutRef.current = null;
    }

    const scheduleTick = (callback: () => void, delay: number) => {
      typewriterTimeoutRef.current = setTimeout(callback, delay);
    };

    const tick = () => {
      const currentText = placeholders[textIdx] || '';

      if (!isDeleting) {
        charIdx++;
        setPlaceholder(currentText.slice(0, charIdx));
        if (charIdx >= currentText.length) {
          scheduleTick(() => {
            isDeleting = true;
            tick();
          }, 2000);
          return;
        }
      } else {
        charIdx--;
        setPlaceholder(currentText.slice(0, charIdx));
        if (charIdx <= 0) {
          isDeleting = false;
          textIdx = (textIdx + 1) % placeholders.length;
        }
      }

      scheduleTick(tick, isDeleting ? 30 : 80);
    };

    tick();
    return () => {
      if (typewriterTimeoutRef.current) {
        clearTimeout(typewriterTimeoutRef.current);
        typewriterTimeoutRef.current = null;
      }
    };
  }, [placeholders]);

  useEffect(() => {
    resizeQuestionField();
  }, [question, placeholder, resizeQuestionField]);

  // Entry animations
  useEffect(() => {
    if (titleRef.current) {
      gsap.fromTo(
        titleRef.current,
        { y: 30, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.8, ease: 'power2.out' },
      );
    }
    const questionField = questionRef.current?.parentElement;
    if (questionField) {
      gsap.fromTo(
        questionField,
        { y: 20, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.8, delay: 0.3, ease: 'power2.out' },
      );
    }
  }, []);

  const buildSimulationOptions = useCallback((
    launch: PendingSimulationLaunch,
    continuityOverrides?: ContinuityOverride[],
  ): CreateScenarioOptions => {
    const trimmed = launch.nextQuestion.trim();
    return {
      question: trimmed,
      rounds: launch.nextRounds,
      numAgents: launch.nextAgents,
      mode: launch.nextMode,
      llmApiKey: llmApiKey || undefined,
      llmBaseUrl: llmBaseUrl || undefined,
      llmModel: llmModel || undefined,
      llmRequestsPerMinute: Number.isFinite(byokRequestsPerMinute) ? byokRequestsPerMinute : undefined,
      llmTokensPerMinute: Number.isFinite(byokTokensPerMinute) ? byokTokensPerMinute : undefined,
      reasoningEffort: reasoningEffort || undefined,
      visualizationEnabled: launch.nextVisualization,
      userId: directorIdentity.userId,
      disableUserQuota,
      webSearchEnabled,
      webSearchProvider: webSearchUsesCustomOverride ? webSearchProvider : undefined,
      webSearchApiKey: webSearchUsesCustomOverride && webSearchApiKey.trim() ? webSearchApiKey.trim() : undefined,
      webSearchBaseUrl: webSearchUsesCustomOverride && webSearchBaseUrl.trim() ? webSearchBaseUrl.trim() : undefined,
      continuityOverrides,
      ...buildScenarioRuntimePresetOptions(runtimePreset),
      ...(agentSelectedIds.size > 0 && { customAgentIdentityIds: [...agentSelectedIds] }),
    };
  }, [
    agentSelectedIds,
    byokRequestsPerMinute,
    byokTokensPerMinute,
    directorIdentity.userId,
    disableUserQuota,
    llmApiKey,
    llmBaseUrl,
    llmModel,
    reasoningEffort,
    runtimePreset,
    webSearchApiKey,
    webSearchBaseUrl,
    webSearchEnabled,
    webSearchProvider,
    webSearchUsesCustomOverride,
  ]);

  const closeContinuityDialog = useCallback(() => {
    if (isSubmitting) return;
    setPendingLaunch(null);
    setContinuityMatches([]);
    setContinuityChoices({});
    setContinuityError(null);
  }, [isSubmitting]);

  const executeSimulationLaunch = useCallback(async (
    launch: PendingSimulationLaunch,
    continuityOverrides?: ContinuityOverride[],
  ) => {
    setIsSubmitting(true);
    setContinuityError(null);
    const wantsSearch = webSearchEnabled;
    if (wantsSearch) setWebSearchStatus('searching');
    else setWebSearchStatus('skipped');
    try {
      const id = await startSimulation(buildSimulationOptions(launch, continuityOverrides));
      if (launch.challengeId) {
        markChallengeStarted(launch.challengeId, id);
      }
      setPendingLaunch(null);
      setContinuityMatches([]);
      setContinuityChoices({});
      navigate(`/sim/${id}`);
    } catch {
      setWebSearchStatus('idle');
      setIsSubmitting(false);
    }
  }, [
    buildSimulationOptions,
    navigate,
    setWebSearchStatus,
    startSimulation,
    webSearchEnabled,
  ]);

  const maybeRunContinuityPreflight = useCallback(async (
    launch: PendingSimulationLaunch,
  ) => {
    if (!caps?.agent_identity?.enabled) return false;
    setContinuityError(null);
    try {
      const result = await identityContinuityPreflight(buildSimulationOptions(launch));
      if (!result.needs_confirmation || result.matches.length === 0) {
        return false;
      }
      setPendingLaunch(launch);
      setContinuityMatches(result.matches);
      setContinuityChoices(
        Object.fromEntries(
          result.matches.map((match) => [match.continuity_key, 'reuse_existing']),
        ) as Record<string, ContinuityOverride['action']>,
      );
      return true;
    } catch (error) {
      console.warn('[InputView] identity continuity preflight failed', error);
      setContinuityError(continuityPreflightErrorCopy);
      return true;
    }
  }, [buildSimulationOptions, caps?.agent_identity?.enabled, continuityPreflightErrorCopy]);

  const confirmContinuityLaunch = useCallback(async () => {
    if (!pendingLaunch || isSubmitting) return;
    const overrides: ContinuityOverride[] = continuityMatches.map((match) => {
      const action = continuityChoices[match.continuity_key] ?? 'reuse_existing';
      return {
        continuityKey: match.continuity_key,
        action,
        ...(action === 'reuse_existing' && match.candidate_identity
          ? { identityId: match.candidate_identity.id }
          : {}),
        agentName: match.name,
        agentRole: match.role,
      };
    });
    await executeSimulationLaunch(pendingLaunch, overrides);
  }, [
    continuityChoices,
    continuityMatches,
    executeSimulationLaunch,
    isSubmitting,
    pendingLaunch,
  ]);

  const launchSimulation = async (launch: PendingSimulationLaunch) => {
    const trimmed = launch.nextQuestion.trim();
    if (!trimmed || isSubmitting) return;
    if (isSimulationBudgetBlocked) return;

    if (llmApiKey.trim() && !hasFreshProbe) {
      const probe = await handleTestConnection();
      if (!probe.ok) {
        return;
      }
    }

    const blockedByContinuityDialog = await maybeRunContinuityPreflight(launch);
    if (blockedByContinuityDialog) {
      return;
    }

    await executeSimulationLaunch(launch);
  };

  const launchDebate = async ({
    nextQuestion,
  }: {
    nextQuestion: string;
  }) => {
    const trimmed = nextQuestion.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const debate = await createDebate(trimmed, undefined, {
        llmApiKey: llmApiKey || undefined,
        llmBaseUrl: llmBaseUrl || undefined,
        llmModel: llmModel || undefined,
        llmRequestsPerMinute: Number.isFinite(byokRequestsPerMinute) ? byokRequestsPerMinute : undefined,
        llmTokensPerMinute: Number.isFinite(byokTokensPerMinute) ? byokTokensPerMinute : undefined,
        reasoningEffort: reasoningEffort || undefined,
        userId: directorIdentity.userId,
      });
      const targetLanguage = debate.language === 'zh' ? 'zh' : 'en';
      if (!i18n.language.startsWith(targetLanguage)) {
        await i18n.changeLanguage(targetLanguage);
      }
      navigate(`/debate/${debate.id}`);
    } catch {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (q: string) => {
    await launchSimulation({
      nextQuestion: q,
      nextRounds: rounds,
      nextAgents: numAgents,
      nextMode: mode,
      nextVisualization: vizEnabled,
    });
  };

  const handleQuickStartSelect = async (preset: QuickStartPreset) => {
    setQuestion(preset.question);
    await launchSimulation({
      nextQuestion: preset.question,
      nextRounds: preset.rounds ?? rounds,
      nextAgents: preset.numAgents ?? numAgents,
      nextMode: preset.mode ?? mode,
      nextVisualization: preset.visualizationEnabled ?? vizEnabled,
    });
  };

  const handleStartChallenge = async () => {
    if (!todayChallenge) return;
    if (todayChallengeProgress?.scenarioId) {
      navigate(`/sim/${todayChallengeProgress.scenarioId}`);
      return;
    }

    setQuestion(todayChallengeQuestion);
    setRounds(todayChallenge.rounds);
    setNumAgents(todayChallenge.numAgents);
    setMode(todayChallenge.mode);
    setVizEnabled(todayChallenge.visualizationEnabled);
    await launchSimulation({
      nextQuestion: todayChallengeQuestion,
      nextRounds: todayChallenge.rounds,
      nextAgents: todayChallenge.numAgents,
      nextMode: todayChallenge.mode,
      nextVisualization: todayChallenge.visualizationEnabled,
      challengeId: todayChallenge.id,
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(question);
    }
  };

  useEffect(() => {
    const win = window as Window & { render_game_to_text?: () => string };
    const render = () => stringifyAutomationPayload(
      {
        question: question || null,
        status: isSubmitting ? 'parsing' : submitError ? 'error' : 'idle',
        currentRound: 0,
        totalRounds: rounds,
        viewMode: vizEnabled ? 'theater' : 'classic',
        visualizationEnabled: vizEnabled,
        isSimulationComplete: false,
        messageCount: 0,
        agentCount: numAgents,
        branchCount: 0,
      },
      null,
          {
        route: window.location.pathname,
        kind: 'input',
        question: question || null,
        rounds,
        num_agents: numAgents,
        mode,
        visualization_enabled: vizEnabled,
        reasoning_effort: reasoningEffort || null,
        runtime_preset: {
          id: runtimePreset,
          branch_sensitivity: runtimePresetConfig.branchSensitivity,
          fork_prompt_variant: runtimePresetConfig.forkPromptVariant,
          fork_detector_active_branch_limit: runtimePresetConfig.forkDetectorActiveBranchLimit,
          applies_to: 'main_simulation',
        },
        byok_expanded: showByok,
        byok_test_status: testStatus,
        error: buildAutomationErrorState(submitErrorCode, submitError),
        byok_test_error: buildAutomationErrorState(null, testStatus === 'fail' ? testError : null),
        byok_requests_per_minute: Number.isFinite(byokRequestsPerMinute) ? byokRequestsPerMinute : null,
        byok_tokens_per_minute: Number.isFinite(byokTokensPerMinute) ? byokTokensPerMinute : null,
        byok_disable_user_quota: disableUserQuota,
        web_search: {
          enabled: webSearchEnabled,
          mode: webSearchMode,
          server_enabled: webSearchServerEnabled,
          server_provider: webSearchServerProvider,
          provider: webSearchUsesCustomOverride ? webSearchProvider : null,
          base_url_overridden: webSearchUsesCustomOverride && webSearchBaseUrl.trim().length > 0,
          api_key_overridden: webSearchUsesCustomOverride && webSearchApiKey.trim().length > 0,
          status: webSearchStatus,
        },
        byok_probe: probeResult
          ? {
              estimated_parallelism: probeResult.estimated_parallelism,
              tested_parallelism: probeResult.tested_parallelism,
              local_provider: probeResult.local_provider,
              allow_disable_user_quota: probeResult.allow_disable_user_quota,
              recommended: probeResult.recommended,
            }
          : null,
        challenge_progress: todayChallengeProgress
          ? {
              source: todayChallengeProgress.source,
              scenario_id: todayChallengeProgress.scenarioId ?? null,
              completed: todayChallengeProgress.completed,
              used_cards_count: todayChallengeProgress.usedCardsKnown ? todayChallengeProgress.usedCards.length : null,
              used_cards_known: todayChallengeProgress.usedCardsKnown,
              bet_placed: todayChallengeProgress.betPlacedKnown ? todayChallengeProgress.betPlaced : null,
              bet_placed_known: todayChallengeProgress.betPlacedKnown,
              betting_hit: todayChallengeProgress.bettingHit ?? null,
            }
          : null,
        daily_challenge: todayChallenge
          ? {
              challenge_id: todayChallenge.id,
              profile_id: todayChallenge.profileId,
              question: todayChallengeQuestion,
              subtitle: isZh ? todayChallenge.subtitleZh : todayChallenge.subtitleEn,
              profile_label: challengeProfileLabel,
              hooks: challengeHooks,
              hook_count: challengeHooks.length,
              mastery_level: dailyMastery?.level ?? 0,
              score_to_next_level: dailyMastery?.score_to_next_level ?? null,
              action_state: dailyChallengeActionState,
              progress_status: dailyChallengeProgressStatus,
              completed: Boolean(todayChallengeProgress?.completed),
              scenario_id: todayChallengeProgress?.scenarioId ?? null,
            }
          : null,
        weekly_challenge: {
          week_key: campaignChallengeRotation?.week_key ?? null,
          challenge_count: weeklyChallenges.length,
          total_runs: campaignWeeklySummary?.total_runs ?? null,
          campaign_score_delta: campaignWeeklySummary?.campaign_score_delta ?? null,
          completed_daily_challenges: campaignWeeklySummary?.completed_daily_challenges ?? null,
          top_profile_id: campaignWeeklySummary?.top_profile_id ?? null,
          top_profile_label: weeklyTopProfileLabel,
          entries: weeklyChallengeEntries,
        },
        director_growth: {
          total_runs: campaignProfile?.total_runs ?? 0,
          badge_count: campaignBadges.length,
          top_mastery_count: topMasteryEntries.length,
          has_hint: topMasteryEntries.length === 0,
          top_masteries: topMasteryEntries,
        },
        campaign: {
          user_id: directorIdentity.userId,
          total_runs: campaignProfile?.total_runs ?? 0,
          badge_count: campaignBadges.length,
          daily_profile_level: dailyMastery?.level ?? 0,
          daily_profile_score_to_next_level: dailyMastery?.score_to_next_level ?? null,
        },
        controls: {
          can_start_simulation: Boolean(question.trim()) && !isSubmitting && !isSimulationBudgetBlocked,
          can_start_debate: Boolean(question.trim()) && !isSubmitting,
        },
      },
    );

    win.render_game_to_text = render;
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
    };
  }, [
    campaignChallengeRotation?.week_key,
    isSubmitting,
    isZh,
    mode,
    numAgents,
    question,
    reasoningEffort,
    rounds,
    showByok,
    submitError,
    submitErrorCode,
    testStatus,
    probeResult,
    runtimePreset,
    runtimePresetConfig.branchSensitivity,
    runtimePresetConfig.forkDetectorActiveBranchLimit,
    runtimePresetConfig.forkPromptVariant,
    todayChallenge,
    todayChallengeProgress,
    vizEnabled,
    todayChallenge?.id,
    todayChallenge?.profileId,
    todayChallenge?.subtitleEn,
    todayChallenge?.subtitleZh,
    todayChallengeQuestion,
    challengeProfileLabel,
    challengeHooks,
    dailyChallengeActionState,
    dailyChallengeProgressStatus,
    weeklyChallengeEntries,
    weeklyChallenges.length,
    weeklyTopProfileLabel,
    campaignWeeklySummary?.campaign_score_delta,
    campaignWeeklySummary?.completed_daily_challenges,
    campaignWeeklySummary?.top_profile_id,
    campaignWeeklySummary?.total_runs,
    campaignBadges.length,
    campaignProfile?.total_runs,
    dailyMastery?.level,
    dailyMastery?.score_to_next_level,
    topMasteryEntries,
    directorIdentity.userId,
    byokRequestsPerMinute,
    byokTokensPerMinute,
    isSimulationBudgetBlocked,
    disableUserQuota,
    testError,
    webSearchApiKey,
    webSearchBaseUrl,
    webSearchEnabled,
    webSearchMode,
    webSearchProvider,
    webSearchServerEnabled,
    webSearchServerProvider,
    webSearchStatus,
    webSearchUsesCustomOverride,
  ]);

  return (
    <div className="input-view">
      {/* Loading Overlay */}
      {isSubmitting && (
        <div className="loading-overlay">
          <div className="loading-overlay__card">
            <div className="loading-overlay__orbit">
              <span className="orbit-dot orbit-dot--1" />
              <span className="orbit-dot orbit-dot--2" />
              <span className="orbit-dot orbit-dot--3" />
            </div>
            <h2 className="loading-overlay__title">{t('home.loading_title')}</h2>
            <div className="loading-steps">
              {loadingSteps.map((label, i) => (
                <LoadingStep
                  key={i}
                  label={label}
                  active={loadingStep === i}
                  done={loadingStep > i}
                />
              ))}
            </div>
            <p className="loading-overlay__tip">{t('home.loading_tip')}</p>
          </div>
        </div>
      )}

      <div className="input-view__content">
        <div className="input-view__form">
          {/* ── STAGE 1: Hero ── */}
          <div className="iv-hero">
            <div className="iv-hero__brand">
              {/* Logo + Title */}
              <div className="input-view__header">
                <div className="logo">
                  <span className="logo__icon"></span>
                  <span className="logo__text">{t('app_title')}</span>
                </div>
                <h1 ref={titleRef} className="input-view__title heading-display">
                  {t('app_title')}
                </h1>
                <div className="input-view__nav">
                  <button className="btn btn-ghost" onClick={() => navigate('/history')}>
                    {t('home.history')}
                  </button>
                  <button className="btn btn-ghost" onClick={() => navigate('/leaderboard')}>
                    🏆
                  </button>
                </div>
              </div>
            </div>

            <div className="iv-hero__prompt">
              <div className="input-wrapper">
                <textarea
                  ref={questionRef}
                  className="input input--hero"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={onKeyDown}
                  placeholder={placeholder}
                  disabled={isSubmitting}
                  autoFocus
                  rows={1}
                />
              </div>
            </div>

            <div className="iv-hero__cta">
              <div className="input-view__submit-row">
                {isSimulationBudgetBlocked && (
                  <p className="byok-probe-warning">
                    {t('home.byok_budget_blocked')}
                  </p>
                )}
                <button
                  className="btn btn-primary btn--submit"
                  onClick={() => handleSubmit(question)}
                  disabled={!question.trim() || isSubmitting || isSimulationBudgetBlocked}
                >
                  {isSubmitting ? <span className="spinner spinner--sm" /> : null}
                  {t('home.submit')}
                </button>
                <button
                  className="btn btn-ghost btn--submit"
                  onClick={() => void launchDebate({ nextQuestion: question })}
                  disabled={!question.trim() || isSubmitting}
                >
                  {t('debate.entry_cta')}
                </button>
              </div>
            </div>

            {/* Round Count Slider */}
            <div className="rounds-selector">
              <span className="rounds-label">{t('home.rounds_label')}</span>
              <div className="rounds-slider-wrap">
                <input
                  type="range"
                  className="rounds-slider"
                  aria-label={t('home.rounds_label')}
                  min={3}
                  max={HOME_MAX_ROUNDS}
                  step={1}
                  value={rounds}
                  onChange={(e) => setRounds(Number(e.target.value))}
                  disabled={isSubmitting}
                />
              </div>
              <span className="rounds-value">{rounds}</span>
              <span className="rounds-hint">
                {rounds <= 5 ? t('home.rounds_fast') : rounds <= 15 ? t('home.rounds_standard') : rounds <= 25 ? t('home.rounds_deep') : t('home.rounds_extreme')}
                <span className="rounds-time">≈{estimatedSimulationMinutes}min</span>
              </span>
            </div>

            {/* Agent Count Slider */}
            <div className="agents-selector">
              <span className="agents-label">{t('home.agents_label')}</span>
              <div className="agents-slider-wrap">
                <input
                  type="range"
                  className="agents-slider"
                  aria-label={t('home.agents_label')}
                  min={3}
                  max={HOME_MAX_AGENTS}
                  step={1}
                  value={numAgents}
                  onChange={(e) => setNumAgents(Number(e.target.value))}
                  disabled={isSubmitting}
                />
              </div>
              <span className="agents-value">{numAgents}</span>
              <span className="agents-hint">
                {numAgents <= 10 ? t('home.agents_few') : numAgents <= 20 ? t('home.agents_standard') : numAgents <= 30 ? t('home.agents_large') : t('home.agents_extreme')}
              </span>
            </div>

            {/* Web Search Enhancement: opt-in toggle (compile-time flag + server hint) */}
            {webSearchAvailable && (
              <div className="web-search-section">
                <label className={`web-search-toggle ${webSearchEnabled ? 'web-search-toggle--active' : ''}`}>
                  <input
                    type="checkbox"
                    checked={webSearchEnabled}
                    onChange={(e) => {
                      const nextChecked = e.target.checked;
                      setWebSearchEnabled(nextChecked);
                      if (nextChecked && !webSearchServerEnabled) {
                        setWebSearchMode('custom_override');
                      }
                    }}
                    disabled={isSubmitting}
                  />
                  <span className="web-search-toggle__copy">
                    <strong>{t('home.web_search_toggle')}</strong>
                    <span>{t('home.web_search_hint')}</span>
                  </span>
                </label>
                {webSearchStatus !== 'idle' && (
                  <span
                    className={`web-search-status web-search-status--${webSearchStatus}`}
                    aria-live="polite"
                    role="status"
                  >
                    {t(`home.web_search_status_${webSearchStatus}`)}
                  </span>
                )}
                {webSearchEnabled && (
                  <div className="web-search-card">
                    <div className="web-search-card__header">
                      <div className="web-search-fields__meta">
                        <span className={`web-search-provider-chip ${webSearchServerEnabled ? 'web-search-provider-chip--ready' : 'web-search-provider-chip--warning'}`}>
                          {webSearchServerEnabled
                            ? t('home.web_search_server_ready')
                            : t('home.web_search_server_missing')}
                        </span>
                        {webSearchServerProvider && (
                          <span className="web-search-provider-chip">
                            {t('home.web_search_server_default', { provider: webSearchServerProvider })}
                          </span>
                        )}
                      </div>
                      <div className="web-search-mode-switch" role="group" aria-label={t('home.web_search_mode_label')}>
                        <button
                          type="button"
                          className={`web-search-mode-btn ${webSearchMode === 'server_default' ? 'web-search-mode-btn--active' : ''}`}
                          aria-pressed={webSearchMode === 'server_default'}
                          onClick={() => setWebSearchMode('server_default')}
                          disabled={isSubmitting || !webSearchServerEnabled}
                        >
                          <span className="web-search-mode-btn__title">{t('home.web_search_mode_server')}</span>
                          <span className="web-search-mode-btn__hint">
                            {webSearchServerEnabled
                              ? t('home.web_search_mode_server_hint', { provider: webSearchServerProvider ?? 'server' })
                              : t('home.web_search_mode_server_unavailable')}
                          </span>
                        </button>
                        <button
                          type="button"
                          className={`web-search-mode-btn ${webSearchMode === 'custom_override' ? 'web-search-mode-btn--active' : ''}`}
                          aria-pressed={webSearchMode === 'custom_override'}
                          onClick={() => setWebSearchMode('custom_override')}
                          disabled={isSubmitting}
                        >
                          <span className="web-search-mode-btn__title">{t('home.web_search_mode_custom')}</span>
                          <span className="web-search-mode-btn__hint">{t('home.web_search_mode_custom_hint')}</span>
                        </button>
                      </div>
                    </div>
                    {webSearchMode === 'server_default' ? (
                      <div className="web-search-summary" role="note">
                        <strong>{t('home.web_search_mode_server')}</strong>
                        <span>
                          {webSearchServerEnabled
                            ? t('home.web_search_server_summary', { provider: webSearchServerProvider ?? 'server' })
                            : t('home.web_search_mode_server_unavailable')}
                        </span>
                      </div>
                    ) : (
                      <div className="web-search-fields">
                        <div className="web-search-grid">
                          <div className="byok-field web-search-field">
                            <label className="byok-label" htmlFor="web-search-provider">
                              {t('home.web_search_provider_label')}
                            </label>
                            <select
                              id="web-search-provider"
                              className="input byok-input web-search-select"
                              value={webSearchProvider}
                              onChange={(e) => setWebSearchProvider(e.target.value as 'tavily' | 'exa' | 'xai' | 'searxng')}
                              disabled={isSubmitting}
                            >
                              <option value="tavily">Tavily</option>
                              <option value="exa">Exa</option>
                              <option value="xai">xAI</option>
                              <option value="searxng">SearXNG</option>
                            </select>
                            <span className="web-search-field-help">{t('home.web_search_provider_hint')}</span>
                          </div>
                          <div className="byok-field web-search-field">
                            <label className="byok-label" htmlFor="web-search-api-key">
                              {t('home.web_search_api_key_label')}
                            </label>
                            <input
                              id="web-search-api-key"
                              type="password"
                              className="input byok-input"
                              value={webSearchApiKey}
                              onChange={(e) => setWebSearchApiKey(e.target.value)}
                              placeholder={t('home.web_search_api_key_placeholder')}
                              disabled={isSubmitting}
                            />
                            <span className="web-search-field-help">{t('home.web_search_api_key_hint')}</span>
                          </div>
                          <div className="byok-field web-search-field web-search-field--full">
                            <label className="byok-label" htmlFor="web-search-base-url">
                              {t('home.web_search_base_url_label')}
                            </label>
                            <input
                              id="web-search-base-url"
                              type="url"
                              className="input byok-input"
                              value={webSearchBaseUrl}
                              onChange={(e) => setWebSearchBaseUrl(e.target.value)}
                              placeholder={webSearchBaseUrlPlaceholder}
                              disabled={isSubmitting}
                            />
                            <span className="web-search-field-help">{t('home.web_search_base_url_hint')}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── STAGE 2: Challenges ── */}
          <div className="iv-challenges">
            {sharedChallengeBanner && (
              <section className="shared-challenge-banner" role="status">
                <span className="shared-challenge-banner__eyebrow">
                  {t('home.shared_challenge_label')}
                </span>
                <strong className="shared-challenge-banner__title">{sharedChallengeBanner.question}</strong>
                <div className="shared-challenge-banner__meta">
                  {sharedChallengeProfileLabel && (
                    <span className="daily-challenge-card__pill daily-challenge-card__pill--profile">
                      {sharedChallengeProfileLabel}
                    </span>
                  )}
                  <span className="daily-challenge-card__pill">
                    {t('home.shared_challenge_prefilled')}
                  </span>
                </div>
              </section>
            )}

            {todayChallenge && (
            <section className="daily-challenge-card">
              <img
                className="daily-challenge-card__art"
                src="/assets/ui/generated/daily_challenge_panel.png"
                alt={t('common.daily_challenge_art_alt')}
              />
              <div className="daily-challenge-card__copy">
                <span className="daily-challenge-card__eyebrow">
                  <img
                    className="daily-challenge-card__eyebrow-icon"
                    src={getGameplayBadgeSrc('daily_challenge')}
                    alt=""
                    aria-hidden="true"
                  />
                  <span>{t('home.daily_challenge_label')}</span>
                </span>
                <strong className="daily-challenge-card__title">{todayChallengeQuestion}</strong>
                <span className="daily-challenge-card__subtitle">
                  {isZh ? todayChallenge.subtitleZh : todayChallenge.subtitleEn}
                </span>
                <div className="daily-challenge-card__hooks" aria-label={t('common.theme_hooks_aria')}>
                  <span className="daily-challenge-card__pill daily-challenge-card__pill--profile">
                    {challengeProfileLabel}
                  </span>
                  {dailyMastery && (
                    <span className="daily-challenge-card__pill">
                      {t('home.campaign_mastery_level', { level: dailyMastery.level })}
                    </span>
                  )}
                  {challengeHooks.map((hook) => (
                    <span key={hook} className="daily-challenge-card__pill">
                      {hook}
                    </span>
                  ))}
                </div>
                <div className="daily-challenge-card__campaign">
                  <span className="daily-challenge-card__campaign-label">
                    {t('home.campaign_progress')}
                  </span>
                  <strong>
                    {dailyMastery
                      ? `${t('home.campaign_mastery_level', { level: dailyMastery.level })} · ${nextUnlockLabel}`
                      : t('home.campaign_first_run')}
                  </strong>
                </div>
                {todayChallengeProgress && (
                  <div className="daily-challenge-card__status">
                    <span className={`daily-challenge-card__pill ${todayChallengeProgress.completed ? 'daily-challenge-card__pill--done' : ''}`}>
                      {todayChallengeProgress.completed
                        ? t('home.daily_challenge_done')
                        : t('home.daily_challenge_in_progress')}
                    </span>
                    {todayChallengeProgress.profileResonance && (
                      <span className="daily-challenge-card__pill daily-challenge-card__pill--profile">
                        {challengeProfileLabel} · {t(`result.archive_resonance_${todayChallengeProgress.profileResonance}`)}
                      </span>
                    )}
                    {todayChallengeProgress.usedCardsKnown && (
                      <span className="daily-challenge-card__pill">
                        {t('home.daily_challenge_cards_used', { count: todayChallengeProgress.usedCards.length })}
                      </span>
                    )}
                    {todayChallengeProgress.betPlacedKnown && (
                      <span className="daily-challenge-card__pill">
                        {todayChallengeProgress.betPlaced
                          ? t('home.daily_challenge_bet_placed')
                          : t('home.daily_challenge_bet_missing')}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary daily-challenge-card__action"
                onClick={handleStartChallenge}
                disabled={isSubmitting}
              >
                {todayChallengeProgress?.completed
                  ? t('home.daily_challenge_replay')
                  : todayChallengeProgress
                    ? t('home.daily_challenge_continue')
                    : t('home.daily_challenge_start')}
              </button>
            </section>
            )}

            {campaignChallengeRotation && (
            <section className="weekly-challenge-card">
              <div className="weekly-challenge-card__side">
                <img
                  className="weekly-challenge-card__badge-art"
                  src={getGameplayBadgeSrc('daily_challenge')}
                  alt=""
                  aria-hidden="true"
                />
              </div>
              <div className="weekly-challenge-card__copy">
                <span className="daily-challenge-card__eyebrow">
                  {t('home.weekly_challenge_label')}
                </span>
                <strong className="daily-challenge-card__title">
                  {t('home.weekly_challenge_title', { week: campaignChallengeRotation.week_key })}
                </strong>
                <span className="daily-challenge-card__subtitle">
                  {campaignWeeklySummary
                    ? t('home.weekly_challenge_intro')
                    : t('home.weekly_challenge_fallback')}
                </span>
                <div className="daily-challenge-card__hooks">
                  {weeklyChallengeEntries.map((entry) => (
                    <span
                      key={entry.challenge_id}
                      className={`daily-challenge-card__pill daily-challenge-card__pill--profile ${entry.runs > 0 ? 'daily-challenge-card__pill--done' : ''}`}
                    >
                      {entry.profile_label}
                    </span>
                  ))}
                </div>
                <div className="daily-challenge-card__status">
                  {campaignWeeklySummary && (
                    <span className="daily-challenge-card__pill">
                      {t('home.weekly_challenge_completed_runs', { runs: campaignWeeklySummary.total_runs })}
                    </span>
                  )}
                  {campaignWeeklySummary && (
                    <span className="daily-challenge-card__pill">
                      {t('home.weekly_challenge_score', { score: campaignWeeklySummary.campaign_score_delta })}
                    </span>
                  )}
                  {weeklyTopProfileLabel && (
                    <span className="daily-challenge-card__pill daily-challenge-card__pill--profile">
                      {t('home.weekly_challenge_top_profile', { profile: weeklyTopProfileLabel })}
                    </span>
                  )}
                </div>
              </div>
            </section>
            )}

            <section className="weekly-challenge-card weekly-challenge-card--growth">
              <div className="weekly-challenge-card__side">
                <img
                  className="weekly-challenge-card__badge-art"
                  src={getGameplayBadgeSrc('archive_record')}
                  alt=""
                  aria-hidden="true"
                />
              </div>
              <div className="weekly-challenge-card__copy">
                <span className="daily-challenge-card__eyebrow">
                  {t('home.director_growth_label')}
                </span>
                <strong
                  className="daily-challenge-card__title"
                  aria-label={t('home.director_growth_title', {
                    runs: campaignProfile?.total_runs ?? 0,
                    badges: campaignBadges.length,
                  })}
                >
                  {hasDirectorGrowth
                    ? t('home.director_growth_active_title', { runs: campaignProfile?.total_runs ?? 0 })
                    : t('home.director_growth_empty_title')}
                </strong>
                <span className="daily-challenge-card__subtitle">
                  {hasDirectorGrowth
                    ? t('home.director_growth_active_subtitle', { badges: campaignBadges.length })
                    : t('home.director_growth_hint')}
                </span>
                {hasDirectorGrowth && (
                  <div className="daily-challenge-card__status">
                    <span className="daily-challenge-card__pill">
                      {t('home.director_growth_runs', { runs: campaignProfile?.total_runs ?? 0 })}
                    </span>
                    <span className="daily-challenge-card__pill">
                      {t('home.director_growth_badges', { badges: campaignBadges.length })}
                    </span>
                  </div>
                )}
                {topMasteries.length > 0 && (
                  <div className="daily-challenge-card__hooks">
                    {topMasteries.map((mastery) => (
                      <span key={mastery.profile_id} className="daily-challenge-card__pill daily-challenge-card__pill--profile">
                        {getGameplayProfileLabel(mastery.profile_id as never, isZh)}
                        {' · '}
                        {t('home.campaign_mastery_level', { level: mastery.level })}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* ── STAGE 3: Collapsible Config ── */}
          <div className="iv-config">
            <button
              type="button"
              className="iv-config__trigger"
              onClick={() => setIsConfigOpen((prev) => !prev)}
              aria-expanded={isConfigOpen}
            >
              {isConfigOpen ? t('home.advanced_settings_expanded') : t('home.advanced_settings')}
              {' '}
              {isConfigOpen ? '▲' : '▼'}
            </button>
            <div className={`iv-config__body ${isConfigOpen ? 'is-open' : ''}`} inert={!isConfigOpen || undefined}>
              <div className="iv-config__inner">
                {/* Mode Selector */}
                <div className="mode-selector-wrap">
                  <div className="mode-selector">
                    <span className="mode-label">{t('home.mode_label')}</span>
                    <div className="mode-options">
                      <button
                        type="button"
                        className={`mode-btn ${mode === 'blackboard' ? 'mode-btn--active' : ''}`}
                        onClick={() => setMode('blackboard')}
                        disabled={isSubmitting}
                        title={t('home.mode_blackboard_title')}
                      >
                        📋 {t('home.mode_blackboard')}
                      </button>
                      <button
                        type="button"
                        className={`mode-btn ${mode === 'raw' ? 'mode-btn--active' : ''}`}
                        onClick={() => setMode('raw')}
                        disabled={isSubmitting}
                        title={t('home.mode_raw_title')}
                      >
                        📜 {t('home.mode_raw')}
                      </button>
                    </div>
                  </div>
                  <span className="mode-desc">
                    {mode === 'blackboard' ? t('home.mode_blackboard_desc') : t('home.mode_raw_desc')}
                  </span>
                </div>

                {/* V2: Visualization Mode Toggle */}
                <div className="mode-selector-wrap">
                  <div className="mode-selector">
                    <span className="mode-label">{t('home.viz_label')}</span>
                    <div className="mode-options">
                      <button
                        type="button"
                        className={`mode-btn ${!vizEnabled ? 'mode-btn--active' : ''}`}
                        onClick={() => setVizEnabled(false)}
                        disabled={isSubmitting}
                      >
                        📊 {t('home.viz_classic')}
                      </button>
                      <button
                        type="button"
                        className={`mode-btn ${vizEnabled ? 'mode-btn--active' : ''}`}
                        onClick={() => setVizEnabled(true)}
                        disabled={isSubmitting}
                      >
                        🎮 {t('home.viz_theater')}
                      </button>
                    </div>
                  </div>
                  {vizEnabled && (
                    <span className="mode-desc">{t('home.viz_theater_desc')}</span>
                  )}
                </div>

                {/* Reasoning Effort Selector */}
                <div className="mode-selector-wrap">
                  <div className="mode-selector">
                    <span className="mode-label">{t('home.reasoning_label')}</span>
                    <div className="mode-options">
                      {[
                        { value: '', label: t('home.reasoning_off') },
                        { value: 'low', label: t('home.reasoning_low') },
                        { value: 'medium', label: t('home.reasoning_medium') },
                        { value: 'high', label: t('home.reasoning_high') },
                      ].map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          className={`mode-btn ${reasoningEffort === opt.value ? 'mode-btn--active' : ''}`}
                          onClick={() => setReasoningEffort(opt.value)}
                          disabled={isSubmitting}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {reasoningEffort && (
                    <span className="mode-desc">{t('home.reasoning_hint')}</span>
                  )}
                </div>

                <div className="mode-selector-wrap">
                  <div className="mode-selector">
                    <span className="mode-label">{t('home.runtime_preset_label')}</span>
                    <div className="mode-options">
                      {(['conservative', 'balanced', 'aggressive'] as ScenarioRuntimePresetId[]).map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={`mode-btn ${runtimePreset === preset ? 'mode-btn--active' : ''}`}
                          onClick={() => setRuntimePreset(preset)}
                          disabled={isSubmitting}
                          title={t(`home.runtime_preset_${preset}_desc`)}
                        >
                          {t(`home.runtime_preset_${preset}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <span className="mode-desc">{runtimePresetDescription}</span>
                  <span className="mode-desc">{t('home.runtime_preset_scope_main_only')}</span>
                </div>

                {/* Phase 3 F3: Custom Agent Attach Panel */}
                {caps?.custom_agents?.enabled && (
                  <AgentAttachPanel userId={directorIdentity.userId} visible={true} />
                )}

                {/* P4-E: BYOK — Bring Your Own Key */}
                <div className="byok-section">
                  <button
                    type="button"
                    className="byok-toggle"
                    onClick={() => setShowByok(!showByok)}
                    disabled={isSubmitting}
                  >
                    {t('home.byok_toggle')} {showByok ? '▲' : '▼'}
                  </button>
                  {showByok && (
                    <div className="byok-fields">
                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-key">{t('home.byok_api_key_label')}</label>
                        <span className="byok-field-help">{t('home.byok_api_key_help')}</span>
                        <input
                          id="byok-key"
                          type="password"
                          className="input byok-input"
                          value={llmApiKey}
                          onChange={(e) => setLlmApiKey(e.target.value)}
                          placeholder="sk-..."
                          disabled={isSubmitting}
                          autoComplete="off"
                        />
                      </div>
                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-url">{t('home.byok_base_url_label')}</label>
                        <span className="byok-field-help">{t('home.byok_base_url_help')}</span>
                        <input
                          id="byok-url"
                          type="url"
                          className="input byok-input"
                          value={llmBaseUrl}
                          onChange={(e) => setLlmBaseUrl(e.target.value)}
                          placeholder="https://api.openai.com/v1/chat/completions"
                          disabled={isSubmitting}
                        />
                      </div>
                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-model">{t('home.byok_model_label')}</label>
                        <span className="byok-field-help">{t('home.byok_model_help')}</span>
                        <input
                          id="byok-model"
                          type="text"
                          className="input byok-input"
                          value={llmModel}
                          onChange={(e) => setLlmModel(e.target.value)}
                          placeholder="gpt-4o / claude-3.5-sonnet / ..."
                          disabled={isSubmitting}
                        />
                      </div>
                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-rpm">{t('home.byok_rpm_label')}</label>
                        <span className="byok-field-help">{t('home.byok_rpm_help')}</span>
                        <input
                          id="byok-rpm"
                          type="number"
                          min="1"
                          step="1"
                          className="input byok-input"
                          value={llmRequestsPerMinute}
                          onChange={(e) => setLlmRequestsPerMinute(e.target.value)}
                          placeholder="10"
                          disabled={isSubmitting}
                          inputMode="numeric"
                        />
                      </div>
                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-tpm">{t('home.byok_tpm_label')}</label>
                        <span className="byok-field-help">{t('home.byok_tpm_help')}</span>
                        <input
                          id="byok-tpm"
                          type="number"
                          min="1"
                          step="1"
                          className="input byok-input"
                          value={llmTokensPerMinute}
                          onChange={(e) => setLlmTokensPerMinute(e.target.value)}
                          placeholder="100000"
                          disabled={isSubmitting}
                          inputMode="numeric"
                        />
                      </div>
                      <label className="byok-switch">
                        <input
                          type="checkbox"
                          checked={disableUserQuota}
                          onChange={(e) => setDisableUserQuota(e.target.checked)}
                          disabled={isSubmitting}
                        />
                        <span className="byok-switch__copy">
                          <strong>{t('home.byok_disable_user_quota_label')}</strong>
                          <span>{t('home.byok_disable_user_quota_hint')}</span>
                        </span>
                      </label>
                      <div className="byok-actions">
                        <button
                          type="button"
                          className={`mode-btn byok-test-btn ${testStatus === 'ok' ? 'byok-test-btn--ok' : testStatus === 'fail' ? 'byok-test-btn--fail' : ''}`}
                          onClick={handleTestConnection}
                          disabled={isSubmitting || testStatus === 'testing' || !llmApiKey.trim()}
                        >
                          {testStatus === 'testing' ? t('home.byok_testing')
                            : testStatus === 'ok' ? t('home.byok_test_ok')
                            : testStatus === 'fail' ? t('home.byok_test_fail')
                            : t('home.byok_test')}
                        </button>
                        {testStatus === 'fail' && testError && (
                          <span className="byok-test-error">{testError}</span>
                        )}
                      </div>
                      {byokBudgetRecommendation && (
                        <div className={`byok-probe-card ${byokBudgetRecommendation.overBudget ? 'byok-probe-card--warn' : ''}`}>
                          <div className="byok-probe-card__title-row">
                            <strong>{t('home.byok_budget_title')}</strong>
                          </div>
                          <p className="byok-probe-copy">
                            {t('home.byok_budget_recommendation', {
                              rounds,
                              agentsMax: byokBudgetRecommendation.agentsMax,
                              agents: numAgents,
                              roundsMax: byokBudgetRecommendation.roundsMax,
                            })}
                          </p>
                          {byokBudgetRecommendation.overBudget && (
                            <p className="byok-probe-warning">
                              {t('home.byok_budget_warning')}
                            </p>
                          )}
                        </div>
                      )}
                      {probeResult && byokRecommendation && (
                        <div className={`byok-probe-card ${(byokRecommendation.exceedsAgents || byokRecommendation.exceedsRounds) ? 'byok-probe-card--warn' : ''}`}>
                          <div className="byok-probe-card__title-row">
                            <strong>{t('home.byok_probe_title')}</strong>
                            <span className="byok-probe-badge">
                              {t('home.byok_probe_parallelism', { count: probeResult.estimated_parallelism })}
                            </span>
                          </div>
                          <p className="byok-probe-copy">
                            {t('home.byok_probe_recommendation', {
                              agentsMin: byokRecommendation.agents_min,
                              agentsMax: byokRecommendation.agents_max,
                              roundsMin: byokRecommendation.rounds_min,
                              roundsMax: byokRecommendation.rounds_max,
                            })}
                          </p>
                          <p className="byok-probe-copy">
                            {probeResult.allow_disable_user_quota
                              ? t('home.byok_probe_local_toggle_enabled')
                              : t('home.byok_probe_local_toggle_disabled')}
                          </p>
                          {(byokRecommendation.exceedsAgents || byokRecommendation.exceedsRounds) && (
                            <p className="byok-probe-warning">
                              {t('home.byok_probe_warning', {
                                agents: numAgents,
                                rounds,
                              })}
                            </p>
                          )}
                        </div>
                      )}
                      <p className="byok-hint">{t('home.byok_hint')}</p>
                      {llmApiKey.trim() && !hasFreshProbe && (
                        <p className="byok-hint">{t('home.byok_preflight_required')}</p>
                      )}
                      <p className="byok-hint">{t('home.byok_storage_notice')}</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="input-view__submit-hints">
            <p className="input-view__submit-hint">{simulationEtaHint}</p>
            <p className="input-view__submit-hint">{t('debate.entry_hint')}</p>
          </div>
          {submitError && !isSubmitting && (
            <span className="byok-test-error" role="alert">{submitError}</span>
          )}
          {continuityError && !isSubmitting && (
            <span className="byok-test-error" role="alert">{continuityError}</span>
          )}

          {pendingLaunch && continuityMatches.length > 0 && (
            <div className="continuity-dialog-backdrop" role="presentation">
              <div
                className="continuity-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={continuityCopy.title}
              >
                <div className="continuity-dialog__header">
                  <h3>{continuityCopy.title}</h3>
                  <p>{continuityCopy.subtitle}</p>
                </div>
                <div className="continuity-dialog__list">
                  {continuityMatches.map((match) => (
                    <article className="continuity-dialog__card" key={match.continuity_key}>
                      <div className="continuity-dialog__card-copy">
                        <strong>{match.name}</strong>
                        <span>{match.role}</span>
                        {match.persona && <p>{match.persona}</p>}
                      </div>
                      {match.candidate_identity && (
                        <div className="continuity-dialog__candidate">
                          <div className="continuity-dialog__candidate-copy">
                            <strong>{continuityCopy.candidateLabel}</strong>
                            <span>{match.candidate_identity.display_name} · {match.candidate_identity.role}</span>
                            <span>
                              {continuityCopy.similarityLabel}: {Math.round((match.candidate_identity.similarity ?? 0) * 100)}%
                            </span>
                          </div>
                          <div className="continuity-dialog__actions">
                            <label className="continuity-dialog__option">
                              <input
                                type="radio"
                                name={`continuity-${match.continuity_key}`}
                                checked={(continuityChoices[match.continuity_key] ?? 'reuse_existing') === 'reuse_existing'}
                                onChange={() => {
                                  setContinuityChoices((current) => ({
                                    ...current,
                                    [match.continuity_key]: 'reuse_existing',
                                  }));
                                }}
                              />
                              <span>{continuityCopy.reuse}</span>
                            </label>
                            <label className="continuity-dialog__option">
                              <input
                                type="radio"
                                name={`continuity-${match.continuity_key}`}
                                checked={(continuityChoices[match.continuity_key] ?? 'reuse_existing') === 'create_new'}
                                onChange={() => {
                                  setContinuityChoices((current) => ({
                                    ...current,
                                    [match.continuity_key]: 'create_new',
                                  }));
                                }}
                              />
                              <span>{continuityCopy.createNew}</span>
                            </label>
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
                <div className="continuity-dialog__footer">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={closeContinuityDialog}
                    disabled={isSubmitting}
                  >
                    {continuityCopy.cancel}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void confirmContinuityLaunch()}
                    disabled={isSubmitting}
                  >
                    {continuityCopy.confirm}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Quick Start */}
        <div className="quick-start-section">
          <h3 className="section-title">{t('home.quick_starts')}</h3>
          <p className="quick-start-section__meta">
            {campaignProfile
              ? t('home.campaign_quickstart_unlocks', {
                  count: campaignBadges.length,
                  runs: campaignProfile.total_runs,
                })
              : t('home.campaign_first_run')}
          </p>
          <QuickStartCards onSelect={handleQuickStartSelect} />
        </div>
      </div>
    </div>
  );
}
