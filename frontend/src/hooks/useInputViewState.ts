import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  getCapabilities,
  getCampaignBadges,
  getCampaignChallengeRotation,
  getCampaignDailyChallengeStatus,
  getCampaignMastery,
  getCampaignProfile,
  getCampaignWeeklySummary,
  type LlmProbeResponse,
  testLlmConnection,
} from '../api/client';
import { getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { readSharedChallengePayload } from '../lib/challengeShare';
import {
  challengeDateKey,
  getChallengeProgress,
  resolveChallengeProgress,
} from '../lib/dailyChallenge';
import {
  loadLlmProviderPolicy,
  saveLlmProviderPolicy,
} from '../lib/llmProviderPolicy';
import type { GameplayProfileId } from '../components/gameplayCards';
import type {
  CampaignBadge,
  CampaignChallengeRotation,
  CampaignDailyChallengeStatus,
  CampaignMastery,
  CampaignProfileSummary,
  CampaignWeeklySummary,
} from '../types';

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;
type WebSearchProviderOption = 'tavily' | 'exa' | 'xai' | 'searxng';
type WebSearchMode = 'server_default' | 'custom_override';

export interface NormalizedChallengeDefinition {
  id: string;
  question: string;
  questionEn: string;
  subtitleZh: string;
  subtitleEn: string;
  profileId: GameplayProfileId;
  rounds: number;
  numAgents: number;
  mode: 'blackboard' | 'raw';
  visualizationEnabled: boolean;
}

function normalizeChallengeDefinition(
  challenge: CampaignChallengeRotation['today_challenge'],
): NormalizedChallengeDefinition {
  return {
    id: challenge.id,
    question: challenge.question,
    questionEn: challenge.question_en ?? challenge.question,
    subtitleZh: challenge.subtitle_zh,
    subtitleEn: challenge.subtitle_en,
    profileId: challenge.profile_id as GameplayProfileId,
    rounds: challenge.rounds,
    numAgents: challenge.num_agents,
    mode: challenge.mode,
    visualizationEnabled: challenge.visualization_enabled,
  };
}

function formatOptionalIntegerInput(value: number | null): string {
  return value == null ? '' : String(value);
}

function parseOptionalIntegerInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  return normalized < 0 ? null : normalized;
}

export function useInputByokSettings(t: TranslateFn) {
  const [initialProviderPolicy] = useState(() => loadLlmProviderPolicy());
  const [showByok, setShowByok] = useState(() => Boolean(
    initialProviderPolicy.apiKey
    || initialProviderPolicy.baseUrl
    || initialProviderPolicy.model
    || initialProviderPolicy.requestsPerMinute != null
    || initialProviderPolicy.tokensPerMinute != null
    || initialProviderPolicy.disableUserQuota
  ));
  const [llmApiKey, setLlmApiKey] = useState(() => initialProviderPolicy.apiKey);
  const [llmBaseUrl, setLlmBaseUrl] = useState(() => initialProviderPolicy.baseUrl);
  const [llmModel, setLlmModel] = useState(() => initialProviderPolicy.model);
  const [llmRequestsPerMinute, setLlmRequestsPerMinute] = useState(
    () => formatOptionalIntegerInput(initialProviderPolicy.requestsPerMinute),
  );
  const [llmTokensPerMinute, setLlmTokensPerMinute] = useState(
    () => formatOptionalIntegerInput(initialProviderPolicy.tokensPerMinute),
  );
  const [disableUserQuota, setDisableUserQuota] = useState(() => initialProviderPolicy.disableUserQuota);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testError, setTestError] = useState('');
  const [probeResult, setProbeResult] = useState<LlmProbeResponse | null>(null);
  const [testedConfigKey, setTestedConfigKey] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState(() => initialProviderPolicy.reasoningEffort);
  const providerPolicyHydrated = useRef(true);

  // Web Search Enhancement: opt-in toggle
  // Visibility = compile-time flag (VITE_ENABLE_WEB_SEARCH) + server hint
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [webSearchServerEnabled, setWebSearchServerEnabled] = useState(false);
  const [webSearchServerProvider, setWebSearchServerProvider] = useState<string | null>(null);
  const [webSearchModePreference, setWebSearchModePreference] = useState<WebSearchMode>('server_default');
  const [webSearchProvider, setWebSearchProvider] = useState<WebSearchProviderOption>('tavily');
  const [webSearchApiKey, setWebSearchApiKey] = useState('');
  const [webSearchBaseUrl, setWebSearchBaseUrl] = useState('');
  const webSearchApiKeyRef = useRef(webSearchApiKey);
  const webSearchBaseUrlRef = useRef(webSearchBaseUrl);
  const [webSearchStatus, setWebSearchStatus] = useState<
    'idle' | 'searching' | 'success' | 'skipped' | 'error'
  >('idle');
  const viteFlagEnabled = (import.meta.env?.VITE_ENABLE_WEB_SEARCH as string | undefined) === 'true';

  useEffect(() => {
    webSearchApiKeyRef.current = webSearchApiKey;
    webSearchBaseUrlRef.current = webSearchBaseUrl;
  }, [webSearchApiKey, webSearchBaseUrl]);

  // On mount: check server web search capability via lightweight GET /api/capabilities
  // (no LLM call — pure config check). Retries once after 3s on failure.
  useEffect(() => {
    if (!viteFlagEnabled) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchHint = () =>
      getCapabilities()
        .then((res) => {
          if (cancelled) return;
          setWebSearchServerEnabled(res.web_search?.server_enabled === true);
          const serverProvider = res.web_search?.provider;
          setWebSearchServerProvider(typeof serverProvider === 'string' ? serverProvider : null);
          if (
            (serverProvider === 'tavily' || serverProvider === 'exa' || serverProvider === 'xai' || serverProvider === 'searxng')
            && !webSearchApiKeyRef.current.trim()
            && !webSearchBaseUrlRef.current.trim()
          ) {
            setWebSearchProvider(serverProvider);
          }
        });
    fetchHint().catch(() => {
      retryTimer = setTimeout(() => {
        if (!cancelled) fetchHint().catch(() => {});
      }, 3000);
    });
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [viteFlagEnabled]);
  const webSearchMode = webSearchEnabled && !webSearchServerEnabled
    ? 'custom_override'
    : webSearchModePreference;

  const currentConfigKey = useMemo(
    () => JSON.stringify({
      apiKey: llmApiKey.trim(),
      baseUrl: llmBaseUrl.trim(),
      model: llmModel.trim(),
    }),
    [llmApiKey, llmBaseUrl, llmModel],
  );

  useEffect(() => {
    if (!providerPolicyHydrated.current) return;
    saveLlmProviderPolicy({
      apiKey: llmApiKey,
      baseUrl: llmBaseUrl,
      model: llmModel,
      requestsPerMinute: parseOptionalIntegerInput(llmRequestsPerMinute),
      tokensPerMinute: parseOptionalIntegerInput(llmTokensPerMinute),
      disableUserQuota,
      reasoningEffort,
    });
  }, [
    disableUserQuota,
    llmApiKey,
    llmBaseUrl,
    llmModel,
    llmRequestsPerMinute,
    llmTokensPerMinute,
    reasoningEffort,
  ]);

  const hasStaleProbe = testedConfigKey !== '' && testedConfigKey !== currentConfigKey;
  const visibleTestStatus = hasStaleProbe ? 'idle' : testStatus;
  const visibleTestError = hasStaleProbe ? '' : testError;
  const visibleProbeResult = hasStaleProbe ? null : probeResult;

  const handleTestConnection = useCallback(async () => {
    setTestStatus('testing');
    setTestError('');
    try {
      const res = await testLlmConnection(
        llmApiKey || undefined,
        llmBaseUrl || undefined,
        llmModel || undefined,
        parseOptionalIntegerInput(llmRequestsPerMinute) ?? undefined,
        parseOptionalIntegerInput(llmTokensPerMinute) ?? undefined,
      );
      // Capture server-level web search hint (scope: server, NOT per-provider)
      setWebSearchServerEnabled(res.web_search?.server_enabled === true);

      if (res.llm.status === 'ok') {
        setTestStatus('ok');
        setProbeResult(res.probe ?? null);
        setTestedConfigKey(currentConfigKey);
        return { ok: true as const, probe: res.probe ?? null };
      } else {
        setTestStatus('fail');
        setTestError(res.llm.error || 'Unknown error');
      }
    } catch (err) {
      setTestStatus('fail');
      setTestError(
        getLocalizedApiErrorMessage(
          err,
          t,
          t('common.api_errors.llm_unavailable'),
          {
            LLM_TEMPORARILY_UNAVAILABLE: 'common.api_errors.llm_unavailable',
            LLM_GENERATION_FAILED: 'common.api_errors.llm_generation_failed',
          },
        ),
      );
    }
    window.setTimeout(() => setTestStatus('idle'), 5000);
    return { ok: false as const, probe: null };
  }, [currentConfigKey, llmApiKey, llmBaseUrl, llmModel, llmRequestsPerMinute, llmTokensPerMinute, t]);

  return {
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
    testStatus: visibleTestStatus,
    testError: visibleTestError,
    probeResult: visibleProbeResult,
    hasFreshProbe: Boolean(visibleProbeResult) && testedConfigKey === currentConfigKey && visibleTestStatus !== 'fail',
    reasoningEffort,
    setReasoningEffort,
    handleTestConnection,
    webSearchEnabled,
    setWebSearchEnabled,
    webSearchServerEnabled,
    webSearchServerProvider,
    webSearchMode,
    setWebSearchMode: setWebSearchModePreference,
    webSearchProvider,
    setWebSearchProvider,
    webSearchApiKey,
    setWebSearchApiKey,
    webSearchBaseUrl,
    setWebSearchBaseUrl,
    webSearchStatus,
    setWebSearchStatus,
    webSearchAvailable: viteFlagEnabled,
  };
}

export function useInputCampaignState({
  directorUserId,
}: {
  directorUserId: string;
}) {
  const localDate = challengeDateKey();
  const [campaignProfile, setCampaignProfile] = useState<CampaignProfileSummary | null>(null);
  const [campaignMastery, setCampaignMastery] = useState<CampaignMastery[]>([]);
  const [campaignBadges, setCampaignBadges] = useState<CampaignBadge[]>([]);
  const [campaignDailyStatus, setCampaignDailyStatus] = useState<CampaignDailyChallengeStatus | null>(null);
  const [campaignWeeklySummary, setCampaignWeeklySummary] = useState<CampaignWeeklySummary | null>(null);
  const [campaignChallengeRotation, setCampaignChallengeRotation] = useState<CampaignChallengeRotation | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const loadChallengeRotation = async () => {
      const rotation = await getCampaignChallengeRotation(localDate, 3, {
        signal: controller.signal,
      }).catch(() => null);
      if (cancelled) return;
      setCampaignChallengeRotation(rotation);
    };

    void loadChallengeRotation();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [localDate]);

  const todayChallenge = useMemo(
    () => (campaignChallengeRotation
      ? normalizeChallengeDefinition(campaignChallengeRotation.today_challenge)
      : null),
    [campaignChallengeRotation],
  );
  const weeklyChallenges = useMemo(
    () => (campaignChallengeRotation
      ? campaignChallengeRotation.weekly_challenges.map(normalizeChallengeDefinition)
      : []),
    [campaignChallengeRotation],
  );
  const cachedChallengeProgress = todayChallenge ? getChallengeProgress(todayChallenge.id) : null;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const loadCampaign = async () => {
      const profile = await getCampaignProfile(directorUserId, {
        signal: controller.signal,
      }).catch(() => null);
      if (!profile) {
        if (!cancelled) {
          setCampaignProfile(null);
          setCampaignMastery([]);
          setCampaignBadges([]);
          setCampaignDailyStatus(null);
          setCampaignWeeklySummary(null);
        }
        return;
      }

      const timezoneOffsetMinutes = new Date().getTimezoneOffset();
      const [mastery, badges, dailyStatus, weeklySummary] = await Promise.all([
        getCampaignMastery(directorUserId, {
          signal: controller.signal,
        }).catch(() => [] as CampaignMastery[]),
        getCampaignBadges(directorUserId, {
          signal: controller.signal,
        }).catch(() => [] as CampaignBadge[]),
        todayChallenge
          ? getCampaignDailyChallengeStatus(
            directorUserId,
            todayChallenge.profileId,
            localDate,
            timezoneOffsetMinutes,
            { signal: controller.signal },
          ).catch(() => null)
          : Promise.resolve(null),
        getCampaignWeeklySummary(
          directorUserId,
          localDate,
          timezoneOffsetMinutes,
          { signal: controller.signal },
        ).catch(() => null),
      ]);

      if (cancelled) return;
      setCampaignProfile(profile);
      setCampaignMastery(mastery);
      setCampaignBadges(badges);
      setCampaignDailyStatus(dailyStatus);
      setCampaignWeeklySummary(weeklySummary);
    };

    void loadCampaign();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [directorUserId, localDate, todayChallenge, todayChallenge?.profileId]);

  const dailyMastery = todayChallenge
    ? (campaignMastery.find((item) => item.profile_id === todayChallenge.profileId) ?? null)
    : null;
  const topMasteries = useMemo(
    () => [...campaignMastery]
      .sort((left, right) => (
        right.campaign_score - left.campaign_score
        || right.level - left.level
        || left.profile_id.localeCompare(right.profile_id)
      ))
      .slice(0, 3),
    [campaignMastery],
  );
  const todayChallengeProgress = resolveChallengeProgress(
    cachedChallengeProgress,
    campaignDailyStatus,
  );

  return {
    localDate,
    campaignProfile,
    campaignBadges,
    campaignWeeklySummary,
    campaignChallengeRotation,
    todayChallenge,
    weeklyChallenges,
    todayChallengeProgress,
    dailyMastery,
    topMasteries,
  };
}

export function useSharedChallengePrefill(searchParams: URLSearchParams) {
  const sharedChallenge = useMemo(
    () => readSharedChallengePayload(searchParams),
    [searchParams],
  );
  const sharedChallengeBanner = useMemo(
    () => (sharedChallenge
      ? {
        question: sharedChallenge.question,
        profileId: sharedChallenge.profileId ?? null,
      }
      : null),
    [sharedChallenge],
  );

  return {
    sharedChallenge,
    sharedChallengeBanner,
  };
}
