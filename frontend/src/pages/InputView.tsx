/* ═══════════════════════════════════════════════════════════
   SwarmOracle — InputView (Landing Page)
   ═══════════════════════════════════════════════════════════ */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import gsap from 'gsap';
import { useTranslation } from 'react-i18next';
import { useSimulationStore } from '../stores/simulationStore';
import {
  createDebate,
  getCampaignBadges,
  getCampaignDailyChallengeStatus,
  getCampaignMastery,
  getCampaignProfile,
  testLlmConnection,
} from '../api/client';
import { getDirectorIdentity } from '../lib/directorIdentity';
import {
  challengeDateKey,
  getChallengeQuestion,
  getChallengeProgress,
  getTodayChallenge,
  markChallengeStarted,
  resolveChallengeProgress,
} from '../lib/dailyChallenge';
import { stringifyAutomationPayload } from '../game/automation';
import {
  getGameplayBadgeSrc,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
} from '../components/gameplayCards';
import { QuickStartCards, type QuickStartPreset } from '../components/QuickStartCards';
import type {
  CampaignBadge,
  CampaignDailyChallengeStatus,
  CampaignMastery,
  CampaignProfileSummary,
} from '../types';
import './InputView.css';

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

export function InputView() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const [question, setQuestion] = useState('');
  const [rounds, setRounds] = useState(5);
  const [numAgents, setNumAgents] = useState(20);
  const [mode, setMode] = useState<'raw' | 'blackboard'>('blackboard');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [placeholder, setPlaceholder] = useState('');
  // P4-E: BYOK
  const [showByok, setShowByok] = useState(false);
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [llmModel, setLlmModel] = useState('');
  // BYOK test connection
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testError, setTestError] = useState('');
  // Reasoning effort
  const [reasoningEffort, setReasoningEffort] = useState<string>('');
  // V2: Pixel Theater visualization
  const [vizEnabled, setVizEnabled] = useState(false);
  const navigate = useNavigate();
  const directorIdentity = getDirectorIdentity();
  const startSimulation = useSimulationStore((s) => s.startSimulation);
  const submitError = useSimulationStore((s) => s.error);
  const reset = useSimulationStore((s) => s.reset);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const todayChallenge = getTodayChallenge();
  const todayChallengeQuestion = getChallengeQuestion(todayChallenge, isZh);
  const cachedChallengeProgress = getChallengeProgress(todayChallenge.id);
  const challengeProfileLabel = getGameplayProfileLabel(todayChallenge.profileId, isZh);
  const challengeHooks = getGameplayProfileSignatureHooks(todayChallenge.profileId, isZh).slice(0, 2);
  const [campaignProfile, setCampaignProfile] = useState<CampaignProfileSummary | null>(null);
  const [campaignMastery, setCampaignMastery] = useState<CampaignMastery[]>([]);
  const [campaignBadges, setCampaignBadges] = useState<CampaignBadge[]>([]);
  const [campaignDailyStatus, setCampaignDailyStatus] = useState<CampaignDailyChallengeStatus | null>(null);

  const resizeQuestionField = useCallback(() => {
    const el = questionRef.current;
    if (!el) return;

    const minHeight = window.innerWidth <= 640 ? 96 : 76;
    const maxHeight = window.innerWidth <= 640 ? 220 : 180;

    el.style.height = '0px';
    const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  // Dynamic placeholders from i18n
  const placeholders = [
    t('home.placeholder_1'),
    t('home.placeholder_2'),
    t('home.placeholder_3')
  ];

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
    let timeout: ReturnType<typeof setTimeout>;

    const tick = () => {
      const currentText = placeholders[textIdx] || '';

      if (!isDeleting) {
        charIdx++;
        setPlaceholder(currentText.slice(0, charIdx));
        if (charIdx >= currentText.length) {
          timeout = setTimeout(() => {
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

      timeout = setTimeout(tick, isDeleting ? 30 : 80);
    };

    tick();
    return () => clearTimeout(timeout);
  }, [t]);

  useEffect(() => {
    resizeQuestionField();
  }, [question, placeholder, resizeQuestionField]);

  useEffect(() => {
    let cancelled = false;

    const loadCampaign = async () => {
      const profile = await getCampaignProfile(directorIdentity.userId).catch(() => null);
      if (!profile) {
        if (!cancelled) {
          setCampaignProfile(null);
          setCampaignMastery([]);
          setCampaignBadges([]);
          setCampaignDailyStatus(null);
        }
        return;
      }

      const [mastery, badges, dailyStatus] = await Promise.all([
        getCampaignMastery(directorIdentity.userId).catch(() => [] as CampaignMastery[]),
        getCampaignBadges(directorIdentity.userId).catch(() => [] as CampaignBadge[]),
        getCampaignDailyChallengeStatus(
          directorIdentity.userId,
          todayChallenge.profileId,
          challengeDateKey(),
          new Date().getTimezoneOffset(),
        ).catch(() => null),
      ]);
      if (cancelled) return;
      setCampaignProfile(profile);
      setCampaignMastery(mastery);
      setCampaignBadges(badges);
      setCampaignDailyStatus(dailyStatus);
    };

    void loadCampaign();
    return () => {
      cancelled = true;
    };
  }, [directorIdentity.userId, todayChallenge.profileId]);

  const dailyMastery = campaignMastery.find((item) => item.profile_id === todayChallenge.profileId) ?? null;
  const todayChallengeProgress = resolveChallengeProgress(
    cachedChallengeProgress,
    campaignDailyStatus,
  );
  const nextUnlockLabel = dailyMastery?.score_to_next_level != null
    ? t('home.campaign_next_unlock', { count: dailyMastery.score_to_next_level })
    : t('home.campaign_mastered');

  // Entry animations
  useEffect(() => {
    if (titleRef.current) {
      gsap.fromTo(
        titleRef.current,
        { y: 30, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.8, ease: 'power2.out' },
      );
    }
    if (questionRef.current) {
      gsap.fromTo(
        questionRef.current.parentElement!,
        { y: 20, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.8, delay: 0.3, ease: 'power2.out' },
      );
    }
  }, []);

  const handleTestConnection = async () => {
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
      } else {
        setTestStatus('fail');
        setTestError(res.llm.error || 'Unknown error');
      }
    } catch (err) {
      setTestStatus('fail');
      setTestError(err instanceof Error ? err.message : 'Network error');
    }
    // Auto-reset after 5s
    setTimeout(() => setTestStatus('idle'), 5000);
  };

  const launchSimulation = async ({
    nextQuestion,
    nextRounds,
    nextAgents,
    nextMode,
    nextVisualization,
    challengeId,
  }: {
    nextQuestion: string;
    nextRounds: number;
    nextAgents: number;
    nextMode: 'raw' | 'blackboard';
    nextVisualization: boolean;
    challengeId?: string;
  }) => {
    const trimmed = nextQuestion.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const id = await startSimulation(
        trimmed, nextRounds, nextAgents, nextMode, undefined,
        llmApiKey || undefined,
        llmBaseUrl || undefined,
        llmModel || undefined,
        reasoningEffort || undefined,
        nextVisualization,
      );
      if (challengeId) {
        markChallengeStarted(challengeId, id);
      }
      navigate(`/sim/${id}`);
    } catch {
      setIsSubmitting(false);
    }
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
      const debate = await createDebate(trimmed);
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
        byok_expanded: showByok,
        byok_test_status: testStatus,
        error: submitError || null,
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
        campaign: {
          user_id: directorIdentity.userId,
          total_runs: campaignProfile?.total_runs ?? 0,
          badge_count: campaignBadges.length,
          daily_profile_level: dailyMastery?.level ?? 0,
          daily_profile_score_to_next_level: dailyMastery?.score_to_next_level ?? null,
        },
        controls: {
          can_start_simulation: Boolean(question.trim()) && !isSubmitting,
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
    isSubmitting,
    mode,
    numAgents,
    question,
    reasoningEffort,
    rounds,
    showByok,
    submitError,
    testStatus,
    todayChallengeProgress,
    vizEnabled,
    campaignBadges.length,
    campaignProfile?.total_runs,
    dailyMastery?.level,
    dailyMastery?.score_to_next_level,
    directorIdentity.userId,
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

        {/* Input Area */}
        <div className="input-view__form">
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

          {/* Round Count Slider */}
          <div className="rounds-selector">
            <span className="rounds-label">{t('home.rounds_label')}</span>
            <div className="rounds-slider-wrap">
              <input
                type="range"
                className="rounds-slider"
                aria-label={t('home.rounds_label')}
                min={3}
                max={40}
                step={1}
                value={rounds}
                onChange={(e) => setRounds(Number(e.target.value))}
                disabled={isSubmitting}
              />
              <span className="rounds-value">{rounds}</span>
            </div>
            <span className="rounds-hint">
              {rounds <= 5 ? t('home.rounds_fast') : rounds <= 15 ? t('home.rounds_standard') : rounds <= 25 ? t('home.rounds_deep') : t('home.rounds_extreme')}
              <span className="rounds-time">≈{Math.round(rounds * 1.2)}min</span>
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
                max={100}
                step={1}
                value={numAgents}
                onChange={(e) => setNumAgents(Number(e.target.value))}
                disabled={isSubmitting}
              />
              <span className="agents-value">{numAgents}</span>
            </div>
            <span className="agents-hint">
              {numAgents <= 10 ? t('home.agents_few') : numAgents <= 30 ? t('home.agents_standard') : numAgents <= 60 ? t('home.agents_large') : t('home.agents_extreme')}
            </span>
          </div>

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
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
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
                  <label className="byok-label" htmlFor="byok-key">API Key</label>
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
                  <label className="byok-label" htmlFor="byok-url">Base URL</label>
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
                  <label className="byok-label" htmlFor="byok-model">Model</label>
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
                <p className="byok-hint">{t('home.byok_hint')}</p>
              </div>
            )}
          </div>

          <div className="input-view__submit-row">
            <button
              className="btn btn-primary btn--submit"
              onClick={() => handleSubmit(question)}
              disabled={!question.trim() || isSubmitting}
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
          <p className="input-view__debate-hint">{t('debate.entry_hint')}</p>
          {submitError && !isSubmitting && (
            <span className="byok-test-error" role="alert">{submitError}</span>
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
