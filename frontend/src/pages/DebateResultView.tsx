import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { getDebateResult } from '../api/client';
import { DebateShareModal } from '../components/DebateShareModal';
import { DebateScoreCard } from '../components/DebateScoreCard';
import { captureElementDataUrl } from '../hooks/useScreenCapture';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import {
  resolveDebateCounterplayRecord,
  getDebateCounterplaySummary,
  loadDebateCounterplay,
  resolveDebateCounterplayOutcome,
} from '../lib/debateCounterplay';
import {
  getDebateDimensionLabel,
  getDebatePhaseLabel,
  getDebateSideLabel,
  getDebateVerdictToneLabel,
} from '../lib/debateLabels';
import { DEBATE_UI_ASSETS, getThemeAssetPath, getTheaterThemeLabel } from '../lib/themeRegistry';
import type { DebatePrediction, DebateResultPayload } from '../types';
import './DebateArena.css';

function isPredictionHit(prediction: DebatePrediction, result: DebateResultPayload['result']): boolean {
  if (prediction.kind === 'winner') return prediction.target_value === result.winner;
  return prediction.target_value === result.verdict_tone;
}

export function DebateResultView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const [payload, setPayload] = useState<DebateResultPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [shareModalState, setShareModalState] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: number | null = null;

    const load = async () => {
      try {
        const nextPayload = await getDebateResult(id);
        if (cancelled) return;
        setPayload(nextPayload);
        setError('');
        setLoading(false);
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : t('debate.result_load_failed');
        if (message.includes('API 409:')) {
          timer = window.setTimeout(() => void load(), 1200);
          return;
        }
        if (!cancelled) {
          setError(message);
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [id, t]);

  const localCounterplayRecord = useMemo(
    () => (id ? loadDebateCounterplay(id) : null),
    [id],
  );
  const counterplayRecord = useMemo(
    () => resolveDebateCounterplayRecord({
      resultCounterplay: payload?.counterplay ?? null,
      predictions: payload?.predictions ?? null,
      localRecord: localCounterplayRecord,
    }),
    [localCounterplayRecord, payload?.counterplay, payload?.predictions],
  );
  const counterplaySummary = useMemo(
    () => getDebateCounterplaySummary(counterplayRecord, t),
    [counterplayRecord, t],
  );
  const counterplayOutcome = useMemo(
    () => resolveDebateCounterplayOutcome(counterplayRecord, payload?.result),
    [counterplayRecord, payload?.result],
  );

  const shareContext = useMemo(() => {
    if (!payload) return null;
    return {
      motion: payload.motion,
      winnerLabel: getDebateSideLabel(t, payload.result.winner),
      toneLabel: getDebateVerdictToneLabel(t, payload.result.verdict_tone),
      bestArgument: payload.result.best_argument,
      bestRebuttal: payload.result.best_rebuttal,
      judgeSummary: payload.result.judge_summary,
      propositionScore: payload.result.score.proposition,
      oppositionScore: payload.result.score.opposition,
      counterplaySummary,
      counterplayOutcomeLabel:
        counterplayOutcome === 'hit'
          ? t('debate.counterplay_hit')
          : counterplayOutcome === 'miss'
            ? t('debate.counterplay_miss')
            : null,
    };
  }, [counterplayOutcome, counterplaySummary, payload, t]);

  useEffect(() => {
    if (!payload?.language) return;
    const targetLanguage = payload.language === 'zh' ? 'zh' : 'en';
    if (!i18n.language.startsWith(targetLanguage)) {
      void i18n.changeLanguage(targetLanguage);
    }
  }, [i18n, payload?.language]);

  useEffect(() => {
    const win = window as AutomationWindow;
    const advance = async (ms: number) => {
      const frames = Math.max(1, Math.round(Math.max(0, ms) / (1000 / 60)));
      for (let index = 0; index < frames; index += 1) {
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
      }
    };
    const capture = async (mode: 'canvas' | 'panel' | 'modal' = 'panel') => {
      if (mode === 'modal') {
        if (!showShare) return null;
        return captureElementDataUrl('.debate-modal--share', 'element');
      }
      return captureElementDataUrl('.debate-shell', 'element');
    };

    win.advanceTime = advance;
    win.capture_game_screenshot = capture;
    win.render_game_to_text = () => stringifyAutomationPayload(
      {
        question: payload?.question ?? null,
        status: loading ? 'loading' : error ? 'error' : 'done',
        currentRound: payload?.turns.length ?? 0,
        totalRounds: payload?.turns.length ?? null,
        viewMode: 'theater',
        visualizationEnabled: true,
        isSimulationComplete: Boolean(payload),
        messageCount: payload?.turns.length ?? 0,
        agentCount: payload?.participants.length ?? 0,
        branchCount: 1,
      },
      payload ? {
        scene: 'DebateResultDOM',
        theme: payload.scene_theme,
        winner: payload.result.winner,
      } : null,
      {
        route: window.location.pathname,
        kind: 'debate_result',
        loading,
        error: error || null,
        controls: {
          can_open_share_modal: Boolean(payload),
          can_go_back_live: Boolean(payload),
          active_modal: showShare ? 'share' : null,
          show_share_modal: showShare,
          modal_state: shareModalState,
        },
        result: payload ? {
          winner: payload.result.winner,
          verdict_tone: payload.result.verdict_tone,
          score: payload.result.score,
          prediction_count: payload.predictions.length,
          counterplay_summary: counterplaySummary ?? null,
          counterplay_outcome: counterplayOutcome,
        } : null,
      },
    );
    return () => {
      if (win.render_game_to_text) delete win.render_game_to_text;
      if (win.advanceTime === advance) delete win.advanceTime;
      if (win.capture_game_screenshot === capture) delete win.capture_game_screenshot;
    };
  }, [counterplayOutcome, counterplaySummary, error, loading, payload, shareModalState, showShare]);

  if (loading) {
    return <div className="debate-shell debate-empty-state">{t('debate.loading')}</div>;
  }

  if (error || !payload) {
    return (
      <div className="debate-shell">
        <div className="debate-shell__inner">
          <p className="debate-modal__error">{error || t('debate.result_missing')}</p>
          <button type="button" className="btn btn-primary" onClick={() => navigate(id ? `/debate/${id}` : '/')}>
            {t('debate.back_home')}
          </button>
        </div>
      </div>
    );
  }

  const winnerLabel = getDebateSideLabel(t, payload.result.winner);
  const themeLabel = getTheaterThemeLabel(payload.scene_theme, isZh);
  const themeAsset = getThemeAssetPath(payload.scene_theme as never);

  return (
    <div className="debate-shell">
      <div className="debate-shell__inner">
        <section className="debate-hero" style={{ backgroundImage: `url(${themeAsset})` }}>
          <div className="debate-hero__content">
            <div className="debate-hero__top">
              <span className="debate-hero__eyebrow">
                <img className="debate-hero__banner" src={DEBATE_UI_ASSETS.stageBanner} alt="" aria-hidden="true" />
                {t('debate.result_title')}
                {themeLabel ? ` · ${themeLabel}` : ''}
              </span>
              <span className="debate-hero__status debate-hero__status--done">
                {t('debate.status_done')}
              </span>
            </div>
            <div className="debate-hero__copy">
              <h1 className="debate-hero__title">{winnerLabel}</h1>
              <p className="debate-hero__subtitle">
                {t('debate.result_tone')}: {getDebateVerdictToneLabel(t, payload.result.verdict_tone)}
              </p>
              <p className="debate-hero__motion">
                <strong>{t('debate.motion_label')}:</strong> {payload.motion}
              </p>
            </div>
            <div className="debate-hero__bottom">
              <div
                className="debate-summary-card debate-summary-card--verdict"
                style={{ backgroundImage: `url(${DEBATE_UI_ASSETS.verdictPanel})` }}
              >
                <span className="debate-score-card__eyebrow">{t('debate.result_scoreline')}</span>
                <div className="debate-summary-card__scoreline">
                  <span>{payload.result.score.proposition}</span>
                  <span>:</span>
                  <span>{payload.result.score.opposition}</span>
                </div>
              </div>
              <div className="debate-controls">
                <button type="button" className="btn btn-ghost" onClick={() => navigate(`/debate/${id}`)}>
                  {t('sim.status.back')}
                </button>
                <button type="button" className="btn btn-primary" onClick={() => setShowShare(true)}>
                  {t('debate.open_share')}
                </button>
              </div>
            </div>
          </div>
        </section>

        <div className="debate-result-grid">
          <div className="debate-result-stack">
            <section className="debate-panel">
              <div className="debate-panel__header">
                <h2>{t('debate.result_breakdown')}</h2>
              </div>
              <div className="debate-panel__body">
                <div className="debate-score-grid">
                  {payload.participants.map((participant) => (
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
                          ? payload.result.score.proposition
                          : participant.side === 'opposition'
                            ? payload.result.score.opposition
                            : 1
                      }
                      active={participant.side === payload.result.winner}
                    />
                  ))}
                </div>
                <div className="debate-breakdown-list">
                  {Object.entries(payload.result.breakdown).map(([dimension, scores]) => (
                    <article key={dimension} className="debate-breakdown-card">
                      <strong>{getDebateDimensionLabel(t, dimension)}</strong>
                      <span>{scores.proposition}</span>
                      <span>{scores.opposition}</span>
                    </article>
                  ))}
                </div>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h2>{t('debate.result_best_argument')}</h2>
              </div>
              <div className="debate-panel__body">
                <div
                  className="debate-quote-frame"
                  style={{ backgroundImage: `url(${DEBATE_UI_ASSETS.quoteFrame})` }}
                >
                  <p className="debate-result-quote">{payload.result.best_argument}</p>
                </div>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h2>{t('debate.result_best_rebuttal')}</h2>
              </div>
              <div className="debate-panel__body">
                <div
                  className="debate-quote-frame"
                  style={{ backgroundImage: `url(${DEBATE_UI_ASSETS.quoteFrame})` }}
                >
                  <p className="debate-result-quote">{payload.result.best_rebuttal}</p>
                </div>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h2>{t('debate.result_judge_summary')}</h2>
              </div>
              <div className="debate-panel__body">
                <div
                  className="debate-quote-frame"
                  style={{ backgroundImage: `url(${DEBATE_UI_ASSETS.quoteFrame})` }}
                >
                  <p className="debate-result-quote">{payload.result.judge_summary}</p>
                </div>
              </div>
            </section>
          </div>

          <div className="debate-result-stack">
            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.result_replay')}</h3>
              </div>
              <div className="debate-panel__body">
                <div className="debate-replay-list">
                  {payload.result.replay.map((item) => (
                    <article key={item.phase} className="debate-replay-card">
                      <div className="debate-replay-card__meta">
                        <span className="debate-phase-chip">{getDebatePhaseLabel(t, item.phase)}</span>
                        <span>{item.speaker_name}</span>
                      </div>
                      <p className="debate-replay-card__quote">{item.quote}</p>
                    </article>
                  ))}
                </div>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.result_predictions')}</h3>
              </div>
              <div className="debate-panel__body">
                {payload.predictions.length > 0 ? (
                  <div className="debate-prediction-list">
                    {payload.predictions.map((prediction) => (
                      <article key={prediction.id} className="debate-prediction-card">
                        <div className="debate-prediction-card__meta">
                          <strong>{prediction.user_name}</strong>
                          <span className="debate-outcome-chip">
                            {isPredictionHit(prediction, payload.result) ? t('result.bet_status_hit') : t('result.bet_status_miss')}
                          </span>
                        </div>
                        <p>
                          {prediction.kind === 'winner'
                            ? `${t('debate.bet_kind_winner')}: ${getDebateSideLabel(t, prediction.target_value as 'proposition' | 'opposition' | 'judge')}`
                            : `${t('debate.bet_kind_tone')}: ${getDebateVerdictToneLabel(t, prediction.target_value)}`}
                        </p>
                        {prediction.score_reason && (
                          <p className="debate-rule-copy">{prediction.score_reason}</p>
                        )}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="debate-empty-state">{t('debate.result_empty_predictions')}</p>
                )}
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.counterplay_title')}</h3>
              </div>
              <div className="debate-panel__body">
                <div className="debate-turn-list">
                  <article className="debate-turn-card">
                    <div className="debate-turn-card__meta">
                      <strong>{t('debate.counterplay_title')}</strong>
                      <span className="debate-outcome-chip">
                        {counterplayOutcome === 'hit'
                          ? t('debate.counterplay_hit')
                          : counterplayOutcome === 'miss'
                            ? t('debate.counterplay_miss')
                            : t('debate.counterplay_unused')}
                      </span>
                    </div>
                    <p className="debate-rule-copy">
                      {counterplaySummary ?? t('debate.counterplay_unused')}
                    </p>
                  </article>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      {showShare && shareContext && (
        <DebateShareModal
          context={shareContext}
          onClose={() => setShowShare(false)}
          onAutomationStateChange={setShareModalState}
        />
      )}
    </div>
  );
}
