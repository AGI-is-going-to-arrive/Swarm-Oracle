import { useTranslation } from 'react-i18next';

interface DebateMomentumBarProps {
  propositionScore: number;
  oppositionScore: number;
  audienceMeter: number;
  frameSrc?: string;
}

export function DebateMomentumBar({
  propositionScore,
  oppositionScore,
  audienceMeter,
}: DebateMomentumBarProps) {
  const { t } = useTranslation();
  const total = Math.max(1, propositionScore + oppositionScore);
  const propositionWidth = `${(propositionScore / total) * 100}%`;
  const oppositionWidth = `${(oppositionScore / total) * 100}%`;

  return (
    <section className="debate-momentum" aria-label={t('debate.momentum_aria')}>
      <div className="debate-momentum__surface">
        <div className="debate-momentum__header">
          <span>{t('debate.side_proposition')}</span>
          <strong>{t('debate.momentum_title')}</strong>
          <span>{t('debate.side_opposition')}</span>
        </div>
        <div className="debate-momentum__meter">
          <div className="debate-momentum__score debate-momentum__score--proposition">
            {propositionScore}
          </div>
          <div className="debate-momentum__track">
            <span className="debate-momentum__fill debate-momentum__fill--proposition" style={{ width: propositionWidth }} />
            <span className="debate-momentum__fill debate-momentum__fill--opposition" style={{ width: oppositionWidth }} />
          </div>
          <div className="debate-momentum__score debate-momentum__score--opposition">
            {oppositionScore}
          </div>
        </div>
        <div className="debate-momentum__footer">
          <span className="debate-momentum__audience-chip">
            {t('debate.audience_meter', { value: audienceMeter })}
          </span>
        </div>
      </div>
    </section>
  );
}
