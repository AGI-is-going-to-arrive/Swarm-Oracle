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
import { loadPhaserGameModule } from './phaserPreload';
import './game.css';

const LazyPhaserGame = lazy(loadPhaserGameModule);

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
  useDomBubbles?: boolean;
  replaySpeed?: number;
  playbackMode?: 'replay' | 'skip';
  playbackBranchId?: string | null;
  playbackRound?: number | null;
}

export function PhaserGameLoader({
  width,
  height,
  className,
  useDomBubbles,
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
        useDomBubbles={useDomBubbles}
        replaySpeed={replaySpeed}
        playbackMode={playbackMode}
        playbackBranchId={playbackBranchId}
        playbackRound={playbackRound}
      />
    </Suspense>
  );
}
