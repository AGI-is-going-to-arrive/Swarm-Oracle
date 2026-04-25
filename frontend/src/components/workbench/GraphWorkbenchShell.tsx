import { Suspense, lazy, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Tooltip from '@radix-ui/react-tooltip';
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

const DIVIDER_W = 6;
const MIN_PANEL_PCT = 20;
const MAX_PANEL_PCT = 80;

export default function GraphWorkbenchShell({
  scenarioId,
  branchId,
  mode,
  isCompact,
}: GraphWorkbenchShellProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftPct, setLeftPct] = useState(50);
  const dragging = useRef(false);

  const showNotice = isCompact && mode === 'split';
  const showCausal = mode !== 'kg';
  const showKG = mode !== 'graph';
  const isSplit = mode === 'split';

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.min(MAX_PANEL_PCT, Math.max(MIN_PANEL_PCT, (x / rect.width) * 100));
    setLeftPct(pct);
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const onDoubleClick = useCallback(() => {
    setLeftPct(50);
  }, []);

  const singlePanel = !isSplit;

  return (
    <Tooltip.Provider delayDuration={300}>
    <div
      ref={containerRef}
      data-testid="graph-workbench-shell"
      onPointerMove={isSplit ? onPointerMove : undefined}
      onPointerUp={isSplit ? onPointerUp : undefined}
      style={{
        display: 'flex',
        height: '100%',
        minHeight: 0,
        contain: 'layout style paint',
        userSelect: dragging.current ? 'none' : undefined,
      }}
    >
      {showNotice && (
        <p
          data-testid="workbench-compact-notice"
          role="status"
          style={{
            width: '100%',
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

      {showCausal && (
        <section
          role="tabpanel"
          id="workbench-panel-graph"
          aria-labelledby="workbench-tab-graph"
          style={{
            width: singlePanel ? '100%' : `calc(${leftPct}% - ${DIVIDER_W / 2}px)`,
            minHeight: 0,
            minWidth: 0,
            overflow: 'hidden',
            contain: 'layout style paint',
          }}
        >
          <Suspense fallback={<PanelFallback />}>
            <CausalGraphBoard
              scenarioId={scenarioId}
              branchId={branchId}
              hideExport={isSplit}
            />
          </Suspense>
        </section>
      )}

      {isSplit && showCausal && showKG && (
        <div
          data-testid="workbench-divider"
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={Math.round(leftPct)}
          aria-valuemin={MIN_PANEL_PCT}
          aria-valuemax={MAX_PANEL_PCT}
          aria-label={t('workbench.resize_divider', 'Drag to resize panels')}
          tabIndex={0}
          style={{
            width: DIVIDER_W,
            cursor: 'col-resize',
            background: 'rgba(255,255,255,0.08)',
            borderRadius: 3,
            flexShrink: 0,
            position: 'relative',
            transition: 'background 0.15s',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.2)'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'; }}
        >
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 2,
            height: 32,
            borderRadius: 1,
            background: 'rgba(255,255,255,0.3)',
          }} />
        </div>
      )}

      {showKG && (
        <section
          role="tabpanel"
          id="workbench-panel-kg"
          aria-labelledby="workbench-tab-kg"
          style={{
            width: singlePanel ? '100%' : `calc(${100 - leftPct}% - ${DIVIDER_W / 2}px)`,
            minHeight: 0,
            minWidth: 0,
            overflow: 'hidden',
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
    </Tooltip.Provider>
  );
}
