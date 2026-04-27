import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export type LayoutMode = 'graph' | 'split' | 'kg';

export interface LayoutSwitcherProps {
  mode: LayoutMode;
  onChange: (mode: LayoutMode) => void;
  isCompact?: boolean;
}

const MODES: LayoutMode[] = ['graph', 'split', 'kg'];
const COMPACT_MODES: LayoutMode[] = ['graph', 'kg'];

const LABEL_KEYS: Record<LayoutMode, [string, string]> = {
  graph: ['workbench.layout_graph', 'Causal'],
  split: ['workbench.layout_split', 'Split'],
  kg: ['workbench.layout_kg', 'Knowledge Graph'],
};

const TAB_CONTROLS: Record<LayoutMode, string> = {
  graph: 'workbench-panel-graph',
  kg: 'workbench-panel-kg',
  split: 'workbench-panel-graph workbench-panel-kg',
};

export default function LayoutSwitcher({ mode, onChange, isCompact = false }: LayoutSwitcherProps) {
  const { t } = useTranslation();
  const tabRefs = useRef<Map<LayoutMode, HTMLButtonElement>>(new Map());
  const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const modes = isCompact ? COMPACT_MODES : MODES;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const currentIndex = modes.indexOf(mode);
      let nextIndex = -1;

      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        nextIndex = (currentIndex + 1) % modes.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        nextIndex = (currentIndex - 1 + modes.length) % modes.length;
      } else if (e.key === 'Home') {
        e.preventDefault();
        nextIndex = 0;
      } else if (e.key === 'End') {
        e.preventDefault();
        nextIndex = modes.length - 1;
      }

      if (nextIndex >= 0) {
        const nextMode = modes[nextIndex];
        onChange(nextMode);
        tabRefs.current.get(nextMode)?.focus();
      }
    },
    [mode, modes, onChange],
  );

  return (
    <div
      role="tablist"
      aria-label={t('workbench.layout_tablist_label', 'Select view layout')}
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        borderRadius: 10,
        background: 'var(--bg-hover, #f2eee7)',
        border: '1px solid var(--border-subtle, #e1ddd7)',
      }}
    >
      {modes.map((m) => {
        const selected = m === mode;
        const [key, fallback] = LABEL_KEYS[m];
        return (
          <button
            key={m}
            ref={(el) => {
              if (el) tabRefs.current.set(m, el);
              else tabRefs.current.delete(m);
            }}
            role="tab"
            id={`workbench-tab-${m}`}
            aria-controls={TAB_CONTROLS[m]}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(m)}
            onKeyDown={handleKeyDown}
            style={{
              padding: '6px 14px',
              minHeight: 36,
              borderRadius: 8,
              border: 'none',
              background: selected
                ? 'var(--bg-elevated, #fff)'
                : 'transparent',
              color: selected
                ? 'var(--text-primary, #181611)'
                : 'var(--text-muted, #928f88)',
              cursor: 'pointer',
              fontSize: '0.82rem',
              fontWeight: selected ? 600 : 400,
              boxShadow: selected ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
              transition: prefersReducedMotion ? 'none' : 'background 150ms, color 150ms, box-shadow 150ms',
            }}
          >
            {t(key, fallback)}
          </button>
        );
      })}
    </div>
  );
}
