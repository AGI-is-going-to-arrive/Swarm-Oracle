/* ═══════════════════════════════════════════════════════════
   SwarmOracle — InputView (Landing Page)
   ═══════════════════════════════════════════════════════════ */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import gsap from 'gsap';
import { useTranslation } from 'react-i18next';
import { useSimulationStore } from '../stores/simulationStore';
import { testLlmConnection } from '../api/client';
import { getChallengeProgress, getTodayChallenge, markChallengeStarted } from '../lib/dailyChallenge';
import { stringifyAutomationPayload } from '../game/automation';
import {
  getGameplayBadgeSrc,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
} from '../components/gameplayCards';
import { QuickStartCards } from '../components/QuickStartCards';
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
  const startSimulation = useSimulationStore((s) => s.startSimulation);
  const submitError = useSimulationStore((s) => s.error);
  const reset = useSimulationStore((s) => s.reset);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const todayChallenge = getTodayChallenge();
  const todayChallengeProgress = getChallengeProgress(todayChallenge.id);
  const challengeProfileLabel = getGameplayProfileLabel(todayChallenge.profileId, isZh);
  const challengeHooks = getGameplayProfileSignatureHooks(todayChallenge.profileId, isZh).slice(0, 2);

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

  const handleSubmit = async (q: string) => {
    await launchSimulation({
      nextQuestion: q,
      nextRounds: rounds,
      nextAgents: numAgents,
      nextMode: mode,
      nextVisualization: vizEnabled,
    });
  };

  const handleStartChallenge = async () => {
    setQuestion(todayChallenge.question);
    setRounds(todayChallenge.rounds);
    setNumAgents(todayChallenge.numAgents);
    setMode(todayChallenge.mode);
    setVizEnabled(todayChallenge.visualizationEnabled);
    await launchSimulation({
      nextQuestion: todayChallenge.question,
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
              completed: todayChallengeProgress.completed,
              used_cards_count: todayChallengeProgress.usedCards.length,
              bet_placed: todayChallengeProgress.betPlaced,
              betting_hit: todayChallengeProgress.bettingHit ?? null,
            }
          : null,
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
              alt="Daily challenge pixel illustration"
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
              <strong className="daily-challenge-card__title">{todayChallenge.question}</strong>
              <span className="daily-challenge-card__subtitle">
                {isZh ? todayChallenge.subtitleZh : todayChallenge.subtitleEn}
              </span>
              <div className="daily-challenge-card__hooks" aria-label={isZh ? '题材钩子' : 'Theme hooks'}>
                <span className="daily-challenge-card__pill daily-challenge-card__pill--profile">
                  {challengeProfileLabel}
                </span>
                {challengeHooks.map((hook) => (
                  <span key={hook} className="daily-challenge-card__pill">
                    {hook}
                  </span>
                ))}
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
                  <span className="daily-challenge-card__pill">
                    {t('home.daily_challenge_cards_used', { count: todayChallengeProgress.usedCards.length })}
                  </span>
                  <span className="daily-challenge-card__pill">
                    {todayChallengeProgress.betPlaced
                      ? t('home.daily_challenge_bet_placed')
                      : t('home.daily_challenge_bet_missing')}
                  </span>
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

          <button
            className="btn btn-primary btn--submit"
            onClick={() => handleSubmit(question)}
            disabled={!question.trim() || isSubmitting}
          >
            {isSubmitting ? <span className="spinner spinner--sm" /> : null}
            {t('home.submit')}
          </button>
          {submitError && !isSubmitting && (
            <span className="byok-test-error" role="alert">{submitError}</span>
          )}
        </div>

        {/* Quick Start */}
        <div className="quick-start-section">
          <h3 className="section-title">{t('home.quick_starts')}</h3>
          <QuickStartCards onSelect={(q) => handleSubmit(q)} />
        </div>
      </div>
    </div>
  );
}
