/**
 * Phase C2 — ArgumentMap tests (upgraded for @xyflow/react DAG)
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fitViewMock = vi.fn();
type TestLocale = 'en' | 'zh';
let currentLocale: TestLocale = 'en';

const TEST_TRANSLATIONS: Record<TestLocale, Record<string, string>> = {
  en: {
    'argument.claim': 'Claim',
    'argument.evidence': 'Evidence',
    'argument.rebuttal': 'Rebuttal',
    'argument.counter': 'Counter',
    'argument.empty': 'No argument map available.',
    'argument.mobile_list_label': 'Argument units list',
    'argument.tour_label': 'Argument map guide',
    'argument.tour_step_verdict': 'This is the verdict — the starting point of the argument map.',
    'argument.tour_step_filter': 'Filter by status to focus on specific arguments.',
    'argument.tour_step_node': 'Click any node to see its argument chain and details.',
    'argument.status_accepted': 'Accepted',
    'argument.status_standing': 'Standing',
    'argument.status_unaddressed': 'Unaddressed',
    'argument.status_rebutted': 'Rebutted',
    'argument.status_rejected': 'Rejected',
    'argument.a11y_label': 'Debate argument map',
    'argument.a11y_list': 'Argument units list',
    'argument.a11y_relations': 'Argument relations list',
    'argument.edge_supports': 'supports',
    'argument.edge_rebuts': 'rebuts',
    'argument.edge_accepted': 'accepts',
    'argument.edge_rejected': 'rejects',
    'argument.edge_unaddressed': 'leaves unaddressed',
    'argument.edge_relation': '{{source}} {{relation}} {{target}}',
    'argument.open_details': 'Open details',
    'causal.evidence_high': 'High',
    'causal.evidence_medium': 'Medium',
    'causal.evidence_low': 'Low',
    'common.graph_controls': 'Graph controls',
    'common.graph_zoom_in': 'Zoom in',
    'common.graph_zoom_out': 'Zoom out',
    'common.graph_fit_view': 'Fit view',
    'common.graph_toggle_interactivity': 'Toggle interactivity',
    'common.graph_minimap': 'Mini map',
    'common.graph_mobile_hint': 'Drag to pan. Pinch or use the graph controls to zoom.',
    'common.skip': 'Skip',
    'common.next': 'Next',
    'common.done': 'Done',
    'argument.search_label': 'Search argument map',
    'argument.search_placeholder': 'Search label, text, type…',
    'argument.search_match_count': '{{matches}} matches, {{related}} related',
    'argument.search_no_match': 'No matches',
    'argument.reset_layout': 'Reset layout',
  },
  zh: {
    'argument.claim': '论点',
    'argument.evidence': '证据',
    'argument.rebuttal': '反驳',
    'argument.counter': '反击',
    'argument.empty': '暂无论证图谱数据。',
    'argument.mobile_list_label': '论证单元列表',
    'argument.tour_label': '论证图谱引导',
    'argument.tour_step_verdict': '这是裁决 — 论证图谱的起点。',
    'argument.tour_step_filter': '按状态筛选，聚焦特定论证。',
    'argument.tour_step_node': '点击任意节点查看论证链和详情。',
    'argument.status_accepted': '已采纳',
    'argument.status_standing': '成立',
    'argument.status_unaddressed': '未回应',
    'argument.status_rebutted': '已反驳',
    'argument.status_rejected': '已驳回',
    'argument.a11y_label': '辩论论证图谱',
    'argument.a11y_list': '论证单元列表',
    'argument.a11y_relations': '论证关系列表',
    'argument.edge_supports': '支持',
    'argument.edge_rebuts': '反驳',
    'argument.edge_accepted': '采纳',
    'argument.edge_rejected': '驳回',
    'argument.edge_unaddressed': '未回应',
    'argument.edge_relation': '{{source}} {{relation}} {{target}}',
    'argument.open_details': '打开详情',
    'causal.evidence_high': '高',
    'causal.evidence_medium': '中',
    'causal.evidence_low': '低',
    'common.graph_controls': '图谱控件',
    'common.graph_zoom_in': '放大',
    'common.graph_zoom_out': '缩小',
    'common.graph_fit_view': '适配视图',
    'common.graph_toggle_interactivity': '切换交互状态',
    'common.graph_minimap': '缩略图',
    'common.graph_mobile_hint': '可拖动画布；双指缩放或使用图谱控件调整视图。',
    'common.skip': '跳过',
    'common.next': '下一步',
    'common.done': '完成',
    'argument.search_label': '搜索论证图',
    'argument.search_placeholder': '搜索标签、文本、类型…',
    'argument.search_match_count': '{{matches}} 条匹配，{{related}} 条相关',
    'argument.search_no_match': '未匹配到任何节点',
    'argument.reset_layout': '重置布局',
  },
};

function interpolate(template: string, values: Record<string, unknown>) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => String(values[key] ?? ''));
}

function resolveTranslation(locale: TestLocale, key: string, fallback?: string | Record<string, unknown>) {
  if (typeof fallback === 'string') return TEST_TRANSLATIONS[locale][key] ?? fallback;
  if (fallback && typeof fallback === 'object') {
    const template = TEST_TRANSLATIONS[locale][key] ?? String(fallback.defaultValue ?? key);
    return interpolate(template, fallback);
  }
  return TEST_TRANSLATIONS[locale][key] ?? key;
}

function setTestLocale(locale: TestLocale) {
  currentLocale = locale;
}

const translationFns: Record<TestLocale, (key: string, fallback?: string | Record<string, unknown>) => string> = {
  en: (key, fallback) => resolveTranslation('en', key, fallback),
  zh: (key, fallback) => resolveTranslation('zh', key, fallback),
};

const i18nMock = {
  changeLanguage: vi.fn(async (locale: string) => {
    if (locale === 'en' || locale === 'zh') currentLocale = locale;
  }),
  get language() {
    return currentLocale;
  },
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translationFns[currentLocale],
    i18n: i18nMock,
  }),
}));

vi.mock('@xyflow/react', async () => {
  const React = await import('react');

  function useNodesStateMock<T>(initial: T[]) {
    const [patchFn, setPatchFn] = React.useState<((nodes: T[]) => T[]) | null>(null);
    const [dragPositions, setDragPositions] = React.useState<Map<string, { x: number; y: number }>>(new Map());
    const baseNodes = React.useMemo(() => {
      if (patchFn) return patchFn(initial);
      return initial;
    }, [initial, patchFn]);
    const nodes = React.useMemo(() => {
      if (dragPositions.size === 0) return baseNodes;
      return baseNodes.map((n) => {
        const id = (n as Record<string, unknown>).id as string;
        const pos = dragPositions.get(id);
        return pos ? { ...n, position: pos } as T : n;
      });
    }, [baseNodes, dragPositions]);
    /* eslint-disable react-hooks/preserve-manual-memoization */
    const setNodes = React.useCallback(
      (arg: T[] | ((prev: T[]) => T[])) => {
        if (typeof arg === 'function') {
          const updater = arg as (prev: T[]) => T[];
          setPatchFn(() => (current: T[]) => updater(current));
        } else {
          setPatchFn(null);
          setDragPositions(new Map());
        }
      },
      [],
    );
    const onNodesChange = React.useCallback(
      (changes: Array<{ id: string; type: string; position?: { x: number; y: number }; dragging?: boolean }>) => {
        setDragPositions((prev) => {
          const next = new Map(prev);
          for (const c of changes) {
            if (c.type === 'position' && c.position) {
              next.set(c.id, c.position);
            }
          }
          return next;
        });
      },
      [],
    );
    /* eslint-enable react-hooks/preserve-manual-memoization */
    return [nodes, setNodes, onNodesChange] as const;
  }
  function useEdgesStateMock<T>(initial: T[]) {
    const setEdges = React.useCallback(() => {}, []);
    const onEdgesChange = React.useCallback(() => {}, []);
    return [initial, setEdges, onEdgesChange] as const;
  }
  return {
    ReactFlow: (props: Record<string, unknown>) => {
      const nodes = props.nodes as Array<{ id: string; position?: { x: number; y: number }; focusable?: boolean; ariaLabel?: string | null; ariaRole?: string | null; data?: Record<string, unknown> }> | undefined;
      const edges = props.edges as Array<Record<string, unknown>> | undefined;
      const ariaLabelConfig = props.ariaLabelConfig as Record<string, string> | undefined;
      const children = props.children as React.ReactNode;
      const onNodeClick = props.onNodeClick as ((e: unknown, n: unknown) => void) | undefined;
      const onPaneClick = props.onPaneClick as (() => void) | undefined;
      const onNodesChange = props.onNodesChange as ((changes: unknown[]) => void) | undefined;
      const onInit = props.onInit as ((instance: { fitView: typeof fitViewMock }) => void) | undefined;
      const firstEdge = edges?.[0];
      const firstNode = nodes?.[0];

      React.useEffect(() => {
        onInit?.({ fitView: fitViewMock });
      }, [onInit]);

      return (
        <div
          data-testid="reactflow"
          data-nodes={nodes?.length}
          data-edges={edges?.length}
          data-edge-stroke={String((firstEdge?.style as Record<string, unknown> | undefined)?.stroke ?? '')}
          data-edge-dash={String((firstEdge?.style as Record<string, unknown> | undefined)?.strokeDasharray ?? '')}
          data-edge-animated={String(firstEdge?.animated ?? false)}
          data-edge-marker={JSON.stringify(firstEdge?.markerEnd ?? null)}
          data-edge-label={String(firstEdge?.label ?? '')}
          data-edge-opacity={String((firstEdge?.style as Record<string, unknown> | undefined)?.opacity ?? '')}
          data-node-focusable={String(firstNode?.focusable ?? '')}
          data-node-aria-label={firstNode?.ariaLabel ?? ''}
          data-node-aria-role={firstNode?.ariaRole ?? ''}
          data-node-dimmed={String(firstNode?.data?.dimmed ?? '')}
          data-node-search-match={String(firstNode?.data?.searchMatch ?? '')}
          data-node-search-related={String(firstNode?.data?.searchRelated ?? '')}
          data-aria-label-config={JSON.stringify(ariaLabelConfig ?? {})}
          data-pan-on-drag={JSON.stringify(props.panOnDrag ?? null)}
          data-fit-view-options={JSON.stringify(props.fitViewOptions ?? null)}
          data-nodes-draggable={String(props.nodesDraggable ?? '')}
        >
          {nodes?.map(n => (
            <button key={n.id} data-testid={`rf-node-${n.id}`} data-dimmed={String(n.data?.dimmed ?? false)} data-search-match={String(n.data?.searchMatch ?? false)} data-search-related={String(n.data?.searchRelated ?? false)} data-x={String(n.position?.x ?? '')} data-y={String(n.position?.y ?? '')} onClick={(e) => onNodeClick?.(e, n)} />
          ))}
          <button data-testid="rf-pane" onClick={() => onPaneClick?.()} />
          <button data-testid="rf-dispatch-position" onClick={() => {
            onNodesChange?.([{ id: 'n1', type: 'position', position: { x: 999, y: 888 }, dragging: false }]);
          }} />
          {children}
        </div>
      );
    },
    Background: () => null,
    BackgroundVariant: { Dots: 'dots', Lines: 'lines', Cross: 'cross' },
    Controls: () => null,
    MiniMap: ({ style }: { style?: React.CSSProperties }) => (
      <div data-testid="rf-minimap" data-pointer-events={String(style?.pointerEvents ?? '')} />
    ),
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    useNodesState: useNodesStateMock,
    useEdgesState: useEdgesStateMock,
  };
});

import { ArgumentMap } from './ArgumentMap';
import { ArgumentMapMobileList } from './ArgumentMapMobileList';
import { ArgumentMapTour } from './ArgumentMapTour';

afterEach(() => {
  cleanup();
  fitViewMock.mockReset();
  currentLocale = 'en';
  document.body.classList.remove('has-argument-map');
  window.localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});


// ── ArgumentMap main component ──────────────────────────────

describe('ArgumentMap', () => {
  it('returns null when not visible', () => {
    const { container } = render(<ArgumentMap debateId="d1" visible={false} />);
    expect(container.innerHTML).toBe('');
  });

  it.each([
    { verdict: false, autoTour: true },
    { verdict: true, autoTour: false },
  ])('keeps manual graph inspection without a false or suppressed automatic tour: %j', async ({ verdict, autoTour }) => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 'saved-graph',
        nodes: [
          { id: 'claim', key: 'claim', type: 'claim', label: 'Saved claim', round: 1, payload: null },
          ...(verdict ? [{ id: 'verdict', key: 'verdict', type: 'verdict', label: 'Saved verdict', round: 2, payload: null }] : []),
        ],
        edges: [],
        units: [{ id: 'unit', type: 'claim', status: 'standing', text: 'Saved claim', turn_id: 'turn', node_id: 'claim' }],
      }),
    } as Response);
    render(<ArgumentMap debateId="saved-debate" visible autoTour={autoTour} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(screen.getByTestId('reactflow')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Argument map guide' })).not.toBeInTheDocument();
    expect(screen.queryByText(/This is the verdict/)).not.toBeInTheDocument();
  });

  it('shows loading state while fetching', () => {
    // Never resolve the fetch to keep loading state
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise(() => {}));
    render(<ArgumentMap debateId="d1" visible={true} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('shows empty state when API returns no units and no nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ snapshot_id: null, nodes: [], edges: [], units: [] }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/No argument map/);
    expect(msg).toBeInTheDocument();
  });

  it('keeps filter controls available when no units match the selected statuses', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-empty-filter',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Only standing', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Only standing', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    // Single-status filter with no matching units: show the new in-graph
    // empty state (status-specific icon + i18n message), keep the
    // ReactFlow surface mounted, and keep all filter controls available.
    await user.click(screen.getByRole('button', { name: 'Accepted' }));

    const emptyState = await screen.findByTestId('argmap-filter-empty');
    expect(emptyState).toBeInTheDocument();
    expect(emptyState).toHaveAttribute('role', 'status');
    expect(emptyState).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByRole('button', { name: 'Standing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    // The ReactFlow container stays mounted (in-graph overlay design).
    expect(screen.queryByTestId('reactflow')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    expect(screen.queryByTestId('argmap-filter-empty')).not.toBeInTheDocument();
  });

  it('renders ReactFlow component when data has units (fallback layout)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Economy grows', turn_id: 't1' },
          { id: 'u2', type: 'rebuttal', status: 'rebutted', text: 'Inflation rises', turn_id: 't2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow).toBeInTheDocument();
    // Fallback layout: 2 units → 2 nodes, 0 edges
    expect(flow.getAttribute('data-nodes')).toBe('2');
    expect(flow.getAttribute('data-edges')).toBe('0');
  });

  it('renders ReactFlow with graph nodes and edges', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's2',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'Supporting data', round: 2, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null },
        ],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Supporting data', turn_id: 't2', node_id: 'n2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-nodes')).toBe('2');
    expect(flow.getAttribute('data-edges')).toBe('1');
    expect(flow).toHaveAttribute('data-pan-on-drag', '[0,1]');
    expect(JSON.parse(flow.getAttribute('data-fit-view-options') ?? '{}')).toMatchObject({
      duration: 0,
    });
  });

  it('uses the localized verdict label in node accessibility text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-verdict',
        nodes: [
          { id: 'n-verdict', key: 'verdict-1', type: 'verdict', label: 'order', round: null, payload: null },
        ],
        edges: [],
        units: [],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-node-aria-label')).toContain('Verdict');
    expect(flow.getAttribute('data-node-aria-label')).toContain('order');
  });

  it('recomputes argument node accessibility labels when the UI language changes at runtime', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-runtime-i18n',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);

    const view = render(<ArgumentMap debateId="d1" visible={true} />);

    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-node-aria-label')).toContain('Claim');
    expect(JSON.parse(flow.getAttribute('data-aria-label-config') ?? '{}')).toMatchObject({
      'controls.zoomIn.ariaLabel': 'Zoom in',
      'minimap.ariaLabel': 'Mini map',
    });

    setTestLocale('zh');
    view.rerender(<ArgumentMap debateId="d1" visible={true} />);

    await waitFor(() => {
      expect(screen.getByTestId('reactflow').getAttribute('data-node-aria-label')).toContain('论点');
    });
    expect(JSON.parse(screen.getByTestId('reactflow').getAttribute('data-aria-label-config') ?? '{}')).toMatchObject({
      'controls.zoomIn.ariaLabel': '放大',
      'minimap.ariaLabel': '缩略图',
    });
  });

  it('handles 501 gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 501,
      json: async () => ({}),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/Feature not enabled|not enabled/i);
    expect(msg).toBeInTheDocument();
  });

  it('applies the too_large guard when fallback data contains many units but no raw graph nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-too-large-fallback',
        nodes: [],
        edges: [],
        units: Array.from({ length: 2001 }, (_, index) => ({
          id: `u${index}`,
          type: 'claim',
          status: 'standing',
          text: `Claim ${index}`,
          turn_id: `t${index}`,
        })),
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    expect(await screen.findByText('Too many nodes to display')).toBeInTheDocument();
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
  });

  it('handles network error gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network failed'));
    render(<ArgumentMap debateId="d1" visible={true} />);
    const msg = await screen.findByText(/Network error/i);
    expect(msg).toBeInTheDocument();
  });

  it('treats a 200 payload with json.error as load_failed and keeps graph/export hidden', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-error',
        nodes: [],
        edges: [],
        units: [],
        error: 'ARGUMENT_MAP_LOAD_FAILED',
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    expect(await screen.findByText('Load failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument();
    expect(screen.queryByText(/No argument map/)).not.toBeInTheDocument();
  });

  it('shows export panel when data has units', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'A claim', turn_id: 't1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const panel = await screen.findByTestId('export-panel');
    expect(panel).toBeInTheDocument();
  });

  it('renders legend with all type labels', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'A claim', turn_id: 't1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    expect(screen.getByText('Claim')).toBeInTheDocument();
    expect(screen.getByText('Evidence')).toBeInTheDocument();
    expect(screen.getByText('Rebuttal')).toBeInTheDocument();
    expect(screen.getByText('Counter')).toBeInTheDocument();
    expect(screen.getByText(/1 units/)).toBeInTheDocument();
  });

  it('renders the minimap as a non-interactive overlay so it does not block node clicks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-minimap',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    const minimap = await screen.findByTestId('rf-minimap');
    expect(minimap).toHaveAttribute('data-pointer-events', 'none');
  });

  it('keeps ReactFlow node wrappers out of the tab order and exposes a dialog action label on the card button', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-a11y-node',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    const flow = await screen.findByTestId('reactflow');
    expect(flow).toHaveAttribute('data-node-focusable', 'false');
    expect(flow).toHaveAttribute('data-node-aria-role', '');
    expect(flow.getAttribute('data-node-aria-label')).toContain('Open details');
  });

  it('hides the minimap on narrow viewports to reduce graph chrome overlap', async () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-mobile',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    await screen.findByTestId('reactflow');
    expect(screen.queryByTestId('rf-minimap')).not.toBeInTheDocument();
    matchMediaSpy.mockRestore();
  });

  it('renders a compact fit-view button on narrow viewports', async () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-mobile-fit',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);
    const user = userEvent.setup();

    render(<ArgumentMap debateId="d1" visible={true} />);

    await screen.findByTestId('reactflow');
    const fitButton = screen.getByRole('button', { name: 'Fit view' });
    expect(fitButton).toBeInTheDocument();
    expect(screen.getByText('Drag to pan. Pinch or use the graph controls to zoom.')).toBeInTheDocument();
    const initialCalls = fitViewMock.mock.calls.length;
    await user.click(fitButton);
    expect(fitViewMock.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(fitViewMock).toHaveBeenLastCalledWith(expect.objectContaining({ duration: 0 }));
    matchMediaSpy.mockRestore();
  });

});


describe('ArgumentMapMobileList', () => {
  it('uses localized existing argument labels and empty text', () => {
    setTestLocale('zh');

    const { rerender } = render(
      <ArgumentMapMobileList
        units={[
          {
            id: 'u1',
            type: 'claim',
            status: 'accepted',
            text: '主张文本',
            turn_id: 't1',
            node_id: 'n1',
          },
        ]}
      />,
    );

    expect(screen.getByRole('list', { name: '论证单元列表' })).toBeInTheDocument();
    expect(screen.getAllByText('论点')).toHaveLength(2);
    expect(screen.getByText('已采纳')).toBeInTheDocument();
    expect(screen.queryByText('argument.type_claim')).not.toBeInTheDocument();

    rerender(<ArgumentMapMobileList units={[]} />);

    expect(screen.getByText('暂无论证图谱数据。')).toBeInTheDocument();
    expect(screen.queryByText('argument.no_data')).not.toBeInTheDocument();
  });
});


describe('ArgumentMapTour', () => {
  it('uses localized common action labels and records skip state', async () => {
    setTestLocale('zh');
    vi.useFakeTimers();

    render(<ArgumentMapTour />);

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(screen.getByRole('dialog', { name: '论证图谱引导' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '跳过' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步' })).toBeInTheDocument();

    await act(async () => {
      screen.getByRole('button', { name: '跳过' }).click();
    });

    expect(window.localStorage.getItem('swarm.argmap.tour_seen')).toBe('1');
    expect(screen.queryByRole('dialog', { name: '论证图谱引导' })).not.toBeInTheDocument();
  });
});
