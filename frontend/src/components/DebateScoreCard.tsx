import { useTranslation } from 'react-i18next';

interface DebateScoreCardProps {
  sideLabel: string;
  role: string;
  score: number;
  active?: boolean;
  badgeSrc?: string;
}

export function DebateScoreCard({
  sideLabel,
  role,
  score,
  active = false,
  badgeSrc,
}: DebateScoreCardProps) {
  const { t } = useTranslation();

  return (
    <article className={`debate-score-card ${active ? 'debate-score-card--active' : ''}`}>
      {badgeSrc ? (
        <img className="debate-score-card__badge" src={badgeSrc} alt="" aria-hidden="true" />
      ) : null}
      <span className="debate-score-card__eyebrow">{sideLabel}</span>
      <strong className="debate-score-card__role">{role}</strong>
      <div className="debate-score-card__score">
        <span>{t('debate.score_label')}</span>
        <strong>{score}</strong>
      </div>
    </article>
  );
}
