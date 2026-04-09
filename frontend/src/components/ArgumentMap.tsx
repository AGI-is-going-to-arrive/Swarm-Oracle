/* ═══════════════════════════════════════════════════════════
   Phase 3 F6 — Debate Argument Map Panel
   Displays argument units as a simple tree/list with status colors.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ArgumentUnit {
  id: string;
  type: string;  // claim | evidence | rebuttal | counter
  status: string; // standing | rebutted | unaddressed | accepted | rejected
  text: string;
  turn_id: string;
}

interface ArgumentMapData {
  snapshot_id: string | null;
  nodes: unknown[];
  edges: unknown[];
  units: ArgumentUnit[];
}

const STATUS_COLORS: Record<string, string> = {
  standing: '#2ecc71',
  rebutted: '#e74c3c',
  unaddressed: '#888',
  accepted: '#4a90d9',
  rejected: '#e74c3c',
};

const TYPE_LABELS: Record<string, string> = {
  claim: 'Claim',
  evidence: 'Evidence',
  rebuttal: 'Rebuttal',
  counter: 'Counter',
};

interface Props {
  debateId: string;
  visible: boolean;
}

export function ArgumentMap({ debateId, visible }: Props) {
  const { t } = useTranslation();
  const [data, setData] = useState<ArgumentMapData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/debate/${debateId}/argument-map`);
      if (res.status === 501) { setData(null); setLoading(false); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
    } catch { setData(null); }
    setLoading(false);
  }, [debateId]);

  useEffect(() => {
    if (!visible || !debateId) return;
    fetchData();
  }, [debateId, visible, fetchData]);

  if (!visible) return null;
  if (loading) return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('common.loading', 'Loading...')}</p>;
  if (!data || data.units.length === 0) {
    return <p style={{ fontSize: '0.85rem', color: '#888' }}>{t('argument.empty', 'No argument map available.')}</p>;
  }

  const grouped = {
    claim: data.units.filter(u => u.type === 'claim'),
    evidence: data.units.filter(u => u.type === 'evidence'),
    rebuttal: data.units.filter(u => u.type === 'rebuttal'),
    counter: data.units.filter(u => u.type === 'counter'),
  };

  return (
    <div
      role="tree"
      aria-label={t('argument.a11y_label', 'Debate argument map')}
      style={{ fontSize: '0.85rem' }}
    >
      {(['claim', 'evidence', 'rebuttal', 'counter'] as const).map(type => {
        const units = grouped[type];
        if (units.length === 0) return null;
        return (
          <div key={type} style={{ marginBottom: '0.75rem' }}>
            <h4 role="treeitem" aria-expanded="true" style={{ margin: '0 0 0.25rem', fontSize: '0.85rem', color: '#aaa' }}>
              {TYPE_LABELS[type]} ({units.length})
            </h4>
            {units.map(u => (
              <div
                key={u.id}
                role="treeitem"
                style={{
                  padding: '4px 8px',
                  marginBottom: 3,
                  borderLeft: `3px solid ${STATUS_COLORS[u.status] ?? '#555'}`,
                  borderRadius: 3,
                  background: 'rgba(255,255,255,0.03)',
                  lineHeight: 1.4,
                }}
              >
                <span style={{ color: STATUS_COLORS[u.status] ?? '#888', fontSize: '0.75rem', fontWeight: 600, marginRight: 6 }}>
                  [{u.status}]
                </span>
                {u.text.length > 200 ? u.text.slice(0, 200) + '...' : u.text}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
