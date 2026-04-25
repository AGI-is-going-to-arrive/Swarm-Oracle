import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import LayoutSwitcher, { type LayoutMode } from '../components/workbench/LayoutSwitcher';
import GraphWorkbenchShell from '../components/workbench/GraphWorkbenchShell';
import { AppErrorBoundary } from '../components/AppErrorBoundary';

const VALID_MODES = new Set<LayoutMode>(['graph', 'split', 'kg']);

function useViewportIsCompact(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 768,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const handle = (e: MediaQueryListEvent | MediaQueryList) => setCompact(e.matches);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handle);
      return () => mq.removeEventListener?.('change', handle);
    }
    mq.addListener?.(handle);
    return () => mq.removeListener?.(handle);
  }, []);
  return compact;
}

export default function WorkbenchView() {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const isCompact = useViewportIsCompact();

  const rawView = searchParams.get('view');
  const branchId = searchParams.get('branch') ?? undefined;

  const {
    loading: causalLoading,
    enabled: causalEnabled,
    error: causalError,
    reload: reloadCausal,
  } = useCapabilityCheck('causal_graph');

  const {
    loading: kgLoading,
    enabled: kgEnabled,
    error: kgError,
    reload: reloadKg,
  } = useCapabilityCheck('kg_explorer');

  const capLoading = causalLoading || kgLoading;
  const capError = causalError || kgError;

  useEffect(() => {
    if (capLoading) return;
    if (rawView && !VALID_MODES.has(rawView as LayoutMode)) {
      setSearchParams((prev) => { prev.set('view', 'graph'); return prev; }, { replace: true });
      return;
    }
    if (isCompact && rawView === 'split') {
      setSearchParams((prev) => { prev.set('view', 'graph'); return prev; }, { replace: true });
    }
  }, [rawView, isCompact, capLoading, setSearchParams]);

  const mode: LayoutMode = rawView && VALID_MODES.has(rawView as LayoutMode)
    ? (rawView as LayoutMode)
    : 'graph';

  const effectiveMode: LayoutMode = isCompact && mode === 'split' ? 'graph' : mode;

  const modeAllowed =
    effectiveMode === 'graph' ? causalEnabled :
    effectiveMode === 'kg' ? (kgEnabled && causalEnabled) :
    causalEnabled && kgEnabled;

  const handleModeChange = (next: LayoutMode) => {
    setSearchParams((prev) => {
      prev.set('view', next);
      return prev;
    });
  };

  const handleReload = () => {
    void reloadCausal?.();
    void reloadKg?.();
  };

  if (capLoading) {
    return (
      <div data-testid="workbench-root" style={{ padding: '3rem', textAlign: 'center' }}>
        <p>{t('workbench.loading', 'Loading workbench...')}</p>
      </div>
    );
  }

  if (capError) {
    return (
      <div data-testid="workbench-root" role="alert" style={{ padding: '3rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>
          {t('workbench.error', 'Failed to load workbench')}
        </h1>
        <button
          type="button"
          onClick={handleReload}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: '1px solid #555',
            background: 'transparent',
            color: '#8ab4f8',
            cursor: 'pointer',
          }}
        >
          {t('common.retry', 'Retry')}
        </button>
      </div>
    );
  }

  if (!modeAllowed) {
    return (
      <div data-testid="workbench-root" role="alert" style={{ maxWidth: 600, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>
        <p style={{ color: '#9aa4b2', marginBottom: '1rem' }}>
          {t('workbench.unavailable', 'Workbench feature is not enabled')}
        </p>
        <Link to="/" style={{ color: '#8ab4f8' }}>
          {t('common.back_home', 'Back to home')}
        </Link>
      </div>
    );
  }

  return (
    <div
      data-testid="workbench-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
        minHeight: '100dvh',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '0.75rem 1rem',
          borderBottom: '1px solid #333',
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
          {t('workbench.title', 'Graph Workbench')}
        </h1>
        <LayoutSwitcher
          mode={effectiveMode}
          onChange={handleModeChange}
          isCompact={isCompact}
        />
      </header>

      <main style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <AppErrorBoundary>
          <Suspense
            fallback={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                <p style={{ color: '#9aa4b2' }}>{t('workbench.loading', 'Loading workbench...')}</p>
              </div>
            }
          >
            <GraphWorkbenchShell
              scenarioId={id}
              branchId={branchId}
              mode={effectiveMode}
              isCompact={isCompact}
            />
          </Suspense>
        </AppErrorBoundary>
      </main>
    </div>
  );
}
