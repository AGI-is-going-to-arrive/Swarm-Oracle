/* ═══════════════════════════════════════════════════════════
   SwarmOracle — LeaderboardView (P5-B)
   ═══════════════════════════════════════════════════════════ */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLeaderboard } from '../api/client';
import { stringifyAutomationPayload } from '../game/automation';
import { buildAutomationErrorState, getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import type { LeaderboardEntry } from '../types';
import './LeaderboardView.css';

const MEDALS = ['🥇', '🥈', '🥉'] as const;

export default function LeaderboardView() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setErrorCode(null);
    try {
      const data = await getLeaderboard(50);
      setEntries(data ?? []);
    } catch (err) {
      setErrorCode(getApiErrorCode(err));
      setError(getLocalizedApiErrorMessage(err, t, 'Failed to load leaderboard'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const win = window as Window & { render_game_to_text?: () => string };
    const render = () => stringifyAutomationPayload(
      {
        question: null,
        status: loading ? 'loading' : error ? 'error' : 'idle',
        currentRound: 0,
        totalRounds: null,
        viewMode: 'classic',
        visualizationEnabled: false,
        isSimulationComplete: false,
        messageCount: 0,
        agentCount: 0,
        branchCount: entries.length,
      },
      null,
      {
        route: window.location.pathname,
        kind: 'leaderboard',
        loading,
        error: buildAutomationErrorState(errorCode, error),
        entry_count: entries.length,
        top_entries: entries.slice(0, 10).map((entry, index) => ({
          rank: index + 1,
          user_name: entry.user_name,
          avg_score: entry.avg_score,
          best_score: entry.best_score,
          total_predictions: entry.total_predictions,
          win_streak: entry.win_streak,
        })),
      },
    );

    win.render_game_to_text = render;
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
    };
  }, [entries, error, errorCode, loading]);

  return (
    <div className="leaderboard-view">
      <header className="leaderboard-header">
        <button className="btn btn-ghost" onClick={() => navigate(-1)}>
          {t('leaderboard.back')}
        </button>
        <h1 className="leaderboard-title">{t('leaderboard.title')}</h1>
        <p className="leaderboard-subtitle">{t('leaderboard.subtitle')}</p>
      </header>

      {loading ? (
        <div className="leaderboard-empty">
          <p>{t('sim.status.loading')}</p>
        </div>
      ) : error ? (
        <div className="leaderboard-empty">
          <p className="result-error">{error}</p>
          <button className="btn" onClick={load}>
            ↺ Retry
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="leaderboard-empty">
          <p>{t('leaderboard.empty')}</p>
        </div>
      ) : (
        <div className="leaderboard-table-wrap">
          <table className="leaderboard-table">
            <thead>
              <tr>
                <th>{t('leaderboard.rank')}</th>
                <th>{t('leaderboard.name')}</th>
                <th>{t('leaderboard.predictions')}</th>
                <th>{t('leaderboard.avg_score')}</th>
                <th>{t('leaderboard.best_score')}</th>
                <th>{t('leaderboard.streak')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr
                  key={entry.user_id}
                  className={`leaderboard-row ${i < 3 ? 'leaderboard-row--top' : ''}`}
                  style={{ '--row-delay': `${i * 0.03}s` } as React.CSSProperties}
                >
                  <td className="rank-cell">
                    {i < 3 ? (
                      <span className="rank-medal">{MEDALS[i]}</span>
                    ) : (
                      <span className="rank-number">{i + 1}</span>
                    )}
                  </td>
                  <td className="name-cell">{entry.user_name}</td>
                  <td>{entry.total_predictions ?? 0}</td>
                  <td className="score-cell">{(entry.avg_score ?? 0).toFixed(1)}</td>
                  <td className="score-cell">{(entry.best_score ?? 0).toFixed(1)}</td>
                  <td>
                    {(entry.win_streak ?? 0) > 0 && (
                      <span className="streak-badge">🔥 {entry.win_streak}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
