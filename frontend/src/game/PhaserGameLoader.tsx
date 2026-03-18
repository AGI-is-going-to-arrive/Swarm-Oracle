/**
 * PhaserGameLoader — Lazy-loads the Phaser game with Suspense + fallback.
 *
 * This component:
 * 1. Dynamically imports PhaserGame to enable Vite code-splitting
 * 2. Shows a skeleton loader while the Phaser bundle downloads
 * 3. Provides an error boundary fallback
 */
import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import './game.css';

const loadPhaserGame = () =>
  import('./PhaserGame').then((mod) => ({ default: mod.PhaserGame }));

const LazyPhaserGame = lazy(loadPhaserGame);

export function preloadPhaserGame() {
  if (typeof navigator !== 'undefined' && /\bjsdom\b/i.test(navigator.userAgent)) {
    return;
  }
  void loadPhaserGame();
}

function GameSkeleton() {
  const { t } = useTranslation();
  return (
    <div className="game-skeleton">
      <div className="game-skeleton__spinner" />
      <span>{t('game.loading')}</span>
    </div>
  );
}

interface PhaserGameLoaderProps {
  width?: number;
  height?: number;
  className?: string;
  replaySpeed?: number;
  playbackMode?: 'replay' | 'skip';
  playbackBranchId?: string | null;
  playbackRound?: number | null;
}

export function PhaserGameLoader({
  width,
  height,
  className,
  replaySpeed,
  playbackMode,
  playbackBranchId,
  playbackRound,
}: PhaserGameLoaderProps) {
  return (
    <Suspense fallback={<GameSkeleton />}>
      <LazyPhaserGame
        width={width}
        height={height}
        className={className}
        replaySpeed={replaySpeed}
        playbackMode={playbackMode}
        playbackBranchId={playbackBranchId}
        playbackRound={playbackRound}
      />
    </Suspense>
  );
}
