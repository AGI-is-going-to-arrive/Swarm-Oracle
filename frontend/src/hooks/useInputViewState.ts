import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
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
import { resolveGameplayProfileId } from '../lib/gameplayProfileSummary';
import type { GameplayProfileId } from '../lib/themeRegistry';
import type {
  CampaignBadge,
  CampaignChallengeRotation,
  CampaignDailyChallengeStatus,
  CampaignMastery,
  CampaignProfileSummary,
  CampaignWeeklySummary,
  WorldContext,
  DocumentSeedAgentPreview,
} from '../types';

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

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
  difficulty_tier?: 'easy' | 'normal' | 'hard' | 'expert' | string;
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
    profileId: resolveGameplayProfileId(challenge.profile_id),
    rounds: challenge.rounds,
    numAgents: challenge.num_agents,
    mode: challenge.mode,
    visualizationEnabled: challenge.visualization_enabled,
    difficulty_tier: challenge.difficulty_tier,
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

export interface UseInputByokSettingsOptions {
  /**
   * Callback fired with the server-level web_search.server_enabled hint
   * after a successful LLM probe. Allows web-search state to live in a
   * sibling hook while still receiving server hints from the BYOK probe.
   */
  onWebSearchServerHint?: (serverEnabled: boolean) => void;
}

interface TestConnectionOptions {
  signal?: AbortSignal;
  includeProbe?: boolean;
}

export function useInputByokSettings(
  t: TranslateFn,
  options: UseInputByokSettingsOptions = {},
) {
  const { onWebSearchServerHint } = options;
  const onWebSearchServerHintRef = useRef(onWebSearchServerHint);
  useEffect(() => {
    onWebSearchServerHintRef.current = onWebSearchServerHint;
  }, [onWebSearchServerHint]);

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

  const handleTestConnection = useCallback(async (options: TestConnectionOptions = {}) => {
    const { includeProbe, signal } = options;
    setTestStatus('testing');
    setTestError('');
    const finishAbortedProbe = () => {
      setTestStatus('idle');
      return { ok: false as const, probe: null, error: t('home.launch_inflight_timeout') };
    };
    try {
      const res = await testLlmConnection(
        llmApiKey || undefined,
        llmBaseUrl || undefined,
        llmModel || undefined,
        parseOptionalIntegerInput(llmRequestsPerMinute) ?? undefined,
        parseOptionalIntegerInput(llmTokensPerMinute) ?? undefined,
        includeProbe,
        undefined,
        undefined,
        undefined,
        { signal },
      );
      if (signal?.aborted) {
        return finishAbortedProbe();
      }
      // Capture server-level web search hint (scope: server, NOT per-provider)
      onWebSearchServerHintRef.current?.(res.web_search?.server_enabled === true);

      if (res.llm.status === 'ok') {
        setTestStatus('ok');
        setProbeResult(res.probe ?? null);
        setTestedConfigKey(currentConfigKey);
        return { ok: true as const, probe: res.probe ?? null };
      } else {
        const error = res.llm.error || 'Unknown error';
        setTestStatus('fail');
        setTestError(error);
        window.setTimeout(() => setTestStatus('idle'), 5000);
        return { ok: false as const, probe: null, error };
      }
    } catch (err) {
      if (signal?.aborted) {
        return finishAbortedProbe();
      }
      const error = getLocalizedApiErrorMessage(
        err,
        t,
        t('common.api_errors.llm_unavailable'),
        {
          LLM_TEMPORARILY_UNAVAILABLE: 'common.api_errors.llm_unavailable',
          LLM_GENERATION_FAILED: 'common.api_errors.llm_generation_failed',
        },
      );
      setTestStatus('fail');
      setTestError(error);
      window.setTimeout(() => setTestStatus('idle'), 5000);
      return { ok: false as const, probe: null, error };
    }
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
    setTestStatus,
    setTestError,
    probeResult: visibleProbeResult,
    hasFreshProbe: Boolean(visibleProbeResult) && testedConfigKey === currentConfigKey && visibleTestStatus !== 'fail',
    reasoningEffort,
    setReasoningEffort,
    handleTestConnection,
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

export function useInputWorldContext() {
  const [worldContext, setWorldContext] = useState<WorldContext | null>(null);
  const [agentsPreview, setAgentsPreview] = useState<DocumentSeedAgentPreview[] | null>(null);
  return {
    worldContext,
    setWorldContext,
    agentsPreview,
    setAgentsPreview,
  };
}
