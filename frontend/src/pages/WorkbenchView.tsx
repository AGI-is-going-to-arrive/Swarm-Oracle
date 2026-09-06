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
  const availableModes: Record<LayoutMode, boolean> = {
    graph: causalEnabled && !causalLoading && !causalError,
    kg: kgEnabled && !kgLoading && !kgError,
    split: causalEnabled && kgEnabled && !capLoading && !capError && !isCompact,
  };
  const defaultMode: LayoutMode = availableModes.graph ? 'graph' : availableModes.kg ? 'kg' : 'graph';
  const disabledReason = (loading: boolean, error: Error | null | undefined): string => (
    loading ? t('workbench.loading', 'Loading workbench...')
      : error ? t('common.capability_error', 'Unable to verify feature availability. Please try again.')
        : t('workbench.unavailable', 'Workbench feature is not enabled')
  );
  const disabledReasons: Record<LayoutMode, string> = {
    graph: disabledReason(causalLoading, causalError),
    kg: disabledReason(kgLoading, kgError),
    split: disabledReason(capLoading, capError),
  };
  const encodedScenarioId = encodeURIComponent(id);
  const resultHref = id ? `/result/${encodedScenarioId}` : '/';

  useEffect(() => {
    if (capLoading) return;
    if (rawView && !VALID_MODES.has(rawView as LayoutMode)) {
      setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set('view', defaultMode); return next; }, { replace: true });
      return;
    }
    if (isCompact && rawView === 'split') {
      setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set('view', defaultMode); return next; }, { replace: true });
    }
  }, [rawView, isCompact, capLoading, defaultMode, setSearchParams]);

  const mode: LayoutMode = rawView && VALID_MODES.has(rawView as LayoutMode)
    ? (rawView as LayoutMode)
    : defaultMode;

  const effectiveMode: LayoutMode = isCompact && mode === 'split' ? defaultMode : mode;

  const modeAllowed = availableModes[effectiveMode];
  const modeLoading = effectiveMode === 'graph' ? causalLoading : effectiveMode === 'kg' ? kgLoading : capLoading;
  const modeError = effectiveMode === 'graph' ? causalError : effectiveMode === 'kg' ? kgError : capError;

  const handleModeChange = (next: LayoutMode) => {
    if (!availableModes[next]) return;
    setSearchParams((prev) => {
      const updated = new URLSearchParams(prev);
      updated.set('view', next);
      return updated;
    });
  };

  const handleReload = () => {
    void reloadCausal?.();
    void reloadKg?.();
  };

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
        <div style={{ display: 'grid', gap: '0.2rem', minWidth: 0 }}>
          <Link
            to={resultHref}
            style={{
              color: 'var(--text-link, #8ab4f8)',
              fontSize: '0.9rem',
              textDecoration: 'none',
              width: 'fit-content',
            }}
          >
            &larr; {t('common.back_to_result', 'Back to Result')}
          </Link>
          <h1 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
            {t('workbench.title', 'Graph Workbench')}
          </h1>
        </div>
        <LayoutSwitcher
          mode={effectiveMode}
          onChange={handleModeChange}
          isCompact={isCompact}
          availableModes={availableModes}
          disabledReasons={disabledReasons}
        />
      </header>

      <main style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {capError && (
          <div role="alert" style={{ padding: '1rem', textAlign: 'center' }}>
            <p>{t('workbench.error', 'Failed to load workbench')}</p>
            <button type="button" onClick={handleReload} style={{ color: 'var(--text-link, #8ab4f8)' }}>
              {t('common.retry', 'Retry')}
            </button>
          </div>
        )}
        {modeLoading ? (
          <p role="status" style={{ padding: '3rem', textAlign: 'center' }}>
            {t('workbench.loading', 'Loading workbench...')}
          </p>
        ) : modeAllowed ? (
          <div style={{ flex: 1, minHeight: 0 }}>
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
          </div>
        ) : !modeError && (
          <div role="alert" style={{ padding: '3rem', textAlign: 'center' }}>
            <p>{t('workbench.unavailable', 'Workbench feature is not enabled')}</p>
            <button type="button" onClick={handleReload} style={{ color: 'var(--text-link, #8ab4f8)' }}>
              {t('common.retry', 'Retry')}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
