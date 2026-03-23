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

export function useInputByokSettings(t: TranslateFn) {
  const [showByok, setShowByok] = useState(false);
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [llmModel, setLlmModel] = useState('');
  const [disableUserQuota, setDisableUserQuota] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testError, setTestError] = useState('');
  const [probeResult, setProbeResult] = useState<LlmProbeResponse | null>(null);
  const [testedConfigKey, setTestedConfigKey] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const providerPolicyHydrated = useRef(false);

  const currentConfigKey = useMemo(
    () => JSON.stringify({
      apiKey: llmApiKey.trim(),
      baseUrl: llmBaseUrl.trim(),
      model: llmModel.trim(),
    }),
    [llmApiKey, llmBaseUrl, llmModel],
  );

  useEffect(() => {
    const storedPolicy = loadLlmProviderPolicy();
    setLlmApiKey(storedPolicy.apiKey);
    setLlmBaseUrl(storedPolicy.baseUrl);
    setLlmModel(storedPolicy.model);
    setDisableUserQuota(storedPolicy.disableUserQuota);
    setReasoningEffort(storedPolicy.reasoningEffort);
    setShowByok(Boolean(
      storedPolicy.apiKey
      || storedPolicy.baseUrl
      || storedPolicy.model
      || storedPolicy.disableUserQuota
    ));
    providerPolicyHydrated.current = true;
  }, []);

  useEffect(() => {
    if (!providerPolicyHydrated.current) return;
    saveLlmProviderPolicy({
      apiKey: llmApiKey,
      baseUrl: llmBaseUrl,
      model: llmModel,
      disableUserQuota,
      reasoningEffort,
    });
  }, [disableUserQuota, llmApiKey, llmBaseUrl, llmModel, reasoningEffort]);

  useEffect(() => {
    setTestStatus('idle');
    setTestError('');
    setProbeResult(null);
    setTestedConfigKey('');
  }, [currentConfigKey]);

  const handleTestConnection = useCallback(async () => {
    setTestStatus('testing');
    setTestError('');
    try {
      const res = await testLlmConnection(
        llmApiKey || undefined,
        llmBaseUrl || undefined,
        llmModel || undefined,
      );
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
  }, [currentConfigKey, llmApiKey, llmBaseUrl, llmModel, t]);

  return {
    showByok,
    setShowByok,
    llmApiKey,
    setLlmApiKey,
    llmBaseUrl,
    setLlmBaseUrl,
    llmModel,
    setLlmModel,
    disableUserQuota,
    setDisableUserQuota,
    testStatus,
    testError,
    probeResult,
    hasFreshProbe: Boolean(probeResult) && testedConfigKey === currentConfigKey && testStatus !== 'fail',
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
  }, [directorUserId, localDate, todayChallenge?.profileId]);

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
