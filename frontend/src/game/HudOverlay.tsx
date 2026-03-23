/**
 * HudOverlay — React HUD elements rendered OUTSIDE the Phaser canvas.
 *
 * Displays:
 * - Leaderboard bar (above the canvas)
 * - Bet panel bar (below the canvas)
 *
 * Wraps children (the Phaser canvas) between the two bars.
 * Listens to EventBridge viz:* events via window CustomEvents.
 *
 * V3: GBC pixel-art styling + rank change animations + SVG faction icons
 */
import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface LeaderboardEntry {
  name: string;
  score: number;
  rank?: string;
}

interface BetData {
  leftOdds: number;
  rightOdds: number;
  leftPct: number;
  rightPct: number;
}

const RANK_MEDALS: Record<string, string> = {
  gold: '🥇',
  silver: '🥈',
  bronze: '🥉',
};

const RANK_COLORS: Record<string, string> = {
  gold: '#ffd700',
  silver: '#c0c0c0',
  bronze: '#cd7f32',
};

/** Inline SVG pixel faction square — lighter than loading external icons */
function FactionIcon({ color, side }: { color: string; side: 'left' | 'right' }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      style={{ flexShrink: 0, verticalAlign: 'middle' }}
      aria-label={`${side} faction`}
    >
      <rect x="1" y="1" width="8" height="8" fill={color} rx="1" />
      <rect x="3" y="3" width="4" height="4" fill="rgba(255,255,255,0.3)" rx="0.5" />
    </svg>
  );
}

/**
 * HudOverlay wraps children (the Phaser canvas) with a leaderboard bar
 * above and a bet panel bar below.
 */
interface HudOverlayProps {
  children: ReactNode;
  canPredict?: boolean;
  onOpenPrediction?: () => void;
}

export function HudOverlay({ children, canPredict = false, onOpenPrediction }: HudOverlayProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [bet, setBet] = useState<BetData>({
    leftOdds: 1.0,
    rightOdds: 1.0,
    leftPct: 50,
    rightPct: 50,
  });

  // Track previous scores for rank change animation
  const prevScoresRef = useRef<Map<string, number>>(new Map());
  const [animateNames, setAnimateNames] = useState<Set<string>>(new Set());

  // Listen to viz events from the EventBridge (DOM CustomEvents)
  const handleVizEvent = useCallback((e: Event) => {
    const ce = e as CustomEvent;
    const { type, data } = ce.detail ?? {};
    if (!type || !data) return;

    if (type === 'viz:leaderboard_update') {
      const newEntries = (data.entries as LeaderboardEntry[]) || [];
      const sliced = newEntries.slice(0, 3);

      // Detect rank changes for animation
      const changed = new Set<string>();
      for (const entry of sliced) {
        const prev = prevScoresRef.current.get(entry.name);
        if (prev !== undefined && prev !== entry.score) {
          changed.add(entry.name);
        }
        prevScoresRef.current.set(entry.name, entry.score);
      }

      if (changed.size > 0) {
        setAnimateNames(changed);
        // Clear animation class after animation completes
        setTimeout(() => setAnimateNames(new Set()), 700);
      }

      setEntries(sliced);
    } else if (type === 'viz:bet_update') {
      setBet({
        leftOdds: (data.left_odds as number) ?? 1.0,
        rightOdds: (data.right_odds as number) ?? 1.0,
        leftPct: (data.left_pct as number) ?? 50,
        rightPct: (data.right_pct as number) ?? 50,
      });
    }
  }, []);

  useEffect(() => {
    window.addEventListener('viz-event', handleVizEvent);
    return () => window.removeEventListener('viz-event', handleVizEvent);
  }, [handleVizEvent]);

  return (
    <>
      {/* ── Leaderboard (above canvas) ── */}
      <div className="hud-bar hud-bar--top">
        <span className="hud-bar__icon">🏆</span>
        <span className="hud-bar__title">{t('game.leaderboard_hud')}</span>
        <div className="hud-bar__entries">
          {entries.length > 0 ? (
            entries.map((e, i) => {
              const rank = e.rank || (i === 0 ? 'gold' : i === 1 ? 'silver' : 'bronze');
              const medal = RANK_MEDALS[rank] || RANK_MEDALS.bronze;
              const color = RANK_COLORS[rank] || RANK_COLORS.bronze;
              const isAnimating = animateNames.has(e.name);
              return (
                <span
                  key={e.name + i}
                  className={`hud-entry ${isAnimating ? 'hud-entry--animate' : ''}`}
                  style={{ color }}
                >
                  {medal} {e.name.slice(0, 8)} <b>{e.score}</b>
                </span>
              );
            })
          ) : (
            <span className="hud-entry hud-entry--placeholder">---</span>
          )}
        </div>
      </div>

      {/* ── Canvas (via children) ── */}
      {children}

      {/* ── Bet Panel (below canvas) ── */}
      <div className="hud-bar hud-bar--bottom">
        <span className="hud-bar__icon">⚔️</span>
        <span className="hud-bar__title">{t('game.bet_panel_title')}</span>
        <div className="hud-bet__content">
          <span className="hud-bet__faction hud-bet__faction--left">
            <FactionIcon color="#F44336" side="left" />{' '}
            <b>{bet.leftOdds.toFixed(1)}x</b>
          </span>
          <div className="hud-bet__bars">
            <div
              className="hud-bet__bar hud-bet__bar--left"
              style={{ width: `${bet.leftPct}%` }}
            />
            <div
              className="hud-bet__bar hud-bet__bar--right"
              style={{ width: `${bet.rightPct}%` }}
            />
          </div>
          <span className="hud-bet__faction hud-bet__faction--right">
            <b>{bet.rightOdds.toFixed(1)}x</b>{' '}
            <FactionIcon color="#2196F3" side="right" />
          </span>
        </div>
        <span
          className={`hud-bet__status ${canPredict ? 'hud-bet__status--open' : 'hud-bet__status--locked'}`}
          aria-live="polite"
        >
          {canPredict ? t('game.bet_window_open') : t('game.bet_window_locked')}
        </span>
        <button
          className="hud-bet__action"
          onClick={() => onOpenPrediction?.()}
          disabled={!canPredict}
          aria-label={canPredict ? t('game.bet_action') : t('game.bet_locked')}
          title={canPredict ? t('game.bet_action') : t('game.bet_locked')}
        >
          {canPredict ? t('game.bet_action') : t('game.bet_locked')}
        </button>
      </div>
    </>
  );
}
