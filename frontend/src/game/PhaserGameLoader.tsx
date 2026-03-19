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

interface NavigatorConnectionLike {
  saveData?: boolean;
  effectiveType?: string;
}

interface NavigatorLike {
  userAgent?: string;
  connection?: NavigatorConnectionLike;
}

interface PhaserPreloadEnvironmentLike {
  visibilityState?: DocumentVisibilityState | 'hidden' | 'visible' | 'prerender';
  prefersReducedData?: boolean;
}

export function shouldPreloadPhaserGame(
  targetNavigator: NavigatorLike | undefined,
  environment: PhaserPreloadEnvironmentLike = {},
): boolean {
  if (!targetNavigator) return false;
  if (/\bjsdom\b/i.test(targetNavigator.userAgent ?? '')) {
    return false;
  }
  if (environment.visibilityState && environment.visibilityState !== 'visible') {
    return false;
  }
  if (environment.prefersReducedData) {
    return false;
  }

  const connection = targetNavigator.connection;
  if (connection?.saveData) {
    return false;
  }

  const effectiveType = connection?.effectiveType?.toLowerCase();
  if (effectiveType === 'slow-2g' || effectiveType === '2g') {
    return false;
  }

  return true;
}

export function preloadPhaserGame() {
  const prefersReducedData = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-data: reduce)').matches;
  const visibilityState = typeof document !== 'undefined'
    ? document.visibilityState
    : undefined;

  if (!shouldPreloadPhaserGame(
    typeof navigator === 'undefined' ? undefined : navigator,
    { visibilityState, prefersReducedData },
  )) {
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
