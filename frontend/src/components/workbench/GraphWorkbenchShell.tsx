import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import type { LayoutMode } from './LayoutSwitcher';

const CausalGraphBoard = lazy(() => import('./CausalGraphBoard'));
const KGGraphBoard = lazy(() => import('./KGGraphBoard'));

export interface GraphWorkbenchShellProps {
  scenarioId: string;
  branchId?: string;
  mode: LayoutMode;
  isCompact: boolean;
  onBranchChange?: (branchId: string) => void;
}

function PanelFallback() {
  const { t } = useTranslation();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
      <p style={{ color: '#9aa4b2', fontSize: '0.85rem' }}>{t('common.loading', 'Loading...')}</p>
    </div>
  );
}

export default function GraphWorkbenchShell({
  scenarioId,
  branchId,
  mode,
  isCompact,
}: GraphWorkbenchShellProps) {
  const { t } = useTranslation();

  const showNotice = isCompact && mode === 'split';

  const showCausal = mode !== 'kg';
  const showKG = mode !== 'graph';

  const gridColumns = mode === 'split' ? '1fr 1fr' : '1fr';

  return (
    <div
      data-testid="graph-workbench-shell"
      style={{
        display: 'grid',
        gridTemplateColumns: gridColumns,
        gap: '0.75rem',
        height: '100%',
        minHeight: 0,
        contain: 'layout style paint',
      }}
    >
      {showNotice && (
        <p
          data-testid="workbench-compact-notice"
          role="status"
          style={{
            gridColumn: '1 / -1',
            color: '#9aa4b2',
            fontSize: '0.78rem',
            textAlign: 'center',
            padding: '0.5rem',
            margin: 0,
          }}
        >
          {t('workbench.mobile_single_only', 'Split view is only available on desktop.')}
        </p>
      )}

      {/* Panels are conditionally rendered (not display:none) so that G6
         always initializes with real container dimensions. autoResize
         handles subsequent resizes, but a 0x0 initial mount is not
         recoverable in all browsers. */}
      {showCausal && (
        <section
          role="tabpanel"
          id="workbench-panel-graph"
          aria-labelledby="workbench-tab-graph"
          style={{
            minHeight: 0,
            contain: 'layout style paint',
          }}
        >
          <Suspense fallback={<PanelFallback />}>
            <CausalGraphBoard
              scenarioId={scenarioId}
              branchId={branchId}
            />
          </Suspense>
        </section>
      )}

      {showKG && (
        <section
          role="tabpanel"
          id="workbench-panel-kg"
          aria-labelledby="workbench-tab-kg"
          style={{
            minHeight: 0,
            contain: 'layout style paint',
          }}
        >
          <Suspense fallback={<PanelFallback />}>
            <KGGraphBoard
              scenarioId={scenarioId}
              branchId={branchId}
            />
          </Suspense>
        </section>
      )}
    </div>
  );
}
