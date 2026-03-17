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
  frameSrc,
}: DebateMomentumBarProps) {
  const { t } = useTranslation();
  const total = Math.max(1, propositionScore + oppositionScore);
  const propositionWidth = `${(propositionScore / total) * 100}%`;
  const oppositionWidth = `${(oppositionScore / total) * 100}%`;

  return (
    <section
      className="debate-momentum"
      aria-label={t('debate.momentum_aria')}
      style={frameSrc ? { backgroundImage: `url(${frameSrc})` } : undefined}
    >
      <div className="debate-momentum__header">
        <span>{t('debate.side_proposition')}</span>
        <strong>{t('debate.momentum_title')}</strong>
        <span>{t('debate.side_opposition')}</span>
      </div>
      <div className="debate-momentum__track">
        <span className="debate-momentum__fill debate-momentum__fill--proposition" style={{ width: propositionWidth }} />
        <span className="debate-momentum__fill debate-momentum__fill--opposition" style={{ width: oppositionWidth }} />
      </div>
      <div className="debate-momentum__footer">
        <span>{propositionScore}</span>
        <span>{t('debate.audience_meter', { value: audienceMeter })}</span>
        <span>{oppositionScore}</span>
      </div>
    </section>
  );
}
