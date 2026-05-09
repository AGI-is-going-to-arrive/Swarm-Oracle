import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getGameplayCardDefinition,
  type GameplayCardId,
} from '../gameplayCards';
import type {
  CampaignFinalizeResult,
  CampaignScenarioSummary,
  CampaignScoreBreakdownItem,
} from '../../types';

type CampaignResonance = CampaignScenarioSummary['profile_resonance'];
type CampaignCommitmentOutcome = NonNullable<CampaignScenarioSummary['commitment_outcome']>;

interface DirectorBadgeItem {
  id: string;
  unlockedAt: string;
  label: string;
  description: string;
}

interface DirectorSignatureArc {
  label: string;
  completedSteps: number;
  totalSteps: number;
  completed: boolean;
  nextCardId: GameplayCardId | null;
  sequenceLabels: string[];
}

interface DirectorSystemTracks {
  riskLabel: string;
  riskValue: number;
  resourceLabel: string;
  resourceValue: number;
  pressure: string;
  counterplayRecommended: boolean;
}

interface DirectorTacticalState {
  label: string;
  note: string;
  focusCards: GameplayCardId[];
}

type DirectorMomentKind = 'card' | 'bet' | 'commitment' | 'story';
type DirectorBetOutcome = 'hit' | 'miss' | 'pending';

interface DirectorWorldlineSummary {
  title: string | null;
  insight?: string | null;
  forkReason?: string | null;
  comparisonTitles?: string[];
}

interface DirectorCommitmentSummary {
  active: boolean;
  branchTitle?: string | null;
  committedAtRound?: number | null;
  outcome?: CampaignCommitmentOutcome | null;
}

interface DirectorBetHighlight {
  targetLabel: string;
  confidence: number;
  placedAtRound: number;
  outcome: DirectorBetOutcome;
}

interface DirectorMomentHighlight {
  id: string;
  kind: DirectorMomentKind;
  label: string;
  round?: number;
  detail?: string;
}

interface DirectorInterventionSummary {
  cardLabel: string;
  branchTitle: string;
  round: number;
  directive: string;
}

export interface DirectorDebriefPanelProps {
  campaignSummary: CampaignFinalizeResult;
  scenarioQuestion?: string | null;
  worldlineSummary?: DirectorWorldlineSummary | null;
  commitmentSummary?: DirectorCommitmentSummary | null;
  betHighlights?: DirectorBetHighlight[];
  momentHighlights?: DirectorMomentHighlight[];
  interventionSummary?: DirectorInterventionSummary | null;
  profileLabel: string | null;
  profileHooks: string[];
  archiveGrade: string | null;
  profileResonance: CampaignResonance | null;
  profileResonanceLabel: string;
  directorStyleLabel: string | null;
  objectiveCompletedCount: number;
  objectiveTotalCount: number;
  commitmentOutcome: CampaignCommitmentOutcome | null;
  commitmentOutcomeLabel: string;
  commitmentBranchTitle: string | null;
  isDailyChallenge: boolean;
  betCount: number;
  bettingHit: boolean | null;
  signatureArc: DirectorSignatureArc | null;
  systemTracks: DirectorSystemTracks | null;
  tacticalState: DirectorTacticalState | null;
  newlyUnlockedBadges: DirectorBadgeItem[];
  dominantBranchTitle?: string | null;
  keyMoments?: string[];
  notebookHref?: string | null;
  analysisHref?: string | null;
  conversationHref?: string | null;
}

function scoreText(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampTrack(value: number): number {
  return Math.max(0, Math.min(6, Math.round(value)));
}

function DirectorActionCard({
  href,
  kicker,
  title,
  detail,
}: {
  href: string | null | undefined;
  kicker: string;
  title: string;
  detail: string;
}) {
  const content = (
    <>
      <span className="director-debrief__action-kicker">{kicker}</span>
      <strong>{title}</strong>
      <span>{detail}</span>
    </>
  );

  if (href) {
    return (
      <a className="director-debrief__action-card" href={href}>
        {content}
      </a>
    );
  }

  return (
    <div className="director-debrief__action-card is-disabled" aria-disabled="true">
      {content}
    </div>
  );
}

export function DirectorDebriefPanel({
  campaignSummary,
  scenarioQuestion = null,
  worldlineSummary = null,
  commitmentSummary = null,
  betHighlights = [],
  momentHighlights = [],
  interventionSummary = null,
  profileLabel,
  profileHooks,
  archiveGrade,
  profileResonance,
  profileResonanceLabel,
  directorStyleLabel,
  objectiveCompletedCount,
  objectiveTotalCount,
  commitmentOutcome,
  commitmentOutcomeLabel,
  commitmentBranchTitle,
  isDailyChallenge,
  betCount,
  bettingHit,
  signatureArc,
  systemTracks,
  tacticalState,
  newlyUnlockedBadges,
  dominantBranchTitle = null,
  keyMoments = [],
  notebookHref = null,
  analysisHref = null,
  conversationHref = null,
}: DirectorDebriefPanelProps) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const fallbackScoreFactors = useMemo<CampaignScoreBreakdownItem[]>(() => {
    const factors: CampaignScoreBreakdownItem[] = [];
    const add = (id: string, points: number, applied: boolean) => {
      factors.push({
        id,
        label_key: `result.director_score_${id}`,
        points,
        applied,
      });
    };

    add('completed_run', 1, true);
    add('daily_challenge', 1, isDailyChallenge);

    add('profile_signature', 2, profileResonance === 'signature');
    add('profile_aligned', 1, profileResonance === 'aligned');
    add('profile_offbeat', 0, profileResonance === 'offbeat');

    add('bet_placed', 1, betCount > 0 || bettingHit != null);
    add('bet_hit', 2, bettingHit === true);
    add('bet_miss', 0, bettingHit === false);
    add('bet_none', 0, betCount <= 0 && bettingHit == null);

    add('archive_s', 2, archiveGrade === 'S');
    add('archive_a', 1, archiveGrade === 'A');
    add('archive_lower', 0, archiveGrade != null && !['S', 'A'].includes(archiveGrade));

    const objectivesComplete = objectiveTotalCount > 0 && objectiveCompletedCount >= objectiveTotalCount;
    add('objectives_complete', 1, objectivesComplete);
    add('objectives_incomplete', 0, objectiveTotalCount > 0 && !objectivesComplete);

    add('commitment_hit', 1, commitmentOutcome === 'hit');
    add('commitment_miss', -1, commitmentOutcome === 'miss');
    add('commitment_pending', 0, commitmentOutcome === 'pending');
    add('commitment_none', 0, commitmentOutcome == null);

    return factors;
  }, [
    archiveGrade,
    betCount,
    bettingHit,
    commitmentOutcome,
    isDailyChallenge,
    objectiveCompletedCount,
    objectiveTotalCount,
    profileResonance,
  ]);
  const scoreFactors = useMemo(() => {
    const source = campaignSummary.score_breakdown?.length
      ? campaignSummary.score_breakdown
      : fallbackScoreFactors;
    const applied = source.filter((factor) => factor.applied);
    return applied.length > 0 ? applied : source.slice(0, 1);
  }, [campaignSummary.score_breakdown, fallbackScoreFactors]);

  const nextScore = campaignSummary.mastery.next_level_score;
  const campaignScore = campaignSummary.mastery.campaign_score;
  const progressPercent = nextScore && nextScore > 0
    ? clampProgress((campaignScore / nextScore) * 100)
    : 100;
  const hitRate = campaignSummary.profile.total_bets > 0
    ? Math.round((campaignSummary.profile.hit_bets / campaignSummary.profile.total_bets) * 100)
    : null;
  const nextCardLabel = signatureArc?.nextCardId
    ? (
      isZh
        ? getGameplayCardDefinition(signatureArc.nextCardId).labelZh
        : getGameplayCardDefinition(signatureArc.nextCardId).labelEn
    )
    : null;
  const focusCards = tacticalState?.focusCards.slice(0, 3).map((cardId) => (
    isZh ? getGameplayCardDefinition(cardId).labelZh : getGameplayCardDefinition(cardId).labelEn
  )) ?? [];
  const firstKeyMoment = keyMoments.map((moment) => moment.trim()).find(Boolean) ?? null;
  const firstMomentHighlight = momentHighlights[0] ?? null;
  const scenarioQuestionText = scenarioQuestion?.trim() || null;
  const worldlineTitle = worldlineSummary?.title?.trim()
    || dominantBranchTitle
    || t('result.director_debrief_worldline_unknown');
  const worldlineDetail = worldlineSummary?.insight?.trim()
    || worldlineSummary?.forkReason?.trim()
    || (
      (worldlineSummary?.comparisonTitles?.length ?? 0) > 0
        ? t('result.director_debrief_worldline_compared', {
            branches: worldlineSummary?.comparisonTitles?.join(' / '),
          })
        : t('result.director_debrief_worldline_detail_fallback')
    );
  const commitmentTitle = commitmentSummary?.active && commitmentSummary.branchTitle
    ? commitmentSummary.branchTitle
    : t('result.director_debrief_commitment_none_title');
  const commitmentDetail = commitmentSummary?.active
    ? (
      typeof commitmentSummary.committedAtRound === 'number'
        ? t('result.director_debrief_commitment_detail', {
            outcome: commitmentOutcomeLabel,
            round: commitmentSummary.committedAtRound,
          })
        : t('result.director_debrief_commitment_detail_no_round', {
            outcome: commitmentOutcomeLabel,
          })
    )
    : t('result.director_debrief_commitment_none_detail');
  const topBet = betHighlights.find((entry) => entry.outcome !== 'pending') ?? betHighlights[0] ?? null;
  const topBetConfidencePercent = topBet
    ? Math.round(topBet.confidence <= 1 ? topBet.confidence * 100 : topBet.confidence)
    : null;
  const betOutcomeLabel = topBet
    ? t(`result.bet_status_${topBet.outcome}`)
    : t('result.director_debrief_no_bets');
  const momentRows = momentHighlights.length > 0
    ? momentHighlights
    : firstKeyMoment
      ? [{
          id: 'story-fallback',
          kind: 'story' as DirectorMomentKind,
          label: firstKeyMoment,
        }]
      : [];
  const riskPercent = systemTracks ? clampProgress((clampTrack(systemTracks.riskValue) / 6) * 100) : 0;
  const resourcePercent = systemTracks ? clampProgress((clampTrack(systemTracks.resourceValue) / 6) * 100) : 0;

  return (
    <section className="result-campaign" aria-labelledby="director-debrief-title">
      <div className="director-debrief__header">
        <p className="director-debrief__eyebrow">{t('result.director_debrief_eyebrow')}</p>
        <h2 id="director-debrief-title" className="result-campaign__title">
          {t('result.director_debrief_title')}
        </h2>
        <p className="director-debrief__lead">
          {t('result.director_debrief_lead', {
            profile: profileLabel ?? t('result.director_debrief_unknown_profile'),
            delta: campaignSummary.campaign_score_delta,
            grade: archiveGrade ?? t('result.archive_unset'),
          })}
        </p>
      </div>

      <div className="director-debrief__question">
        <span>{t('result.director_debrief_question_label')}</span>
        <strong>
          {scenarioQuestionText ?? t('result.director_debrief_question_empty')}
        </strong>
      </div>

      <div className="director-debrief__summary-grid">
        <article className="director-debrief__summary-item">
          <span>{t('result.director_debrief_worldline_title')}</span>
          <strong>{worldlineTitle}</strong>
          <p>{worldlineDetail}</p>
        </article>
        <article className="director-debrief__summary-item">
          <span>{t('result.director_debrief_commitment_title')}</span>
          <strong>{commitmentTitle}</strong>
          <p>{commitmentDetail}</p>
        </article>
        <article className="director-debrief__summary-item">
          <span>{t('result.director_debrief_bet_title')}</span>
          <strong>
            {topBet
              ? t('result.director_debrief_bet_target', { target: topBet.targetLabel })
              : t('result.director_debrief_bet_none_title')}
          </strong>
          <p>
            {topBet
              ? t('result.director_debrief_bet_detail', {
                  outcome: betOutcomeLabel,
                  confidence: topBetConfidencePercent,
                  round: topBet.placedAtRound,
                })
              : t('result.director_debrief_bet_none_detail')}
          </p>
        </article>
      </div>

      {interventionSummary && (
        <article className="director-debrief__intervention">
          <div>
            <span>{t('result.director_debrief_intervention_title')}</span>
            <strong>
              {t('result.director_debrief_intervention_detail', {
                card: interventionSummary.cardLabel,
                branch: interventionSummary.branchTitle,
                round: interventionSummary.round,
              })}
            </strong>
          </div>
          <p>{interventionSummary.directive}</p>
        </article>
      )}

      {momentRows.length > 0 && (
        <div className="director-debrief__moments">
          <span>{t('result.director_debrief_moments_title')}</span>
          <ul>
            {momentRows.map((moment) => (
              <li key={moment.id}>
                <small>
                  {moment.round
                    ? t('result.director_debrief_moment_with_round', {
                        kind: t(`result.director_debrief_moment_${moment.kind}`),
                        round: moment.round,
                      })
                    : t(`result.director_debrief_moment_${moment.kind}`)}
                </small>
                <strong>{moment.label}</strong>
                {moment.detail && <p>{moment.detail}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="director-debrief__metrics" aria-label={t('result.director_debrief_metrics_aria')}>
        <div className="director-debrief__metric director-debrief__metric--primary">
          <span>{t('result.campaign_delta')}</span>
          <strong>+{campaignSummary.campaign_score_delta}</strong>
          <small>{t('result.director_debrief_visible_score')}</small>
        </div>
        <div className="director-debrief__metric">
          <span>{t('result.campaign_level')}</span>
          <strong>{t('home.campaign_mastery_level', { level: campaignSummary.mastery.level })}</strong>
          <small>{profileLabel ?? t('result.director_debrief_unknown_profile')}</small>
        </div>
        <div className="director-debrief__metric">
          <span>{t('result.director_debrief_total_runs')}</span>
          <strong>{campaignSummary.profile.total_runs}</strong>
          <small>{t('result.director_debrief_profile_runs', { count: campaignSummary.mastery.runs })}</small>
        </div>
        <div className="director-debrief__metric">
          <span>{t('result.director_debrief_accuracy')}</span>
          <strong>
            {hitRate == null
              ? t('result.director_debrief_no_bets')
              : t('result.director_debrief_hit_rate', { percent: hitRate })}
          </strong>
          <small>
            {t('result.director_debrief_bet_record', {
              hit: campaignSummary.profile.hit_bets,
              total: campaignSummary.profile.total_bets,
            })}
          </small>
        </div>
      </div>

      <div className="director-debrief__progress">
        <div className="director-debrief__progress-copy">
          <strong>{t('result.director_debrief_progress_title')}</strong>
          <span>
            {(campaignSummary.mastery.score_to_next_level ?? 0) > 0
              ? t('home.campaign_next_unlock', { count: campaignSummary.mastery.score_to_next_level ?? 0 })
              : t('home.campaign_mastered')}
          </span>
        </div>
        <div
          className="director-debrief__progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progressPercent}
          aria-label={t('result.director_debrief_progress_aria')}
        >
          <span style={{ width: `${progressPercent}%` }} />
        </div>
      </div>

      <div className="director-debrief__actions" aria-label={t('result.director_debrief_actions_aria')}>
        <DirectorActionCard
          href={notebookHref}
          kicker={t('result.director_debrief_action_anchor_kicker')}
          title={dominantBranchTitle
            ? t('result.director_debrief_action_anchor_title', { branch: dominantBranchTitle })
            : t('result.director_debrief_action_anchor_title_fallback')}
          detail={firstMomentHighlight
            ? t('result.director_debrief_action_anchor_detail_structured', {
                kind: t(`result.director_debrief_moment_${firstMomentHighlight.kind}`),
                moment: firstMomentHighlight.label,
              })
            : firstKeyMoment
              ? t('result.director_debrief_action_anchor_detail', { moment: firstKeyMoment })
            : t('result.director_debrief_action_anchor_detail_fallback')}
        />
        <DirectorActionCard
          href={analysisHref}
          kicker={t('result.director_debrief_action_analysis_kicker')}
          title={tacticalState?.label ?? t('result.director_debrief_action_analysis_title_fallback')}
          detail={tacticalState?.note ?? t('result.director_debrief_next_fallback')}
        />
        <DirectorActionCard
          href={conversationHref}
          kicker={t('result.director_debrief_action_conversation_kicker')}
          title={t('result.director_debrief_action_conversation_title')}
          detail={conversationHref
            ? t('result.director_debrief_action_conversation_detail')
            : t('result.director_debrief_action_conversation_unavailable')}
        />
      </div>

      <div className="director-debrief__columns">
        <article className="director-debrief__block">
          <h3>{t('result.director_debrief_score_title')}</h3>
          <ul className="director-debrief__score-list">
            {scoreFactors.map((factor) => (
              <li key={factor.id}>
                <span>{t(factor.label_key, { defaultValue: factor.id.replaceAll('_', ' ') })}</span>
                <strong className={factor.points < 0 ? 'is-negative' : undefined}>
                  {scoreText(factor.points)}
                </strong>
              </li>
            ))}
          </ul>
          <p>{t('result.director_debrief_score_total', { total: campaignSummary.campaign_score_delta })}</p>
        </article>

        <article className="director-debrief__block">
          <h3>{t('result.director_debrief_read_title')}</h3>
          <dl className="director-debrief__readout">
            <div>
              <dt>{t('result.archive_resonance')}</dt>
              <dd>{profileResonanceLabel}</dd>
            </div>
            {directorStyleLabel && (
              <div>
                <dt>{t('result.director_debrief_style')}</dt>
                <dd>{directorStyleLabel}</dd>
              </div>
            )}
            <div>
              <dt>{t('result.archive_worldline_commitment_label')}</dt>
              <dd>
                {commitmentBranchTitle
                  ? `${commitmentOutcomeLabel} · ${commitmentBranchTitle}`
                  : commitmentOutcomeLabel}
              </dd>
            </div>
            {systemTracks && (
              <>
                <div>
                  <dt>{systemTracks.riskLabel}</dt>
                  <dd className="director-debrief__track-value">
                    <span>{systemTracks.riskValue}/6 · {systemTracks.pressure}</span>
                    <span
                      className="director-debrief__track-meter director-debrief__track-meter--risk"
                      role="meter"
                      aria-label={t('result.director_debrief_track_aria', {
                        label: systemTracks.riskLabel,
                        value: systemTracks.riskValue,
                      })}
                      aria-valuemin={0}
                      aria-valuemax={6}
                      aria-valuenow={clampTrack(systemTracks.riskValue)}
                    >
                      <span style={{ width: `${riskPercent}%` }} />
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>{systemTracks.resourceLabel}</dt>
                  <dd className="director-debrief__track-value">
                    <span>{systemTracks.resourceValue}/6</span>
                    <span
                      className="director-debrief__track-meter director-debrief__track-meter--resource"
                      role="meter"
                      aria-label={t('result.director_debrief_track_aria', {
                        label: systemTracks.resourceLabel,
                        value: systemTracks.resourceValue,
                      })}
                      aria-valuemin={0}
                      aria-valuemax={6}
                      aria-valuenow={clampTrack(systemTracks.resourceValue)}
                    >
                      <span style={{ width: `${resourcePercent}%` }} />
                    </span>
                  </dd>
                </div>
              </>
            )}
          </dl>
          <p>
            {systemTracks?.counterplayRecommended
              ? t('result.director_debrief_counterplay_hint')
              : t('result.director_debrief_stable_hint')}
          </p>
          <div className="director-debrief__chips">
            {tacticalState && (
              <span className="director-debrief__chip director-debrief__chip--strong">
                {tacticalState.label}
              </span>
            )}
            {nextCardLabel && (
              <span className="director-debrief__chip">
                {t('result.director_debrief_next_card', { card: nextCardLabel })}
              </span>
            )}
            {focusCards.map((card) => (
              <span key={card} className="director-debrief__chip">{card}</span>
            ))}
          </div>
          {signatureArc && (
            <small>
              {t('result.director_debrief_arc_progress', {
                arc: signatureArc.label,
                completed: signatureArc.completedSteps,
                total: signatureArc.totalSteps,
              })}
            </small>
          )}
        </article>
      </div>

      {profileHooks.length > 0 && (
        <div className="director-debrief__hook-row" aria-label={t('common.theme_hooks_aria')}>
          {profileHooks.map((hook) => (
            <span key={hook} className="director-debrief__chip">{hook}</span>
          ))}
        </div>
      )}

      <div className="result-campaign__badges">
        {newlyUnlockedBadges.length > 0 ? (
          newlyUnlockedBadges.map((badge) => (
            <article key={`${badge.id}-${badge.unlockedAt}`} className="result-campaign__badge">
              <strong>{badge.label}</strong>
              <small>{badge.description}</small>
            </article>
          ))
        ) : (
          <p className="result-campaign__empty">{t('result.campaign_badges_none')}</p>
        )}
      </div>
    </section>
  );
}
