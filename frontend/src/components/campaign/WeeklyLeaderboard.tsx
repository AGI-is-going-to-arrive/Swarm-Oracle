import React from 'react';
import { useTranslation } from 'react-i18next';
import type { WeeklyLeaderboardEntry } from '../../types';

interface WeeklyLeaderboardProps {
  entries: WeeklyLeaderboardEntry[];
  currentUserRank?: number;
  loading?: boolean;
  error?: boolean;
}

export const WeeklyLeaderboard: React.FC<WeeklyLeaderboardProps> = ({
  entries,
  currentUserRank,
  loading = false,
  error = false,
}) => {
  const { t } = useTranslation();

  return (
    <section className="weekly-leaderboard" aria-labelledby="weekly-leaderboard-title">
      <style>{`
        .weekly-leaderboard {
          background: rgba(255, 250, 240, 0.7);
          border: 1px solid rgba(148, 122, 96, 0.3);
          border-radius: 0.75rem;
          padding: 1rem;
          color: #2b1f12;
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
        }
        .weekly-leaderboard__title {
          margin: 0;
          font-size: 1rem;
          font-weight: 700;
          color: #4b3a26;
        }
        .weekly-leaderboard__your-rank {
          font-size: 0.85rem;
          color: #6b4626;
          font-weight: 600;
        }
        .weekly-leaderboard__table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.85rem;
        }
        .weekly-leaderboard__table th,
        .weekly-leaderboard__table td {
          padding: 0.4rem 0.5rem;
          text-align: left;
          border-bottom: 1px solid rgba(148, 122, 96, 0.18);
        }
        .weekly-leaderboard__table th {
          font-weight: 600;
          color: #8a6a3a;
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .weekly-leaderboard__rank-col {
          width: 2.5rem;
          text-align: center;
        }
        .weekly-leaderboard__score-col {
          text-align: right;
          width: 4.5rem;
          font-variant-numeric: tabular-nums;
        }
        .weekly-leaderboard__row--current {
          background: rgba(253, 230, 138, 0.45);
          font-weight: 600;
        }
        .weekly-leaderboard__state {
          padding: 1rem 0.5rem;
          text-align: center;
          color: #6b4626;
          font-size: 0.9rem;
        }
        .weekly-leaderboard__state--error {
          color: #991b1b;
        }
        .weekly-leaderboard__privacy {
          margin: 0;
          font-size: 0.7rem;
          color: #8a6a3a;
          font-style: italic;
        }
        @media (max-width: 480px) {
          .weekly-leaderboard {
            padding: 0.75rem;
          }
          .weekly-leaderboard__table th,
          .weekly-leaderboard__table td {
            padding: 0.3rem 0.35rem;
            font-size: 0.8rem;
          }
        }
        @media (forced-colors: active) {
          .weekly-leaderboard {
            border-color: CanvasText;
            background-color: Canvas;
          }
          .weekly-leaderboard__row--current {
            background-color: Highlight;
            color: HighlightText;
          }
        }
      `}</style>
      <header>
        <h3 id="weekly-leaderboard-title" className="weekly-leaderboard__title">
          {t('campaign.leaderboard_title', { defaultValue: 'Leaderboard' })}
        </h3>
        {currentUserRank != null && (
          <p className="weekly-leaderboard__your-rank">
            {t('campaign.leaderboard_your_rank', {
              rank: currentUserRank,
              defaultValue: `Your rank: #${currentUserRank}`,
            })}
          </p>
        )}
      </header>
      {loading ? (
        <p className="weekly-leaderboard__state" role="status" aria-live="polite">
          {t('campaign.leaderboard_loading', { defaultValue: 'Loading...' })}
        </p>
      ) : error ? (
        <p className="weekly-leaderboard__state weekly-leaderboard__state--error" role="alert">
          {t('campaign.leaderboard_error', { defaultValue: 'Could not load leaderboard' })}
        </p>
      ) : entries.length === 0 ? (
        <p className="weekly-leaderboard__state">
          {t('campaign.leaderboard_empty', { defaultValue: 'No entries yet' })}
        </p>
      ) : (
        <table className="weekly-leaderboard__table">
          <thead>
            <tr>
              <th scope="col" className="weekly-leaderboard__rank-col">
                #
              </th>
              <th scope="col">
                {t('campaign.leaderboard_name_col', { defaultValue: 'Name' })}
              </th>
              <th scope="col" className="weekly-leaderboard__score-col">
                {t('campaign.leaderboard_score_col', { defaultValue: 'Score' })}
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const isCurrent = currentUserRank != null && entry.rank === currentUserRank;
              return (
                <tr
                  key={`${entry.rank}-${entry.user_name}`}
                  className={isCurrent ? 'weekly-leaderboard__row--current' : ''}
                  aria-current={isCurrent ? 'true' : undefined}
                >
                  <td className="weekly-leaderboard__rank-col">{entry.rank}</td>
                  <td>{entry.user_name}</td>
                  <td className="weekly-leaderboard__score-col">{entry.score}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="weekly-leaderboard__privacy">
        {t('campaign.leaderboard_privacy_note', {
          defaultValue: 'Names are partially hidden for privacy',
        })}
      </p>
    </section>
  );
};
