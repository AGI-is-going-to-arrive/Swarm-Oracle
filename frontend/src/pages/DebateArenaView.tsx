import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { predictDebate } from '../api/client';
import { DebateBetModal } from '../components/DebateBetModal';
import { DebateMomentumBar } from '../components/DebateMomentumBar';
import { DebateScoreCard } from '../components/DebateScoreCard';
import { DebateStageRibbon } from '../components/DebateStageRibbon';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import {
  getDebateDimensionLabel,
  getDebatePhaseLabel,
  getDebateSideLabel,
} from '../lib/debateLabels';
import { DEBATE_UI_ASSETS, getThemeAssetPath, getTheaterThemeLabel } from '../lib/themeRegistry';
import {
  captureElementDataUrl,
  useScreenCapture,
} from '../hooks/useScreenCapture';
import { useDebateWS } from '../hooks/useDebateWS';
import { useDebateStore } from '../stores/debateStore';
import { getDirectorIdentity } from '../lib/directorIdentity';
import './DebateArena.css';

const REVEAL_INTERVAL_MS = 1400;

export function DebateArenaView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const directorIdentity = getDirectorIdentity();

  const debate = useDebateStore((state) => state.debate);
  const status = useDebateStore((state) => state.status);
  const error = useDebateStore((state) => state.error);
  const loadDebate = useDebateStore((state) => state.loadDebate);

  const [revealCount, setRevealCount] = useState(0);
  const [selectedPhase, setSelectedPhase] = useState<string>('opening');
  const [showBetModal, setShowBetModal] = useState(false);
  const [betSubmitting, setBetSubmitting] = useState(false);
  const [betModalState, setBetModalState] = useState<Record<string, unknown> | null>(null);
  const [betNotice, setBetNotice] = useState('');
  const [captureNotice, setCaptureNotice] = useState('');
  const [autoReveal, setAutoReveal] = useState(true);
  const [phaseLocked, setPhaseLocked] = useState(false);
  const revealRef = useRef(0);

  const { status: captureStatus, captureScreenshot } = useScreenCapture({
    selector: '.debate-shell',
  });

  useEffect(() => {
    if (!id) return;
    void loadDebate(id);
  }, [id, loadDebate]);

  useEffect(() => {
    if (!debate?.language) return;
    const targetLanguage = debate.language === 'zh' ? 'zh' : 'en';
    if (!i18n.language.startsWith(targetLanguage)) {
      void i18n.changeLanguage(targetLanguage);
    }
  }, [debate?.language, i18n]);

  useDebateWS(id, Boolean(id));

  useEffect(() => {
    if (!debate?.turns.length) return;
    if (revealCount === 0) {
      setRevealCount(1);
    }
  }, [debate?.turns.length, revealCount]);

  useEffect(() => {
    revealRef.current = revealCount;
  }, [revealCount]);

  useEffect(() => {
    if (!debate?.turns.length || !autoReveal) return undefined;
    if (revealCount >= debate.turns.length) return undefined;
    const timer = window.setTimeout(() => {
      setRevealCount((current) => Math.min((debate?.turns.length ?? current), current + 1));
    }, REVEAL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [autoReveal, debate?.turns.length, revealCount]);

  const visibleTurns = useMemo(
    () => debate?.turns.slice(0, revealCount) ?? [],
    [debate?.turns, revealCount],
  );
  const activeSpeakerSide = visibleTurns.at(-1)?.speaker_side ?? null;

  const unlockedPhases = useMemo(
    () => Array.from(new Set(visibleTurns.map((turn) => turn.phase))),
    [visibleTurns],
  );

  const currentPhase = visibleTurns.at(-1)?.phase ?? debate?.current_phase ?? 'opening';
  const stageTurns = useMemo(
    () => visibleTurns.filter((turn) => turn.phase === selectedPhase),
    [selectedPhase, visibleTurns],
  );

  useEffect(() => {
    if (!phaseLocked) {
      setSelectedPhase(currentPhase);
    }
  }, [currentPhase, phaseLocked]);

  const currentPhaseIndex = useMemo(
    () => ['opening', 'crossfire', 'rebuttal', 'closing', 'verdict'].indexOf(currentPhase),
    [currentPhase],
  );
  const canBetNow = Boolean(debate && !debate.result_ready && currentPhaseIndex < 3);

  const phaseScoreDelta = useMemo(
    () => stageTurns.reduce(
      (acc, turn) => ({
        proposition: acc.proposition + (turn.score_delta?.proposition ?? 0),
        opposition: acc.opposition + (turn.score_delta?.opposition ?? 0),
      }),
      { proposition: 0, opposition: 0 },
    ),
    [stageTurns],
  );

  const watchedDimension = useMemo(() => {
    switch (selectedPhase) {
      case 'opening':
        return 'coherence';
      case 'crossfire':
        return 'evidence';
      case 'rebuttal':
        return 'adaptability';
      case 'closing':
      case 'verdict':
        return 'impact';
      default:
        return 'coherence';
    }
  }, [selectedPhase]);

  const clashCopy = useMemo(() => t(`debate.clash_${selectedPhase}`), [selectedPhase, t]);
  const phaseLeaderLabel = useMemo(() => {
    if (phaseScoreDelta.proposition === phaseScoreDelta.opposition) {
      return t('debate.phase_balance');
    }
    return phaseScoreDelta.proposition > phaseScoreDelta.opposition
      ? getDebateSideLabel(t, 'proposition')
      : getDebateSideLabel(t, 'opposition');
  }, [phaseScoreDelta.opposition, phaseScoreDelta.proposition, t]);
  const phasePressureCopy = useMemo(() => {
    const swing = Math.abs(phaseScoreDelta.proposition - phaseScoreDelta.opposition);
    if (swing === 0) {
      return t('debate.pressure_even');
    }
    return t('debate.pressure_edge', { side: phaseLeaderLabel, value: swing });
  }, [phaseLeaderLabel, phaseScoreDelta.opposition, phaseScoreDelta.proposition, t]);
  const betWindowLabel = canBetNow ? t('debate.bet_window_open') : t('debate.bet_window_locked');

  const themeLabel = getTheaterThemeLabel(debate?.scene_theme, isZh);
  const themeAsset = debate?.scene_theme ? getThemeAssetPath(debate.scene_theme as never) : null;

  useEffect(() => {
    if (!canBetNow && showBetModal) {
      setShowBetModal(false);
    }
  }, [canBetNow, showBetModal]);

  useEffect(() => {
    const win = window as AutomationWindow;
    const capture = async (mode: 'canvas' | 'panel' | 'modal' = 'panel') => {
      if (mode === 'modal') {
        if (!showBetModal) return null;
        return captureElementDataUrl('.debate-modal', 'element');
      }
      return captureElementDataUrl('.debate-shell', 'element');
    };
    win.advanceTime = async (ms: number) => {
      const steps = Math.max(1, Math.floor(ms / REVEAL_INTERVAL_MS));
      setAutoReveal(false);
      setRevealCount((current) => Math.min(debate?.turns.length ?? current, current + steps));
    };
    win.capture_game_screenshot = capture;
    win.render_game_to_text = () => stringifyAutomationPayload(
      {
        question: debate?.question ?? null,
        status: status === 'loading' ? 'loading' : error ? 'error' : debate?.status ?? 'idle',
        currentRound: revealCount,
        totalRounds: debate?.turns.length ?? null,
        viewMode: 'theater',
        visualizationEnabled: true,
        isSimulationComplete: debate?.result_ready ?? false,
        messageCount: visibleTurns.length,
        agentCount: debate?.participants.length ?? 0,
        branchCount: 1,
      },
      debate ? {
        scene: 'DebateArenaDOM',
        theme: debate.scene_theme,
        phase: currentPhase,
        visible_turn_count: visibleTurns.length,
      } : null,
      {
        route: window.location.pathname,
        kind: 'debate',
        phase: currentPhase,
        selected_phase: selectedPhase,
        is_phase_locked: phaseLocked,
        unlocked_phases: unlockedPhases,
        controls: {
          can_open_prediction: canBetNow,
          can_view_result: Boolean(debate?.result_ready),
          can_capture_screenshot: captureStatus === 'idle',
          capture_mode: 'panel',
          active_modal: showBetModal ? 'bet' : null,
          show_bet_modal: showBetModal,
          bet_submitting: betSubmitting,
          auto_reveal: autoReveal,
          modal_state: betModalState,
        },
        debate: debate ? {
          motion: debate.motion,
          proposition: { score: debate.score.proposition },
          opposition: { score: debate.score.opposition },
          judge: { summary_ready: debate.result_ready },
          visible_quotes: visibleTurns.slice(-3).map((turn) => turn.content),
          bet_window_open: canBetNow,
          stage_turn_count: stageTurns.length,
          phase_delta: phaseScoreDelta,
          watched_dimension: watchedDimension,
        } : null,
      },
    );

    return () => {
      if (win.render_game_to_text) delete win.render_game_to_text;
      if (win.advanceTime) delete win.advanceTime;
      if (win.capture_game_screenshot === capture) delete win.capture_game_screenshot;
    };
  }, [
    autoReveal,
    betSubmitting,
    betModalState,
    canBetNow,
    captureStatus,
    currentPhase,
    debate,
    error,
    phaseLocked,
    phaseScoreDelta,
    revealCount,
    selectedPhase,
    showBetModal,
    stageTurns.length,
    status,
    t,
    unlockedPhases,
    visibleTurns,
    watchedDimension,
  ]);

  const handleBetSubmit = async (payload: {
    kind: 'winner' | 'verdict_tone';
    targetValue: string;
    confidence: number;
  }) => {
    if (!id || !canBetNow) return;
    setBetSubmitting(true);
    try {
      await predictDebate(id, {
        kind: payload.kind,
        targetValue: payload.targetValue,
        confidence: payload.confidence,
        userId: directorIdentity.userId,
        userName: directorIdentity.userName,
      });
      setBetNotice(t('debate.bet_success'));
      setShowBetModal(false);
    } finally {
      setBetSubmitting(false);
    }
  };

  const handleCapture = async () => {
    await captureScreenshot({ selector: '.debate-shell', captureTarget: 'element' });
    setCaptureNotice(t('debate.capture_done'));
    window.setTimeout(() => setCaptureNotice(''), 1600);
  };

  const debateStatusLabel = debate?.status ? t(`debate.status_${debate.status}`) : t('common.loading');

  return (
    <div className="debate-shell">
      <div className="debate-shell__inner">
        <section
          className="debate-hero"
          style={themeAsset ? { backgroundImage: `url(${themeAsset})` } : undefined}
        >
          <div className="debate-hero__content">
            <div className="debate-hero__top">
              <span className="debate-hero__eyebrow">
                <img className="debate-hero__banner" src={DEBATE_UI_ASSETS.stageBanner} alt="" aria-hidden="true" />
                {t('debate.entry_title')}
                {themeLabel ? ` · ${themeLabel}` : ''}
              </span>
              <span className={`debate-hero__status ${debate?.result_ready ? 'debate-hero__status--done' : ''}`}>
                {debateStatusLabel}
              </span>
            </div>

            <div className="debate-hero__copy">
              <h1 className="debate-hero__title">{t('debate.live_title')}</h1>
              <p className="debate-hero__subtitle">{t('debate.live_subtitle')}</p>
              <p className="debate-hero__motion">
                <strong>{t('debate.motion_label')}:</strong> {debate?.motion ?? t('debate.loading')}
              </p>
            </div>

            <DebateStageRibbon
              activePhase={selectedPhase}
              unlockedPhases={unlockedPhases}
              onSelect={(phase) => {
                setSelectedPhase(phase);
                setPhaseLocked(phase !== currentPhase);
              }}
            />

            <div className="debate-hero__bottom">
              <DebateMomentumBar
                propositionScore={debate?.score.proposition ?? 0}
                oppositionScore={debate?.score.opposition ?? 0}
                audienceMeter={debate?.score.audience_meter ?? 0}
                frameSrc={DEBATE_UI_ASSETS.scoreMeter}
              />
              <div className="debate-controls">
                <button type="button" className="btn btn-ghost" onClick={() => navigate('/')}>
                  {t('debate.back_home')}
                </button>
                {!debate?.result_ready && (
                  <button
                    type="button"
                    className="btn btn-ghost debate-primary-cta debate-primary-cta--hero"
                    onClick={() => setShowBetModal(true)}
                    disabled={!canBetNow}
                  >
                    {t('debate.open_bet')}
                  </button>
                )}
                <button type="button" className="btn btn-ghost" onClick={handleCapture}>
                  {t('debate.capture_panel')}
                </button>
                {debate?.result_ready && (
                  <button
                    type="button"
                    className="btn btn-primary debate-primary-cta debate-primary-cta--hero"
                    onClick={() => navigate(`/debate/${id}/result`)}
                  >
                    {t('debate.view_result')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        {betNotice && <p className="debate-phase-chip">{betNotice}</p>}
        {captureNotice && <p className="debate-phase-chip">{captureNotice}</p>}
        {error && <p className="debate-modal__error">{error}</p>}
        <div className="debate-mobile-rail" aria-label={t('debate.mobile_primary_actions')}>
          {!debate?.result_ready ? (
            <button
              type="button"
              className="btn btn-primary debate-primary-cta debate-primary-cta--rail"
              onClick={() => setShowBetModal(true)}
              disabled={!canBetNow}
            >
              {t('debate.open_bet')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary debate-primary-cta debate-primary-cta--rail"
              onClick={() => navigate(`/debate/${id}/result`)}
            >
              {t('debate.view_result')}
            </button>
          )}
        </div>

        <div className="debate-layout">
          <div className="debate-main">
            <section className="debate-panel">
              <div className="debate-panel__header">
                <h2>{t('debate.participants_title')}</h2>
                <span className="debate-phase-chip">
                  {t('debate.current_phase')}: {getDebatePhaseLabel(t, currentPhase)}
                </span>
              </div>
              <div className="debate-panel__body">
                <div className="debate-score-grid">
                  {debate?.participants.map((participant) => (
                    <DebateScoreCard
                      key={participant.side}
                      sideLabel={getDebateSideLabel(t, participant.side)}
                      role={participant.role}
                      badgeSrc={
                        participant.side === 'proposition'
                          ? DEBATE_UI_ASSETS.badgeProposition
                          : participant.side === 'opposition'
                            ? DEBATE_UI_ASSETS.badgeOpposition
                            : DEBATE_UI_ASSETS.badgeJudge
                      }
                      score={
                        participant.side === 'proposition'
                          ? debate.score.proposition
                          : participant.side === 'opposition'
                            ? debate.score.opposition
                            : debate.result_ready
                              ? 1
                              : 0
                      }
                      active={
                        participant.side === activeSpeakerSide
                        || (participant.side === 'judge' && currentPhase === 'verdict')
                      }
                    />
                  ))}
                </div>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h2>{t('debate.feed_title')}</h2>
                <div className="debate-controls">
                  <button type="button" className="btn btn-ghost" onClick={() => setAutoReveal((current) => !current)}>
                    {t('debate.auto_reveal')}: {t(autoReveal ? 'debate.state_on' : 'debate.state_off')}
                  </button>
                  {phaseLocked && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setPhaseLocked(false);
                        setSelectedPhase(currentPhase);
                      }}
                    >
                      {t('debate.return_to_live')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setAutoReveal(false);
                      setPhaseLocked(false);
                      setRevealCount(debate?.turns.length ?? 0);
                      setSelectedPhase('verdict');
                    }}
                  >
                    {t('debate.skip_to_verdict')}
                  </button>
                </div>
              </div>
              <div className="debate-panel__body">
                {stageTurns.length > 0 ? (
                  <div className="debate-turn-list">
                    {stageTurns.map((turn) => (
                      <article key={turn.id} className="debate-turn-card">
                        <div className="debate-turn-card__meta">
                          <strong>{turn.speaker_name}</strong>
                          <span>{getDebateSideLabel(t, turn.speaker_side)}</span>
                        </div>
                        <p className="debate-turn-card__content">{turn.content}</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="debate-empty-state">{t('debate.loading')}</p>
                )}
              </div>
            </section>
          </div>

          <aside className="debate-side">
            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.strategy_title')}</h3>
                <span className="debate-phase-chip">{betWindowLabel}</span>
              </div>
              <div className="debate-panel__body">
                <div className="debate-turn-list">
                  <article className="debate-turn-card">
                    <div className="debate-turn-card__meta">
                      <strong>{t('debate.strategy_current_clash')}</strong>
                      <span>{getDebatePhaseLabel(t, selectedPhase)}</span>
                    </div>
                    <p className="debate-rule-copy">{clashCopy}</p>
                  </article>
                  <article className="debate-turn-card">
                    <div className="debate-turn-card__meta">
                      <strong>{t('debate.strategy_pressure')}</strong>
                      <span>{phaseLeaderLabel}</span>
                    </div>
                    <p className="debate-rule-copy">{phasePressureCopy}</p>
                  </article>
                  <article className="debate-turn-card">
                    <div className="debate-turn-card__meta">
                      <strong>{t('debate.strategy_watchlist')}</strong>
                      <span>{getDebateDimensionLabel(t, watchedDimension)}</span>
                    </div>
                    <p className="debate-rule-copy">
                      {canBetNow ? t('debate.watchlist_open') : t('debate.watchlist_locked')}
                    </p>
                  </article>
                </div>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.rules_title')}</h3>
              </div>
              <div className="debate-panel__body">
                <p className="debate-rule-copy">{t('debate.rules_body')}</p>
              </div>
            </section>
          </aside>
        </div>
      </div>

      {showBetModal && (
        <DebateBetModal
          loading={betSubmitting}
          onClose={() => setShowBetModal(false)}
          onSubmit={handleBetSubmit}
          onAutomationStateChange={setBetModalState}
        />
      )}
    </div>
  );
}
