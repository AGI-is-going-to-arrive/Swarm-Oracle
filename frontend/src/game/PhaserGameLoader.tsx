/**
 * PhaserGameLoader — Lazy-loads the Phaser game with Suspense + fallback.
 *
 * This component:
 * 1. Dynamically imports PhaserGame to enable Vite code-splitting
 * 2. Shows a skeleton loader while the Phaser bundle downloads
 * 3. Provides an error boundary fallback
 */
import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { loadPhaserGameModule } from './phaserPreload';
import './game.css';

const LazyPhaserGame = lazy(loadPhaserGameModule);

interface ErrorBoundaryProps {
  children: ReactNode;
  t: (key: string) => string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  webglLost: boolean;
}

class PhaserErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    webglLost: false,
  };

  private cleanupContextLostListener?: () => void;

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[PhaserErrorBoundary] Caught error:', error, errorInfo);
  }

  componentDidMount() {
    const handleContextLost = (e: Event) => {
      e.preventDefault();
      this.setState({ webglLost: true, hasError: true });
    };
    window.addEventListener('webglcontextlost', handleContextLost, true);
    this.cleanupContextLostListener = () => {
      window.removeEventListener('webglcontextlost', handleContextLost, true);
    };
  }

  componentWillUnmount() {
    this.cleanupContextLostListener?.();
  }

  render() {
    if (this.state.hasError) {
      const { t } = this.props;
      return (
        <div className="game-skeleton game-skeleton--error" role="alert" style={{ flexDirection: 'column', gap: '8px' }}>
          <span>{t('game.visualization_unavailable')}</span>
          {this.state.webglLost && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => window.location.reload()}
              style={{ marginTop: '8px' }}
            >
              {t('game.webgl_lost_reload')}
            </button>
          )}
        </div>
      );
    }
    return this.props.children;
  }
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
  const { t } = useTranslation();

  return (
    <PhaserErrorBoundary t={t}>
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
    </PhaserErrorBoundary>
  );
}

