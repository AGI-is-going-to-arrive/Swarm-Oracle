/* ═══════════════════════════════════════════════════════════
   SwarmOracle — InputView (Landing Page)
   ═══════════════════════════════════════════════════════════ */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import gsap from 'gsap';
import { useTranslation } from 'react-i18next';
import { normalizeLanguage } from '../i18n/config';
import { useSimulationStore } from '../stores/simulationStore';
import {
  createDebate,
  getSessionBoundUserId,
  identityContinuityPreflight,
  type ContinuityOverride,
  type CreateScenarioOptions,
  type IdentityContinuityMatch,
  createMultiRun,
  listModelProfiles,
} from '../api/client';
import type { WebSearchFamily, CampaignContext, SuggestedSettings, ModelProfile } from '../types';
import { useAgentStore } from '../stores/agentStore';
import AgentSelectionStrip from '../components/AgentSelectionStrip';
import { AgentDrawer } from '../components/AgentDrawer';
import { DocumentSeedPanel } from '../components/DocumentSeedPanel';
import { LocalPackPicker } from '../components/LocalPackPicker';
import { EducationTemplatePicker } from '../components/EducationTemplatePicker';
import type { EducationTemplate } from '../api/client';
import { OnboardingGuide } from '../components/Onboarding/OnboardingGuide';
import { LlmNotConfiguredBanner } from '../components/LlmNotConfiguredBanner';
import { LlmErrorHint } from '../components/LlmErrorHint';
import ModelSelect from '../components/ModelSelect';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { useOnboardingState } from '../hooks/useOnboardingState';
import {
  challengeDateKey,
  markChallengeStarted,
} from '../lib/dailyChallenge';
import { stringifyAutomationPayload } from '../game/automation';
import { buildAutomationErrorState, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
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
  SCENARIO_QUESTION_MAX_LENGTH,
  clampScenarioQuestion,
  normalizeScenarioQuestionForLaunch,
} from '../lib/questionLimits';
import {
  useInputByokSettings,
  useInputCampaignState,
  useSharedChallengePrefill,
  useInputWorldContext,
} from '../hooks/useInputViewState';
import { useWebSearchConfig } from '../hooks/useWebSearchConfig';
import { QuickStartCards, type QuickStartPreset } from '../components/QuickStartCards';
import { ProgressIndicator } from '../components/ProgressIndicator';
import SnapshotImportDialog from '../components/Export/SnapshotImportDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { predictTextareaHeight } from '../lib/textLayout/inputPredict';
import { validateByok } from '../lib/llmProviderPolicy';
import { friendlyProviderName } from './inputProviderName';
import { StreakIndicator, DifficultyBadge, RefreshCountdown, WeeklyTrackChip, WeeklyTrackDialog, CampaignProgressSheet } from '../components/campaign';
import './InputView.css';

function estimateSimulationMinutes(rounds: number, numAgents: number) {
  return Math.max(1, Math.round(rounds * (0.75 + numAgents * 0.0225)));
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
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

/* ── FE-5: NewSourceToggles (4 source family toggles) ─────── */
interface NewSourceTogglesProps {
  polymarket: boolean;
  finance: boolean;
  academic: boolean;
  newsDeep: boolean;
  onChange: Record<WebSearchFamily, (next: boolean) => void>;
  disabled?: boolean;
  /**
   * Search-enabled gate. When false, all toggles are rendered as disabled
   * with a "enable search first" hint. Independent from `disabled` (which is
   * used during form submission).
   */
  searchEnabled?: boolean;
  /**
   * Whether the effective provider supports domain-specific filtering. When
   * false, all toggles are disabled with an "unsupported by provider" hint.
   */
  supportsDomainFilter?: boolean;
}

function NewSourceToggleItem({
  family,
  checked,
  onChange,
  disabled,
  searchEnabled,
  supportsDomainFilter,
}: {
  family: WebSearchFamily;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  searchEnabled?: boolean;
  supportsDomainFilter?: boolean;
}) {
  const { t } = useTranslation();
  // Per-family capability gate (server may disable any family independently).
  const { enabled: featureEnabled, loading } = useCapabilityCheck(
    'web_search',
    `providers.${family}.enabled`,
  );
  // P4-2: the parent (InputView) now resolves provider capability via
  // useWebSearchConfig (so custom-override providers get their own capability
  // rather than the server default). We honor that explicit signal when given
  // and fall back to "supported" only when the prop is omitted entirely.
  const domainFilterSupported = supportsDomainFilter ?? true;
  const searchToggleOn = searchEnabled ?? true;
  const testId = `input-source-toggle-${family}`;
  const effectiveDisabled =
    Boolean(disabled)
    || loading
    || !featureEnabled
    || !domainFilterSupported
    || !searchToggleOn;
  const title = t(`input_source.${family}.label`, {
    defaultValue: family.replace('_', ' '),
  });
  const tooltip = t(`input_source.${family}.tooltip`, {
    defaultValue: 'External source provider.',
  });
  // Order matters: the most actionable hint wins. "Enable web search first"
  // beats "provider does not support filter" because the former is fixable
  // here while the latter only resolves if the user switches provider.
  // Keys live in the `input_source.*` namespace to remain stable for tests
  // and translators (these tooltips predate P4 and are referenced widely).
  const disabledReasonKey = !searchToggleOn
    ? 'input_source.search_disabled_tooltip'
    : !featureEnabled
      ? 'input_source.disabled_tooltip'
      : !domainFilterSupported
        ? 'input_source.domain_filter_unsupported'
        : null;
  const disabledReason = disabledReasonKey
    ? t(disabledReasonKey, {
        defaultValue:
          disabledReasonKey === 'input_source.search_disabled_tooltip'
            ? 'Enable web search to use source categories.'
            : disabledReasonKey === 'input_source.disabled_tooltip'
              ? 'This data source is not enabled on the server.'
              : 'The current search provider does not support domain-specific filtering.',
      })
    : null;
  const reasonId = disabledReason ? `new-source-toggle-reason-${family}` : undefined;
  const tooltipText = disabledReason ?? tooltip;
  const effectiveChecked =
    featureEnabled && !disabled && domainFilterSupported && searchToggleOn && checked;
  return (
    <label
      className={`new-source-toggle ${effectiveChecked ? 'new-source-toggle--active' : ''} ${effectiveDisabled ? 'new-source-toggle--disabled' : ''}`}
      data-testid={testId}
      data-source-family={family}
      data-feature-enabled={featureEnabled ? 'true' : 'false'}
      data-domain-filter-supported={domainFilterSupported ? 'true' : 'false'}
      title={tooltipText}
    >
      <input
        type="checkbox"
        checked={effectiveChecked}
        onChange={(evt) => onChange(evt.target.checked)}
        disabled={effectiveDisabled}
        aria-describedby={reasonId}
      />
      <span className="new-source-toggle__copy">
        <strong>{title}</strong>
        <span>{tooltip}</span>
        {disabledReason && (
          <small
            id={reasonId}
            className="new-source-toggle__reason"
            data-testid={`${testId}-reason`}
          >
            {disabledReason}
          </small>
        )}
      </span>
    </label>
  );
}

function NewSourceToggles({
  polymarket,
  finance,
  academic,
  newsDeep,
  onChange,
  disabled,
  searchEnabled,
  supportsDomainFilter,
}: NewSourceTogglesProps) {
  const { enabled: pmEnabled } = useCapabilityCheck('web_search', 'providers.polymarket.enabled');
  const { enabled: finEnabled } = useCapabilityCheck('web_search', 'providers.finance.enabled');
  const { enabled: acadEnabled } = useCapabilityCheck('web_search', 'providers.academic.enabled');
  const { enabled: ndEnabled } = useCapabilityCheck('web_search', 'providers.news_deep.enabled');
  if (!pmEnabled && !finEnabled && !acadEnabled && !ndEnabled) return null;
  return (
    <div className="new-source-toggles" role="group">
      <NewSourceToggleItem
        family="polymarket"
        checked={polymarket}
        onChange={onChange.polymarket}
        disabled={disabled}
        searchEnabled={searchEnabled}
        supportsDomainFilter={supportsDomainFilter}
      />
      <NewSourceToggleItem
        family="finance"
        checked={finance}
        onChange={onChange.finance}
        disabled={disabled}
        searchEnabled={searchEnabled}
        supportsDomainFilter={supportsDomainFilter}
      />
      <NewSourceToggleItem
        family="academic"
        checked={academic}
        onChange={onChange.academic}
        disabled={disabled}
        searchEnabled={searchEnabled}
        supportsDomainFilter={supportsDomainFilter}
      />
      <NewSourceToggleItem
        family="news_deep"
        checked={newsDeep}
        onChange={onChange.news_deep}
        disabled={disabled}
        searchEnabled={searchEnabled}
        supportsDomainFilter={supportsDomainFilter}
      />
    </div>
  );
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
  campaignContext?: CampaignContext;
};

function normalizeCampaignDifficultyTier(
  value: string | undefined,
): CampaignContext['difficulty_tier'] {
  if (value === 'easy' || value === 'normal' || value === 'hard' || value === 'expert') {
    return value;
  }
  return undefined;
}

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
  const [webSearchUrlError, setWebSearchUrlError] = useState<string>('');
  const [launchError, setLaunchError] = useState<string | null>(null);
  const clearLaunchError = useCallback(() => {
    setLaunchError(null);
  }, []);
  const [pendingLaunch, setPendingLaunch] = useState<PendingSimulationLaunch | null>(null);
  // FE-5: 4 new source toggles (independent state per family)
  const [newSourceTogglePolymarket, setNewSourceTogglePolymarket] = useState(false);
  const [newSourceToggleFinance, setNewSourceToggleFinance] = useState(false);
  const [newSourceToggleAcademic, setNewSourceToggleAcademic] = useState(false);
  const [newSourceToggleNewsDeep, setNewSourceToggleNewsDeep] = useState(false);
  // V2: Pixel Theater visualization
  const [vizEnabled, setVizEnabled] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showWebSearchEndpoint, setShowWebSearchEndpoint] = useState(false);
  const [showSnapshotImport, setShowSnapshotImport] = useState(false);
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
  const [runtimePreset, setRuntimePreset] = useState<ScenarioRuntimePresetId>(() => loadScenarioRuntimePreset());
  const [multiRunEnabled, setMultiRunEnabled] = useState(false);
  const [multiRunCount, setMultiRunCount] = useState(5);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const apiUserId = getSessionBoundUserId();
  const {
    capabilities: caps,
    loading: customAgentsCapabilityLoading,
  } = useCapabilityCheck('custom_agents');
  const {
    capabilities: multiRunCaps,
    error: multiRunCapError,
    reload: reloadMultiRunCap,
  } = useCapabilityCheck('multi_run');
  const customAgentsEnabled = caps?.custom_agents?.enabled === true;
  const multiRunMaxCount = multiRunCaps?.multi_run?.max_count ?? 10;
  const { enabled: educationTemplatesEnabled } = useCapabilityCheck('education_templates');
  const [educationPickerOpen, setEducationPickerOpen] = useState(false);

  const {
    enabled: modelProfilesEnabled,
    error: modelProfilesError,
    reload: reloadModelProfilesCap,
  } = useCapabilityCheck('model_profiles');

  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');
  const [propositionProfileId, setPropositionProfileId] = useState<string>('');
  const [oppositionProfileId, setOppositionProfileId] = useState<string>('');
  const [judgeProfileId, setJudgeProfileId] = useState<string>('');

  useEffect(() => {
    if (modelProfilesEnabled) {
      listModelProfiles()
        .then((res) => setProfiles(res.profiles || []))
        .catch(() => {});
    }
  }, [modelProfilesEnabled]);

  const handleProfileChange = (profileId: string) => {
    clearLaunchError();
    setSelectedProfileId(profileId);
    const profile = profiles.find((p) => p.id === profileId);
    if (profile) {
      setLlmModel(profile.model);
      setLlmBaseUrl(profile.base_url || '');
      setLlmRequestsPerMinute(profile.rpm !== null && profile.rpm !== undefined ? String(profile.rpm) : '');
      setLlmTokensPerMinute(profile.tpm !== null && profile.tpm !== undefined ? String(profile.tpm) : '');
      setLlmApiKey('');
    } else {
      setLlmModel('');
      setLlmBaseUrl('');
      setLlmRequestsPerMinute('');
      setLlmTokensPerMinute('');
      setLlmApiKey('');
    }
  };
  // S1-5: First-visit onboarding guide. Hidden once the user finishes or skips.
  const onboarding = useOnboardingState();
  const agentSelectedIds = useAgentStore((s) => s.selectedIds);
  const pruneSelectionToSize = useAgentStore((s) => s.pruneSelectionToSize);
  const startSimulation = useSimulationStore((s) => s.startSimulation);
  const submitError = useSimulationStore((s) => s.error);
  const submitErrorCode = useSimulationStore((s) => s.errorCode);
  const reset = useSimulationStore((s) => s.reset);
  const [confirmDialogData, setConfirmDialogData] = useState<{ question: string } | null>(null);
  const [weeklyTrackDialogOpen, setWeeklyTrackDialogOpen] = useState(false);
  const [campaignSheetOpen, setCampaignSheetOpen] = useState(false);
  const isComposingRef = useRef(false);
  const launchInFlightRef = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const continuityDialogRef = useRef<HTMLDivElement>(null);
  const typewriterTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleClosedConfigFocusCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (isConfigOpen) return;
    event.preventDefault();
    (event.target as HTMLElement | null)?.blur?.();
  }, [isConfigOpen]);
  const handleClosedAdvancedFocusCapture = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (advancedOpen) return;
    event.preventDefault();
    (event.target as HTMLElement | null)?.blur?.();
  }, [advancedOpen]);
  const {
    webSearchEnabled,
    setWebSearchEnabled,
    webSearchServerEnabled,
    setWebSearchServerEnabled,
    webSearchServerProvider,
    webSearchMode,
    setWebSearchMode,
    webSearchProvider,
    setWebSearchProvider,
    webSearchApiKey,
    setWebSearchApiKey,
    webSearchBaseUrl,
    setWebSearchBaseUrl,
    webSearchIntensity,
    setWebSearchIntensity,
    webSearchStatus,
    setWebSearchStatus,
    effectiveProviderCapability,
    supportsDomainFilter,
    inferredCustomProvider,
  } = useWebSearchConfig();
  const {
    showByok,
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
    setTestStatus,
    setTestError,
    probeResult,
    hasFreshProbe,
    reasoningEffort,
    setReasoningEffort,
    handleTestConnection,
  } = useInputByokSettings(t, {
    onWebSearchServerHint: setWebSearchServerEnabled,
  });

  // 建档后 / 已有档案时，自动选中首个 model profile（list 按 updated_at desc，故为最近的），
  // 让首页直接用 DB 凭据推演。否则"未选档案 + sessionStorage 残留 base_url 无 key"会让
  // launchSimulation 的 validateByok 命中 `baseUrl && !apiKey` → BYOK_INVALID → 推演死锁。
  // 仅在「无本地明文 BYOK」「未手动选过档案」时抢选一次（ref 守卫防重复 + 不覆盖用户选择）。
  const autoSelectProfileRef = useRef(false);
  useEffect(() => {
    if (autoSelectProfileRef.current) return;
    if (selectedProfileId || llmApiKey.trim()) return;
    // 只自动选「带 api_key」的档案——与后端 llm_configured 口径一致（no-key 档案后端不算已
    // 配置，自动选中会隐藏 banner 却在推演时回退服务端默认/失败）。无带 key 档案则不抢选。
    const first = profiles.find((p) => p.has_api_key);
    if (!first) return;
    autoSelectProfileRef.current = true;
    setSelectedProfileId(first.id);
    setLlmModel(first.model);
    setLlmBaseUrl(first.base_url || '');
    setLlmRequestsPerMinute(first.rpm != null ? String(first.rpm) : '');
    setLlmTokensPerMinute(first.tpm != null ? String(first.tpm) : '');
    setLlmApiKey('');
  }, [
    profiles,
    selectedProfileId,
    llmApiKey,
    setSelectedProfileId,
    setLlmModel,
    setLlmBaseUrl,
    setLlmRequestsPerMinute,
    setLlmTokensPerMinute,
    setLlmApiKey,
  ]);

  // 防 stale 选择：选中的档案在最新列表中已不存在（被删除 / 切 user）时，清空选择并重置档案
  // 派生字段，避免提交携带不存在的 modelProfileId。profiles 为空视为加载中，不清。
  useEffect(() => {
    if (!selectedProfileId || profiles.length === 0) return;
    if (profiles.some((p) => p.id === selectedProfileId)) return;
    setSelectedProfileId('');
    setLlmModel('');
    setLlmBaseUrl('');
    setLlmRequestsPerMinute('');
    setLlmTokensPerMinute('');
  }, [
    profiles,
    selectedProfileId,
    setSelectedProfileId,
    setLlmModel,
    setLlmBaseUrl,
    setLlmRequestsPerMinute,
    setLlmTokensPerMinute,
  ]);

  const activeProfile = profiles.find((p) => p.id === selectedProfileId);
  const isModelOverridden = !!activeProfile && llmModel !== activeProfile.model;
  const isBaseUrlOverridden = !!activeProfile && llmBaseUrl !== (activeProfile.base_url || '');
  const isRpmOverridden = !!activeProfile && llmRequestsPerMinute !== (activeProfile.rpm != null ? String(activeProfile.rpm) : '');
  const isTpmOverridden = !!activeProfile && llmTokensPerMinute !== (activeProfile.tpm != null ? String(activeProfile.tpm) : '');
  const isApiKeyOverridden = !!activeProfile && llmApiKey !== '';

  const staticLlmConfigured = caps?.llm_static_configured === true;
  const profileOnlyLlmConfigured =
    caps?.llm_configured === true &&
    caps?.llm_static_configured === false &&
    caps?.llm_profile_configured === true;
  const hasUsableLlmCredential =
    staticLlmConfigured ||
    Boolean(activeProfile?.has_api_key) ||
    Boolean(llmApiKey.trim());
  const llmNotConfigured =
    !hasUsableLlmCredential &&
    (caps?.llm_configured === false || profileOnlyLlmConfigured);

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
    directorUserId: apiUserId,
  });
  const { sharedChallenge, sharedChallengeBanner } = useSharedChallengePrefill(searchParams);
  const {
    worldContext,
    setWorldContext,
    agentsPreview,
    setAgentsPreview,
  } = useInputWorldContext();
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
  const sharedChallengeProfileLabel = sharedChallengeBanner?.profileId
    ? getGameplayProfileLabel(sharedChallengeBanner.profileId, isZh)
    : null;
  const weeklyTopProfileLabel = campaignWeeklySummary?.top_profile_id
    ? getGameplayProfileLabel(campaignWeeklySummary.top_profile_id, isZh)
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
    profile_label: getGameplayProfileLabel(mastery.profile_id, isZh),
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
      case 'firecrawl':
        return 'https://api.firecrawl.dev/v2/search';
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
  const customSearchProviderMatchesServer = webSearchProvider === webSearchServerProvider;
  const customSearchUsesSearxng = webSearchProvider === 'searxng';
  const showCustomSearchEndpointField =
    customSearchUsesSearxng || showWebSearchEndpoint || webSearchBaseUrl.trim().length > 0;
  const showUnknownEndpointWarning =
    webSearchUsesCustomOverride
    && webSearchBaseUrl.trim().length > 0
    && inferredCustomProvider == null;
  const handleWebSearchProviderChange = (next: 'tavily' | 'exa' | 'firecrawl' | 'xai' | 'searxng') => {
    setWebSearchProvider(next);
    if (next === 'searxng') {
      setWebSearchApiKey('');
      setShowWebSearchEndpoint(true);
    }
  };
  const selectedWebSearchFamilies = useMemo<WebSearchFamily[]>(() => {
    if (!webSearchEnabled || !supportsDomainFilter) return [];
    const nextFamilies: WebSearchFamily[] = [];
    if (newSourceTogglePolymarket) nextFamilies.push('polymarket');
    if (newSourceToggleFinance) nextFamilies.push('finance');
    if (newSourceToggleAcademic) nextFamilies.push('academic');
    if (newSourceToggleNewsDeep) nextFamilies.push('news_deep');
    return nextFamilies;
  }, [
    newSourceToggleAcademic,
    newSourceToggleFinance,
    newSourceToggleNewsDeep,
    newSourceTogglePolymarket,
    supportsDomainFilter,
    webSearchEnabled,
  ]);
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
  const maxCustomAgents = useMemo(() => {
    if (!customAgentsEnabled) return 0;
    const serverMax = caps?.custom_agents?.max_custom_agents;
    const capLimit = typeof serverMax === 'number' && serverMax >= 0 ? serverMax : 1;
    return Math.min(numAgents, capLimit);
  }, [customAgentsEnabled, numAgents, caps?.custom_agents?.max_custom_agents]);
  const selectedCustomAgentCount = customAgentsEnabled
    ? Math.min(agentSelectedIds.size, maxCustomAgents)
    : 0;

  useEffect(() => {
    if (!customAgentsCapabilityLoading && maxCustomAgents >= 0) {
      pruneSelectionToSize(maxCustomAgents);
    }
  }, [customAgentsCapabilityLoading, maxCustomAgents, pruneSelectionToSize]);

  const getClampedCustomAgentIds = useCallback((maxAllowed: number): string[] => {
    if (!customAgentsEnabled) return [];
    const cap = Math.max(0, Math.trunc(maxAllowed));
    return Array.from(useAgentStore.getState().selectedIds).slice(0, cap);
  }, [customAgentsEnabled]);

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
  const continuityCopy = useMemo(() => ({
    title: t('home.continuity_title'),
    subtitle: t('home.continuity_subtitle'),
    reuse: t('home.continuity_reuse'),
    createNew: t('home.continuity_create_new'),
    candidateLabel: t('home.continuity_candidate_label'),
    similarityLabel: t('home.continuity_similarity_label'),
    cancel: t('home.continuity_cancel'),
    confirm: t('home.continuity_confirm'),
  }), [t]);
  const continuityPreflightErrorCopy = useMemo(
    () => t('home.continuity_preflight_error'),
    [t],
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
    clearLaunchError();
    setQuestion(clampScenarioQuestion(sharedChallenge.question));
    setRounds(sharedChallenge.rounds);
    setNumAgents(sharedChallenge.numAgents);
    setMode(sharedChallenge.mode);
    setVizEnabled(sharedChallenge.visualizationEnabled);
    if (sharedChallenge.runtimePreset) {
      setRuntimePreset(sharedChallenge.runtimePreset);
    }
  }, [clearLaunchError, sharedChallenge]);

  useEffect(() => {
    saveScenarioRuntimePreset(runtimePreset);
  }, [runtimePreset]);

  // P1-7: clear source family selections when the gate closes
  // so stale picks don't sneak into a later run if it reopens.
  useEffect(() => {
    if (!webSearchEnabled || !supportsDomainFilter) {
      setNewSourceTogglePolymarket(false);
      setNewSourceToggleFinance(false);
      setNewSourceToggleAcademic(false);
      setNewSourceToggleNewsDeep(false);
    }
  }, [supportsDomainFilter, webSearchEnabled]);

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

    if (prefersReducedMotion()) {
      setPlaceholder(placeholders[0] || '');
      return undefined;
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
    if (prefersReducedMotion()) return;
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
    const trimmed = normalizeScenarioQuestionForLaunch(launch.nextQuestion);
    const serverMaxCustomAgents = customAgentsEnabled ? caps?.custom_agents?.max_custom_agents : 0;
    const capLimit =
      customAgentsEnabled && typeof serverMaxCustomAgents === 'number' && serverMaxCustomAgents >= 0
        ? serverMaxCustomAgents
        : customAgentsEnabled
          ? 1
          : 0;
    const effectiveMaxCustomAgents = Math.max(
      0,
      Math.min(launch.nextAgents, capLimit),
    );
    const clampedCustomAgentIds = getClampedCustomAgentIds(effectiveMaxCustomAgents);

    let campaignContext: CampaignContext | undefined = launch.campaignContext;
    if (!campaignContext && launch.challengeId) {
      if (todayChallenge && launch.challengeId === todayChallenge.id) {
        const activeTrack = campaignChallengeRotation?.weekly_track;
        campaignContext = {
          challenge_id: todayChallenge.id,
          challenge_local_date: campaignChallengeRotation?.local_date ?? challengeDateKey(),
          profile_id: todayChallenge.profileId,
          difficulty_tier: normalizeCampaignDifficultyTier(todayChallenge.difficulty_tier),
          is_daily_challenge: true,
          ...(activeTrack && campaignChallengeRotation?.iso_week_key
            ? {
                week_key: campaignChallengeRotation.iso_week_key,
                weekly_track_id: activeTrack.id,
                is_weekly_track: true,
              }
            : {}),
        };
      } else if (weeklyChallenges) {
        const weeklyMatch = weeklyChallenges.find((c) => c.id === launch.challengeId);
        const activeTrack = campaignChallengeRotation?.weekly_track;
        if (weeklyMatch && activeTrack && campaignChallengeRotation?.iso_week_key) {
          // Phase 2b: campaign_context.week_key MUST be the ISO YYYY-Wnn form
          // (matches the backend validator). The legacy `week_key` field on
          // the rotation response is the Monday-of-week date; use
          // `iso_week_key` instead. Falls back to undefined if missing.
          campaignContext = {
            week_key: campaignChallengeRotation.iso_week_key,
            weekly_track_id: activeTrack.id,
            profile_id: activeTrack.profile_ids?.[0] ?? weeklyMatch.profileId,
            is_weekly_track: true,
          };
        }
      }
    }

    const profile = profiles.find((p) => p.id === selectedProfileId);
    let resolvedApiKey: string | undefined = llmApiKey || undefined;
    let resolvedBaseUrl: string | undefined = llmBaseUrl || undefined;
    let resolvedModel: string | undefined = llmModel || undefined;
    let resolvedRpm: number | undefined = Number.isFinite(byokRequestsPerMinute) ? byokRequestsPerMinute : undefined;
    let resolvedTpm: number | undefined = Number.isFinite(byokTokensPerMinute) ? byokTokensPerMinute : undefined;

    if (profile) {
      if (llmApiKey.trim() === '') {
        resolvedApiKey = undefined;
      }
      if (llmBaseUrl === (profile.base_url || '')) {
        resolvedBaseUrl = undefined;
      }
      if (llmModel === profile.model) {
        resolvedModel = undefined;
      }
      if (resolvedRpm === (profile.rpm ?? undefined)) {
        resolvedRpm = undefined;
      }
      if (resolvedTpm === (profile.tpm ?? undefined)) {
        resolvedTpm = undefined;
      }
    }

    return {
      question: trimmed,
      rounds: launch.nextRounds,
      numAgents: launch.nextAgents,
      mode: launch.nextMode,
      llmApiKey: resolvedApiKey,
      llmBaseUrl: resolvedBaseUrl,
      llmModel: resolvedModel,
      llmRequestsPerMinute: resolvedRpm,
      llmTokensPerMinute: resolvedTpm,
      reasoningEffort: reasoningEffort || undefined,
      visualizationEnabled: launch.nextVisualization,
      userId: apiUserId,
      disableUserQuota,
      webSearchEnabled,
      webSearchFamilies: selectedWebSearchFamilies,
      webSearchProvider: webSearchUsesCustomOverride ? webSearchProvider : undefined,
      webSearchApiKey: webSearchUsesCustomOverride && webSearchApiKey.trim() ? webSearchApiKey.trim() : undefined,
      webSearchBaseUrl: webSearchUsesCustomOverride && webSearchBaseUrl.trim() ? webSearchBaseUrl.trim() : undefined,
      webSearchIntensity: webSearchEnabled ? webSearchIntensity : undefined,
      continuityOverrides,
      ...buildScenarioRuntimePresetOptions(runtimePreset),
      ...(clampedCustomAgentIds.length > 0 && { customAgentIdentityIds: clampedCustomAgentIds }),
      ...(campaignContext && { campaignContext }),
      ...(worldContext && { worldContext }),
      modelProfileId: selectedProfileId || undefined,
      language: normalizeLanguage(i18n.language),
    };
  }, [
    byokRequestsPerMinute,
    byokTokensPerMinute,
    caps?.custom_agents?.max_custom_agents,
    customAgentsEnabled,
    apiUserId,
    disableUserQuota,
    llmApiKey,
    llmBaseUrl,
    llmModel,
    reasoningEffort,
    runtimePreset,
    webSearchApiKey,
    webSearchBaseUrl,
    webSearchEnabled,
    webSearchIntensity,
    selectedWebSearchFamilies,
    webSearchProvider,
    webSearchUsesCustomOverride,
    todayChallenge,
    weeklyChallenges,
    campaignChallengeRotation,
    getClampedCustomAgentIds,
    worldContext,
    profiles,
    selectedProfileId,
    i18n.language,
  ]);

  const closeContinuityDialog = useCallback(() => {
    if (isSubmitting) return;
    setPendingLaunch(null);
    setContinuityMatches([]);
    setContinuityChoices({});
    setContinuityError(null);
  }, [isSubmitting]);

  const isContinuityDialogOpen = Boolean(pendingLaunch && continuityMatches.length > 0);

  const handleContinuityDialogKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeContinuityDialog();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = continuityDialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute('aria-hidden'));
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, [closeContinuityDialog]);

  const executeSimulationLaunch = useCallback(async (
    launch: PendingSimulationLaunch,
    continuityOverrides?: ContinuityOverride[],
  ) => {
    setIsSubmitting(true);
    setContinuityError(null);
    const wantsSearch = webSearchEnabled;
    if (wantsSearch) setWebSearchStatus('searching');
    else setWebSearchStatus('skipped');
    // Pipeline stepper integration: add body class so the stepper spacer
    // can apply bottom padding during the brief launching window.
    document.body.classList.add('has-pipeline-launching');
    try {
      const options = buildSimulationOptions(launch, continuityOverrides);
      if (multiRunCaps?.multi_run?.enabled && multiRunEnabled) {
        const multiRunResponse = await createMultiRun({
          ...options,
          runCount: multiRunCount,
          verdictOnlyRuns: true,
        });
        const firstScenarioId = multiRunResponse.runs[0]?.scenario_id;
        if (firstScenarioId) {
          navigate(`/result/${firstScenarioId}`);
        } else {
          throw new Error('No scenarios returned from multi-run');
        }
      } else {
        const id = await startSimulation(options);
        if (launch.challengeId) {
          markChallengeStarted(launch.challengeId, id);
        }
        navigate(`/sim/${id}`);
      }
      setPendingLaunch(null);
      setContinuityMatches([]);
      setContinuityChoices({});
    } catch (err) {
      console.error('[executeSimulationLaunch] failed:', err);
      const errMsg = getLocalizedApiErrorMessage(err, t, t('common.api_errors.simulation_start_failed'));
      setLaunchError(errMsg);
      setWebSearchStatus('idle');
      setIsSubmitting(false);
      setPendingLaunch(null);
      setContinuityMatches([]);
      setContinuityChoices({});
      launchInFlightRef.current = false;
      throw err;
    } finally {
      document.body.classList.remove('has-pipeline-launching');
    }
  }, [
    buildSimulationOptions,
    navigate,
    setWebSearchStatus,
    startSimulation,
    webSearchEnabled,
    multiRunCaps?.multi_run?.enabled,
    multiRunEnabled,
    multiRunCount,
    t,
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
        result.matches.reduce<Record<string, ContinuityOverride['action']>>((accumulator, match) => {
          accumulator[match.continuity_key] = 'reuse_existing';
          return accumulator;
        }, {}),
      );
      return true;
    } catch (error) {
      console.warn('[InputView] identity continuity preflight failed', error);
      setContinuityError(continuityPreflightErrorCopy);
      return false;
    }
  }, [buildSimulationOptions, caps?.agent_identity?.enabled, continuityPreflightErrorCopy]);

  const confirmContinuityLaunch = useCallback(async () => {
    if (!pendingLaunch || isSubmitting || launchInFlightRef.current) return;
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
    launchInFlightRef.current = true;
    try {
      await executeSimulationLaunch(pendingLaunch, overrides);
    } catch (err) {
      console.error('[confirmContinuityLaunch] failed:', err);
      const errMsg = getLocalizedApiErrorMessage(err, t, t('common.api_errors.simulation_start_failed'));
      setLaunchError(errMsg);
    } finally {
      launchInFlightRef.current = false;
    }
  }, [
    continuityChoices,
    continuityMatches,
    executeSimulationLaunch,
    isSubmitting,
    pendingLaunch,
    t,
  ]);

  useEffect(() => {
    if (multiRunCaps?.multi_run?.default_count) {
      setMultiRunCount(multiRunCaps.multi_run.default_count);
    }
  }, [multiRunCaps?.multi_run?.default_count]);

  useEffect(() => {
    if (!isContinuityDialogOpen) return undefined;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusFirstControl = () => {
      const dialog = continuityDialogRef.current;
      const firstControl = dialog?.querySelector<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      (firstControl ?? dialog)?.focus();
    };
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusFirstControl);
    } else {
      focusFirstControl();
    }
    return () => {
      previousFocus?.focus();
    };
  }, [isContinuityDialogOpen]);

  const launchSimulation = async (launch: PendingSimulationLaunch) => {
    const trimmed = normalizeScenarioQuestionForLaunch(launch.nextQuestion);
    if (!trimmed || isSubmitting) return;
    if (llmNotConfigured) return;
    if (launchInFlightRef.current) return;
    if (isSimulationBudgetBlocked) return;
    const normalizedLaunch = launch.nextQuestion === trimmed
      ? launch
      : { ...launch, nextQuestion: trimmed };
    if (launch.nextQuestion.trim() !== trimmed) {
      setQuestion(trimmed);
    }
    setWebSearchUrlError('');
    const isProfileSelected = Boolean(selectedProfileId);
    const byokValidation = isProfileSelected
      ? { valid: true }
      : validateByok({ apiKey: llmApiKey, baseUrl: llmBaseUrl });
    if (!byokValidation.valid) {
      setTestStatus('fail');
      setTestError(t('conversation.error.byok_invalid'));
      setIsConfigOpen(true);
      return;
    }
    if (webSearchUsesCustomOverride) {
      const trimmedBase = webSearchBaseUrl.trim();
      if (trimmedBase) {
        try {
          const parsed = new URL(trimmedBase);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('invalid scheme');
          }
        } catch {
          setWebSearchUrlError(t('home.web_search_base_url_invalid'));
          return;
        }
      }
    }

    launchInFlightRef.current = true;
    try {
      if (llmApiKey.trim() && !hasFreshProbe) {
        const probe = await handleTestConnection();
        if (!probe.ok) {
          setIsConfigOpen(true);
          return;
        }
      }

      setIsSubmitting(true);
      setConfirmDialogData(null);

      const blockedByContinuityDialog = await maybeRunContinuityPreflight(normalizedLaunch);
      if (blockedByContinuityDialog) {
        setIsSubmitting(false);
        launchInFlightRef.current = false;
        return;
      }

      await executeSimulationLaunch(normalizedLaunch);
    } catch (err) {
      console.error('[launchSimulation] failed:', err);
      const errMsg = getLocalizedApiErrorMessage(err, t, t('common.api_errors.simulation_start_failed'));
      setLaunchError(errMsg);
      setIsSubmitting(false);
      throw err;
    } finally {
      launchInFlightRef.current = false;
    }
  };

  const launchDebate = async ({
    nextQuestion,
  }: {
    nextQuestion: string;
  }) => {
    const trimmed = normalizeScenarioQuestionForLaunch(nextQuestion);
    if (!trimmed || isSubmitting) return;
    if (llmNotConfigured) return;
    clearLaunchError();
    if (nextQuestion.trim() !== trimmed) {
      setQuestion(trimmed);
    }
    const debateProfileFallbackId = profileOnlyLlmConfigured ? selectedProfileId : '';
    const effectivePropositionProfileId = propositionProfileId || debateProfileFallbackId;
    const effectiveOppositionProfileId = oppositionProfileId || debateProfileFallbackId;
    const effectiveJudgeProfileId = judgeProfileId || debateProfileFallbackId;
    const isProfileSelected = Boolean(
      effectivePropositionProfileId ||
      effectiveOppositionProfileId ||
      effectiveJudgeProfileId,
    );
    const byokValidation = isProfileSelected
      ? { valid: true }
      : validateByok({ apiKey: llmApiKey, baseUrl: llmBaseUrl });
    if (!byokValidation.valid) {
      setTestStatus('fail');
      setTestError(t('conversation.error.byok_invalid'));
      setIsConfigOpen(true);
      return;
    }

    setIsSubmitting(true);
    try {
      const serverMaxCustomAgents = caps?.custom_agents?.max_custom_agents;
      const debateCustomAgentLimit = Math.min(
        2,
        customAgentsEnabled && typeof serverMaxCustomAgents === 'number' && serverMaxCustomAgents >= 0
          ? serverMaxCustomAgents
          : 2,
      );
      const [propositionAgentId, oppositionAgentId] = getClampedCustomAgentIds(debateCustomAgentLimit);
      const resolvedLlmApiKey = llmApiKey.trim() || undefined;
      const resolvedLlmBaseUrl = !isProfileSelected || resolvedLlmApiKey
        ? llmBaseUrl || undefined
        : undefined;
      const resolvedLlmModel = activeProfile && llmModel === activeProfile.model
        ? undefined
        : llmModel || undefined;
      const debate = await createDebate(trimmed, undefined, {
        llmApiKey: resolvedLlmApiKey,
        llmBaseUrl: resolvedLlmBaseUrl,
        llmModel: resolvedLlmModel,
        llmRequestsPerMinute: Number.isFinite(byokRequestsPerMinute) ? byokRequestsPerMinute : undefined,
        llmTokensPerMinute: Number.isFinite(byokTokensPerMinute) ? byokTokensPerMinute : undefined,
        reasoningEffort: reasoningEffort || undefined,
        userId: apiUserId,
        propositionModelProfileId: effectivePropositionProfileId || undefined,
        oppositionModelProfileId: effectiveOppositionProfileId || undefined,
        judgeModelProfileId: effectiveJudgeProfileId || undefined,
        language: normalizeLanguage(i18n.language),
      }, propositionAgentId ? {
        proposition: propositionAgentId,
        opposition: oppositionAgentId,
      } : undefined);
      navigate(`/debate/${debate.id}`);
    } catch (err) {
      console.error('[launchDebate] failed:', err);
      const errMsg = getLocalizedApiErrorMessage(err, t, t('common.api_errors.simulation_start_failed'));
      setLaunchError(errMsg);
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

  const handleEducationTemplateSelect = useCallback((template: EducationTemplate) => {
    const localizedTitle = isZh
      ? (template.title_zh || template.title_en)
      : (template.title_en || template.title_zh);
    clearLaunchError();
    setQuestion(clampScenarioQuestion(localizedTitle || ''));
    if (Number.isFinite(template.suggested_rounds) && template.suggested_rounds > 0) {
      setRounds(template.suggested_rounds);
    }
    if (Number.isFinite(template.suggested_agents) && template.suggested_agents > 0) {
      setNumAgents(template.suggested_agents);
    }
    setEducationPickerOpen(false);
    requestAnimationFrame(() => {
      questionRef.current?.focus();
    });
  }, [clearLaunchError, isZh]);

  const handleImportPack = useCallback((payload: { question: string; suggested_settings: SuggestedSettings }) => {
    clearLaunchError();
    setQuestion(clampScenarioQuestion(payload.question));
    if (Number.isFinite(payload.suggested_settings.rounds) && payload.suggested_settings.rounds > 0) {
      setRounds(payload.suggested_settings.rounds);
    }
    if (Number.isFinite(payload.suggested_settings.num_agents) && payload.suggested_settings.num_agents > 0) {
      setNumAgents(payload.suggested_settings.num_agents);
    }
    if (payload.suggested_settings.simulation_mode) {
      setRuntimePreset(payload.suggested_settings.simulation_mode);
    }
    if (payload.suggested_settings.language === 'zh' || payload.suggested_settings.language === 'en') {
      i18n.changeLanguage(payload.suggested_settings.language).catch(() => {});
    }
    requestAnimationFrame(() => {
      questionRef.current?.focus();
    });
  }, [clearLaunchError, i18n]);

  const handleQuickStartSelect = async (preset: QuickStartPreset) => {
    clearLaunchError();
    const nextQuestion = clampScenarioQuestion(preset.question);
    setQuestion(nextQuestion);
    try {
      await launchSimulation({
        nextQuestion,
        nextRounds: preset.rounds ?? rounds,
        nextAgents: preset.numAgents ?? numAgents,
        nextMode: preset.mode ?? mode,
        nextVisualization: preset.visualizationEnabled ?? vizEnabled,
      });
    } catch (err) {
      console.error('[handleQuickStartSelect] failed:', err);
    }
  };

  const handleStartChallenge = async () => {
    if (!todayChallenge) return;
    if (todayChallengeProgress?.scenarioId) {
      navigate(`/sim/${todayChallengeProgress.scenarioId}`);
      return;
    }

    clearLaunchError();
    const nextQuestion = clampScenarioQuestion(todayChallengeQuestion);
    setQuestion(nextQuestion);
    setRounds(todayChallenge.rounds);
    setNumAgents(todayChallenge.numAgents);
    setMode(todayChallenge.mode);
    setVizEnabled(todayChallenge.visualizationEnabled);
    try {
      await launchSimulation({
        nextQuestion,
        nextRounds: todayChallenge.rounds,
        nextAgents: todayChallenge.numAgents,
        nextMode: todayChallenge.mode,
        nextVisualization: todayChallenge.visualizationEnabled,
        challengeId: todayChallenge.id,
      });
    } catch (err) {
      console.error('[handleStartChallenge] failed:', err);
    }
  };

  const handleDailyCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.daily-challenge-card__action') || target.closest('a') || target.closest('button')) {
      return;
    }
    if (todayChallengeQuestion) {
      clearLaunchError();
      setQuestion(todayChallengeQuestion);
      if (todayChallenge) {
        setRounds(todayChallenge.rounds);
        setNumAgents(todayChallenge.numAgents);
        setMode(todayChallenge.mode);
        setVizEnabled(todayChallenge.visualizationEnabled);
      }
    }
  };

  const handleWeeklyChipClick = () => {
    setWeeklyTrackDialogOpen(true);
  };

  const handleWeeklyTrackConfirm = async () => {
    const track = campaignChallengeRotation?.weekly_track;
    setWeeklyTrackDialogOpen(false);
    if (!track || isSubmitting || launchInFlightRef.current) return;

    const firstWeekly = weeklyChallenges[0];
    if (!firstWeekly) return;

    const profileId = track.profile_ids?.[0] ?? firstWeekly.profileId;
    const recommendedAgents = track.recommended_params?.num_agents ?? firstWeekly.numAgents;
    const recommendedRounds = track.recommended_params?.rounds ?? firstWeekly.rounds;

    const trackQuestion = clampScenarioQuestion(isZh ? firstWeekly.question : firstWeekly.questionEn);

    clearLaunchError();
    setQuestion(trackQuestion);
    setRounds(recommendedRounds);
    setNumAgents(recommendedAgents);
    setMode(firstWeekly.mode);
    setVizEnabled(firstWeekly.visualizationEnabled);

    try {
      await launchSimulation({
        nextQuestion: trackQuestion,
        nextRounds: recommendedRounds,
        nextAgents: recommendedAgents,
        nextMode: firstWeekly.mode,
        nextVisualization: firstWeekly.visualizationEnabled,
        challengeId: firstWeekly.id,
        campaignContext: {
          // Phase 2b: ISO YYYY-Wnn form required by backend CampaignContext.
          week_key: campaignChallengeRotation?.iso_week_key,
          weekly_track_id: track.id,
          profile_id: profileId,
          is_weekly_track: true,
        },
      });
    } catch (err) {
      console.error('[handleWeeklyTrackConfirm] failed:', err);
    }
  };

  const handleWeeklyTrackCancel = () => {
    setWeeklyTrackDialogOpen(false);
  };

  const requestLaunch = (q: string) => {
    clearLaunchError();
    const trimmed = normalizeScenarioQuestionForLaunch(q);
    if (!trimmed || isSubmitting || launchInFlightRef.current || isSimulationBudgetBlocked || llmNotConfigured) return;
    if (q.trim() !== trimmed) {
      setQuestion(trimmed);
    }
    setConfirmDialogData({ question: trimmed });
  };

  const confirmLaunch = () => {
    if (!confirmDialogData) return;
    const q = confirmDialogData.question;
    setConfirmDialogData(null);
    clearLaunchError();
    handleSubmit(q).catch((err) => {
      console.error('[confirmLaunch] failed:', err);
      const errMsg = getLocalizedApiErrorMessage(err, t, t('common.api_errors.simulation_start_failed'));
      setLaunchError(errMsg);
    });
  };

  const cancelLaunch = () => {
    setConfirmDialogData(null);
    // Defer focus restoration so Radix's focus-trap teardown does not race ahead.
    // Radix tries to restore focus to the original trigger; fall back to textarea
    // if Radix loses track (e.g. when the dialog opened via keyboard from textarea).
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) {
        questionRef.current?.focus();
      }
    });
  };

  const handleConfirmOpenChange = (open: boolean) => {
    if (!open) cancelLaunch();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (isComposingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
        return;
      }
      e.preventDefault();
      requestLaunch(question);
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
          families: selectedWebSearchFamilies,
          intensity: webSearchIntensity,
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
          user_id: apiUserId,
          total_runs: campaignProfile?.total_runs ?? 0,
          badge_count: campaignBadges.length,
          daily_profile_level: dailyMastery?.level ?? 0,
          daily_profile_score_to_next_level: dailyMastery?.score_to_next_level ?? null,
        },
        controls: {
          can_start_simulation: Boolean(question.trim()) && !isSubmitting && !isSimulationBudgetBlocked && !llmNotConfigured,
          can_start_debate: Boolean(question.trim()) && !isSubmitting && !llmNotConfigured,
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
    apiUserId,
    byokRequestsPerMinute,
    byokTokensPerMinute,
    isSimulationBudgetBlocked,
    disableUserQuota,
    testError,
    webSearchApiKey,
    webSearchBaseUrl,
    webSearchEnabled,
    webSearchIntensity,
    selectedWebSearchFamilies,
    webSearchMode,
    webSearchProvider,
    webSearchServerEnabled,
    webSearchServerProvider,
    webSearchStatus,
    webSearchUsesCustomOverride,
    llmNotConfigured,
  ]);



  return (
    <div className="input-view">
      {/* S1-5: First-visit onboarding guide. Suppressed while a launch is in
          progress so the loading overlay stays focused. */}
      <OnboardingGuide
        open={!onboarding.completed && !isSubmitting}
        onComplete={onboarding.complete}
      />
      {llmNotConfigured && <LlmNotConfiguredBanner />}
      {/* Loading Overlay */}
      {isSubmitting && (
        <div
          className="loading-overlay"
          role="status"
          aria-live="polite"
          aria-busy="true"
          aria-labelledby="loading-overlay-title"
          aria-describedby="loading-overlay-tip"
        >
          <div className="loading-overlay__card">
            <div className="loading-overlay__orbit">
              <span className="orbit-dot orbit-dot--1" />
              <span className="orbit-dot orbit-dot--2" />
              <span className="orbit-dot orbit-dot--3" />
            </div>
            <h2 id="loading-overlay-title" className="loading-overlay__title">{t('home.loading_title')}</h2>
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
            <p id="loading-overlay-tip" className="loading-overlay__tip">{t('home.loading_tip')}</p>
          </div>
        </div>
      )}

      <main className="input-view__content">
        <div className="input-view__form">
          <ProgressIndicator currentStep={1} />
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
                <nav className="input-view__nav">
                  <button className="btn btn-ghost" onClick={() => navigate('/history')}>
                    {t('home.history')}
                  </button>
                  {customAgentsEnabled && (
                    <button className="btn btn-ghost" onClick={() => navigate('/agents')}>
                      {t('home.agents', 'Agents')}
                    </button>
                  )}
                  {caps?.prediction_journal?.enabled && (
                    <button className="btn btn-ghost" onClick={() => navigate('/me/journal')}>
                      {t('journal.title')}
                    </button>
                  )}
                  {caps?.snapshot_export?.enabled && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setShowSnapshotImport(true)}
                    >
                      {t('snapshot.import_btn')}
                    </button>
                  )}
                  <button
                    className="btn btn-ghost"
                    onClick={() => navigate('/leaderboard')}
                    aria-label={t('home.leaderboard_button_label')}
                  >
                    🏆
                  </button>
                </nav>
              </div>
            </div>

            <div className="iv-hero__prompt">
              <div className="input-wrapper">
                <textarea
                  ref={questionRef}
                  className="input input--hero"
                  value={question}
                  onChange={(e) => {
                    clearLaunchError();
                    setQuestion(clampScenarioQuestion(e.target.value));
                  }}
                  onKeyDown={onKeyDown}
                  onCompositionStart={() => { isComposingRef.current = true; }}
                  onCompositionEnd={() => { isComposingRef.current = false; }}
                  placeholder={placeholder}
                  aria-label={t('home.question_input_label')}
                  disabled={isSubmitting}
                  autoFocus
                  rows={1}
                  maxLength={SCENARIO_QUESTION_MAX_LENGTH}
                />
              </div>
            </div>

            <div className="iv-hero__cta">
              <div className="input-view__submit-row">
                <button
                  className="btn btn-primary btn--submit"
                  onClick={() => requestLaunch(question)}
                  disabled={!question.trim() || isSubmitting || isSimulationBudgetBlocked || llmNotConfigured}
                >
                  {isSubmitting ? <span className="spinner spinner--sm" /> : null}
                  {multiRunCaps?.multi_run?.enabled && multiRunEnabled ? t('multi_run.launch_btn') : t('home.submit')}
                  {selectedCustomAgentCount > 0 && (
                    <>
                      <span className="iv-submit__badge" aria-hidden="true">
                        {selectedCustomAgentCount}
                      </span>
                      <span className="sr-only">
                        {t('agents.badge_count', { count: selectedCustomAgentCount })}
                      </span>
                    </>
                  )}
                </button>
                <button
                  className="btn btn-ghost btn--submit"
                  onClick={() => void launchDebate({ nextQuestion: question })}
                  disabled={!question.trim() || isSubmitting || llmNotConfigured}
                >
                  {t('debate.entry_cta')}
                </button>
                {educationTemplatesEnabled && (
                  <button
                    type="button"
                    className="btn btn-ghost btn--submit edu-template-trigger"
                    onClick={() => setEducationPickerOpen(true)}
                    disabled={isSubmitting}
                  >
                    {t('education.use_template')}
                  </button>
                )}
              </div>

              {/* 预算阻断警告：独立无条件呈现（不被输入/凭据原因抢占），恢复既有契约 */}
              {isSimulationBudgetBlocked && !isSubmitting && (
                <p className="byok-probe-warning" role="status" aria-live="polite" style={{ marginTop: '8px' }}>
                  {t('home.byok_budget_blocked')}
                </p>
              )}

              {/* 为什么现在不能开始的原因提示区（按优先级唯一显示一条；预算阻断已独立呈现） */}
              {(() => {
                if (isSubmitting) return null;
                if (isSimulationBudgetBlocked) return null;
                if (!question.trim()) {
                  return (
                    <div className="iv-hero__disabled-reason" role="status" aria-live="polite" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <p className="byok-probe-warning" style={{ margin: 0 }}>
                        💡 {t('home.disabled_reason_question')}
                      </p>
                    </div>
                  );
                }
                if (llmNotConfigured) {
                  return (
                    <div className="iv-hero__disabled-reason" role="status" aria-live="polite" style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <p className="byok-probe-warning" style={{ margin: 0 }}>
                        ⚠️ <span>{t('home.disabled_reason_llm')}</span>{' '}
                        <Link to="/admin/setup" style={{ textDecoration: 'underline', fontWeight: 600 }}>
                          {t('llm_banner.configure_cta')}
                        </Link>
                      </p>
                    </div>
                  );
                }
                return null;
              })()}

              {/* 提交错误就地呈现区 */}
              {launchError && !isSubmitting && (
                <div className="iv-hero__launch-error" role="alert" style={{ marginTop: '12px', padding: '0.75rem', border: '1px solid #f5c6cb', backgroundColor: '#fdf3f4', borderRadius: '6px', color: '#721c24', fontSize: '0.875rem', textAlign: 'left' }}>
                  ⚠️ {launchError}
                </div>
              )}

              {/* Task 1d: We implement onboarding final CTA -> setup by displaying a prominent warning banner
                  (LlmNotConfiguredBanner) at the top of InputView, and the degraded warning block below,
                  both pointing to /admin/setup, which will be visible after onboarding completes on first run
                  when llmNotConfigured. This avoids editing OnboardingGuide.tsx which is outside the WRITE SET. */}
              {llmNotConfigured && (
                <div className="degraded-llm-warning" style={{ marginTop: '12px', textAlign: 'left' }}>
                  <p className="byok-probe-warning" style={{ margin: '0 0 8px 0', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    <span>⚠️ {t('degraded_hints.llm_required')}</span>
                    <Link to="/admin/setup" style={{ textDecoration: 'underline', fontWeight: 600 }}>
                      {t('llm_banner.configure_cta')}
                    </Link>
                  </p>

                  <div className="degraded-demo-entry" style={{ padding: '12px', border: '1px dashed var(--color-border-default)', borderRadius: 'var(--radius-lg, 8px)', backgroundColor: 'var(--color-base, oklch(98% 0.005 80))' }}>
                    <p style={{ margin: '0 0 8px 0', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                      💡 {t('degraded_hints.sample_hint')}
                    </p>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setShowSnapshotImport(true)}
                      style={{ width: '100%', justifyContent: 'center' }}
                    >
                      📂 {t('degraded_hints.view_sample_result')}
                    </button>
                  </div>
                </div>
              )}
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
                    onChange={(e) => {
                      clearLaunchError();
                      setRounds(Number(e.target.value));
                    }}
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
                    onChange={(e) => {
                      clearLaunchError();
                      setNumAgents(Number(e.target.value));
                    }}
                    disabled={isSubmitting}
                />
              </div>
              <span className="agents-value">{numAgents}</span>
              <span className="agents-hint">
                {numAgents <= 10 ? t('home.agents_few') : numAgents <= 20 ? t('home.agents_standard') : numAgents <= 30 ? t('home.agents_large') : t('home.agents_extreme')}
              </span>
            </div>

            {/* Quick Start (moved up for first-run prominence) */}
            <div className="quick-start-section">
              {/* h2 (not h3) so the page heading outline stays continuous after
                  the h1 page title — avoids an h1 -> h3 skip. Visual style is
                  unchanged (same `section-title` class). */}
              <h2 className="section-title">{t('home.quick_starts')}</h2>
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

            {customAgentsEnabled && (
              <AgentSelectionStrip
                userId={apiUserId}
                visible={true}
                maxSelected={maxCustomAgents}
                onManageClick={() => setAgentDrawerOpen(true)}
              />
            )}

            {/* Web Search Enhancement: always visible */}
              <div className="web-search-section">
                <label
                  className={`web-search-toggle ${webSearchEnabled ? 'web-search-toggle--active' : ''} ${isSubmitting ? 'web-search-toggle--disabled' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={webSearchEnabled}
                      onChange={(e) => {
                        clearLaunchError();
                        const nextChecked = e.target.checked;
                        setWebSearchEnabled(nextChecked);
                      if (nextChecked && !webSearchServerEnabled) {
                        setWebSearchMode('custom_override');
                      }
                    }}
                    disabled={isSubmitting}
                    aria-describedby="ws-hint"
                  />
                  <span className="web-search-toggle__copy">
                    <strong>{t('home.web_search_toggle')}</strong>
                    <span id="ws-hint">{t('home.web_search_hint')}</span>
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
                            {t('home.web_search_server_default', { provider: friendlyProviderName(webSearchServerProvider, t) })}
                          </span>
                        )}
                      </div>
                    </div>
                    {webSearchMode === 'server_default' && webSearchServerEnabled ? (
                      <div className="web-search-summary" role="note">
                        <strong>{t('home.web_search_mode_server')}</strong>
                        <span>{t('home.web_search_server_summary', { provider: friendlyProviderName(webSearchServerProvider, t) ?? 'server' })}</span>
                                <button
                                  type="button"
                                  className="web-search-secondary-btn"
                                  onClick={() => {
                                    clearLaunchError();
                                    setWebSearchMode('custom_override');
                                  }}
                                  disabled={isSubmitting}
                        >
                          {t('home.web_search_change_provider')}
                        </button>
                      </div>
                    ) : (
                      <div className="web-search-fields">
                        <div className="web-search-mode-switch" role="group" aria-label={t('home.web_search_mode_label')}>
                          <button
                            type="button"
                              className={`web-search-mode-btn ${webSearchMode === 'server_default' ? 'web-search-mode-btn--active' : ''}`}
                              aria-pressed={webSearchMode === 'server_default'}
                              onClick={() => {
                                clearLaunchError();
                                setWebSearchMode('server_default');
                              }}
                              disabled={isSubmitting || !webSearchServerEnabled}
                          >
                            <span className="web-search-mode-btn__title">{t('home.web_search_mode_server')}</span>
                            <span className="web-search-mode-btn__hint">
                              {webSearchServerEnabled
                                ? t('home.web_search_mode_server_hint', { provider: friendlyProviderName(webSearchServerProvider, t) ?? 'server' })
                                : t('home.web_search_mode_server_unavailable')}
                            </span>
                          </button>
                          <button
                            type="button"
                              className={`web-search-mode-btn ${webSearchMode === 'custom_override' ? 'web-search-mode-btn--active' : ''}`}
                              aria-pressed={webSearchMode === 'custom_override'}
                              onClick={() => {
                                clearLaunchError();
                                setWebSearchMode('custom_override');
                              }}
                              disabled={isSubmitting}
                          >
                            <span className="web-search-mode-btn__title">{t('home.web_search_mode_custom')}</span>
                            <span className="web-search-mode-btn__hint">{t('home.web_search_mode_custom_hint')}</span>
                          </button>
                        </div>
                        <div className="web-search-grid">
                          <div className="byok-field web-search-field">
                            <label className="byok-label" htmlFor="web-search-provider">
                              {t('home.web_search_provider_label')}
                            </label>
                            <select
                              id="web-search-provider"
                                className="input byok-input web-search-select"
                                value={webSearchProvider}
                                onChange={(e) => {
                                  clearLaunchError();
                                  handleWebSearchProviderChange(e.target.value as 'tavily' | 'exa' | 'firecrawl' | 'xai' | 'searxng');
                                }}
                                disabled={isSubmitting}
                              aria-describedby="web-search-provider-capability-hint"
                            >
                              <option value="tavily">Tavily</option>
                              <option value="exa">Exa</option>
                              <option value="firecrawl">Firecrawl</option>
                              <option value="xai">xAI</option>
                              <option value="searxng">SearXNG</option>
                            </select>
                            <span className="web-search-field-help">{t('home.web_search_provider_hint')}</span>
                            {/* P4-2: per-provider capability hint. Renders a friendly
                                line explaining how each provider applies the
                                domain filter (e.g., API param vs site: syntax). */}
                            <span
                              id="web-search-provider-capability-hint"
                              className="iv-provider-hint"
                              data-testid="iv-provider-capability-hint"
                              data-provider={webSearchProvider}
                            >
                              {t(`home.web_search_provider_${webSearchProvider}_hint`, {
                                defaultValue:
                                  webSearchProvider === 'tavily'
                                    ? 'Domain filtering is supported.'
                                    : webSearchProvider === 'exa'
                                      ? 'Domain filtering is supported.'
                                      : webSearchProvider === 'firecrawl'
                                        ? 'API-backed search with domain filtering.'
                                        : webSearchProvider === 'xai'
                                          ? 'Domain filtering is supported (up to 5 domains).'
                                          : 'Self-hosted search. Filters via site: query syntax.',
                              })}
                            </span>
                          </div>
                          {customSearchUsesSearxng ? (
                            <div className="web-search-inline-note" role="note">
                              {t('home.web_search_searxng_no_key')}
                            </div>
                          ) : (
                            <div className="byok-field web-search-field">
                              <label className="byok-label" htmlFor="web-search-api-key">
                                {t('home.web_search_api_key_label')}
                              </label>
                              <input
                                id="web-search-api-key"
                                  type="password"
                                  className="input byok-input"
                                  value={webSearchApiKey}
                                  onChange={(e) => {
                                    clearLaunchError();
                                    setWebSearchApiKey(e.target.value);
                                  }}
                                  placeholder={t('home.web_search_api_key_placeholder')}
                                disabled={isSubmitting}
                              />
                              <span className="web-search-field-help">
                                {customSearchProviderMatchesServer
                                  ? t('home.web_search_api_key_hint_optional')
                                  : t('home.web_search_api_key_hint_required')}
                              </span>
                            </div>
                          )}
                          <div className="web-search-field web-search-field--full">
                            {!showCustomSearchEndpointField && (
                              <button
                                type="button"
                                className="web-search-secondary-btn web-search-secondary-btn--inline"
                                onClick={() => setShowWebSearchEndpoint(true)}
                                disabled={isSubmitting}
                              >
                                {t('home.web_search_custom_endpoint_toggle')}
                              </button>
                            )}
                            {showCustomSearchEndpointField && (
                              <div className="byok-field">
                                <label className="byok-label" htmlFor="web-search-base-url">
                                  {customSearchUsesSearxng
                                    ? t('home.web_search_searxng_url_label')
                                    : t('home.web_search_base_url_label')}
                                </label>
                                <input
                                  id="web-search-base-url"
                                  type="url"
                                  className="input byok-input"
                                  value={webSearchBaseUrl}
                                  onChange={(e) => {
                                    clearLaunchError();
                                    setWebSearchBaseUrl(e.target.value);
                                  }}
                                  placeholder={webSearchBaseUrlPlaceholder}
                                  disabled={isSubmitting}
                                  aria-invalid={!!webSearchUrlError || showUnknownEndpointWarning}
                                  aria-describedby={webSearchUrlError ? 'web-search-base-url-error' : undefined}
                                />
                                <span className="web-search-field-help">
                                  {customSearchUsesSearxng
                                    ? t('home.web_search_searxng_url_hint')
                                    : t('home.web_search_base_url_hint')}
                                </span>
                              </div>
                            )}
                            {/* P4-2: surface the provider we inferred from the
                                base_url host so the user can confirm the
                                override targets the expected backend. When the
                                host is unknown we tell them domain filter is
                                unavailable for this run. */}
                            {webSearchBaseUrl.trim() && (
                              <span
                                className="iv-provider-hint"
                                data-testid="iv-inferred-provider-hint"
                                data-inferred-provider={inferredCustomProvider ?? 'unknown'}
                              >
                                {inferredCustomProvider
                                  ? t('home.web_search_inferred_provider', {
                                      defaultValue: 'Detected provider: {{provider}}',
                                      provider: friendlyProviderName(inferredCustomProvider, t),
                                    })
                                  : t('home.web_search_inferred_provider_unknown', {
                                      defaultValue:
                                        'Could not detect provider from this base URL. Domain filtering will be disabled.',
                                    })}
                              </span>
                            )}
                            {showUnknownEndpointWarning && (
                              <span className="iv-provider-hint iv-provider-hint--warning" role="status">
                                {t('home.web_search_unknown_endpoint_warning')}
                              </span>
                            )}
                            {webSearchUrlError && (
                              <span
                                id="web-search-base-url-error"
                                className="text-xs text-red-500 mt-1"
                                role="alert"
                              >
                                {webSearchUrlError}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="web-search-native-note" role="note">
                      {t('home.web_search_native_hint')}
                    </div>
                  </div>
                )}
              </div>

            {/* Advanced Settings Accordion (source toggles + mode selectors) */}
            <div className="iv-advanced">
              <button
                type="button"
                className="iv-advanced__trigger"
                onClick={() => setAdvancedOpen((prev) => !prev)}
                aria-expanded={advancedOpen}
                aria-controls="iv-advanced-body"
              >
                <span>{t('home.advanced_settings')}</span>
                <span className="iv-config__arrow">{advancedOpen ? '▲' : '▼'}</span>
              </button>
              <div
                id="iv-advanced-body"
                className={`iv-advanced__body ${advancedOpen ? 'is-open' : ''}`}
                aria-hidden={!advancedOpen}
                inert={!advancedOpen || undefined}
                onFocusCapture={handleClosedAdvancedFocusCapture}
              >
                <div className="iv-advanced__inner">
                  {/* P4-2: warn the user when no provider is resolvable (no server
                      default + custom override base URL points at an unknown host).
                      Without a provider the source-family checkboxes cannot filter,
                      so we surface the issue rather than silently disabling them. */}
                  {webSearchEnabled && effectiveProviderCapability.source === 'unknown' && (
                    <div
                      className="iv-no-provider-warning"
                      role="status"
                      aria-live="polite"
                      data-testid="iv-no-provider-warning"
                    >
                      {t('home.web_search_no_provider_warning', {
                        defaultValue:
                          'No search provider is currently resolvable. Configure a server default or a recognized custom override to use source categories.',
                      })}
                    </div>
                  )}
                  {/* FE-5: 4 new source toggles (polymarket/finance/academic/news_deep) */}
                  <NewSourceToggles
                    polymarket={newSourceTogglePolymarket}
                    finance={newSourceToggleFinance}
                    academic={newSourceToggleAcademic}
                    newsDeep={newSourceToggleNewsDeep}
                    onChange={{
                      polymarket: setNewSourceTogglePolymarket,
                      finance: setNewSourceToggleFinance,
                      academic: setNewSourceToggleAcademic,
                      news_deep: setNewSourceToggleNewsDeep,
                    }}
                    disabled={isSubmitting}
                    searchEnabled={webSearchEnabled}
                    supportsDomainFilter={supportsDomainFilter}
                  />

                  {webSearchEnabled && (
                    <div className="mode-selector-wrap">
                      <div className="mode-selector">
                        <span className="mode-label">{t('home.web_search_intensity_label')}</span>
                        <div className="mode-options">
                          {([
                            { value: 'light', label: t('home.web_search_intensity_light') },
                            { value: 'standard', label: t('home.web_search_intensity_standard') },
                            { value: 'deep', label: t('home.web_search_intensity_deep') },
                          ] as const).map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              className={`mode-btn ${webSearchIntensity === opt.value ? 'mode-btn--active' : ''}`}
                              data-testid={`web-search-intensity-${opt.value}`}
                              aria-pressed={webSearchIntensity === opt.value}
                              onClick={() => setWebSearchIntensity(opt.value)}
                              disabled={isSubmitting}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <span className="mode-desc">
                        {t(`home.web_search_intensity_${webSearchIntensity}_desc`)}
                      </span>
                    </div>
                  )}

                  {/* ── Mode Selectors (inline with input area) ── */}
                  <div className="iv-mode-selectors">
                      {/* Mode Selector */}
                      <div className="mode-selector-wrap">
                        <div className="mode-selector">
                          <span className="mode-label">{t('home.mode_label')}</span>
                          <div className="mode-options">
                            <button
                              type="button"
                                className={`mode-btn ${mode === 'blackboard' ? 'mode-btn--active' : ''}`}
                                aria-pressed={mode === 'blackboard'}
                                onClick={() => {
                                  clearLaunchError();
                                  setMode('blackboard');
                                }}
                                disabled={isSubmitting}
                              title={t('home.mode_blackboard_title')}
                            >
                              📋 {t('home.mode_blackboard')}
                            </button>
                            <button
                              type="button"
                                className={`mode-btn ${mode === 'raw' ? 'mode-btn--active' : ''}`}
                                aria-pressed={mode === 'raw'}
                                onClick={() => {
                                  clearLaunchError();
                                  setMode('raw');
                                }}
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
                                aria-pressed={!vizEnabled}
                                onClick={() => {
                                  clearLaunchError();
                                  setVizEnabled(false);
                                }}
                                disabled={isSubmitting}
                            >
                              📊 {t('home.viz_classic')}
                            </button>
                            <button
                                type="button"
                                className={`mode-btn ${vizEnabled ? 'mode-btn--active' : ''}`}
                                aria-pressed={vizEnabled}
                                onClick={() => {
                                  clearLaunchError();
                                  setVizEnabled(true);
                                }}
                                disabled={isSubmitting}
                            >
                              🎬 {t('home.viz_theater')}
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* F2: Multi-Run Mode Toggle */}
                      {multiRunCapError ? (
                        <div className="mode-selector-wrap mode-selector-wrap--error" style={{ padding: '0.75rem', border: '1px solid #f5c6cb', backgroundColor: '#fdf3f4', borderRadius: '6px', fontSize: '0.85rem', color: '#721c24', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                          <span>{t('common.capability_error')}</span>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            style={{ backgroundColor: '#ffffff', border: '1px solid #c61583', color: '#c61583', padding: '0.25rem 0.5rem', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem' }}
                            onClick={() => {
                              if (reloadMultiRunCap) {
                                void reloadMultiRunCap();
                              }
                            }}
                            aria-label={t('common.retry')}
                          >
                            {t('common.retry')}
                          </button>
                        </div>
                      ) : (
                        multiRunCaps?.multi_run && (
                          <div className="mode-selector-wrap" data-testid="multi-run-mode-wrap">
                            <div className="mode-selector">
                              <span className="mode-label">{t('multi_run.input_label')}</span>
                              {multiRunCaps.multi_run.enabled ? (
                                <div className="mode-options">
                                  <button
                                    type="button"
                                    className={`mode-btn ${!multiRunEnabled ? 'mode-btn--active' : ''}`}
                                    aria-pressed={!multiRunEnabled}
                                    onClick={() => setMultiRunEnabled(false)}
                                    disabled={isSubmitting}
                                  >
                                    ⚡ {t('home.viz_classic')}
                                  </button>
                                  <button
                                    type="button"
                                    className={`mode-btn ${multiRunEnabled ? 'mode-btn--active' : ''}`}
                                    aria-pressed={multiRunEnabled}
                                    onClick={() => setMultiRunEnabled(true)}
                                    disabled={isSubmitting}
                                  >
                                    🌀 {t('multi_run.input_section_title')}
                                  </button>
                                </div>
                              ) : (
                                <div className="multi-run-disabled-hint" style={{ color: '#7a756b', fontSize: '0.85rem', fontStyle: 'italic' }}>
                                  {t('multi_run.capability_disabled')}
                                </div>
                              )}
                            </div>
                            {multiRunCaps.multi_run.enabled && multiRunEnabled && (
                              <div className="multi-run-count-selector" style={{ marginTop: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <input
                                  type="number"
                                  min={1}
                                  max={multiRunMaxCount}
                                  value={multiRunCount}
                                  onChange={(e) => {
                                    const val = parseInt(e.target.value, 10);
                                    if (Number.isInteger(val)) {
                                      setMultiRunCount(Math.max(1, Math.min(multiRunMaxCount, val)));
                                    }
                                  }}
                                  disabled={isSubmitting}
                                  className="form-control"
                                  style={{ width: '80px', padding: '0.25rem 0.5rem', border: '1px solid #e6dfd5', borderRadius: '4px' }}
                                />
                                <span style={{ fontSize: '0.85rem', color: '#524e47' }}>
                                  {t('multi_run.reminder_runs', { count: multiRunCount })} (max: {multiRunMaxCount})
                                </span>
                              </div>
                            )}
                          </div>
                        )
                      )}

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
                                  aria-pressed={reasoningEffort === opt.value}
                                  onClick={() => {
                                    clearLaunchError();
                                    setReasoningEffort(opt.value);
                                  }}
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
                                aria-pressed={runtimePreset === preset}
                                onClick={() => {
                                  clearLaunchError();
                                  setRuntimePreset(preset);
                                }}
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
                  </div>

                  <div className="iv-advanced__divider" style={{ margin: '16px 0', borderTop: '1px solid rgba(64, 48, 40, 0.08)' }} />

                  <DocumentSeedPanel
                    worldContext={worldContext}
                    setWorldContext={setWorldContext}
                    agentsPreview={agentsPreview}
                    setAgentsPreview={setAgentsPreview}
                  />

                  <div className="iv-advanced__divider" style={{ margin: '16px 0', borderTop: '1px solid rgba(64, 48, 40, 0.08)' }} />

                  <LocalPackPicker onImport={handleImportPack} />
                </div>
              </div>
            </div>
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
            <section className="daily-challenge-card" onClick={handleDailyCardClick} style={{ cursor: 'pointer' }}>
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
                <strong className="daily-challenge-card__title" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {todayChallengeQuestion}
                  {todayChallengeProgress?.current_streak !== undefined && (
                    <StreakIndicator streak={todayChallengeProgress.current_streak} />
                  )}
                </strong>
                <span className="daily-challenge-card__subtitle" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <DifficultyBadge difficulty={todayChallenge.difficulty_tier} />
                  <span>{isZh ? todayChallenge.subtitleZh : todayChallenge.subtitleEn}</span>
                </span>
                <div className="daily-challenge-card__hooks" aria-label={t('common.theme_hooks_aria')}>
                  <span className="daily-challenge-card__pill daily-challenge-card__pill--profile">
                    {challengeProfileLabel}
                  </span>
                  {challengeHooks.slice(0, 2).map((hook) => (
                    <span key={hook} className="daily-challenge-card__pill">
                      {hook}
                    </span>
                  ))}
                </div>
                {todayChallengeProgress && (
                  <div className="daily-challenge-card__status">
                    <span className={`daily-challenge-card__pill ${todayChallengeProgress.completed ? 'daily-challenge-card__pill--done' : ''}`}>
                      {todayChallengeProgress.completed
                        ? `✓ ${t('campaign.daily_completed')}`
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
                <RefreshCountdown nextRefreshAt={todayChallengeProgress?.next_refresh_at} />
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
                {campaignChallengeRotation.weekly_track && (
                  <div className="weekly-track-chip-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }}>
                    <WeeklyTrackChip
                      track={campaignChallengeRotation.weekly_track}
                      active={campaignWeeklySummary?.weekly_track_id === campaignChallengeRotation.weekly_track.id}
                      onClick={handleWeeklyChipClick}
                    />
                  </div>
                )}
                <div className="daily-challenge-card__status">
                  {campaignWeeklySummary && (
                    <span className="daily-challenge-card__pill">
                      {t('home.weekly_challenge_completed_runs', { runs: campaignWeeklySummary.total_runs })}
                      {' · '}
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

            <section
              className={`weekly-challenge-card weekly-challenge-card--growth${
                hasDirectorGrowth ? ' iv-growth-button' : ''
              }`}
              {...(hasDirectorGrowth
                ? {
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => setCampaignSheetOpen(true),
                    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setCampaignSheetOpen(true);
                      }
                    },
                    'aria-label': t('campaign_sheet.open_aria', {
                      defaultValue: 'Open progress details',
                    }),
                    'aria-describedby': 'director-growth-summary',
                  }
                : {})}
            >
              <div className="weekly-challenge-card__side">
                <img
                  className="weekly-challenge-card__badge-art"
                  src={getGameplayBadgeSrc('archive_record')}
                  alt=""
                  aria-hidden="true"
                />
              </div>
              <div className="weekly-challenge-card__copy">
                {hasDirectorGrowth && (
                  <span id="director-growth-summary" className="sr-only">
                    {t('campaign_sheet.open_summary', {
                      runs: campaignProfile?.total_runs ?? 0,
                      badges: campaignBadges.length,
                      defaultValue: '{{runs}} total runs; {{badges}} badges unlocked.',
                    })}
                  </span>
                )}
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
                        {getGameplayProfileLabel(mastery.profile_id, isZh)}
                        {' · '}
                        {t('home.campaign_mastery_level', { level: mastery.level })}
                      </span>
                    ))}
                  </div>
                )}
                {hasDirectorGrowth && (
                  <span className="daily-challenge-card__pill iv-growth-cta">
                    {t('campaign_sheet.open_cta', { defaultValue: 'View full progress →' })}
                  </span>
                )}
              </div>
            </section>
          </div>

          {/* ── Collapsible BYOK ── */}
          <div className="iv-config">
            <button
              type="button"
              className="iv-config__trigger"
              onClick={() => setIsConfigOpen((prev) => !prev)}
              aria-expanded={isConfigOpen}
              aria-controls="iv-config-body"
            >
              {t('home.byok_toggle')}
              {' '}
              {isConfigOpen ? '▲' : '▼'}
            </button>
            <div
              id="iv-config-body"
              className={`iv-config__body ${isConfigOpen ? 'is-open' : ''}`}
              aria-hidden={!isConfigOpen}
              inert={!isConfigOpen || undefined}
              onFocusCapture={handleClosedConfigFocusCapture}
            >
              <div className="iv-config__inner">
                {/* P4-E: BYOK — Bring Your Own Key */}
                <div className="byok-section">
                    <div className="byok-fields">
                      {isConfigOpen && (modelProfilesError ? (
                        <div className="model-profiles-cap-error" role="alert" style={{ marginBottom: '1rem', padding: '0.75rem', border: '1px solid #f5c6cb', backgroundColor: '#fdf3f4', borderRadius: '6px', color: '#721c24', display: 'flex', flexDirection: 'column', gap: '0.5rem', gridColumn: '1 / -1' }}>
                          <strong>{t('common.capability_error_title')}</strong>
                          <span>{t('common.capability_error')}</span>
                          {reloadModelProfilesCap && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              style={{ backgroundColor: '#ffffff', border: '1px solid #c61583', color: '#c61583', padding: '0.25rem 0.5rem', borderRadius: '4px', cursor: 'pointer', fontSize: '0.8rem', alignSelf: 'flex-start' }}
                              onClick={() => void reloadModelProfilesCap()}
                              aria-label={t('common.retry')}
                            >
                              {t('common.retry')}
                            </button>
                          )}
                        </div>
                      ) : !modelProfilesEnabled ? (
                        <div className="model-profiles-disabled" style={{ marginBottom: '1rem', padding: '0.75rem', backgroundColor: '#f8f9fa', borderRadius: '6px', color: '#6c757d', gridColumn: '1 / -1' }}>
                          <span>{t('model_profiles.disabled_hint')}</span>
                        </div>
                      ) : (
                        <div className="model-profile-selectors-section" style={{ gridColumn: '1 / -1', marginBottom: '1.5rem', borderBottom: '1px solid rgba(64, 48, 40, 0.08)', paddingBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                          <div className="byok-field">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                              <label className="byok-label" htmlFor="scenario-profile-select" style={{ marginBottom: 0 }}>{t('model_profiles.title')}</label>
                              <Link
                                to="/model-profiles"
                                className="agent-link"
                                style={{ fontSize: '0.85rem' }}
                                data-testid="manage-profiles-link"
                              >
                                {t('model_profiles.manage_link', 'Manage model profiles')}
                              </Link>
                            </div>
                            <span className="byok-field-help">{t('model_profiles.placeholder_select')}</span>
                            <select
                              id="scenario-profile-select"
                              className="form-control"
                              value={selectedProfileId}
                              onChange={(e) => handleProfileChange(e.target.value)}
                              disabled={isSubmitting}
                              style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border-color, #e6dfd5)' }}
                            >
                              <option value="">{t('model_profiles.byok_custom_option')}</option>
                              {profiles.map((p) => (
                                <option key={p.id} value={p.id}>{p.name} ({p.provider} - {p.model})</option>
                              ))}
                            </select>
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                            <div className="byok-field">
                              <label className="byok-label" htmlFor="debate-prop-profile">{t('model_profiles.label_proposition')}</label>
                              <select
                                  id="debate-prop-profile"
                                  className="form-control"
                                  value={propositionProfileId}
                                  onChange={(e) => {
                                    clearLaunchError();
                                    setPropositionProfileId(e.target.value);
                                  }}
                                  disabled={isSubmitting}
                                style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border-color, #e6dfd5)' }}
                              >
                                <option value="">{t('model_profiles.byok_custom_option')}</option>
                               {profiles.map((p) => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </select>
                            </div>
                            <div className="byok-field">
                              <label className="byok-label" htmlFor="debate-opp-profile">{t('model_profiles.label_opposition')}</label>
                              <select
                                  id="debate-opp-profile"
                                  className="form-control"
                                  value={oppositionProfileId}
                                  onChange={(e) => {
                                    clearLaunchError();
                                    setOppositionProfileId(e.target.value);
                                  }}
                                  disabled={isSubmitting}
                                style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border-color, #e6dfd5)' }}
                              >
                                <option value="">{t('model_profiles.byok_custom_option')}</option>
                                {profiles.map((p) => (
                                  <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div className="byok-field">
                            <label className="byok-label" htmlFor="debate-judge-profile">{t('model_profiles.label_judge')}</label>
                            <select
                                id="debate-judge-profile"
                                className="form-control"
                                value={judgeProfileId}
                                onChange={(e) => {
                                  clearLaunchError();
                                  setJudgeProfileId(e.target.value);
                                }}
                                disabled={isSubmitting}
                              style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border-color, #e6dfd5)' }}
                            >
                              <option value="">{t('model_profiles.option_none_default')}</option>
                              {profiles.map((p) => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ))}

                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-key">
                          {t('home.byok_api_key_label')}
                          {isApiKeyOverridden && <span className="override-badge" style={{ marginLeft: '8px', fontSize: '0.75rem', color: '#f59e0b', fontWeight: 500 }}>({t('model_profiles.overridden')})</span>}
                        </label>
                        <span className="byok-field-help">{t('home.byok_api_key_help')}</span>
                        <input
                          id="byok-key"
                            type="password"
                            className="input byok-input"
                            value={llmApiKey}
                            onChange={(e) => {
                              clearLaunchError();
                              setLlmApiKey(e.target.value);
                            }}
                            placeholder="sk-..."
                          disabled={isSubmitting}
                          autoComplete="off"
                        />
                      </div>
                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-url">
                          {t('home.byok_base_url_label')}
                          {isBaseUrlOverridden && <span className="override-badge" style={{ marginLeft: '8px', fontSize: '0.75rem', color: '#f59e0b', fontWeight: 500 }}>({t('model_profiles.overridden')})</span>}
                        </label>
                        <span className="byok-field-help">{t('home.byok_base_url_help')}</span>
                        <input
                          id="byok-url"
                            type="url"
                            className="input byok-input"
                            value={llmBaseUrl}
                            onChange={(e) => {
                              clearLaunchError();
                              setLlmBaseUrl(e.target.value);
                            }}
                            placeholder="https://api.openai.com/v1/chat/completions"
                          disabled={isSubmitting}
                        />
                      </div>
                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-model">
                          {t('home.byok_model_label')}
                          {isModelOverridden && <span className="override-badge" style={{ marginLeft: '8px', fontSize: '0.75rem', color: '#f59e0b', fontWeight: 500 }}>({t('model_profiles.overridden')})</span>}
                        </label>
                        <span className="byok-field-help">{t('home.byok_model_help')}</span>
                        <ModelSelect
                          inputId="byok-model"
                          inputClassName="input byok-input"
                            baseUrl={llmBaseUrl}
                            apiKey={llmApiKey}
                            value={llmModel}
                            onChange={(nextModel) => {
                              clearLaunchError();
                              setLlmModel(nextModel);
                            }}
                            disabled={isSubmitting}
                        />
                      </div>
                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-rpm">
                          {t('home.byok_rpm_label')}
                          {isRpmOverridden && <span className="override-badge" style={{ marginLeft: '8px', fontSize: '0.75rem', color: '#f59e0b', fontWeight: 500 }}>({t('model_profiles.overridden')})</span>}
                        </label>
                        <span className="byok-field-help">{t('home.byok_rpm_help')}</span>
                        <input
                          id="byok-rpm"
                          type="number"
                          min="1"
                            step="1"
                            className="input byok-input"
                            value={llmRequestsPerMinute}
                            onChange={(e) => {
                              clearLaunchError();
                              setLlmRequestsPerMinute(e.target.value);
                            }}
                            placeholder="10"
                          disabled={isSubmitting}
                          inputMode="numeric"
                        />
                      </div>
                      <div className="byok-field">
                        <label className="byok-label" htmlFor="byok-tpm">
                          {t('home.byok_tpm_label')}
                          {isTpmOverridden && <span className="override-badge" style={{ marginLeft: '8px', fontSize: '0.75rem', color: '#f59e0b', fontWeight: 500 }}>({t('model_profiles.overridden')})</span>}
                        </label>
                        <span className="byok-field-help">{t('home.byok_tpm_help')}</span>
                        <input
                          id="byok-tpm"
                          type="number"
                          min="1"
                            step="1"
                            className="input byok-input"
                            value={llmTokensPerMinute}
                            onChange={(e) => {
                              clearLaunchError();
                              setLlmTokensPerMinute(e.target.value);
                            }}
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
                </div>
              </div>
            </div>
          </div>

          <div className="input-view__submit-hints">
            {multiRunCaps?.multi_run?.enabled && multiRunEnabled ? (
              <p className="input-view__submit-hint" data-testid="multi-run-estimate-hint">
                {t('multi_run.reminder_runs', { count: multiRunCount })}
              </p>
            ) : (
              <p className="input-view__submit-hint">{simulationEtaHint}</p>
            )}
            <p className="input-view__submit-hint">{t('debate.entry_hint')}</p>
          </div>
          {submitError && !isSubmitting && (
            submitErrorCode && [
              'LLM_UNREACHABLE',
              'LLM_AUTH_FAILED',
              'LLM_MODEL_NOT_FOUND',
              'LLM_RATE_LIMITED'
            ].includes(submitErrorCode) ? (
              <LlmErrorHint code={submitErrorCode} />
            ) : (
              <span className="byok-test-error" role="alert">{submitError}</span>
            )
          )}
          {continuityError && !isSubmitting && (
            <span className="byok-test-error" role="alert">{continuityError}</span>
          )}

          <p className="iv-security-notice">{t('home.security_notice')}</p>

          {campaignChallengeRotation?.weekly_track && (
            <WeeklyTrackDialog
              track={campaignChallengeRotation.weekly_track}
              open={weeklyTrackDialogOpen}
              onConfirm={handleWeeklyTrackConfirm}
              onCancel={handleWeeklyTrackCancel}
            />
          )}

          <CampaignProgressSheet
            open={campaignSheetOpen}
            onOpenChange={setCampaignSheetOpen}
            userId={apiUserId}
            weeklySummary={campaignWeeklySummary}
            weeklyTrackName={
              campaignChallengeRotation?.weekly_track
                ? (isZh
                    ? campaignChallengeRotation.weekly_track.title_zh
                    : campaignChallengeRotation.weekly_track.title_en) ?? null
                : null
            }
          />


          <AlertDialog
            open={!!confirmDialogData}
            onOpenChange={handleConfirmOpenChange}
          >
            <AlertDialogContent
              className="confirm-launch"
              overlayClassName="confirm-launch-backdrop"
              onOverlayClick={cancelLaunch}
              role="dialog"
              aria-modal="true"
              aria-label={multiRunCaps?.multi_run?.enabled && multiRunEnabled ? t('multi_run.launch_btn') : t('home.confirm_launch_title')}
              onClick={(event) => event.stopPropagation()}
            >
              <AlertDialogHeader className="confirm-launch__header">
                <AlertDialogTitle asChild>
                  <h3>{multiRunCaps?.multi_run?.enabled && multiRunEnabled ? t('multi_run.launch_btn') : t('home.confirm_launch_title')}</h3>
                </AlertDialogTitle>
              </AlertDialogHeader>
              <div className="confirm-launch__body">
                <p className="confirm-launch__question">
                  {confirmDialogData?.question ?? ''}
                </p>
                <AlertDialogDescription
                  className="confirm-launch__settings"
                >
                  {multiRunCaps?.multi_run?.enabled && multiRunEnabled ? (
                    <>
                      {t('multi_run.reminder_runs', { count: multiRunCount })}
                      {' · '}
                      {t('home.confirm_launch_settings', {
                        rounds,
                        agents: numAgents,
                        mode: t(mode === 'blackboard' ? 'home.mode_blackboard' : 'home.mode_raw'),
                      })}
                    </>
                  ) : (
                    t('home.confirm_launch_settings', {
                      rounds,
                      agents: numAgents,
                      mode: t(mode === 'blackboard' ? 'home.mode_blackboard' : 'home.mode_raw'),
                    })
                  )}
                </AlertDialogDescription>
              </div>
              <AlertDialogFooter className="confirm-launch__footer">
                <AlertDialogCancel
                  className="btn btn-ghost"
                  onClick={cancelLaunch}
                >
                  {t('common.cancel')}
                </AlertDialogCancel>
                <AlertDialogAction
                  className="btn btn-primary"
                  onClick={confirmLaunch}
                  autoFocus
                >
                  {multiRunCaps?.multi_run?.enabled && multiRunEnabled ? t('multi_run.launch_btn') : t('home.submit')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {isContinuityDialogOpen && (
            <div className="continuity-dialog-backdrop" role="presentation">
              <div
                ref={continuityDialogRef}
                className="continuity-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={continuityCopy.title}
                tabIndex={-1}
                onKeyDown={handleContinuityDialogKeyDown}
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
      </main>
      <SnapshotImportDialog
        isOpen={showSnapshotImport}
        onClose={() => setShowSnapshotImport(false)}
        onImported={(scenarioId) => {
          setShowSnapshotImport(false);
          navigate(`/result/${encodeURIComponent(scenarioId)}`);
        }}
      />
      {customAgentsEnabled && (
        <AgentDrawer
          open={agentDrawerOpen}
          onOpenChange={setAgentDrawerOpen}
          userId={apiUserId}
          maxSelected={maxCustomAgents}
        />
      )}
      {educationTemplatesEnabled && (
        <EducationTemplatePicker
          open={educationPickerOpen}
          onClose={() => setEducationPickerOpen(false)}
          onSelect={handleEducationTemplateSelect}
        />
      )}
    </div>
  );
}
