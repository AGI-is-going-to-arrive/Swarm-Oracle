/* ═══════════════════════════════════════════════════════════
   SwarmOracle — ResultView (Multi-Ending Comparison)
   ═══════════════════════════════════════════════════════════ */

import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getScenario, getStory, getAgents, exportScenario, listPredictions, scorePredictions } from '../api/client';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import {
  getChallengeProgress,
  getTodayChallenge,
  isChallengeScenario,
  markChallengeCompleted,
} from '../lib/dailyChallenge';
import { buildArchiveSummary, getDirectorStyleLabel } from '../lib/archiveSummary';
import { loadScenarioMeta, updateArchive } from '../lib/scenarioMeta';
import {
  getEndingToneLabel,
  getPredictionRationale,
  getStructuredBetKindLabel,
  parseStructuredPredictionText,
  resolveStructuredBetOutcome,
  type StructuredBetOutcome,
} from '../lib/predictionBetting';
import { buildExportArchivePreface, type ShareFlavorContext } from '../lib/shareEnvelope';
import { getTheaterThemeLabel } from '../lib/themeLabels';
import {
  getGameplayBadgeSrc,
  getGameplayCardDefinition,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
  inferGameplayProfile,
} from '../components/gameplayCards';
import type { StoryData, AgentInfo, PredictionInfo, Scenario } from '../types';
import ShareModal from '../components/ShareModal';
import './ResultView.css';

function getBetOutcomeLabel(
  outcome: StructuredBetOutcome,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  if (outcome === 'hit') return t('result.bet_status_hit');
  if (outcome === 'miss') return t('result.bet_status_miss');
  return t('result.bet_status_pending');
}

function getBetOutcomeClass(outcome: StructuredBetOutcome) {
  return `bet-outcome-chip bet-outcome-chip--${outcome}`;
}

export default function ResultView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const [storyData, setStoryData] = useState<StoryData | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [predictions, setPredictions] = useState<PredictionInfo[]>([]);
  const [expandedBranch, setExpandedBranch] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [shareAutomation, setShareAutomation] = useState<Record<string, unknown> | null>(null);
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState('');
  const hasUnscored = predictions.some((p) => p.score == null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let retryTimer: number | null = null;

    const load = async () => {
      try {
        // Fetch story and scenario in parallel, handle prediction API failure gracefully
        const [story, agentList, scenario, preds] = await Promise.all([
          getStory(id),
          getAgents(id),
          getScenario(id),
          listPredictions(id).catch(() => [] as PredictionInfo[]),
        ]);
        if (cancelled) return;

        setScenario(scenario);
        setAgents(agentList);
        setPredictions(preds);

        if (scenario.status !== 'done') {
          retryTimer = window.setTimeout(() => {
            retryTimer = null;
            void load();
          }, 1500);
          return;
        }

        // Story API might not include question — merge from scenario
        setStoryData({
          ...story,
          question: story.question || scenario.question,
        });
        const todayChallenge = getTodayChallenge();
        const isDailyChallenge = isChallengeScenario(todayChallenge.id, id);
        const profile = inferGameplayProfile(scenario.question, scenario.scene_theme);
        const nextMeta = updateArchive(id, {
          question: scenario.question,
          sceneTheme: scenario.scene_theme,
          profileId: profile.id,
          branchSnapshots: story.branches.map((branch) => ({
            branchId: branch.id,
            title: branch.title,
            probability: branch.probability,
          })),
        });
        const archiveSummary = buildArchiveSummary({
          branches: story.branches,
          usages: nextMeta.cards.usageLog,
          bets: nextMeta.betting.bets,
          keyMomentCount: nextMeta.archive.keyMoments.length,
          isDailyChallenge,
          profileId: profile.id,
        });
        const finalMeta = updateArchive(id, archiveSummary);
        if (isDailyChallenge) {
          markChallengeCompleted(todayChallenge.id, id, {
            resultBranchId: story.branches[0]?.id,
            usedCards: finalMeta.cards.usageLog.map((usage) => usage.cardId),
            betPlaced: finalMeta.betting.bets.length > 0,
            bettingHit: archiveSummary.bettingHit ?? null,
            profileResonance: archiveSummary.profileResonance,
          });
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load results');
      } finally {
        if (!cancelled && retryTimer == null) {
          setLoading(false);
        }
      }
    };

    setLoading(true);
    setError('');
    setStoryData(null);
    void load();

    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [id]);

  useEffect(() => {
    const win = window as AutomationWindow;
    const render = () => stringifyAutomationPayload(
      {
        question: storyData?.question ?? null,
        status: loading ? 'loading' : error ? 'error' : 'done',
        currentRound: 0,
        totalRounds: null,
        viewMode: 'classic',
        visualizationEnabled: false,
        isSimulationComplete: !loading && !error,
        messageCount: 0,
        agentCount: agents.length,
        branchCount: storyData?.branches.length ?? 0,
      },
      null,
      {
        route: window.location.pathname,
        kind: 'result',
        loading,
        error: error || null,
        question: storyData?.question ?? null,
        branch_titles: (storyData?.branches ?? []).map((branch) => branch.title),
        predictions_count: predictions.length,
        has_unscored: hasUnscored,
        archive_summary: storyData && id
          ? (() => {
              const currentMeta = loadScenarioMeta(id);
              return {
                most_used_card: currentMeta.archive.mostUsedCard ?? null,
                betting_hit: currentMeta.archive.bettingHit ?? null,
                archive_grade: currentMeta.archive.archiveGrade ?? null,
                dominant_branch_title: currentMeta.archive.dominantBranchTitle ?? null,
                dominant_tone: currentMeta.archive.dominantTone ?? null,
              };
            })()
          : null,
        controls: {
          can_go_back_to_simulation: true,
          can_export_markdown: !exporting,
          can_open_share_modal: true,
          can_open_leaderboard: true,
          can_score_predictions: hasUnscored && !scoring,
          active_modal: showShare ? 'share' : null,
          modal_state: showShare ? shareAutomation : null,
          expanded_branch_id: expandedBranch,
        },
        branches: (storyData?.branches ?? []).slice(0, 8).map((branch) => ({
          id: branch.id,
          title: branch.title,
          probability: branch.probability,
          has_story: Boolean(branch.story),
          can_expand_story: Boolean(branch.story && branch.story.length > 150),
          expanded: expandedBranch === branch.id,
        })),
      },
    );

    win.render_game_to_text = render;
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
    };
  }, [agents.length, error, expandedBranch, exporting, hasUnscored, loading, predictions, scoring, shareAutomation, showShare, storyData]);

  const handleExport = async () => {
    if (!id || exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const markdown = await exportScenario(id);
      const themedMarkdown = buildExportArchivePreface(markdown, shareFlavorContext, isZh);
      const blob = new Blob([themedMarkdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `swarmoracle-${id.slice(0, 8)}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleScore = async () => {
    if (!id || scoring) return;
    setScoring(true);
    setScoreError('');
    try {
      await scorePredictions(id);
      // Reload predictions to show scores
      const preds = await listPredictions(id);
      setPredictions(preds);
    } catch (err) {
      setScoreError(err instanceof Error ? err.message : 'Scoring failed');
    } finally {
      setScoring(false);
    }
  };

  const branches = storyData?.branches ?? [];
  const scenarioMeta = id ? loadScenarioMeta(id) : null;
  const gameplayProfileLabel =
    scenarioMeta?.archive.profileId
      ? getGameplayProfileLabel(scenarioMeta.archive.profileId, isZh)
      : null;
  const gameplayProfileHooks = scenarioMeta?.archive.profileId
    ? getGameplayProfileSignatureHooks(scenarioMeta.archive.profileId, isZh)
    : [];
  const dominantBranch = useMemo(() => (
    scenarioMeta?.archive.dominantBranchTitle
      ? branches.find((branch) => branch.title === scenarioMeta.archive.dominantBranchTitle) ?? null
      : null
  ), [branches, scenarioMeta?.archive.dominantBranchTitle]);
  const challenge = getTodayChallenge();
  const isDailyChallenge = id ? isChallengeScenario(challenge.id, id) : false;
  const challengeProgress = isDailyChallenge ? getChallengeProgress(challenge.id) : null;
  const profileResonanceLabel = scenarioMeta?.archive.profileResonance
    ? t(`result.archive_resonance_${scenarioMeta.archive.profileResonance}`)
    : t('result.archive_unset');
  const challengeFeedbackLabel = challengeProgress?.profileResonance
    ? `${gameplayProfileLabel ?? ''} · ${t(`result.archive_resonance_${challengeProgress.profileResonance}`)}`
    : null;
  const directorStyleLabel = scenarioMeta?.archive.directorStyleTag
    ? getDirectorStyleLabel(
        scenarioMeta.archive.directorStyleTag as Parameters<typeof getDirectorStyleLabel>[0],
        isZh,
      )
    : null;
  const shareFlavorContext = useMemo<ShareFlavorContext>(() => ({
    question: storyData?.question ?? null,
    profileLabel: gameplayProfileLabel,
    profileHooks: gameplayProfileHooks,
    resonanceLabel: profileResonanceLabel,
    directorStyleLabel,
    dominantBranchTitle: scenarioMeta?.archive.dominantBranchTitle ?? null,
  }), [
    storyData?.question,
    gameplayProfileLabel,
    gameplayProfileHooks,
    profileResonanceLabel,
    directorStyleLabel,
    scenarioMeta?.archive.dominantBranchTitle,
  ]);
  const betOutcomeContext = useMemo(() => ({
    dominantBranchId: dominantBranch?.id ?? null,
    dominantBranchTitle: scenarioMeta?.archive.dominantBranchTitle ?? null,
    dominantTone: scenarioMeta?.archive.dominantTone ?? null,
    profileResonance: scenarioMeta?.archive.profileResonance ?? null,
  }), [
    dominantBranch?.id,
    scenarioMeta?.archive.dominantBranchTitle,
    scenarioMeta?.archive.dominantTone,
    scenarioMeta?.archive.profileResonance,
  ]);
  const localBetOutcomes = useMemo(() => (
    scenarioMeta?.betting.bets.map((bet) => ({
      bet,
      outcome: resolveStructuredBetOutcome(bet, betOutcomeContext),
    })) ?? []
  ), [betOutcomeContext, scenarioMeta?.betting.bets]);
  const hitBetCount = localBetOutcomes.filter((entry) => entry.outcome === 'hit').length;
  const resolvedBetCount = localBetOutcomes.filter((entry) => entry.outcome !== 'pending').length;

  if (loading) {
    return (
      <div className="result-view">
        <p className="result-loading">
          {scenario?.status && scenario.status !== 'done'
            ? t('result.loading_narration')
            : t('sim.status.loading')}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="result-view">
        <p className="result-error">{error}</p>
        <button className="btn" onClick={() => navigate('/')}>
          {t('sim.status.back')}
        </button>
      </div>
    );
  }

  const mostUsedCardLabel = scenarioMeta?.archive.mostUsedCard
    ? (isZh
      ? getGameplayCardDefinition(scenarioMeta.archive.mostUsedCard).labelZh
      : getGameplayCardDefinition(scenarioMeta.archive.mostUsedCard).labelEn)
    : t('result.archive_no_cards');
  const bettingHitLabel =
    !scenarioMeta || scenarioMeta.betting.bets.length === 0
      ? t('result.archive_no_bets')
      : resolvedBetCount === 0
        ? t('result.archive_pending')
        : t('result.archive_hit_ratio', { hit: hitBetCount, total: scenarioMeta.betting.bets.length });
  const dominantToneLabel = scenarioMeta?.archive.dominantTone
    ? getEndingToneLabel(scenarioMeta.archive.dominantTone, isZh)
    : t('result.archive_unset');

  return (
    <div className="result-view">
      {/* Header */}
      <header className="result-header">
        <button
          className="btn btn-ghost result-back"
          onClick={() => navigate(`/sim/${id}`)}
        >
          {t('result.back')}
        </button>
        <h1 className="result-title">{t('result.title')}</h1>
        {storyData?.question && (
          <p className="result-question">{storyData.question}</p>
        )}
        <p className="result-subtitle">
          {t('result.subtitle')} — {branches.length} {t('result.ending_card').toLowerCase()}
          {branches.length !== 1 ? 's' : ''}
        </p>
        <div className="result-actions">
          <button
            className="btn"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? t('result.exporting') : t('result.export')}
          </button>
          <button
            className="btn"
            onClick={() => setShowShare(true)}
          >
            {t('result.share_btn')}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => navigate('/leaderboard')}
          >
            {t('result.leaderboard_link')}
          </button>
        </div>
        {exportError && <p className="result-error result-error--spaced">{exportError}</p>}
      </header>

      {/* Ending Cards Grid */}
      {branches.length === 0 ? (
        <div className="result-empty">
          <p>{t('result.no_stories')}</p>
        </div>
      ) : (
        <div className="endings-grid">
          {branches.map((branch, index) => (
            <article
              key={branch.id}
              className={`ending-card ${expandedBranch === branch.id ? 'expanded' : ''}`}
              ref={(el) => { if (el) el.style.setProperty('--card-delay', `${index * 0.1}s`); }}
            >
              <div className="ending-header">
                <span className="ending-index">
                  {t('result.ending_card')} {index + 1}
                </span>
                <h2 className="ending-title">{branch.title}</h2>
              </div>

              {/* Probability Bar */}
              <div className="probability-section">
                <div className="probability-label">
                  <span>{t('result.probability')}</span>
                  <span className="probability-value">
                    {((branch.probability ?? 0) * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="probability-bar">
                  <div
                    className="probability-fill"
                    ref={(el) => { if (el) el.style.setProperty('--prob-fill', `${Math.max((branch.probability ?? 0) * 100, 2)}%`); }}
                  />
                </div>
              </div>

              {/* Fork Reason */}
              {branch.fork_reason && (
                <div className="fork-reason">
                  <span className="fork-label">{t('result.fork_reason')}</span>
                  <p>{branch.fork_reason}</p>
                </div>
              )}

              {/* Story Preview / Full */}
              <div className="story-section">
                <h3 className="section-label">{t('result.story')}</h3>
                <p className={`story-text ${expandedBranch === branch.id ? 'full' : 'preview'}`}>
                  {branch.story || '—'}
                </p>
                {branch.story && branch.story.length > 150 && (
                  <button
                    className="btn btn-ghost expand-btn"
                    onClick={() =>
                      setExpandedBranch(
                        expandedBranch === branch.id ? null : branch.id,
                      )
                    }
                  >
                    {expandedBranch === branch.id
                      ? t('result.collapse')
                      : t('result.read_full')}
                  </button>
                )}
              </div>

              {/* Insight */}
              {branch.insight && (
                <div className="insight-section">
                  <h3 className="section-label">{t('result.insight')}</h3>
                  <blockquote className="insight-quote">{branch.insight}</blockquote>
                </div>
              )}

              {/* Key Moments */}
              {branch.key_moments && branch.key_moments.length > 0 && (
                <div className="moments-section">
                  <h3 className="section-label">{t('result.key_moments')}</h3>
                  <ol className="moments-list">
                    {branch.key_moments.map((moment, mi) => (
                      <li key={mi}>{moment}</li>
                    ))}
                  </ol>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {/* Predictions Section (P5-B) */}
      {predictions.length > 0 && (
        <section className="result-predictions">
          <h2 className="result-predictions-title">{t('result.predictions_title')}</h2>
          {hasUnscored && (
            <button
              className="btn result-score-btn"
              onClick={handleScore}
              disabled={scoring}
            >
              {scoring ? t('result.scoring') : t('result.score_predictions')}
            </button>
          )}
          {scoreError && <p className="result-error">{scoreError}</p>}
          <div className="predictions-grid">
            {predictions.map((p) => (
              <div key={p.id} className="prediction-card">
                {(() => {
                  const structuredBet = parseStructuredPredictionText(p.prediction_text);
                  const structuredOutcome = structuredBet
                    ? resolveStructuredBetOutcome(structuredBet.meta, betOutcomeContext)
                    : null;
                  return (
                    <>
                <div className="prediction-card__header">
                  <span className="prediction-card__user">{p.user_name}</span>
                  <span className="prediction-card__confidence">
                    {Math.round((p.confidence ?? 0) * 100)}%
                  </span>
                </div>
                {structuredBet && (
                  <div className="prediction-card__bet-row">
                    <p className="prediction-card__bet-kind">
                      {getStructuredBetKindLabel(structuredBet.meta.kind, isZh)}
                      {' · '}
                      {structuredBet.meta.targetLabel}
                    </p>
                    {structuredOutcome && (
                      <span className={getBetOutcomeClass(structuredOutcome)}>
                        {getBetOutcomeLabel(structuredOutcome, t)}
                      </span>
                    )}
                  </div>
                )}
                <p className="prediction-card__text">{getPredictionRationale(p.prediction_text)}</p>
                {p.score != null && (
                  <div className="prediction-card__score">
                    <span className="score-value">{p.score.toFixed(0)}</span>
                    <span className="score-label">/ 100</span>
                    {p.score_reason && (
                      <p className="score-reason">{p.score_reason}</p>
                    )}
                  </div>
                )}
                    </>
                  );
                })()}
              </div>
            ))}
          </div>
        </section>
      )}

      {scenarioMeta && (
        <section className="result-archive">
          <h2 className="result-archive__title">
            <img src={getGameplayBadgeSrc('archive_record')} alt="" aria-hidden="true" />
            <span>{t('result.archive_title')}</span>
          </h2>
          <img
            className="result-archive__art"
            src="/assets/ui/generated/archive_panel.png"
            alt="Archive seal illustration"
          />
          <div className="result-archive__meta">
            {gameplayProfileLabel && (
              <span className="archive-chip archive-chip--primary">{gameplayProfileLabel}</span>
            )}
            {scenario?.scene_theme && (
              <span className="archive-chip">{getTheaterThemeLabel(scenario.scene_theme, isZh)}</span>
            )}
            {isDailyChallenge && (
              <span className="archive-chip archive-chip--challenge">
                <img src={getGameplayBadgeSrc('daily_challenge')} alt="" aria-hidden="true" />
                <span>{t('result.archive_daily_challenge')}</span>
              </span>
            )}
            <span className="archive-chip">
              {t('result.archive_director_points', {
                remaining: scenarioMeta.director.remainingPoints,
                max: scenarioMeta.director.maxPoints,
              })}
            </span>
            {scenarioMeta.archive.bettingHit === true && (
              <span className="archive-chip archive-chip--winner">
                <img src={getGameplayBadgeSrc('bet_winner')} alt="" aria-hidden="true" />
                <span>{t('result.archive_bet_hit')}</span>
              </span>
            )}
            {directorStyleLabel && (
              <span className="archive-chip">
                {directorStyleLabel}
              </span>
            )}
          </div>
          {gameplayProfileHooks.length > 0 && (
            <div className="result-archive__hooks" aria-label={isZh ? '题材钩子' : 'Theme hooks'}>
              {gameplayProfileHooks.map((hook) => (
                <span key={hook} className="archive-chip archive-chip--hook">
                  {hook}
                </span>
              ))}
            </div>
          )}

          <div className="archive-summary-grid">
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_dominant_branch')}</span>
              <strong>{scenarioMeta.archive.dominantBranchTitle ?? t('result.archive_unset')}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_dominant_tone')}</span>
              <strong>{dominantToneLabel}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_most_used_card')}</span>
              <strong>{mostUsedCardLabel}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_bet_result')}</span>
              <strong>{bettingHitLabel}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_grade')}</span>
              <strong>{scenarioMeta.archive.archiveGrade ?? 'C'}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_resonance')}</span>
              <strong>{profileResonanceLabel}</strong>
            </div>
            <div className="archive-summary-card">
              <span className="archive-summary-card__label">{t('result.archive_challenge_feedback')}</span>
              <strong>
                {challengeProgress
                  ? `${challengeProgress.completed ? t('result.archive_completed') : t('result.archive_in_progress')} · ${challengeFeedbackLabel ?? t('result.archive_cards_used', { count: challengeProgress.usedCards.length })}`
                  : t('result.archive_regular_run')}
              </strong>
            </div>
          </div>

          {scenarioMeta.cards.usageLog.length > 0 && (
            <div className="result-archive__section">
              <h3>{t('result.archive_cards_section')}</h3>
              <div className="archive-list">
                {scenarioMeta.cards.usageLog.map((usage, index) => (
                  <div key={`${usage.usedAt}-${index}`} className="archive-item">
                    <strong>{isZh ? getGameplayCardDefinition(usage.cardId).labelZh : getGameplayCardDefinition(usage.cardId).labelEn}</strong>
                    <span>R{usage.round} · {usage.branchTitle}</span>
                    <p>{usage.directive}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {scenarioMeta.betting.bets.length > 0 && (
            <div className="result-archive__section">
              <h3>{t('result.archive_bets_section')}</h3>
              <div className="archive-list">
                {localBetOutcomes.map(({ bet, outcome }) => (
                  <div key={bet.betId} className="archive-item">
                    <div className="archive-item__top">
                      <strong>{bet.targetLabel}</strong>
                      <span className={getBetOutcomeClass(outcome)}>
                        {getBetOutcomeLabel(outcome, t)}
                      </span>
                    </div>
                    <span>R{bet.placedAtRound} · {Math.round(bet.confidence * 100)}%</span>
                    <p>{getStructuredBetKindLabel(bet.kind, isZh)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {scenarioMeta.archive.keyMoments.length > 0 && (
            <div className="result-archive__section">
              <h3>{t('result.archive_moments_section')}</h3>
              <ul className="archive-moments">
                {scenarioMeta.archive.keyMoments.map((moment, index) => (
                  <li key={`${moment}-${index}`}>{moment}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Agent Roster */}
      {agents.length > 0 && (
        <section className="result-agents">
          <h2 className="result-agents-title">{t('result.agents')}</h2>
          <div className="result-agents-grid">
            {agents.map((agent) => (
              <div key={agent.id} className="result-agent-card">
                <span className="result-agent-name">{agent.name}</span>
                <span className="result-agent-role">{agent.role}</span>
                {agent.tier && (
                  <span className={`tier-badge tier-${agent.tier.toLowerCase()}`}>
                    {agent.tier}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Share Modal (P6) */}
      {showShare && id && (
        <ShareModal
          scenarioId={id}
          shareContext={shareFlavorContext}
          onAutomationStateChange={setShareAutomation}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}
