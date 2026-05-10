/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Director's Notebook (collapsible archive panel)
   ═══════════════════════════════════════════════════════════ */

import {
  getGameplayBadgeSrc,
  getGameplayCardDefinition,
  getGameplaySignatureArcState,
  getScenarioSystemTrackState,
} from '../../components/gameplayCards';
import {
  getEndingToneLabel,
  type EndingToneId,
  type StructuredBetOutcome,
} from '../../lib/predictionBetting';
import { getTheaterThemeLabel } from '../../lib/themeLabels';
import type { StructuredBetRecord } from '../../lib/scenarioMeta';
import type { EvaluatedDirectorObjective } from '../../lib/directorObjectives';
import type { ChallengeProgressEntry } from '../../lib/dailyChallenge';
import { getBetOutcomeLabel } from './../resultHelpers';
import { useResultContext } from './ResultContext';

export interface DirectorNotebookArchiveProps {
  displayArchive: {
    profileId: string | null;
    dominantBranchTitle: string | null;
    dominantTone: EndingToneId | null;
    mostUsedCard: string | null;
    bettingHit: boolean | null;
    archiveGrade: string | null;
    directorStyleTag: string | null;
    profileResonance: string | null;
    objectiveCompletedCount: number;
    objectiveTotalCount: number;
    commitmentOutcome: 'hit' | 'miss' | 'pending' | null;
    counterplayCardCount: number;
    lastCounterplayCard: string | null;
    riskValue: number | null;
    resourceValue: number | null;
  } | null;
  hasLocalDirectorState: boolean;
  resolvedBetCount: number;
  hitBetCount: number;
  formattedArchiveKeyMoments: string[];
  localBetOutcomes: Array<{
    bet: StructuredBetRecord;
    outcome: StructuredBetOutcome;
  }>;
  evaluatedObjectives: EvaluatedDirectorObjective[];
  signatureArcState: ReturnType<typeof getGameplaySignatureArcState> | null;
  systemTracks: ReturnType<typeof getScenarioSystemTrackState> | null;
  challengeProgress: ChallengeProgressEntry | null;
  challengeFeedbackLabel: string | null;
  lastCounterplayCardLabel: string;
  commitmentOutcomeLabel: string;
  counterplaySummaryLabel: string;
  completedObjectiveCount: number;
  displayBranchSnapshots: Array<{
    branchId: string;
    title: string;
    probability: number;
  }>;
  directorStyleLabel: string | null;
  profileResonanceLabel: string;
  resultConversationContext: {
    insight?: string | null | undefined;
    forkReason?: string | null | undefined;
  } | null;
}

export default function DirectorNotebook(props: DirectorNotebookArchiveProps) {
  const {
    displayArchive,
    hasLocalDirectorState,
    resolvedBetCount,
    hitBetCount,
    formattedArchiveKeyMoments,
    localBetOutcomes,
    evaluatedObjectives,
    signatureArcState,
    systemTracks,
    challengeProgress,
    challengeFeedbackLabel,
    lastCounterplayCardLabel,
    commitmentOutcomeLabel,
    counterplaySummaryLabel,
    completedObjectiveCount,
    displayBranchSnapshots,
    directorStyleLabel,
    profileResonanceLabel,
    resultConversationContext,
  } = props;

  const {
    t,
    isZh,
    scenario,
    storyData,
    analysisBranch,
    scenarioMeta,
    notebookOpen,
    setNotebookOpen,
    blurCollapsedPanelFocus,
    isDailyChallenge,
    gameplayProfileLabel,
    gameplayProfileHooks,
  } = useResultContext();

  const mostUsedCardLabel = displayArchive?.mostUsedCard
    ? (isZh
      ? getGameplayCardDefinition(
          displayArchive.mostUsedCard as Parameters<typeof getGameplayCardDefinition>[0],
        ).labelZh
      : getGameplayCardDefinition(
          displayArchive.mostUsedCard as Parameters<typeof getGameplayCardDefinition>[0],
        ).labelEn)
    : t('result.archive_no_cards');
  const bettingHitLabel =
    !scenarioMeta
      ? t('result.archive_no_bets')
      : scenarioMeta.betting.bets.length > 0
        ? resolvedBetCount === 0
          ? t('result.archive_pending')
          : t('result.archive_hit_ratio', { hit: hitBetCount, total: scenarioMeta.betting.bets.length })
        : displayArchive?.bettingHit == null
          ? t('result.archive_no_bets')
          : displayArchive.bettingHit
            ? t('result.archive_bet_hit')
            : t('result.archive_bet_miss');
  const dominantToneLabel = displayArchive?.dominantTone
    ? getEndingToneLabel(displayArchive.dominantTone, isZh)
    : t('result.archive_unset');
  const archiveQuestion = storyData?.question ?? scenario?.question ?? t('result.archive_question_unset');
  const archiveVerdictTitle = displayArchive?.dominantBranchTitle ?? analysisBranch?.title ?? t('result.archive_unset');
  const archiveVerdictDetail = resultConversationContext?.insight
    ?? resultConversationContext?.forkReason
    ?? formattedArchiveKeyMoments[0]
    ?? t('result.archive_verdict_fallback');
  const archiveUsedCardCount = scenarioMeta?.cards.usageLog.length ?? 0;
  const archiveCardDetail = archiveUsedCardCount > 0
    ? t('result.archive_card_detail', { count: archiveUsedCardCount })
    : t('result.archive_empty_card_hint');
  const topArchiveBet = localBetOutcomes.find(({ outcome }) => outcome !== 'pending') ?? localBetOutcomes[0] ?? null;
  const topArchiveBetConfidence = topArchiveBet
    ? Math.round(topArchiveBet.bet.confidence <= 1 ? topArchiveBet.bet.confidence * 100 : topArchiveBet.bet.confidence)
    : null;
  const archiveBetDetail = topArchiveBet
    ? t('result.archive_bet_detail', {
        target: topArchiveBet.bet.targetLabel,
        outcome: getBetOutcomeLabel(topArchiveBet.outcome, t),
        confidence: topArchiveBetConfidence,
        round: topArchiveBet.bet.placedAtRound,
      })
    : t('result.archive_empty_bet_hint');
  const archiveCommitmentBranchTitle = scenarioMeta?.commitment.branchTitle
    ?? (displayArchive?.commitmentOutcome ? displayArchive.dominantBranchTitle : null);
  const archiveCommitmentDetail = archiveCommitmentBranchTitle
    ? scenarioMeta?.commitment.committedAtRound
      ? t('result.archive_commitment_detail_with_round', {
          branch: archiveCommitmentBranchTitle,
          round: scenarioMeta.commitment.committedAtRound,
        })
      : t('result.archive_commitment_detail', { branch: archiveCommitmentBranchTitle })
    : t('result.archive_empty_commitment_hint');
  const archiveCounterplayDetail = (displayArchive?.counterplayCardCount ?? 0) > 0
    ? `${t('result.archive_last_counterplay')}: ${lastCounterplayCardLabel}`
    : t('result.archive_empty_counterplay_hint');
  const archiveGoalDetail = evaluatedObjectives.length > 0
    ? evaluatedObjectives.map((objective) => `${objective.title} · ${objective.progress}`).join(' / ')
    : t('result.archive_empty_goals_hint');
  const archiveSignatureValue = signatureArcState?.label ?? t('result.archive_unset');
  const archiveSignatureDetail = signatureArcState
    ? `${signatureArcState.sequenceLabels.join(' → ')} · ${signatureArcState.completedSteps}/${signatureArcState.totalSteps}`
    : t('result.archive_empty_signature_hint');
  const archiveSystemValue = systemTracks
    ? `${systemTracks.riskLabel} ${systemTracks.riskValue}/6`
    : t('result.archive_unset');
  const archiveSystemDetail = systemTracks
    ? `${systemTracks.resourceLabel} ${systemTracks.resourceValue}/6 · ${systemTracks.pressure}`
    : t('result.archive_empty_system_hint');
  const archiveChallengeFeedback = challengeProgress
    ? `${challengeProgress.completed ? t('result.archive_completed') : t('result.archive_in_progress')} · ${challengeFeedbackLabel ?? t('result.archive_cards_used', { count: challengeProgress.usedCards.length })}`
    : isDailyChallenge
      ? `${gameplayProfileLabel ? `${gameplayProfileLabel} · ` : ''}${t('result.archive_completed')}`
      : t('result.archive_regular_run');
  const visibleArchiveKeyMoments = formattedArchiveKeyMoments.slice(0, 4);
  const hiddenArchiveKeyMoments = formattedArchiveKeyMoments.slice(4);

  return (
    <section id="result-director-notebook" className="result-director-notebook">
      <button
        type="button"
        className="result-director-notebook__trigger"
        aria-expanded={notebookOpen}
        aria-label={t(notebookOpen ? 'result_ux.director_notebook_collapse' : 'result_ux.director_notebook_expand')}
        aria-describedby="director-notebook-hint"
        onClick={() => setNotebookOpen((prev) => !prev)}
      >
        <span className="result-director-notebook__trigger-copy">
          <span>{t('result_ux.director_notebook')}</span>
          <small id="director-notebook-hint">{t('result_ux.director_notebook_hint')}</small>
        </span>
        <span aria-hidden="true">{notebookOpen ? '▲' : '▼'}</span>
      </button>
      <div
        className={`result-director-notebook__body ${notebookOpen ? 'is-open' : ''}`}
        aria-hidden={!notebookOpen}
        inert={!notebookOpen || undefined}
        onFocusCapture={notebookOpen ? undefined : blurCollapsedPanelFocus}
      >
        <div className="result-director-notebook__inner">

      {scenarioMeta && (
        <section className="result-archive">
          <div className="result-archive__header">
            <div>
              <span className="result-archive__eyebrow">{t('result.archive_brief_label')}</span>
              <h2 className="result-archive__title">
                <img src={getGameplayBadgeSrc('archive_record')} alt="" aria-hidden="true" />
                <span>{t('result.archive_title')}</span>
              </h2>
              <p className="result-archive__lead">{t('result.archive_lead')}</p>
            </div>
            <div className="result-archive__grade" aria-label={t('result.archive_grade')}>
              <span>{t('result.archive_grade')}</span>
              <strong>{displayArchive?.archiveGrade ?? 'C'}</strong>
            </div>
          </div>

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
            {hasLocalDirectorState && (
              <span className="archive-chip">
                {t('result.archive_director_points', {
                  remaining: scenarioMeta.director.remainingPoints,
                  max: scenarioMeta.director.maxPoints,
                })}
              </span>
            )}
            {displayArchive?.bettingHit === true && (
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
            <div className="result-archive__hooks" aria-label={t('common.theme_hooks_aria')}>
              {gameplayProfileHooks.map((hook) => (
                <span key={hook} className="archive-chip archive-chip--hook">
                  {hook}
                </span>
              ))}
            </div>
          )}

          <div className="result-archive__brief">
            <div className="result-archive__question">
              <span>{t('result.archive_question_label')}</span>
              <p>{archiveQuestion}</p>
            </div>
            <div className="result-archive__verdict">
              <span>{t('result.archive_verdict_label')}</span>
              <strong>{archiveVerdictTitle}</strong>
              <p>{archiveVerdictDetail}</p>
            </div>
          </div>

          <div className="archive-decision-grid">
            <article className="archive-decision-panel archive-decision-panel--primary">
              <h3>{t('result.archive_group_judgement')}</h3>
              <dl className="archive-signal-list">
                <div>
                  <dt>{t('result.archive_dominant_branch')}</dt>
                  <dd>
                    <strong>{archiveVerdictTitle}</strong>
                    <span>{t('result.archive_dominant_branch_hint')}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('result.archive_dominant_tone')}</dt>
                  <dd>
                    <strong>{dominantToneLabel}</strong>
                    <span>{t('result.archive_dominant_tone_hint')}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('result.archive_resonance')}</dt>
                  <dd>
                    <strong>{profileResonanceLabel}</strong>
                    <span>{t('result.archive_resonance_hint')}</span>
                  </dd>
                </div>
              </dl>
            </article>

            <article className="archive-decision-panel">
              <h3>{t('result.archive_group_actions')}</h3>
              <dl className="archive-signal-list">
                <div>
                  <dt>{t('result.archive_most_used_card')}</dt>
                  <dd>
                    <strong>{mostUsedCardLabel}</strong>
                    <span>{archiveCardDetail}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('result.archive_bet_result')}</dt>
                  <dd>
                    <strong>{bettingHitLabel}</strong>
                    <span>{archiveBetDetail}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('result.archive_worldline_commitment_label')}</dt>
                  <dd>
                    <strong>{commitmentOutcomeLabel}</strong>
                    <span>{archiveCommitmentDetail}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('result.archive_counterplay')}</dt>
                  <dd>
                    <strong>{counterplaySummaryLabel}</strong>
                    <span>{archiveCounterplayDetail}</span>
                  </dd>
                </div>
              </dl>
            </article>

            <article className="archive-decision-panel">
              <h3>{t('result.archive_group_next')}</h3>
              <dl className="archive-signal-list">
                <div>
                  <dt>{t('result.archive_director_goals_label')}</dt>
                  <dd>
                    <strong>{completedObjectiveCount}/{evaluatedObjectives.length || 0}</strong>
                    <span>{archiveGoalDetail}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('result.archive_signature_arc_label')}</dt>
                  <dd>
                    <strong>{archiveSignatureValue}</strong>
                    <span>{archiveSignatureDetail}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('result.archive_system_tracks_label')}</dt>
                  <dd>
                    <strong>{archiveSystemValue}</strong>
                    <span>{archiveSystemDetail}</span>
                  </dd>
                </div>
                <div>
                  <dt>{t('result.archive_challenge_feedback')}</dt>
                  <dd>
                    <strong>{archiveChallengeFeedback}</strong>
                    <span>{t('result.archive_challenge_feedback_hint')}</span>
                  </dd>
                </div>
              </dl>
            </article>
          </div>

          <div className="result-archive__evidence">
            <div className="result-archive__evidence-head">
              <div>
                <h3>{t('result.archive_evidence_title')}</h3>
                <p>{t('result.archive_evidence_lead')}</p>
              </div>
              <div className="archive-evidence-counts" aria-label={t('result.archive_evidence_counts_label')}>
                <span>{t('result.archive_count_cards', { count: scenarioMeta.cards.usageLog.length })}</span>
                <span>{t('result.archive_count_bets', { count: localBetOutcomes.length })}</span>
                <span>{t('result.archive_count_moments', { count: formattedArchiveKeyMoments.length })}</span>
                <span>{t('result.archive_count_branches', { count: displayBranchSnapshots.length })}</span>
              </div>
            </div>

            <div className="archive-ledger-shell">
              <section className="archive-ledger-panel archive-ledger-panel--moments">
                <h3>{t('result.archive_moments_section')}</h3>
                {visibleArchiveKeyMoments.length > 0 ? (
                  <>
                    <ol className="archive-moment-timeline">
                      {visibleArchiveKeyMoments.map((moment, index) => (
                        <li key={`${moment}-${index}`}>
                          <span className="archive-moment-timeline__index">{String(index + 1).padStart(2, '0')}</span>
                          <span className="archive-moment-timeline__text" title={moment}>{moment}</span>
                        </li>
                      ))}
                    </ol>
                    {hiddenArchiveKeyMoments.length > 0 && (
                      <details className="archive-moment-more">
                        <summary>{t('result.archive_moments_more', { count: hiddenArchiveKeyMoments.length })}</summary>
                        <ol className="archive-moment-timeline archive-moment-timeline--compact">
                          {hiddenArchiveKeyMoments.map((moment, index) => (
                            <li key={`${moment}-${index + visibleArchiveKeyMoments.length}`}>
                              <span className="archive-moment-timeline__index">
                                {String(index + visibleArchiveKeyMoments.length + 1).padStart(2, '0')}
                              </span>
                              <span className="archive-moment-timeline__text" title={moment}>{moment}</span>
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </>
                ) : (
                  <p className="archive-empty-note">{t('result.archive_moments_empty')}</p>
                )}
              </section>

              <div className="archive-ledger-rail">
                <section className="archive-ledger-panel">
                  <h3>{t('result.archive_cards_section')}</h3>
                  {scenarioMeta.cards.usageLog.length > 0 ? (
                    <div className="archive-compact-list">
                      {scenarioMeta.cards.usageLog.slice(0, 3).map((usage, index) => (
                        <div key={`${usage.usedAt}-${index}`} className="archive-compact-row">
                          <span>{`R${usage.round}`}</span>
                          <strong>{isZh ? getGameplayCardDefinition(usage.cardId).labelZh : getGameplayCardDefinition(usage.cardId).labelEn}</strong>
                          <small>{usage.branchTitle}</small>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="archive-empty-note">{t('result.archive_cards_empty_short')}</p>
                  )}
                </section>

                <section className="archive-ledger-panel">
                  <h3>{t('result.archive_bets_section')}</h3>
                  {localBetOutcomes.length > 0 ? (
                    <div className="archive-compact-list">
                      {localBetOutcomes.slice(0, 3).map(({ bet, outcome }) => (
                        <div key={bet.betId} className="archive-compact-row archive-compact-row--bet">
                          <span>{`R${bet.placedAtRound}`}</span>
                          <strong>{bet.targetLabel}</strong>
                          <small>
                            {Math.round(bet.confidence <= 1 ? bet.confidence * 100 : bet.confidence)}
                            %
                            {' · '}
                            {getBetOutcomeLabel(outcome, t)}
                          </small>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="archive-empty-note">{t('result.archive_bets_empty_short')}</p>
                  )}
                </section>

                <section className="archive-ledger-panel">
                  <h3>{t('result.archive_branches_section')}</h3>
                  {displayBranchSnapshots.length > 0 ? (
                    <div className="archive-compact-list">
                      {displayBranchSnapshots.slice(0, 4).map((snapshot) => (
                        <div key={snapshot.branchId} className="archive-compact-row archive-compact-row--branch">
                          <span>{t('result.archive_branch_probability', { percent: Math.round(snapshot.probability * 100) })}</span>
                          <strong>{snapshot.title}</strong>
                          <span className="archive-branch-meter" aria-hidden="true">
                            <span style={{ width: `${Math.round(snapshot.probability * 100)}%` }} />
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="archive-empty-note">{t('result.archive_branches_empty')}</p>
                  )}
                </section>
              </div>
            </div>
          </div>
        </section>
      )}

        </div>{/* end .result-director-notebook__inner */}
      </div>{/* end .result-director-notebook__body */}
    </section>
  );
}
