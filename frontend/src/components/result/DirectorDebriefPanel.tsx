import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getGameplayCardDefinition,
  type GameplayCardId,
} from '../gameplayCards';
import type {
  CampaignFinalizeResult,
  CampaignScenarioSummary,
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

export interface DirectorDebriefPanelProps {
  campaignSummary: CampaignFinalizeResult;
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
}

interface ScoreFactor {
  id: string;
  label: string;
  value: number;
}

function scoreText(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function DirectorDebriefPanel({
  campaignSummary,
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
}: DirectorDebriefPanelProps) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const scoreFactors = useMemo<ScoreFactor[]>(() => {
    const factors: ScoreFactor[] = [{
      id: 'completed-run',
      label: t('result.director_debrief_score_completed'),
      value: 1,
    }];

    if (isDailyChallenge) {
      factors.push({
        id: 'daily-challenge',
        label: t('result.director_debrief_score_daily'),
        value: 1,
      });
    }

    if (profileResonance === 'signature') {
      factors.push({
        id: 'profile-signature',
        label: t('result.director_debrief_score_signature'),
        value: 2,
      });
    } else if (profileResonance === 'aligned') {
      factors.push({
        id: 'profile-aligned',
        label: t('result.director_debrief_score_aligned'),
        value: 1,
      });
    }

    if (betCount > 0) {
      factors.push({
        id: 'bet-placed',
        label: t('result.director_debrief_score_bet'),
        value: 1,
      });
    }
    if (bettingHit === true) {
      factors.push({
        id: 'bet-hit',
        label: t('result.director_debrief_score_bet_hit'),
        value: 2,
      });
    }

    if (archiveGrade === 'S') {
      factors.push({
        id: 'archive-s',
        label: t('result.director_debrief_score_archive_s'),
        value: 2,
      });
    } else if (archiveGrade === 'A') {
      factors.push({
        id: 'archive-a',
        label: t('result.director_debrief_score_archive_a'),
        value: 1,
      });
    }

    if (objectiveTotalCount > 0 && objectiveCompletedCount >= objectiveTotalCount) {
      factors.push({
        id: 'objectives',
        label: t('result.director_debrief_score_objectives'),
        value: 1,
      });
    }

    if (commitmentOutcome === 'hit') {
      factors.push({
        id: 'commitment-hit',
        label: t('result.director_debrief_score_commitment_hit'),
        value: 1,
      });
    } else if (commitmentOutcome === 'miss') {
      factors.push({
        id: 'commitment-miss',
        label: t('result.director_debrief_score_commitment_miss'),
        value: -1,
      });
    }

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
    t,
  ]);

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

      <div className="director-debrief__columns">
        <article className="director-debrief__block">
          <h3>{t('result.director_debrief_score_title')}</h3>
          <ul className="director-debrief__score-list">
            {scoreFactors.map((factor) => (
              <li key={factor.id}>
                <span>{factor.label}</span>
                <strong className={factor.value < 0 ? 'is-negative' : undefined}>
                  {scoreText(factor.value)}
                </strong>
              </li>
            ))}
          </ul>
          <p>{t('result.director_debrief_score_total', { total: campaignSummary.campaign_score_delta })}</p>
        </article>

        <article className="director-debrief__block">
          <h3>{t('result.director_debrief_next_title')}</h3>
          <p>
            {tacticalState?.note
              ?? t('result.director_debrief_next_fallback')}
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
                  <dd>{systemTracks.riskValue}/6 · {systemTracks.pressure}</dd>
                </div>
                <div>
                  <dt>{systemTracks.resourceLabel}</dt>
                  <dd>{systemTracks.resourceValue}/6</dd>
                </div>
              </>
            )}
          </dl>
          <p>
            {systemTracks?.counterplayRecommended
              ? t('result.director_debrief_counterplay_hint')
              : t('result.director_debrief_stable_hint')}
          </p>
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
