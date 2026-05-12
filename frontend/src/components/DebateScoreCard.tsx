import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface DebateScoreCardProps {
  sideLabel: string;
  role: string;
  score: number | string;
  active?: boolean;
  badgeSrc?: string;
  persona?: string;
}

export function DebateScoreCard({
  sideLabel,
  role,
  score,
  active = false,
  badgeSrc,
  persona,
}: DebateScoreCardProps) {
  const { t } = useTranslation();
  const trimmedPersona = persona?.trim();
  const [personaExpanded, setPersonaExpanded] = useState(false);
  const isLongPersona = Boolean(trimmedPersona && trimmedPersona.length > 40);

  return (
    <article className={`debate-score-card ${active ? 'debate-score-card--active' : ''}`}>
      {badgeSrc ? (
        <img className="debate-score-card__badge" src={badgeSrc} alt="" aria-hidden="true" />
      ) : null}
      <span className="debate-score-card__eyebrow">{sideLabel}</span>
      <strong className="debate-score-card__role">{role}</strong>
      {trimmedPersona ? (
        <p
          className={`debate-score-card__persona ${personaExpanded ? 'debate-score-card__persona--expanded' : ''}`}
          title={personaExpanded ? undefined : trimmedPersona}
        >
          {trimmedPersona}
        </p>
      ) : null}
      {isLongPersona ? (
        <button
          type="button"
          className="debate-card-expand-btn"
          onClick={() => setPersonaExpanded(!personaExpanded)}
          aria-expanded={personaExpanded}
        >
          {personaExpanded ? t('shared.foldable.collapse_text') : t('shared.foldable.show_full_text')}
        </button>
      ) : null}
      <div className="debate-score-card__score">
        <span>{t('debate.score_label')}</span>
        <strong>{score}</strong>
      </div>
    </article>
  );
}
