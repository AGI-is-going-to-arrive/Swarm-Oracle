/**
 * Phase C2 — ArgumentMap tests (upgraded for @xyflow/react DAG)
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

function makeConversationSseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map((frame) => encoder.encode(frame));
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: vi.fn(async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index];
          index += 1;
          return { done: false, value };
        }),
      }),
    },
  } as unknown as Response;
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

import { ArgumentMap, ArgumentStrengthMeter, type ArgumentUnit } from './ArgumentMap';

afterEach(() => {
  cleanup();
  fitViewMock.mockReset();
  currentLocale = 'en';
  document.body.classList.remove('has-argument-map');
  vi.restoreAllMocks();
});

const createDeferredResponse = () => {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

// ── ArgumentMap main component ──────────────────────────────

describe('ArgumentMap', () => {
  it('adds and removes the body class that repositions the global language switcher around the graph chrome', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-body-class',
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

    await screen.findByTestId('reactflow');
    expect(document.body).toHaveClass('has-argument-map');

    view.unmount();
    expect(document.body).not.toHaveClass('has-argument-map');
  });

  it('disables animated graph edges when reduced motion is preferred', async () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
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
        snapshot_id: 's-reduced-motion',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'rebuttal', label: 'Counter point', round: 2, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'rebuts', weight: 1, label: null },
        ],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
          { id: 'u2', type: 'rebuttal', status: 'rebutted', text: 'Counter point', turn_id: 't2', node_id: 'n2' },
        ],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    const flow = await screen.findByTestId('reactflow');
    expect(flow).toHaveAttribute('data-edge-animated', 'false');
    matchMediaSpy.mockRestore();
  });

  it('renders the rejected status filter when backend data uses that status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-rejected',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Rejected claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'rejected', text: 'Rejected claim', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    expect(screen.getByRole('button', { name: 'Rejected' })).toBeInTheDocument();
  });

  it('keeps the node detail panel outside the export target so transient UI is not exported', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-export-scope',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);

    const { container } = render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    await user.click(screen.getByTestId('rf-node-n1'));

    const detailPanel = await screen.findByTestId('node-detail-panel');
    const exportRoot = await screen.findByTestId('argument-map-export-target');
    expect(container.contains(exportRoot)).toBe(true);
    expect(exportRoot?.contains(detailPanel)).toBe(false);
  });

  it('renders screen reader fallback list with all units', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'A claim', turn_id: 't1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Proof', turn_id: 't2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    const srList = screen.getByRole('list', { name: 'Argument units list' });
    const items = within(srList).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Claim');
    expect(items[0].textContent).toContain('A claim');
    expect(items[0].textContent).toContain('Standing');
  });

  it('renders screen reader fallback items for node-only maps with no units', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-node-only',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Node only claim', round: 1, payload: null },
        ],
        edges: [],
        units: [],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    const srList = screen.getByRole('list', { name: 'Argument units list' });
    const items = within(srList).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toContain('Claim');
    expect(items[0].textContent).toContain('Node only claim');
  });

  it('includes an explicit screen reader relations list for graph edges', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-relations',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'Evidence pack', round: 2, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null },
        ],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Evidence pack', turn_id: 't2', node_id: 'n2' },
        ],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    const relationList = screen.getByRole('list', { name: 'Argument relations list' });
    const items = within(relationList).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Main claim supports Evidence pack');
  });

  it('uses localized relation labels for verdict-style graph edges', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-relation-labels',
        nodes: [
          { id: 'n1', key: 'k1', type: 'verdict', label: 'Verdict', round: null, payload: null },
          { id: 'n2', key: 'k2', type: 'claim', label: 'Claim A', round: 1, payload: null },
          { id: 'n3', key: 'k3', type: 'rebuttal', label: 'Rebuttal B', round: 2, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'accepted', weight: 1, label: null },
          { id: 'e2', source: 'n1', target: 'n3', type: 'unaddressed', weight: 1, label: null },
        ],
        units: [
          { id: 'u2', type: 'claim', status: 'accepted', text: 'Claim A', turn_id: 't1', node_id: 'n2' },
          { id: 'u3', type: 'rebuttal', status: 'unaddressed', text: 'Rebuttal B', turn_id: 't2', node_id: 'n3' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);

    const relationList = await screen.findByRole('list', { name: 'Argument relations list' });
    const items = within(relationList).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Verdict accepts Claim A');
    expect(items[1]).toHaveTextContent('Verdict leaves unaddressed Rebuttal B');
  });

  it('encodes debate ids before requesting the argument-map endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ snapshot_id: null, nodes: [], edges: [], units: [] }),
    } as Response);
    render(<ArgumentMap debateId="debate/alpha?beta" visible={true} />);

    await screen.findByText(/No argument map/);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/debate/debate%2Falpha%3Fbeta/argument-map',
      expect.objectContaining({ headers: expect.anything() }),
    );
  });

  it('keeps node-only maps keyboard-accessible through the rendered graph node button', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-node-only-keyboard',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Node only claim', round: 1, payload: null },
        ],
        edges: [],
        units: [],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    const nodeButton = screen.getByTestId('rf-node-n1');
    nodeButton.focus();
    expect(nodeButton).toHaveFocus();

    await user.keyboard('{Enter}');

    const detailPanel = await screen.findByTestId('node-detail-panel');
    expect(detailPanel).toHaveTextContent('Node only claim');
  });

  it('renders aria-label on map container', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's1',
        nodes: [],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'X', turn_id: 't1' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    expect(screen.getByLabelText('Debate argument map')).toBeInTheDocument();
  });

  it('clears node detail panel when refreshTrigger fires re-fetch', async () => {
    // First render: load data with a graph node
    const data = {
      snapshot_id: 's1',
      nodes: [{ id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null }],
      edges: [],
      units: [{ id: 'u1', type: 'claim', status: 'standing', text: 'Main claim full', turn_id: 't1', node_id: 'n1' }],
    };
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, json: async () => data } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => data } as Response);

    const user = userEvent.setup();
    const { rerender } = render(<ArgumentMap debateId="d1" visible={true} refreshTrigger={0} />);
    await screen.findByTestId('reactflow');

    // Click node to open detail panel
    await user.click(screen.getByTestId('rf-node-n1'));
    expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();

    // Re-render with new refreshTrigger → triggers re-fetch → should clear panel
    rerender(<ArgumentMap debateId="d1" visible={true} refreshTrigger={1} />);
    // After re-fetch, detail panel should be gone
    await screen.findByTestId('reactflow');
    expect(screen.queryByTestId('node-detail-panel')).not.toBeInTheDocument();
  });

  it('ignores stale responses when debateId changes and a newer request resolves first', async () => {
    const firstResponse = createDeferredResponse();
    const secondResponse = createDeferredResponse();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/debate/d1/argument-map')) return firstResponse.promise;
      if (url.includes('/api/debate/d2/argument-map')) return secondResponse.promise;
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    const { rerender } = render(<ArgumentMap debateId="d1" visible={true} />);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    rerender(<ArgumentMap debateId="d2" visible={true} />);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    secondResponse.resolve({
      ok: true,
      json: async () => ({
        snapshot_id: 's-new',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'New claim', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'New evidence', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'New claim', turn_id: 't2', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'New evidence', turn_id: 't2', node_id: 'n2' },
        ],
      }),
    } as Response);

    const flow = await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(flow.getAttribute('data-nodes')).toBe('2');
    });

    firstResponse.resolve({
      ok: true,
      json: async () => ({
        snapshot_id: 's-old',
        nodes: [
          { id: 'old-1', key: 'old-k1', type: 'claim', label: 'Old claim', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'old-u1', type: 'claim', status: 'standing', text: 'Old claim', turn_id: 't1', node_id: 'old-1' },
        ],
      }),
    } as Response);

    await waitFor(() => {
      expect(screen.getByTestId('reactflow').getAttribute('data-nodes')).toBe('2');
    });
    expect(screen.getByText(/2 units/)).toBeInTheDocument();
  });

  it('refits the viewport after status filters change the graph', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-fit',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Claim A', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'Evidence B', round: 1, payload: null },
        ],
        edges: [{ id: 'e1', source: 'n2', target: 'n1', type: 'supports', weight: 1, label: null }],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Claim A', turn_id: 't1', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Evidence B', turn_id: 't1', node_id: 'n2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    const initialCalls = fitViewMock.mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Accepted' }));

    expect(fitViewMock.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('does not refit the viewport when selecting or clearing a node highlight', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-select',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Claim A', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'Evidence B', round: 1, payload: null },
        ],
        edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null }],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Claim A', turn_id: 't1', node_id: 'n1' },
          { id: 'u2', type: 'evidence', status: 'accepted', text: 'Evidence B', turn_id: 't1', node_id: 'n2' },
        ],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    const initialCalls = fitViewMock.mock.calls.length;

    await user.click(screen.getByTestId('rf-node-n1'));
    await waitFor(() => {
      expect(screen.getByTestId('node-detail-panel')).toBeInTheDocument();
    });
    expect(fitViewMock.mock.calls.length).toBe(initialCalls);

    const detailPanel = screen.getByTestId('node-detail-panel');
    const closeButton = detailPanel.querySelector('button[aria-label="Close"]');
    expect(closeButton).not.toBeNull();
    await user.click(closeButton as HTMLButtonElement);
    await waitFor(() => {
      expect(screen.queryByTestId('node-detail-panel')).not.toBeInTheDocument();
    });
    expect(fitViewMock.mock.calls.length).toBe(initialCalls);
  });

  it('does not render a payload block for nodes whose backend payload is null', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-null-payload',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Claim A', round: 1, payload: null },
        ],
        edges: [],
        units: [
          { id: 'u1', type: 'claim', status: 'standing', text: 'Claim A', turn_id: 't1', node_id: 'n1' },
        ],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    await user.click(screen.getByTestId('rf-node-n1'));

    const detailPanel = await screen.findByTestId('node-detail-panel');
    expect(within(detailPanel).queryByText('Payload')).not.toBeInTheDocument();
  });

  it('opens NodeConversationSheet when a node is clicked (FE-3-seq wire-up)', async () => {
    class NoopWS {
      static OPEN = 1;
      readyState = NoopWS.OPEN;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: ((ev: { code: number }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal('WebSocket', NoopWS as unknown as typeof WebSocket);
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    try {
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snapshot_id: 's-sheet',
          nodes: [
            { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
          ],
          edges: [],
          units: [
            { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
          ],
        }),
      } as Response);

      render(<ArgumentMap debateId="d1" conversationScenarioId="scenario-open-sheet" visible={true} />);
      await screen.findByTestId('reactflow');
      expect(screen.queryByTestId('node-conversation-sheet')).toBeNull();

      await user.click(screen.getByTestId('rf-node-n1'));

      const detailPanel = await screen.findByTestId('node-detail-panel');
      const sheet = await screen.findByTestId('node-conversation-sheet');
      expect(detailPanel).toHaveStyle({ right: '464px' });
      expect(sheet).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the provided conversationScenarioId and a null identity id when starting a node conversation', async () => {
    class NoopWS {
      static OPEN = 1;
      readyState = NoopWS.OPEN;
      onopen: ((ev: unknown) => void) | null = null;
      onmessage: ((ev: { data: string }) => void) | null = null;
      onclose: ((ev: { code: number }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      send = vi.fn();
      close = vi.fn();
    }
    vi.stubGlobal('WebSocket', NoopWS as unknown as typeof WebSocket);
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    try {
      const user = userEvent.setup();
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            snapshot_id: 's-sheet',
            nodes: [
              { id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null },
            ],
            edges: [],
            units: [
              { id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' },
            ],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ thread_id: 'thread-arg-1' }),
        } as Response)
        .mockResolvedValueOnce(
          makeConversationSseResponse([
            'event: turn_started\ndata: {"turn_id":"turn-arg-1","thread_id":"thread-arg-1","sequence":2}\n\n',
            'event: turn_token_delta\ndata: {"turn_id":"turn-arg-1","delta":"ok"}\n\n',
            'event: turn_completed\ndata: {"turn_id":"turn-arg-1","sequence":2,"status":"committed"}\n\n',
          ]),
        );

      render(<ArgumentMap debateId="d1" conversationScenarioId="scenario-arg-1" visible={true} />);
      await screen.findByTestId('reactflow');
      await user.click(screen.getByTestId('rf-node-n1'));
      await user.type(await screen.findByTestId('node-conversation-input'), 'probe this node');
      await user.click(screen.getByTestId('node-conversation-send'));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          '/api/conversation/start',
          expect.objectContaining({ method: 'POST' }),
        );
      });
      const startCall = fetchSpy.mock.calls.find(([url]) => url === '/api/conversation/start');
      expect(startCall).toBeDefined();
      const [, startOptions] = startCall as [string, RequestInit];
      const startBody = JSON.parse(String(startOptions.body));
      expect(startBody.scenario_id).toBe('scenario-arg-1');
      expect(startBody.agent_identity_id).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not open NodeConversationSheet when conversationScenarioId is absent', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    }));
    try {
      const user = userEvent.setup();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          snapshot_id: 's-no-sheet',
          nodes: [{ id: 'n1', key: 'k1', type: 'claim', label: 'Main claim', round: 1, payload: null }],
          edges: [],
          units: [{ id: 'u1', type: 'claim', status: 'standing', text: 'Main claim', turn_id: 't1', node_id: 'n1' }],
        }),
      } as Response);

      render(<ArgumentMap debateId="d1" visible={true} />);
      await screen.findByTestId('reactflow');
      await user.click(screen.getByTestId('rf-node-n1'));

      expect(screen.queryByTestId('node-conversation-sheet')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── Phase C: Status filter (C5) ─────────────────────────────

describe('ArgumentMap status filter (C5)', () => {
  const dataWithStatuses = {
    snapshot_id: 's1',
    nodes: [
      { id: 'n1', key: 'k1', type: 'claim', label: 'Claim A', round: 1, payload: null },
      { id: 'n2', key: 'k2', type: 'evidence', label: 'Evidence B', round: 1, payload: null },
    ],
    edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null }],
    units: [
      { id: 'u1', type: 'claim', status: 'standing', text: 'Claim A', turn_id: 't1', node_id: 'n1' },
      { id: 'u2', type: 'evidence', status: 'accepted', text: 'Evidence B', turn_id: 't2', node_id: 'n2' },
    ],
  };

  it('renders filter chips for all statuses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => dataWithStatuses,
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');
    expect(screen.getByRole('button', { name: 'Accepted' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Standing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unaddressed' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rebutted' })).toBeInTheDocument();
  });

  it('shows clear button when filter is active', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => dataWithStatuses,
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    await screen.findByTestId('reactflow');

    // Initially no clear button
    expect(screen.queryByText('Clear')).not.toBeInTheDocument();

    // Click a filter chip
    await user.click(screen.getByRole('button', { name: 'Standing' }));

    // Clear button should appear
    expect(screen.getByText('Clear')).toBeInTheDocument();
  });

  it('filters displayed nodes by status', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => dataWithStatuses,
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-nodes')).toBe('2');

    // Filter to only 'accepted' — should show 1 node (n2 with accepted unit)
    await user.click(screen.getByRole('button', { name: 'Accepted' }));
    expect(flow.getAttribute('data-nodes')).toBe('1');
  });

  it('keeps node-only graphs visible when a status filter is active', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's-node-only',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'Detached claim', round: 1, payload: null },
        ],
        edges: [],
        units: [],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    const flow = await screen.findByTestId('reactflow');
    expect(flow).toHaveAttribute('data-nodes', '1');

    await user.click(screen.getByRole('button', { name: 'Accepted' }));

    await waitFor(() => expect(screen.getByTestId('reactflow')).toHaveAttribute('data-nodes', '1'));
    expect(screen.queryByText('No argument units match the selected filters.')).not.toBeInTheDocument();
  });

  it('updates the strength meter to reflect the filtered units', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true, json: async () => dataWithStatuses,
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    await screen.findByTestId('reactflow');
    expect(screen.getByTitle('Accepted: 1/2')).toBeInTheDocument();
    expect(screen.getByTitle('Standing: 1/2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Accepted' }));

    await waitFor(() => expect(screen.getByTitle('Accepted: 1/1')).toBeInTheDocument());
    expect(screen.queryByTitle('Standing: 1/2')).not.toBeInTheDocument();
  });
});

// ── Phase C: Edge styling (C2) ──────────────────────────────

describe('ArgumentMap edge styling (C2)', () => {
  it('edges use EDGE_STYLES colors from graphTokens', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's2',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'A', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'B', round: 1, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'supports', weight: 1, label: null },
        ],
        units: [],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-edges')).toBe('1');
    expect(flow.getAttribute('data-edge-stroke')).toBe('#2ecc71');
    expect(flow.getAttribute('data-edge-animated')).toBe('false');
    expect(flow.getAttribute('data-edge-marker')).toContain('arrowclosed');
  });

  it('temporal edges omit arrow markers and use dashed styling', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's3',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'A', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'claim', label: 'B', round: 2, payload: null },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', type: 'temporal', weight: 0.5, label: null },
        ],
        units: [],
      }),
    } as Response);
    render(<ArgumentMap debateId="d1" visible={true} />);
    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-edge-dash')).toBe('4 4');
    expect(flow.getAttribute('data-edge-marker')).toBe('null');
  });

  it('localizes evidence tier badges in edge labels', async () => {
    setTestLocale('zh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        snapshot_id: 's4',
        nodes: [
          { id: 'n1', key: 'k1', type: 'claim', label: 'A', round: 1, payload: null },
          { id: 'n2', key: 'k2', type: 'evidence', label: 'B', round: 2, payload: null },
        ],
        edges: [{
          id: 'e1',
          source: 'n1',
          target: 'n2',
          type: 'supports',
          weight: 1,
          label: null,
          evidence: {
            confidence_tier: 'medium',
            source_ref: null,
            source_round_number: 2,
            detail: null,
          },
        }],
        units: [],
      }),
    } as Response);

    render(<ArgumentMap debateId="d1" visible={true} />);

    const flow = await screen.findByTestId('reactflow');
    expect(flow).toHaveAttribute('data-edge-label', 'R2 [中]');
    expect(flow).not.toHaveAttribute('data-edge-label', 'R2 [medium]');
  });
});

// ── ArgumentStrengthMeter ───────────────────────────────────

describe('ArgumentStrengthMeter', () => {
  it('returns null when units are empty', () => {
    const { container } = render(<ArgumentStrengthMeter units={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the strength distribution as an accessible list summary', () => {
    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'standing', text: '', turn_id: 't1' },
      { id: 'u2', type: 'claim', status: 'standing', text: '', turn_id: 't2' },
      { id: 'u3', type: 'rebuttal', status: 'rebutted', text: '', turn_id: 't3' },
    ];
    render(<ArgumentStrengthMeter units={units} />);
    const summary = screen.getByRole('list', { name: 'Argument strength distribution' });
    expect(summary).toBeInTheDocument();

    // Check segments are rendered via title attributes
    const standingSegment = screen.getByTitle(/Standing: 2\/3/);
    expect(standingSegment).toBeInTheDocument();
    expect(standingSegment).toHaveStyle({ background: '#62748b' });
    expect(standingSegment).toHaveAttribute('role', 'listitem');
    expect(standingSegment).toHaveAttribute('aria-label', 'Standing: 2/3');

    const rebuttedSegment = screen.getByTitle(/Rebutted: 1\/3/);
    expect(rebuttedSegment).toBeInTheDocument();
    expect(rebuttedSegment).toHaveStyle({ background: '#c85d84' });
    expect(rebuttedSegment).toHaveAttribute('role', 'listitem');
    expect(rebuttedSegment).toHaveAttribute('aria-label', 'Rebutted: 1/3');
  });

  it('skips zero-count statuses', () => {
    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'accepted', text: '', turn_id: 't1' },
    ];
    render(<ArgumentStrengthMeter units={units} />);
    const meter = screen.getByRole('list', { name: 'Argument strength distribution' });
    // Only 1 child segment (accepted)
    const segments = meter.children;
    expect(segments.length).toBe(1);
    expect(screen.getByTitle(/Accepted: 1\/1/)).toBeInTheDocument();
  });

  it('renders compact height when compact prop is true', () => {
    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'standing', text: '', turn_id: 't1' },
    ];
    render(<ArgumentStrengthMeter units={units} compact />);
    const meter = screen.getByRole('list', { name: 'Argument strength distribution' });
    expect(meter).toHaveStyle({ height: '6px' });
  });

  it('subscribes to legacy WebKit media query listeners for reduced motion changes', () => {
    let legacyListener: ((event: MediaQueryListEvent) => void) | undefined;
    const addListener = vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      legacyListener = listener;
    });
    const removeListener = vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      if (legacyListener === listener) legacyListener = undefined;
    });

    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener,
      removeListener,
      addEventListener: undefined,
      removeEventListener: undefined,
      dispatchEvent: vi.fn(() => false),
    } as unknown as MediaQueryList));

    const units: ArgumentUnit[] = [
      { id: 'u1', type: 'claim', status: 'standing', text: '', turn_id: 't1' },
    ];

    const { unmount } = render(<ArgumentStrengthMeter units={units} />);

    expect(screen.getByTitle('Standing: 1/1')).toHaveStyle({ transition: 'width 0.3s ease' });
    expect(addListener).toHaveBeenCalledTimes(1);

    act(() => {
      legacyListener?.({ matches: true } as MediaQueryListEvent);
    });

    expect(screen.getByTitle('Standing: 1/1')).toHaveStyle({ transition: 'none' });

    unmount();

    expect(removeListener).toHaveBeenCalledTimes(1);
  });
});
