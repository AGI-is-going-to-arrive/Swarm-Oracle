import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { getDebateResult, importReplayDebate, isApiError } from '../api/client';
import { buildAutomationErrorState, getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
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
import {
  buildDebatePhaseSummaries,
  getDebateScoreLeader,
} from '../lib/debateInsights';
import { buildDebateReplayUrl, readDebateReplayPayload } from '../lib/debateReplay';
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
  const [searchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const [payload, setPayload] = useState<DebateResultPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [shareModalState, setShareModalState] = useState<Record<string, unknown> | null>(null);
  const [importingReplay, setImportingReplay] = useState(false);
  const replayPayload = useMemo(
    () => readDebateReplayPayload(searchParams),
    [searchParams],
  );
  const isReplayMode = Boolean(replayPayload);

  useEffect(() => {
    if (replayPayload) {
      setPayload(replayPayload);
      setError('');
      setErrorCode(null);
      setLoading(false);
      return;
    }
    if (!id) {
      setError(t('debate.result_missing'));
      setErrorCode('DEBATE_RESULT_MISSING');
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const load = async () => {
      try {
        const nextPayload = await getDebateResult(id);
        if (cancelled) return;
        setPayload(nextPayload);
        setError('');
        setErrorCode(null);
        setLoading(false);
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : t('debate.result_load_failed');
        if (isApiError(nextError) && nextError.status === 409) {
          timer = window.setTimeout(() => void load(), 1200);
          return;
        }
        if (!cancelled) {
          setErrorCode(getApiErrorCode(nextError) ?? 'DEBATE_RESULT_LOAD_FAILED');
          setError(getLocalizedApiErrorMessage(nextError, t, message));
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [id, replayPayload, t]);

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
  const adjudicationModeLabel = useMemo(() => {
    const mode = payload?.result.adjudication_mode ?? 'deterministic';
    return mode === 'llm_hybrid'
      ? t('debate.adjudication_llm_hybrid')
      : t('debate.adjudication_deterministic');
  }, [payload?.result.adjudication_mode, t]);
  const counterplayExplanation = payload?.counterplay?.explanation ?? null;
  const counterplayOutcome = useMemo(
    () => resolveDebateCounterplayOutcome(counterplayRecord, payload?.result),
    [counterplayRecord, payload?.result],
  );
  const judgeRationale = payload?.result?.judge_rationale ?? null;
  const supportingTurns = judgeRationale?.supporting_turns ?? [];
  const phaseSummaries = useMemo(
    () => buildDebatePhaseSummaries(payload?.turns ?? [], payload ? payload.turns.map((turn) => turn.phase) : []),
    [payload],
  );
  const serverPhaseInsights = payload?.phase_insights ?? [];
  const serverPhaseInsightMap = useMemo(
    () => new Map(serverPhaseInsights.map((insight) => [insight.phase, insight])),
    [serverPhaseInsights],
  );
  const predictionStats = useMemo(() => {
    const total = payload?.predictions.length ?? 0;
    const hitCount = payload?.predictions.filter((prediction) => isPredictionHit(prediction, payload.result)).length ?? 0;
    return {
      total,
      hitCount,
      hitRate: total > 0 ? Math.round((hitCount / total) * 100) : 0,
    };
  }, [payload]);
  const scoreLeader = useMemo(
    () => getDebateScoreLeader(payload?.result.score.proposition ?? 0, payload?.result.score.opposition ?? 0),
    [payload?.result.score.opposition, payload?.result.score.proposition],
  );
  const hingeTurn = supportingTurns[0] ?? null;
  const signalCards = useMemo(() => {
    if (!payload) return [];
    const winnerLabel = getDebateSideLabel(t, payload.result.winner);
    return [
      {
        label: t('debate.result_signal_winner'),
        value: winnerLabel,
        detail: `${t('debate.result_tone')}: ${getDebateVerdictToneLabel(t, payload.result.verdict_tone)}`,
      },
      {
        label: t('debate.result_signal_hinge'),
        value: hingeTurn
          ? `${getDebatePhaseLabel(t, hingeTurn.phase)} · ${hingeTurn.speaker_name}`
          : t('debate.result_judge_summary'),
        detail: hingeTurn?.why_it_matters ?? judgeRationale?.swing_factor ?? payload.result.judge_summary,
      },
      {
        label: t('debate.result_signal_predictions'),
        value: predictionStats.total > 0
          ? `${predictionStats.hitCount}/${predictionStats.total}`
          : '0',
        detail: predictionStats.total > 0
          ? t('debate.result_predictions_hit_rate', { value: predictionStats.hitRate })
          : t('debate.result_predictions_empty'),
      },
      {
        label: t('debate.result_signal_counterplay'),
        value: counterplayOutcome === 'hit'
          ? t('debate.counterplay_hit')
          : counterplayOutcome === 'miss'
            ? t('debate.counterplay_miss')
            : t('debate.counterplay_unused'),
        detail: counterplaySummary
          ?? counterplayExplanation
          ?? t('debate.result_counterplay_none'),
      },
    ];
  }, [counterplayExplanation, counterplayOutcome, counterplaySummary, hingeTurn, judgeRationale?.swing_factor, payload, predictionStats.hitCount, predictionStats.hitRate, predictionStats.total, t]);

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
      counterplayExplanation,
      supportingTurns: (payload.result.judge_rationale?.supporting_turns ?? []).map((turn) => (
        `${getDebatePhaseLabel(t, turn.phase)} · ${turn.speaker_name}: ${turn.quote} ${turn.why_it_matters}`
      )),
      counterplayOutcomeLabel:
        counterplayOutcome === 'hit'
          ? t('debate.counterplay_hit')
          : counterplayOutcome === 'miss'
            ? t('debate.counterplay_miss')
            : null,
      permalinkUrl: buildDebateReplayUrl(window.location.origin, payload),
    };
  }, [counterplayExplanation, counterplayOutcome, counterplaySummary, payload, t]);

  const handleImportReplay = async () => {
    if (!replayPayload || importingReplay) return;
    setImportingReplay(true);
    try {
      const imported = await importReplayDebate(replayPayload);
      navigate(`/debate/${imported.id}/result`);
    } finally {
      setImportingReplay(false);
    }
  };

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
        error: buildAutomationErrorState(errorCode, error),
        replay_source: replayPayload ? 'token' : 'api',
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
          adjudication_mode: payload.result.adjudication_mode ?? 'deterministic',
          score: payload.result.score,
          prediction_count: payload.predictions.length,
          prediction_stats: predictionStats,
          judge_rationale: judgeRationale,
          supporting_turns: supportingTurns.map((turn) => ({
            id: turn.id,
            phase: turn.phase,
            speaker_name: turn.speaker_name,
            quote: turn.quote,
            why_it_matters: turn.why_it_matters,
          })),
          phase_summaries: phaseSummaries,
          server_phase_insights: serverPhaseInsights,
          signal_cards: signalCards,
          counterplay_summary: counterplaySummary ?? null,
          counterplay_explanation: counterplayExplanation,
          counterplay_outcome: counterplayOutcome,
          score_leader: scoreLeader,
        } : null,
      },
    );
    return () => {
      if (win.render_game_to_text) delete win.render_game_to_text;
      if (win.advanceTime === advance) delete win.advanceTime;
      if (win.capture_game_screenshot === capture) delete win.capture_game_screenshot;
    };
  }, [counterplayExplanation, counterplayOutcome, counterplaySummary, error, errorCode, judgeRationale, loading, payload, phaseSummaries, predictionStats, replayPayload, scoreLeader, serverPhaseInsights, shareModalState, showShare, signalCards, supportingTurns]);

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
              <p className="debate-hero__subtitle">
                {t('debate.result_adjudication')}: {adjudicationModeLabel}
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
                {isReplayMode && (
                  <button type="button" className="btn btn-ghost" onClick={() => void handleImportReplay()} disabled={importingReplay}>
                    {importingReplay
                      ? (isZh ? '导入中...' : 'Importing...')
                      : (isZh ? '导入为本地运行' : 'Import as Local Run')}
                  </button>
                )}
                <button type="button" className="btn btn-primary" onClick={() => setShowShare(true)}>
                  {t('debate.open_share')}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="debate-situation-grid" aria-label={t('debate.result_signal_winner')}>
          {signalCards.map((card) => (
            <article key={card.label} className="debate-situation-card">
              <span className="debate-situation-card__eyebrow">{card.label}</span>
              <strong className="debate-situation-card__value">{card.value}</strong>
              <p className="debate-situation-card__detail">{card.detail}</p>
            </article>
          ))}
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
                      {judgeRationale?.dimension_rationales?.[dimension] && (
                        <p className="debate-rule-copy">{judgeRationale.dimension_rationales[dimension]}</p>
                      )}
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

            {judgeRationale && (
              <section className="debate-panel">
                <div className="debate-panel__header">
                  <h2>{t('debate.result_verdict_logic')}</h2>
                </div>
                <div className="debate-panel__body">
                  <div className="debate-turn-list">
                    {judgeRationale.winner_reason && (
                      <article className="debate-turn-card">
                        <div className="debate-turn-card__meta">
                          <strong>{t('debate.result_winner_reason')}</strong>
                        </div>
                        <p className="debate-rule-copy">{judgeRationale.winner_reason}</p>
                      </article>
                    )}
                    {judgeRationale.loser_gap && (
                      <article className="debate-turn-card">
                        <div className="debate-turn-card__meta">
                          <strong>{t('debate.result_loser_gap')}</strong>
                        </div>
                        <p className="debate-rule-copy">{judgeRationale.loser_gap}</p>
                      </article>
                    )}
                    {judgeRationale.swing_factor && (
                      <article className="debate-turn-card">
                        <div className="debate-turn-card__meta">
                          <strong>{t('debate.result_swing_factor')}</strong>
                        </div>
                        <p className="debate-rule-copy">{judgeRationale.swing_factor}</p>
                      </article>
                    )}
                    {judgeRationale.closing_note && (
                      <article className="debate-turn-card">
                        <div className="debate-turn-card__meta">
                          <strong>{t('debate.result_closing_note')}</strong>
                        </div>
                        <p className="debate-rule-copy">{judgeRationale.closing_note}</p>
                      </article>
                    )}
                    {judgeRationale.supporting_turns?.map((turn) => (
                      <article key={turn.id} className="debate-turn-card">
                        <div className="debate-turn-card__meta">
                          <strong>{t('debate.result_supporting_turn')}</strong>
                          <span className="debate-phase-chip">{getDebatePhaseLabel(t, turn.phase)}</span>
                          <span>{turn.speaker_name}</span>
                        </div>
                        <p className="debate-replay-card__quote">{turn.quote}</p>
                        <p className="debate-rule-copy">{turn.why_it_matters}</p>
                      </article>
                    ))}
                  </div>
                </div>
              </section>
            )}
          </div>

          <div className="debate-result-stack">
            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.result_phase_map')}</h3>
                <span className="debate-phase-chip">
                  {scoreLeader.leader === 'balanced'
                    ? t('debate.phase_balance')
                    : getDebateSideLabel(t, scoreLeader.leader)}
                </span>
              </div>
              <div className="debate-panel__body">
                <div className="debate-stage-summary-list">
                  {phaseSummaries.map((summary) => {
                    const serverInsight = serverPhaseInsightMap.get(summary.phase);
                    return (
                      <article key={summary.phase} className="debate-stage-summary-card">
                        <div className="debate-stage-summary-card__meta">
                          <span className="debate-phase-chip">{getDebatePhaseLabel(t, summary.phase)}</span>
                          <span>{summary.lastSpeakerName ?? t('debate.loading')}</span>
                        </div>
                        <strong className="debate-stage-summary-card__value">
                          {summary.swing === 0
                            ? t('debate.stage_swing_even')
                            : t('debate.stage_swing_edge', {
                              side: summary.leader === 'balanced'
                                ? t('debate.phase_balance')
                                : getDebateSideLabel(t, summary.leader),
                              value: summary.swing,
                            })}
                        </strong>
                        <p className="debate-stage-summary-card__detail">
                          {summary.turnCount > 0
                            ? t('debate.stage_turn_count', { count: summary.turnCount })
                            : t('debate.loading')}
                        </p>
                        {serverInsight?.commentary && (
                          <p className="debate-stage-summary-card__detail">{serverInsight.commentary}</p>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            </section>

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
                          <div className="debate-turn-card__tags">
                            <span className="debate-outcome-chip">
                              {isPredictionHit(prediction, payload.result) ? t('result.bet_status_hit') : t('result.bet_status_miss')}
                            </span>
                            <span className="debate-phase-chip">
                              {t('debate.result_prediction_confidence', { value: Math.round(prediction.confidence * 100) })}
                            </span>
                          </div>
                        </div>
                        <p>
                          {prediction.kind === 'winner'
                            ? `${t('debate.bet_kind_winner')}: ${getDebateSideLabel(t, prediction.target_value as 'proposition' | 'opposition' | 'judge')}`
                            : `${t('debate.bet_kind_tone')}: ${getDebateVerdictToneLabel(t, prediction.target_value)}`}
                        </p>
                        {prediction.score != null && (
                          <p className="debate-rule-copy">
                            {t('debate.score_label')}: {prediction.score}
                          </p>
                        )}
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
                    {counterplayExplanation && (
                      <p className="debate-rule-copy">{counterplayExplanation}</p>
                    )}
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
