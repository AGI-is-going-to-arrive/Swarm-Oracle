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

afterEach(() => {
  cleanup();
  fitViewMock.mockReset();
  currentLocale = 'en';
  document.body.classList.remove('has-argument-map');
  vi.restoreAllMocks();
});

// ── P2-4: Drag + Search ───────────────────────────────────

describe('P2-4 drag + search', () => {
  const searchTestData = {
    snapshot_id: 's-search',
    nodes: [
      { id: 'n1', key: 'k1', type: 'claim', label: 'Economy grows', round: 1, payload: null },
      { id: 'n2', key: 'k2', type: 'evidence', label: 'GDP report', round: 2, payload: null },
      { id: 'n3', key: 'k3', type: 'rebuttal', label: 'Inflation counter', round: 2, payload: null },
      { id: 'n4', key: 'k4', type: 'counter', label: 'Unrelated point', round: 3, payload: null },
    ],
    edges: [
      { id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null },
      { id: 'e2', source: 'n3', target: 'n1', type: 'rebuts', weight: 1, label: null },
    ],
    units: [
      { id: 'u1', type: 'claim', status: 'standing', text: 'Economy grows', turn_id: 't1', node_id: 'n1' },
      { id: 'u2', type: 'evidence', status: 'accepted', text: 'GDP report data', turn_id: 't2', node_id: 'n2' },
      { id: 'u3', type: 'rebuttal', status: 'rebutted', text: 'Inflation counter', turn_id: 't3', node_id: 'n3' },
      { id: 'u4', type: 'counter', status: 'standing', text: 'Unrelated point', turn_id: 't4', node_id: 'n4' },
    ],
  };

  function renderWithSearchData() {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => searchTestData,
    } as Response);
    return render(<ArgumentMap debateId="d-search" visible={true} />);
  }

  it('enables nodesDraggable on the ReactFlow instance', async () => {
    renderWithSearchData();
    const flow = await screen.findByTestId('reactflow');
    expect(flow).toHaveAttribute('data-nodes-draggable', 'true');
  });

  it('shows correct matchCount after entering a search term', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    const searchInput = screen.getByRole('searchbox');
    await user.type(searchInput, 'economy');

    await waitFor(() => {
      expect(screen.getByText('1 matches, 2 related')).toBeInTheDocument();
    });
  });

  it('shows No matches when search has no hits', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    const searchInput = screen.getByRole('searchbox');
    await user.type(searchInput, 'zzzznotfound');

    await waitFor(() => {
      expect(screen.getByText('No matches')).toBeInTheDocument();
    });
  });

  it('dims non-matching nodes during search', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    const searchInput = screen.getByRole('searchbox');
    await user.type(searchInput, 'economy');

    await waitFor(() => {
      const n1 = screen.getByTestId('rf-node-n1');
      expect(n1).toHaveAttribute('data-dimmed', 'false');
      expect(n1).toHaveAttribute('data-search-match', 'true');

      const n4 = screen.getByTestId('rf-node-n4');
      expect(n4).toHaveAttribute('data-dimmed', 'true');
      expect(n4).toHaveAttribute('data-search-match', 'false');
    });
  });

  it('keeps one-hop neighbor nodes visible (not dimmed) during search', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    const searchInput = screen.getByRole('searchbox');
    await user.type(searchInput, 'economy');

    await waitFor(() => {
      const n2 = screen.getByTestId('rf-node-n2');
      expect(n2).toHaveAttribute('data-dimmed', 'false');
      expect(n2).toHaveAttribute('data-search-related', 'true');
    });
  });

  it('combines status filter + search (AND semantics)', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    await user.click(screen.getByRole('button', { name: 'Standing' }));
    await waitFor(() => {
      expect(screen.getByTestId('reactflow').getAttribute('data-nodes')).toBe('2');
    });

    const searchInput = screen.getByRole('searchbox');
    await user.type(searchInput, 'economy');

    await waitFor(() => {
      expect(screen.getByText('1 matches, 0 related')).toBeInTheDocument();
    });
  });

  it('renders Reset Layout button that can be clicked without error', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    const resetButton = screen.getByRole('button', { name: 'Reset layout' });
    expect(resetButton).toBeInTheDocument();

    await user.click(resetButton);

    expect(screen.getByTestId('reactflow')).toBeInTheDocument();
    expect(resetButton).toBeInTheDocument();
  });

  it('does not activate search state when input is empty', async () => {
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    expect(screen.queryByText('No matches')).not.toBeInTheDocument();
    expect(screen.queryByText(/match/)).not.toBeInTheDocument();

    const n1 = screen.getByTestId('rf-node-n1');
    expect(n1).toHaveAttribute('data-dimmed', 'false');
    expect(n1).toHaveAttribute('data-search-match', 'false');
  });

  it('matches by unit text in addition to node label', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    const searchInput = screen.getByRole('searchbox');
    await user.type(searchInput, 'GDP report data');

    await waitFor(() => {
      expect(screen.getByText('1 matches, 1 related')).toBeInTheDocument();
      expect(screen.getByTestId('rf-node-n2')).toHaveAttribute('data-search-match', 'true');
    });
  });

  it('search input does not reset dragged node positions', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    await act(async () => {
      screen.getByTestId('rf-dispatch-position').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-n1')).toHaveAttribute('data-x', '999');
      expect(screen.getByTestId('rf-node-n1')).toHaveAttribute('data-y', '888');
    });

    const searchInput = screen.getByRole('searchbox');
    await user.type(searchInput, 'economy');

    await waitFor(() => {
      expect(screen.getByText('1 matches, 2 related')).toBeInTheDocument();
    });

    expect(screen.getByTestId('rf-node-n1')).toHaveAttribute('data-x', '999');
    expect(screen.getByTestId('rf-node-n1')).toHaveAttribute('data-y', '888');
  });

  it('node click does not reset dragged node positions', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    await screen.findByTestId('reactflow');

    await act(async () => {
      screen.getByTestId('rf-dispatch-position').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-n1')).toHaveAttribute('data-x', '999');
      expect(screen.getByTestId('rf-node-n1')).toHaveAttribute('data-y', '888');
    });

    await user.click(screen.getByTestId('rf-node-n2'));
    await waitFor(() => {
      expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();
    });

    expect(screen.getByTestId('rf-node-n1')).toHaveAttribute('data-x', '999');
    expect(screen.getByTestId('rf-node-n1')).toHaveAttribute('data-y', '888');
  });

  it('Reset Layout button restores dagre positions after drag', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    const n1Initial = await screen.findByTestId('rf-node-n1');
    const originalX = n1Initial.getAttribute('data-x');

    await act(async () => {
      screen.getByTestId('rf-dispatch-position').click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('rf-node-n1')).toHaveAttribute('data-x', '999');
    });

    const resetButton = screen.getByRole('button', { name: 'Reset layout' });
    await user.click(resetButton);

    await waitFor(() => {
      const n1 = screen.getByTestId('rf-node-n1');
      expect(n1.getAttribute('data-x')).toBe(originalX);
    });
  });

  it('edge opacity has three tiers during search', async () => {
    const user = userEvent.setup();
    renderWithSearchData();
    const flow = await screen.findByTestId('reactflow');

    const searchInput = screen.getByRole('searchbox');
    await user.type(searchInput, 'economy');

    await waitFor(() => {
      const opacity = flow.getAttribute('data-edge-opacity');
      expect(opacity).toBeTruthy();
      const val = Number(opacity);
      expect([0.08, 0.4, 1]).toContain(val);
    });
  });
});
