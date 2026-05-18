import React from 'react';
import { useTranslation } from 'react-i18next';

export interface BadgeDefinition {
  id: string;
  name_key: string;
  description_key: string;
  category: string;
}

interface BadgeCabinetProps {
  definitions: BadgeDefinition[];
  unlockedIds: string[];
  loading?: boolean;
  /** When true, suppress the internal "Badge Collection" h3 title (parent already renders a section heading). */
  hideTitle?: boolean;
}

export const BadgeCabinet: React.FC<BadgeCabinetProps> = ({
  definitions,
  unlockedIds,
  loading = false,
  hideTitle = false,
}) => {
  const { t } = useTranslation();
  const idPrefix = React.useId();
  const unlockedSet = React.useMemo(() => new Set(unlockedIds), [unlockedIds]);

  const lockedLabel = t('campaign.badge_locked', { defaultValue: 'Locked' });
  const unlockedLabel = t('campaign.badge_unlocked', { defaultValue: 'Unlocked' });
  const cabinetTitle = t('campaign.badge_cabinet_title', { defaultValue: 'Badge Collection' });

  return (
    <>
      <style>{`
        .badge-cabinet {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
        }
        .badge-cabinet__title {
          font-size: 1rem;
          font-weight: 600;
          color: #181611;
          margin: 0;
        }
        .badge-cabinet__grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.75rem;
        }
        .badge-cabinet__card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.4rem;
          padding: 0.85rem 0.65rem;
          border-radius: 0.75rem;
          border: 1px solid #e1ddd7;
          background: #fcfcfa;
          text-align: center;
          transition: background-color 0.15s ease, border-color 0.15s ease;
        }
        .badge-cabinet__card--locked {
          opacity: 1;
          color: #4a4741;
        }
        .badge-cabinet__card--unlocked {
          opacity: 1;
          border-color: rgba(46, 139, 122, 0.5);
          background: linear-gradient(180deg, rgba(46, 139, 122, 0.12) 0%, rgba(252, 252, 250, 0.9) 100%);
        }
        .badge-cabinet__icon {
          font-size: 1.5rem;
          line-height: 1;
        }
        .badge-cabinet__icon--unlocked {
          color: #2e8b7a;
        }
        .badge-cabinet__name {
          font-size: 0.85rem;
          font-weight: 600;
          color: #181611;
          line-height: 1.25;
        }
        .badge-cabinet__desc {
          font-size: 0.75rem;
          color: #4f4b45;
          line-height: 1.3;
        }
        .badge-cabinet__card--locked .badge-cabinet__icon {
          color: #6f6a62;
        }
        .badge-cabinet__skeleton {
          height: 6rem;
          border-radius: 0.75rem;
          background: linear-gradient(90deg, rgba(148, 122, 96, 0.12) 25%, rgba(148, 122, 96, 0.2) 50%, rgba(148, 122, 96, 0.12) 75%);
          background-size: 200% 100%;
          animation: badgeCabinetShimmer 1.4s ease-in-out infinite;
        }
        @keyframes badgeCabinetShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @media (max-width: 640px) {
          .badge-cabinet__grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (forced-colors: active) {
          .badge-cabinet__card {
            border-color: CanvasText;
            background-color: Canvas;
            color: CanvasText;
          }
          .badge-cabinet__card--locked {
            color: GrayText;
            border-color: GrayText;
            opacity: 1;
          }
          .badge-cabinet__card--unlocked {
            background-color: Highlight;
            color: HighlightText;
            border-color: HighlightText;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .badge-cabinet__card,
          .badge-cabinet__skeleton {
            transition: none;
            animation: none;
          }
        }
      `}</style>
      <section className="badge-cabinet" aria-label={cabinetTitle}>
        {!hideTitle && <h3 className="badge-cabinet__title">{cabinetTitle}</h3>}
        {loading ? (
          <div className="badge-cabinet__grid" role="status" aria-busy="true">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="badge-cabinet__skeleton" aria-hidden="true" />
            ))}
          </div>
        ) : (
          <div className="badge-cabinet__grid" role="list">
            {definitions.map((def) => {
              const unlocked = unlockedSet.has(def.id);
              const name = t(def.name_key, { defaultValue: def.id });
              const description = t(def.description_key, { defaultValue: '' });
              const stateLabel = unlocked ? unlockedLabel : lockedLabel;
              const safeId = def.id.replace(/[^a-zA-Z0-9_-]/g, '-');
              const nameId = `${idPrefix}-${safeId}-name`;
              const stateId = `${idPrefix}-${safeId}-state`;
              const descId = `${idPrefix}-${safeId}-desc`;
              return (
                <div
                  key={def.id}
                  className={`badge-cabinet__card ${
                    unlocked ? 'badge-cabinet__card--unlocked' : 'badge-cabinet__card--locked'
                  }`}
                  role="listitem"
                  aria-labelledby={`${nameId} ${stateId}`}
                  aria-describedby={description ? descId : undefined}
                >
                  <span
                    className={`badge-cabinet__icon${
                      unlocked ? ' badge-cabinet__icon--unlocked' : ''
                    }`}
                    aria-hidden="true"
                  >
                    {unlocked ? '✓' : '🔒'}
                  </span>
                  <span id={nameId} className="badge-cabinet__name">{name}</span>
                  <span id={stateId} className="sr-only">{stateLabel}</span>
                  {description && (
                    <span id={descId} className="badge-cabinet__desc">
                      {description}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
};
