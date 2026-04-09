/* ═══════════════════════════════════════════════════════════
   Phase 3 F4 — Compare Digest View
   Side-by-side text comparison of two branches (per-round diff).
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';

interface RoundDiff {
  round: number;
  branch_a_summary: string;
  branch_b_summary: string;
  divergence_score: number;
}

interface CompareData {
  scenario_id: string;
  branch_a: string;
  branch_b: string;
  rounds: RoundDiff[];
}

export function CompareDigestView() {
  const { t } = useTranslation();
  const { loading: capLoading, enabled } = useCapabilityCheck('counterfactual_replay');
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const branchA = searchParams.get('branch_a') ?? '';
  const branchB = searchParams.get('branch_b') ?? '';

  const [data, setData] = useState<CompareData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCompare = useCallback(async () => {
    if (!id || !branchA || !branchB) {
      setLoading(false);
      setError(t('compare.missing_params', 'Missing branch parameters'));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`/api/scenario/${id}/compare?branch_a=${branchA}&branch_b=${branchB}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
    } catch (err) { setError((err as Error).message); }
    setLoading(false);
  }, [id, branchA, branchB, t]);

  useEffect(() => {
    if (!enabled) return;
    fetchCompare();
  }, [fetchCompare, enabled]);

  if (capLoading) return <div style={{ padding: '3rem', textAlign: 'center' }}>{t('common.loading', 'Loading...')}</div>;
  if (!enabled) return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>
      <p style={{ color: '#888' }}>{t('compare.feature_disabled', 'Counterfactual replay feature is not enabled.')}</p>
      <Link to={id ? `/result/${id}` : '/'} style={{ color: '#8ab4f8' }}>{t('common.back_to_result', 'Back to Result')}</Link>
    </div>
  );

  if (loading) {
    return <div style={{ maxWidth: 900, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>{t('common.loading', 'Loading...')}</div>;
  }

  if (error) {
    return (
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>
        <h1>{t('compare.title', 'Counterfactual Compare')}</h1>
        <p role="alert" style={{ color: '#e74c3c' }}>{error}</p>
        <Link to={`/result/${id}`} style={{ color: '#8ab4f8' }}>{t('common.back_to_result', 'Back to Result')}</Link>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <Link to={`/result/${id}`} style={{ color: '#8ab4f8', textDecoration: 'none' }}>
          ← {t('common.back_to_result', 'Back to Result')}
        </Link>
        <h1 style={{ margin: 0, fontSize: '1.2rem' }}>{t('compare.title', 'Counterfactual Compare')}</h1>
      </div>

      {!data || data.rounds.length === 0 ? (
        <p style={{ color: '#888' }}>{t('compare.no_data', 'No comparison data available.')}</p>
      ) : (
        <div>
          {data.rounds.map(round => {
            const divergePct = Math.round(round.divergence_score * 100);
            const barColor = divergePct > 60 ? '#e74c3c' : divergePct > 30 ? '#e67e22' : '#2ecc71';
            return (
              <div key={round.round} style={{ marginBottom: '1rem', border: '1px solid #333', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ padding: '0.5rem 1rem', background: '#1a1a2e', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                    {t('compare.round', 'Round {{round}}', { round: round.round })}
                  </span>
                  <span style={{ fontSize: '0.8rem' }}>
                    {t('compare.divergence_label', 'Divergence')}:{' '}
                    <span style={{ color: barColor, fontWeight: 600 }}>{divergePct}%</span>
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
                  <div style={{ padding: '0.75rem', borderRight: '1px solid #333', fontSize: '0.85rem', lineHeight: 1.5 }}>
                    <div style={{ fontSize: '0.7rem', color: '#888', marginBottom: 4 }}>
                      {t('compare.branch_a_label', 'Branch A (Original)')}
                    </div>
                    {round.branch_a_summary || <span style={{ color: '#555' }}>—</span>}
                  </div>
                  <div style={{ padding: '0.75rem', fontSize: '0.85rem', lineHeight: 1.5 }}>
                    <div style={{ fontSize: '0.7rem', color: '#888', marginBottom: 4 }}>
                      {t('compare.branch_b_label', 'Branch B (Counterfactual)')}
                    </div>
                    {round.branch_b_summary || <span style={{ color: '#555' }}>—</span>}
                  </div>
                </div>
                <div style={{ height: 3, background: barColor, width: `${divergePct}%` }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default CompareDigestView;
