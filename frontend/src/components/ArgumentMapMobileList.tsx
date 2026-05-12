import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface ArgumentUnit {
  id: string;
  type: string;
  status: string;
  text: string;
  turn_id: string;
  node_id?: string;
}

interface Props {
  units: ArgumentUnit[];
  onUnitClick?: (unitId: string, nodeId?: string) => void;
}

// Status badge colors (sRGB)
const STATUS_BADGE: Record<string, { color: string; label: string }> = {
  accepted:    { color: '#22c55e', label: 'Accepted' },
  standing:    { color: '#3b82f6', label: 'Standing' },
  unaddressed: { color: '#f59e0b', label: 'Unaddressed' },
  rebutted:    { color: '#a855f7', label: 'Rebutted' },
  rejected:    { color: '#ef4444', label: 'Rejected' },
};

export function ArgumentMapMobileList({ units, onUnitClick }: Props) {
  const { t } = useTranslation();

  // Group units by type, then sort: verdict first, then claims, evidence, rebuttals
  const grouped = useMemo(() => {
    const groups: Record<string, ArgumentUnit[]> = {
      claim: [],
      evidence: [],
      rebuttal: [],
      counter: [],
    };
    for (const u of units) {
      const key = u.type in groups ? u.type : 'claim';
      groups[key].push(u);
    }
    return groups;
  }, [units]);

  const TYPE_LABELS: Record<string, [string, string]> = {
    claim:     ['argument.claim', 'Claim'],
    evidence:  ['argument.evidence', 'Evidence'],
    rebuttal:  ['argument.rebuttal', 'Rebuttal'],
    counter:   ['argument.counter', 'Counter'],
  };

  if (units.length === 0) {
    return (
      <div className="argmap-mobile-empty" role="status">
        <p>{t('argument.empty', 'No argument map available.')}</p>
      </div>
    );
  }

  return (
    <div className="argmap-mobile-list" role="list" aria-label={t('argument.mobile_list_label', 'Argument units list')}>
      {(['claim', 'evidence', 'rebuttal', 'counter'] as const).map(type => {
        const items = grouped[type];
        if (!items || items.length === 0) return null;
        const [i18nKey, fallback] = TYPE_LABELS[type] || ['', type];
        return (
          <details key={type} className="argmap-mobile-group" open={type === 'claim'}>
            <summary className="argmap-mobile-group__header">
              <span className="argmap-mobile-group__title">
                {t(i18nKey, fallback)}
              </span>
              <span className="argmap-mobile-group__count">({items.length})</span>
            </summary>
            <ul className="argmap-mobile-group__list" role="list">
              {items.map(unit => {
                const badge = STATUS_BADGE[unit.status];
                const [typeKey, typeFallback] = TYPE_LABELS[unit.type] ?? ['', unit.type];
                return (
                  <li
                    key={unit.id}
                    className="argmap-mobile-unit"
                    role="listitem"
                    onClick={() => onUnitClick?.(unit.id, unit.node_id)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onUnitClick?.(unit.id, unit.node_id);
                      }
                    }}
                  >
                    <div className="argmap-mobile-unit__header">
                      <span
                        className="argmap-mobile-unit__badge"
                        style={{ background: badge?.color || '#888' }}
                      >
                        {t(`argument.status_${unit.status}`, badge?.label || unit.status)}
                      </span>
                      <span className="argmap-mobile-unit__type">
                        {t(typeKey, typeFallback)}
                      </span>
                    </div>
                    <p className="argmap-mobile-unit__text">{unit.text}</p>
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
