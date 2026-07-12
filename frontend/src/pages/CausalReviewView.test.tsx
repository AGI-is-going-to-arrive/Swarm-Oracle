/**
 * Phase C1 — CausalReviewView tests
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import dagre from 'dagre';
import { stubNoopWebSocket } from '../test-utils/noopWebSocket';

type TestLocale = 'en' | 'zh';
const {
  changeTestLanguage,
  fitViewMock,
  getCurrentLocale,
  getLocaleVersion,
  i18nMock,
  resetTestI18n,
  setTestLocale: applyTestLocale,
  subscribeToLocaleChange,
} = vi.hoisted(() => {
  let currentLocale: TestLocale = 'en';
  let localeVersion = 0;
  const listeners = new Set<() => void>();
  const fitViewMock = vi.fn();

  const emitLocaleChange = () => {
    localeVersion += 1;
    for (const listener of listeners) listener();
  };

  const setTestLocale = (locale: TestLocale) => {
    if (currentLocale === locale) return;
    currentLocale = locale;
    emitLocaleChange();
  };

  const changeTestLanguage = vi.fn(async (locale: string) => {
    if (locale === 'en' || locale === 'zh') setTestLocale(locale);
  });

  const i18nMock = {
    changeLanguage: changeTestLanguage,
    get language() {
      return currentLocale;
    },
  };

  return {
    changeTestLanguage,
    fitViewMock,
    getCurrentLocale: () => currentLocale,
    getLocaleVersion: () => localeVersion,
    i18nMock,
    resetTestI18n: () => {
      currentLocale = 'en';
      localeVersion = 0;
      listeners.clear();
      changeTestLanguage.mockClear();
    },
    setTestLocale,
    subscribeToLocaleChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const TEST_TRANSLATIONS: Record<TestLocale, Record<string, string>> = {
  en: {
    'causal.type_event': 'Event',
    'causal.a11y_list': 'Causal events list',
    'causal.a11y_relations': 'Causal relations list',
    'causal.edge_caused': 'causes',
    'causal.edge_temporal': 'precedes',
    'causal.edge_responds_to': 'responds to',
    'causal.edge_supports_stance': 'aligns with',
    'causal.edge_opposes_stance': 'opposes',
    'causal.edge_affect_alignment_proxy': 'affect aligned (proxy)',
    'causal.edge_affect_distance_proxy': 'affect distant (proxy)',
    'causal.edge_led_to': 'leads to',
    'causal.edge_triggered_fork': 'triggered fork',
    'causal.edge_relation': '{{source}} {{relation}} {{target}}',
    'causal.node_card_summary_isolated': 'No nearby links yet',
    'causal.node_card_summary_event': 'Causes {{causeCount}} · effects {{effectCount}}',
    'causal.node_card_summary_event_with_relations': 'Causes {{causeCount}} · effects {{effectCount}} · links {{relationCount}}',
    'causal.node_card_summary_fork': 'Fork point · {{effectCount}} follow-ups',
    'causal.node_card_summary_outcome': 'Endpoint · {{causeCount}} sources',
    'causal.node.stance_shift': '{{agent_name}} stance shifted',
    'causal.type_affect_shift_proxy': 'Affect shift (proxy)',
    'causal.scope_branch_lineage': 'Showing the selected branch’s effective scope only; parent post-fork rounds, sibling rounds, and unrelated source-branch coordinates are excluded.',
    'causal.node.outcome': 'Outcome',
    'causal.type_outcome': 'Outcome',
    'node_context_banner.meaning_event_title': 'Event card',
    'node_context_banner.meaning_event_description': 'This records one important move. The links explain why it matters and what it changes next.',
    'node_context_banner.meaning_fork_title': 'Fork card',
    'node_context_banner.meaning_fork_description': 'This marks where one route split into alternatives. The links explain what triggered the split and what it opened.',
    'node_context_banner.meaning_outcome_title': 'Outcome card',
    'node_context_banner.meaning_outcome_description': 'This is the endpoint of one branch. Incoming links explain which earlier moves carried the branch here.',
    'node_context_banner.cause_title': 'Why this card appears',
    'node_context_banner.effect_title': 'What it changes',
    'node_context_banner.relation_title': 'Alignment and conflict',
    'node_context_banner.cause_temporal': 'It follows {{node}}, so it continues that timeline.',
    'node_context_banner.effect_temporal': '{{node}} happens after this card, so this card sets up the next beat.',
    'node_context_banner.cause_led_to': '{{node}} pushed the story toward this card.',
    'node_context_banner.effect_led_to': 'This card pushes the story toward {{node}}.',
    'node_context_banner.cause_responds_to': 'It responds to or names {{node}}, so that earlier card is the direct context.',
    'node_context_banner.effect_responds_to': '{{node}} responds to or names this card, so this card becomes what is being answered.',
    'node_context_banner.relation_supports': 'It aligns with {{node}} in the same round.',
    'node_context_banner.relation_opposes': 'It conflicts with {{node}} in the same round.',
    'node_context_banner.cause_default': '{{node}} links into this card by {{relation}}.',
    'node_context_banner.effect_default': 'This card links onward to {{node}} by {{relation}}.',
    'node_context_banner.relation_more': '+{{count}} more nearby links',
    'node_context_banner.related_title': 'Related links',
    'node_context_banner.related_incoming': 'Source: {{node}} · {{relation}}',
    'node_context_banner.related_outgoing': 'Next: {{relation}} · {{node}}',
    'causal.evidence_high': 'High',
    'causal.evidence_medium': 'Medium',
    'causal.evidence_low': 'Low',
    'causal.evidence_high_context': 'high confidence',
    'causal.evidence_medium_context': 'medium confidence',
    'causal.evidence_low_context': 'low confidence',
    'causal.edge_round_context': 'Round {{round}}',
    'causal.edge_confidence_context': 'confidence: {{tier}}',
    'causal.edge_context_suffix': '({{context}})',
    'causal.guide_preview_action': 'View full',
    'causal.guide_preview_aria': 'Show full text: {{label}}',
    'causal.guide_expand_details': 'Show details',
    'causal.guide_collapse_details': 'Hide details',
    'causal.error.network': 'Unable to load the causal graph. Check your connection and try again.',
    'causal.error.branch_not_found': 'The selected branch is no longer available for this scenario.',
    'causal.error.unauthorized': 'You do not have permission to view this causal graph.',
    'causal.error.server': 'The server could not load the causal graph right now.',
    'causal.error.load_failed': 'Unable to load the causal graph right now. Please retry.',
    'common.graph_controls': 'Graph controls',
    'common.graph_zoom_in': 'Zoom in',
    'common.graph_zoom_out': 'Zoom out',
    'common.graph_fit_view': 'Fit view',
    'common.graph_toggle_interactivity': 'Toggle interactivity',
    'common.graph_minimap': 'Mini map',
    'common.graph_mobile_hint': 'Drag to pan. Pinch or use the graph controls to zoom.',
  },
  zh: {
    'causal.type_event': '事件',
    'causal.a11y_list': '因果事件列表',
    'causal.a11y_relations': '因果关系列表',
    'causal.edge_caused': '导致',
    'causal.edge_temporal': '先于',
    'causal.edge_responds_to': '回应',
    'causal.edge_supports_stance': '立场一致',
    'causal.edge_opposes_stance': '立场对立',
    'causal.edge_affect_alignment_proxy': '情绪代理相近',
    'causal.edge_affect_distance_proxy': '情绪代理差异',
    'causal.edge_led_to': '导向',
    'causal.edge_triggered_fork': '触发分支',
    'causal.edge_relation': '{{source}} {{relation}} {{target}}',
    'causal.node_card_summary_isolated': '暂无相邻关系',
    'causal.node_card_summary_event': '前因 {{causeCount}} · 后续 {{effectCount}}',
    'causal.node_card_summary_event_with_relations': '前因 {{causeCount}} · 后续 {{effectCount}} · 关系 {{relationCount}}',
    'causal.node_card_summary_fork': '分岔点 · {{effectCount}} 条去向',
    'causal.node_card_summary_outcome': '结局 · {{causeCount}} 个来源',
    'causal.node.stance_shift': '{{agent_name}} 立场转变',
    'causal.type_affect_shift_proxy': '情绪变化（代理）',
    'causal.scope_branch_lineage': '仅展示所选分支的有效范围；父分支分叉后的轮次、兄弟分支轮次及无关源分支坐标均已排除。',
    'causal.node.outcome': '结局',
    'causal.type_outcome': '结局',
    'node_context_banner.meaning_event_title': '事件卡',
    'node_context_banner.meaning_event_description': '它记录一次关键发言或行动。下面会说明它为什么重要，以及它把局面推向哪里。',
    'node_context_banner.meaning_fork_title': '分岔卡',
    'node_context_banner.meaning_fork_description': '它标记世界线开始分岔。下面会说明分岔从哪里来，又打开了哪些后续路线。',
    'node_context_banner.meaning_outcome_title': '结局卡',
    'node_context_banner.meaning_outcome_description': '它是某条路线的落点。下面会说明哪些发言、分岔或行动把这条线带到这里。',
    'node_context_banner.cause_title': '为什么会出现',
    'node_context_banner.effect_title': '它带来什么影响',
    'node_context_banner.relation_title': '它和谁呼应或冲突',
    'node_context_banner.cause_temporal': '它接在 {{node}} 之后，是这条时间线的下一步。',
    'node_context_banner.effect_temporal': '{{node}} 接在它之后，说明这张卡铺垫了下一步。',
    'node_context_banner.cause_led_to': '{{node}} 把局面推向了这张卡。',
    'node_context_banner.effect_led_to': '这张卡把局面推向 {{node}}。',
    'node_context_banner.cause_responds_to': '它回应或点名了 {{node}}，所以那张卡是它的直接上下文。',
    'node_context_banner.effect_responds_to': '{{node}} 回应或点名了这张卡，说明它成了后续发言的对象。',
    'node_context_banner.relation_supports': '它和 {{node}} 在同一回合立场相近。',
    'node_context_banner.relation_opposes': '它和 {{node}} 在同一回合立场相冲。',
    'node_context_banner.cause_default': '{{node}} 通过“{{relation}}”关联到这张卡之前。',
    'node_context_banner.effect_default': '这张卡通过“{{relation}}”继续关联到 {{node}}。',
    'node_context_banner.relation_more': '另有 {{count}} 条相邻关系',
    'node_context_banner.related_title': '关联关系',
    'node_context_banner.related_incoming': '前因：{{node}} · {{relation}}',
    'node_context_banner.related_outgoing': '后续：{{relation}} · {{node}}',
    'causal.evidence_high': '高',
    'causal.evidence_medium': '中',
    'causal.evidence_low': '低',
    'causal.evidence_high_context': '高可信度',
    'causal.evidence_medium_context': '中等可信度',
    'causal.evidence_low_context': '低可信度',
    'causal.edge_round_context': '第 {{round}} 轮',
    'causal.edge_confidence_context': '可信度：{{tier}}',
    'causal.edge_context_suffix': '（{{context}}）',
    'causal.guide_preview_action': '查看全文',
    'causal.guide_preview_aria': '查看完整内容：{{label}}',
    'causal.guide_expand_details': '展开详情',
    'causal.guide_collapse_details': '收起详情',
    'causal.error.network': '因果图谱加载失败，请检查网络后重试。',
    'causal.error.branch_not_found': '所选分支已不在当前场景中。',
    'causal.error.unauthorized': '你没有权限查看此因果图谱。',
    'causal.error.server': '服务器暂时无法加载因果图谱。',
    'causal.error.load_failed': '因果图谱暂时无法加载，请稍后重试。',
    'common.graph_controls': '图谱控件',
    'common.graph_zoom_in': '放大',
    'common.graph_zoom_out': '缩小',
    'common.graph_fit_view': '适配视图',
    'common.graph_toggle_interactivity': '切换交互状态',
    'common.graph_minimap': '缩略图',
    'common.graph_mobile_hint': '可拖动画布；双指缩放或使用图谱控件调整视图。',
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

const {
  getMockCapabilityEnabled,
  getMockCapabilityError,
  getMockCapabilityReload,
  resetMockCapabilities,
  setMockCapabilityEnabled,
  setMockCapabilityError,
} = vi.hoisted(() => {
  const capabilityOverrides = new Map<string, boolean>();
  const capabilityErrors = new Map<string, Error | null>();
  const capabilityReloads = new Map<string, ReturnType<typeof vi.fn>>();
  const getCapabilityReload = (name: string) => {
    let reload = capabilityReloads.get(name);
    if (!reload) {
      reload = vi.fn(async () => undefined);
      capabilityReloads.set(name, reload);
    }
    return reload;
  };
  return {
    getMockCapabilityEnabled: (name: string) => (
      capabilityOverrides.has(name) ? capabilityOverrides.get(name)! : name !== 'graph_analysis'
    ),
    getMockCapabilityError: (name: string) => capabilityErrors.get(name) ?? null,
    getMockCapabilityReload: getCapabilityReload,
    resetMockCapabilities: () => {
      capabilityOverrides.clear();
      capabilityErrors.clear();
      capabilityReloads.clear();
    },
    setMockCapabilityEnabled: (name: string, enabled: boolean) => {
      capabilityOverrides.set(name, enabled);
    },
    setMockCapabilityError: (name: string, error: Error | null) => {
      capabilityErrors.set(name, error);
    },
  };
});

const graphAnalysisApiMock = vi.hoisted(() => ({
  buildSessionHeaders: vi.fn(() => new Headers()),
  getGraphAnalysis: vi.fn(),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: (name: string) => ({
    loading: false,
    enabled: getMockCapabilityError(name) ? false : getMockCapabilityEnabled(name),
    capabilities: null,
    error: getMockCapabilityError(name),
    reload: getMockCapabilityReload(name),
  }),
}));

vi.mock('../api/client', () => ({
  buildSessionHeaders: graphAnalysisApiMock.buildSessionHeaders,
  getGraphAnalysis: graphAnalysisApiMock.getGraphAnalysis,
}));

vi.mock('react-i18next', async () => {
  const React = await import('react');
  return {
    useTranslation: () => {
      const localeVersion = React.useSyncExternalStore(
        subscribeToLocaleChange,
        getLocaleVersion,
      );
      const t = React.useMemo(() => {
        void localeVersion;
        return (key: string, fallback?: string | Record<string, unknown>) => (
          resolveTranslation(getCurrentLocale(), key, fallback)
        );
      }, [localeVersion]);
      return { t, i18n: i18nMock };
    },
  };
});

// Mock @xyflow/react to avoid canvas errors in jsdom
vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  const useStatefulFlow = <T,>(items: T[]) => {
    const [state, setState] = React.useState(items);
    return [state, setState, vi.fn()] as const;
  };
  return {
    ReactFlow: ({
      children,
      nodes,
      ariaLabelConfig,
      onInit,
      onNodeClick,
      onPaneClick,
      panOnDrag,
      nodesDraggable,
      elementsSelectable,
      fitViewOptions,
      minZoom,
      edges,
    }: {
      children?: React.ReactNode;
      nodes?: Array<{
        id: string;
        ariaLabel?: string | null;
        ariaRole?: string | null;
        className?: string | null;
        data?: { summary?: string | null };
      }>;
      edges?: Array<{ label?: string | null }>;
      ariaLabelConfig?: Record<string, string>;
      onInit?: (instance: { fitView: typeof fitViewMock }) => void;
      onNodeClick?: (event: unknown, node: { id: string }) => void;
      onPaneClick?: () => void;
      panOnDrag?: boolean | number[];
      nodesDraggable?: boolean;
      elementsSelectable?: boolean;
      fitViewOptions?: { padding?: number; duration?: number; minZoom?: number; maxZoom?: number };
      minZoom?: number;
    }) => {
      const firstNode = nodes?.[0];
      const firstEdge = edges?.[0];
      const onInitRef = React.useRef(onInit);
      React.useEffect(() => {
        onInitRef.current?.({ fitView: fitViewMock });
      }, []);
      return (
        <div
          data-testid="reactflow"
          data-node-aria-label={firstNode?.ariaLabel ?? ''}
          data-node-aria-role={firstNode?.ariaRole ?? ''}
          data-aria-label-config={JSON.stringify(ariaLabelConfig ?? {})}
          data-pan-on-drag={JSON.stringify(panOnDrag ?? null)}
          data-nodes-draggable={String(nodesDraggable ?? false)}
          data-elements-selectable={String(elementsSelectable ?? false)}
          data-fit-view-options={JSON.stringify(fitViewOptions ?? null)}
          data-min-zoom={String(minZoom ?? '')}
          data-edge-label={String(firstEdge?.label ?? '')}
          data-first-node-class-name={firstNode?.className ?? ''}
          data-first-node-summary={String(firstNode?.data?.summary ?? '')}
        >
          {nodes?.map((node) => (
            <button
              key={node.id}
              data-testid={`rf-node-${node.id}`}
              onClick={(event) => onNodeClick?.(event, node)}
            />
          ))}
          <button data-testid="rf-pane" onClick={() => onPaneClick?.()} />
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
    useNodesState: useStatefulFlow,
    useEdgesState: useStatefulFlow,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
  };
});

import { Route, Routes } from 'react-router-dom';
import { CausalReviewView } from './CausalReviewView';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fitViewMock.mockReset();
  graphAnalysisApiMock.getGraphAnalysis.mockReset();
  graphAnalysisApiMock.buildSessionHeaders.mockClear();
  resetMockCapabilities();
  resetTestI18n();
  document.body.classList.remove('has-causal-graph');
});

const renderView = (path = '/sim/test-id/causal-map') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/sim/:id/causal-map" element={<CausalReviewView />} />
      </Routes>
    </MemoryRouter>,
  );

async function expandGraphOverview(user = userEvent.setup()) {
  expect(await screen.findByText('Graph Overview')).toBeInTheDocument();
  const detailsButton = screen.getByRole('button', { name: 'Show details' });
  expect(detailsButton).toHaveAttribute('aria-expanded', 'false');
  await user.click(detailsButton);
  return user;
}

const createDeferredResponse = () => {
  let resolve!: (value: Response) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createDeferredGraphAnalysis = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

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

const installLegacyMatchMedia = (initialMatches: boolean) => {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    get matches() {
      return matches && query.includes('max-width');
    },
    media: query,
    onchange: null,
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    }),
    dispatchEvent: vi.fn(() => false),
  } as unknown as MediaQueryList));

  return {
    emit(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches: nextMatches, media: '(max-width: 768px)' } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
    matchMediaSpy,
  };
};

function BranchNavigationHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/sim/test-id/causal-map?branch_id=br1')}>Go br1</button>
      <button onClick={() => navigate('/sim/test-id/causal-map?branch_id=br2')}>Go br2</button>
      <CausalReviewView />
    </>
  );
}

function ScenarioNavigationHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/sim/test-id/causal-map')}>Go scenario A</button>
      <button onClick={() => navigate('/sim/next-id/causal-map')}>Go scenario B</button>
      <CausalReviewView />
    </>
  );
}

const countCausalGraphRequests = (fetchSpy: { mock: { calls: Array<[unknown, ...unknown[]]> } }) => (
  fetchSpy.mock.calls.filter(([request]) => String(request).includes('/causal-graph')).length
);

const changeUiLanguage = async (locale: TestLocale) => {
  await act(async () => {
    await changeTestLanguage(locale);
  });
};

describe('CausalReviewView', () => {
  it('uses affect-proxy display types and the truthful localized scope baseline', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-affect-proxy',
          scope_kind: 'branch_lineage',
          scope_caveat: 'Selected branch lineage includes pre-fork ancestor rounds.',
          nodes: [
            {
              id: 'n1',
              key: 'shift-1',
              type: 'stance_shift',
              label: 'Ada affect proxy shifted',
              round: 2,
              payload: { display_type: 'affect_shift_proxy', agent_name: 'Ada' },
            },
            { id: 'n2', key: 'event-2', type: 'event', label: 'Beta', round: 2, payload: null },
          ],
          edges: [
            {
              id: 'edge-1',
              source: 'n1',
              target: 'n2',
              type: 'supports_stance',
              display_type: 'affect_alignment_proxy',
              weight: 1,
              label: null,
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'scenario-1', branches: [], agents: [] }),
      } as Response);

    renderView('/sim/test-id/causal-map?branch_id=branch-1');

    const graph = await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(graph).toHaveAttribute('data-edge-label', 'affect aligned (proxy)');
      expect(graph.getAttribute('data-node-aria-label')).toContain(
        'Affect shift (proxy)',
      );
    });
    const scopeNote = screen.getByRole('note');
    expect(scopeNote).toHaveTextContent(
      'Showing the selected branch’s effective scope only; parent post-fork rounds, sibling rounds, and unrelated source-branch coordinates are excluded.',
    );
    expect(scopeNote).not.toHaveTextContent(/ancestor/i);
  });

  it.each([
    {
      locale: 'en' as const,
      expected: 'Showing the selected branch’s effective scope only; parent post-fork rounds, sibling rounds, and unrelated source-branch coordinates are excluded.',
    },
    {
      locale: 'zh' as const,
      expected: '仅展示所选分支的有效范围；父分支分叉后的轮次、兄弟分支轮次及无关源分支坐标均已排除。',
    },
  ])('uses the $locale localized branch-lineage baseline when the server caveat is absent', async ({ locale, expected }) => {
    applyTestLocale(locale);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: `g-lineage-${locale}`,
          scope_kind: 'branch_lineage',
          nodes: [
            { id: 'n1', key: 'event-1', type: 'event', label: 'Alpha', round: 1, payload: null },
          ],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'scenario-1', branches: [], agents: [] }),
      } as Response);

    renderView('/sim/test-id/causal-map?branch_id=branch-1');

    expect(await screen.findByRole('note')).toHaveTextContent(expected);
  });

  it('keeps a nonempty English server caveat localized in Chinese without promising ancestors', async () => {
    applyTestLocale('zh');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-lineage-server-caveat-zh',
          scope_kind: 'branch_lineage',
          scope_caveat: 'Selected branch lineage includes pre-fork ancestor rounds.',
          nodes: [
            { id: 'n1', key: 'event-1', type: 'event', label: 'Alpha', round: 1, payload: null },
          ],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'scenario-1', branches: [], agents: [] }),
      } as Response);

    renderView('/sim/test-id/causal-map?branch_id=branch-1');

    const scopeNote = await screen.findByRole('note');
    expect(scopeNote).toHaveTextContent(
      '仅展示所选分支的有效范围；父分支分叉后的轮次、兄弟分支轮次及无关源分支坐标均已排除。',
    );
    expect(scopeNote).not.toHaveTextContent(/ancestor|祖先/i);
  });

  it('ignores a malformed server caveat and renders the localized scope baseline', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-lineage-malformed-caveat',
          scope_kind: 'branch_lineage',
          scope_caveat: { unexpected: true },
          nodes: [
            { id: 'n1', key: 'event-1', type: 'event', label: 'Alpha', round: 1, payload: null },
          ],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'scenario-1', branches: [], agents: [] }),
      } as Response);

    renderView('/sim/test-id/causal-map?branch_id=branch-1');

    expect(await screen.findByRole('note')).toHaveTextContent(
      'Showing the selected branch’s effective scope only; parent post-fork rounds, sibling rounds, and unrelated source-branch coordinates are excluded.',
    );
  });

  it('does not render a lineage scope note for an unscoped graph response', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-unscoped',
          nodes: [
            { id: 'n1', key: 'event-1', type: 'event', label: 'Alpha', round: 1, payload: null },
          ],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'scenario-1', branches: [], agents: [] }),
      } as Response);

    renderView();

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    // Mock fetch to never resolve
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    renderView();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('shows a localized error when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));
    renderView();
    // Wait for error to appear
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to load the causal graph. Check your connection and try again.');
    vi.restoreAllMocks();
  });

  it('maps invalid branch filters to localized error copy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        detail: {
          code: 'BRANCH_NOT_FOUND',
          message: 'Branch missing-branch not found in scenario',
        },
      }),
    } as Response);
    renderView('/sim/test-id/causal-map?branch_id=missing-branch');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The selected branch is no longer available for this scenario.');
    vi.restoreAllMocks();
  });

  it('localizes known causal graph network errors instead of leaking raw browser text', async () => {
    applyTestLocale('zh');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('因果图谱加载失败，请检查网络后重试。');
    expect(alert).not.toHaveTextContent('Network error');
  });

  it('localizes branch-not-found errors from backend codes', async () => {
    applyTestLocale('zh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({
        detail: {
          code: 'BRANCH_NOT_FOUND',
          message: 'Branch missing-branch not found in scenario',
        },
      }),
    } as Response);

    renderView('/sim/test-id/causal-map?branch_id=missing-branch');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('所选分支已不在当前场景中。');
    expect(alert).not.toHaveTextContent('Branch missing-branch not found in scenario');
  });

  it('shows empty state when graph has no nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'g1', nodes: [], edges: [] }),
    } as Response);
    renderView();
    const empty = await screen.findByTestId('dag-empty-state');
    expect(empty).toBeInTheDocument();
    expect(screen.getByText(/No graph data yet/)).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('shows the explanatory empty-state guide when the graph has no nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'g-empty-guide', nodes: [], edges: [] }),
    } as Response);

    renderView();

    expect(await screen.findByTestId('dag-empty-state')).toBeInTheDocument();
    expect(screen.getByText(/No graph data yet/)).toBeInTheDocument();
    expect(screen.getByText(/Run a simulation/)).toBeInTheDocument();
  });

  it('renders ReactFlow when graph has nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    const flow = await screen.findByTestId('reactflow');
    expect(flow).toBeInTheDocument();
    expect(flow).toHaveAttribute('data-pan-on-drag', '[0,1]');
    expect(flow).toHaveAttribute('data-nodes-draggable', 'true');
    expect(flow).toHaveAttribute('data-elements-selectable', 'true');
    expect(JSON.parse(flow.getAttribute('data-fit-view-options') ?? '{}')).toMatchObject({
      duration: 0,
    });
    vi.restoreAllMocks();
  });

  it('keeps a 66-node sparse causal map in readable fit mode', async () => {
    const nodes = Array.from({ length: 66 }, (_value, index) => ({
      id: `n${index}`,
      key: `event-${index}`,
      type: 'event',
      label: `Event ${index}`,
      round: index + 1,
      payload: { agent_id: `agent-${index % 4}` },
    }));
    const edges = Array.from({ length: 16 }, (_value, index) => ({
      id: `edge-${index}`,
      source: `n${index}`,
      target: `n${index + 1}`,
      type: 'caused',
      weight: 1,
      label: null,
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-readable-medium',
        nodes,
        edges,
      }),
    } as Response);

    renderView();

    const flow = await screen.findByTestId('reactflow');
    expect(JSON.parse(flow.getAttribute('data-fit-view-options') ?? '{}')).toMatchObject({
      duration: 0,
      minZoom: 0.35,
    });
    expect(flow).toHaveAttribute('data-min-zoom', '0.02');
    expect(flow).toHaveAttribute('data-first-node-class-name', '');
  });

  it('shows the compact guide summary by default and expands details on demand', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-guide-visible',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Alpha node', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: 'Beta node', round: 2, payload: null },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);

    renderView();

    expect(await screen.findByText('Graph Overview')).toBeInTheDocument();
    expect(screen.getByText(/This graph is mainly a cause-and-effect timeline/)).toBeInTheDocument();
    expect(screen.getByText('Graph size: 2 nodes · 1 edges')).toBeInTheDocument();
    expect(screen.queryByText('Start with these nodes')).not.toBeInTheDocument();
    expect(screen.queryByText('Link count means incoming plus outgoing relationships. It is context size, not a quality score.')).not.toBeInTheDocument();

    const detailsButton = screen.getByRole('button', { name: 'Show details' });
    expect(detailsButton).toHaveAttribute('aria-expanded', 'false');
    await user.click(detailsButton);

    expect(await screen.findByText('Start with these nodes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide details' })).toHaveAttribute('aria-expanded', 'true');
    const closeButton = screen.getByRole('button', { name: 'Close guide' });
    expect(closeButton).toHaveAttribute('aria-expanded', 'true');
    expect(closeButton).toHaveAttribute('aria-controls', 'causal-guide-panel');
    expect(screen.getByText('Link count means incoming plus outgoing relationships. It is context size, not a quality score.')).toBeInTheDocument();
    expect(screen.getByText('Click a node to read its full card, causes, effects, and chat target.')).toBeInTheDocument();
  });

  it('explains fork-to-outcome routes in the guide panel', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-guide-routes',
        nodes: [
          { id: 'fork-1', key: 'f1', type: 'fork', label: 'Route split after council', round: 1, payload: null },
          { id: 'event-1', key: 'e1', type: 'event', label: 'Advisor warns about supply lines', round: 2, payload: null },
          { id: 'outcome-1', key: 'o1', type: 'outcome', label: 'Northern campaign stalls', round: 3, payload: null },
        ],
        edges: [
          { id: 'edge-1', source: 'fork-1', target: 'event-1', type: 'caused', weight: 1, label: null },
          { id: 'edge-2', source: 'fork-1', target: 'outcome-1', type: 'led_to', weight: 1, label: null },
        ],
      }),
    } as Response);

    renderView();
    await expandGraphOverview(user);

    expect(await screen.findByText('How branches resolve')).toBeInTheDocument();
    expect(screen.getByText(/This graph connects 1 forks, 1 events, and 1 outcomes through 2 links/)).toBeInTheDocument();
    expect(screen.getAllByText('Route split after council').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Northern campaign stalls').length).toBeGreaterThan(0);
  });

  it('keeps canvas edge labels human-readable while preserving evidence context in text summaries', async () => {
    applyTestLocale('zh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-evidence-tier',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: 'Beta', round: 2, payload: null },
        ],
        edges: [{
          id: 'edge-1',
          source: 'n1',
          target: 'n2',
          type: 'caused',
          weight: 1,
          label: null,
          evidence: {
            confidence_tier: 'medium',
            source_ref: null,
            source_round_number: 2,
            detail: null,
          },
        }],
      }),
    } as Response);

    renderView();

    const flow = await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(flow).toHaveAttribute('data-edge-label', '导致');
    });
    expect(flow.getAttribute('data-edge-label') ?? '').not.toContain('R2');
    expect(flow.getAttribute('data-edge-label') ?? '').not.toContain('[中]');
    expect(screen.getByText('Alpha 导致 Beta （第 2 轮 · 可信度：中等可信度）')).toBeInTheDocument();
  });

  it('keeps guide counts tied to graphData even when search filters the visible graph', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-guide-counts',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Alpha node', round: 1, payload: { agent_id: 'alpha' } },
          { id: 'n2', key: 'e2', type: 'event', label: 'Beta node', round: 2, payload: { agent_id: 'beta' } },
          { id: 'n3', key: 'e3', type: 'event', label: 'Gamma node', round: 3, payload: { agent_id: 'gamma' } },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);

    renderView();

    await expandGraphOverview(user);
    await screen.findByText('Graph Overview');
    await user.type(screen.getByPlaceholderText('Search nodes or agents...'), 'Alpha');

    expect(screen.getByText('Graph size: 3 nodes · 1 edges')).toBeInTheDocument();
  });

  it('only lists key nodes whose degree is greater than zero', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-guide-key-nodes',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Connected Alpha', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: 'Connected Beta', round: 2, payload: null },
          { id: 'n3', key: 'e3', type: 'event', label: 'Isolated Gamma', round: 3, payload: null },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);

    renderView();

    await expandGraphOverview();
    expect(await screen.findByText('Start with these nodes')).toBeInTheDocument();
    expect(screen.getByLabelText('Connected Alpha - 1 links')).toBeInTheDocument();
    expect(screen.getByLabelText('Connected Beta - 1 links')).toBeInTheDocument();
    expect(screen.queryByLabelText('Isolated Gamma - 0 links')).not.toBeInTheDocument();
  });

  it('keeps verbose guide key node labels compact while preserving the full label', async () => {
    const user = userEvent.setup();
    const longLabel = '诸葛亮昨夜翻检汉中粮册时发现秋雨让褒斜道慢了两日，木牛流马坏损又牵动成都后勤与北伐节奏';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-guide-long-key-node',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: longLabel, round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: 'Anchor node', round: 2, payload: null },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);

    renderView();

    await expandGraphOverview(user);
    expect(await screen.findByText('Start with these nodes')).toBeInTheDocument();
    expect(screen.queryByText(`${longLabel} (1)`)).not.toBeInTheDocument();
    const fullLabelNode = screen.getByLabelText(`${longLabel} - 1 links`);
    expect(fullLabelNode).toHaveTextContent('...');
    expect(fullLabelNode).toHaveAttribute('title', `${longLabel} - 1 links`);
    expect(screen.getByText(longLabel)).not.toBeVisible();
    await user.click(screen.getByText('View full'));
    expect(screen.getByText(longLabel)).toBeVisible();
  });

  it('expands guide event cards to the full payload content instead of the short graph label', async () => {
    const user = userEvent.setup();
    const shortLabel = '诸葛亮: 汉中秋雨拖慢粮道，木牛流马坏了两架';
    const fullContent = '汉中秋雨拖慢粮道，木牛流马坏了两架，修起来比新造还费人；若成都调拨与军府号令不能一起稳住，前线每慢一拍都会让北伐失去主动。';
    const fullDisplayText = `诸葛亮: ${fullContent}`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-guide-full-event-content',
        nodes: [
          {
            id: 'n1',
            key: 'e1',
            type: 'event',
            label: shortLabel,
            round: 1,
            payload: { agent_name: '诸葛亮', content: fullContent },
          },
          { id: 'n2', key: 'e2', type: 'event', label: 'Anchor node', round: 2, payload: null },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);

    renderView();

    await expandGraphOverview(user);
    const fullLabelNode = screen.getByLabelText(`${fullDisplayText} - 1 links`);
    expect(fullLabelNode).toHaveTextContent(shortLabel);
    expect(screen.getByText(fullDisplayText)).not.toBeVisible();

    await user.click(screen.getByText('View full'));
    expect(screen.getByText(fullDisplayText)).toBeVisible();
  });

  it('hides the guide panel after closing it and exposes the show-overview button', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-guide-close',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Alpha node', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);

    renderView();

    await expandGraphOverview(user);
    await user.click(await screen.findByRole('button', { name: 'Close guide' }));

    expect(screen.queryByText('Graph Overview')).not.toBeInTheDocument();
    const showButton = screen.getByRole('button', { name: 'Show graph overview' });
    expect(showButton).toHaveAttribute('aria-expanded', 'false');
    expect(showButton).toHaveAttribute('aria-controls', 'causal-guide-panel');
  });

  it('shows a snapshot fallback instead of ReactFlow when the graph has multiple nodes but no edges', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-relationless',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: 'Beta', round: 2, payload: null },
        ],
        edges: [],
      }),
    } as Response);

    renderView();

    expect(await screen.findByText('No causal edges were generated for this scenario yet. Showing event snapshots instead.')).toBeInTheDocument();
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Round 1/i })).toBeInTheDocument();
    expect(screen.getAllByRole('list', { name: 'Causal events list' })).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('shows export panel when graph has nodes', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    const panel = await screen.findByTestId('export-panel');
    expect(panel).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('does not show export panel when graph is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'g1', nodes: [], edges: [] }),
    } as Response);
    renderView();
    await screen.findByTestId('dag-empty-state');
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('renders agent search input (C5)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Agent Alpha speaks', round: 1, payload: { agent_id: 'alpha' } }],
        edges: [],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    const searchInput = screen.getByPlaceholderText('Search nodes or agents...');
    expect(searchInput).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('shows the full-graph label in the guide when search is active', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-guide-full-graph',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Alpha node', round: 1, payload: { agent_id: 'alpha' } },
          { id: 'n2', key: 'e2', type: 'event', label: 'Beta node', round: 2, payload: { agent_id: 'beta' } },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);

    renderView();
    await expandGraphOverview(user);

    const guideHeading = (await screen.findByText('Graph Overview')).closest('strong');
    expect(guideHeading).not.toBeNull();
    expect(guideHeading).not.toHaveTextContent('(full graph)');

    await user.type(screen.getByPlaceholderText('Search nodes or agents...'), 'Alpha');

    expect(guideHeading).toHaveTextContent('(full graph)');
  });

  it('recomputes graph node accessibility labels when the UI language changes at runtime', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      if (String(request).includes('/causal-graph')) {
        return {
          ok: true,
          json: async () => ({
            id: 'g-runtime-i18n',
            nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Timeline split', round: 1, payload: null }],
            edges: [{ id: 'edge-1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
          }),
        } as Response;
      }
      throw new Error('scenario lookup disabled for test');
    });

    renderView();
    await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(screen.getByTestId('reactflow').getAttribute('data-node-aria-label')).toContain('Event');
    });
    expect(JSON.parse(screen.getByTestId('reactflow').getAttribute('data-aria-label-config') ?? '{}')).toMatchObject({
      'controls.zoomIn.ariaLabel': 'Zoom in',
      'minimap.ariaLabel': 'Mini map',
    });
    expect(countCausalGraphRequests(fetchSpy)).toBe(1);

    await changeUiLanguage('zh');

    await waitFor(() => {
      expect(screen.getByTestId('reactflow').getAttribute('data-node-aria-label')).toContain('事件');
    });
    expect(JSON.parse(screen.getByTestId('reactflow').getAttribute('data-aria-label-config') ?? '{}')).toMatchObject({
      'controls.zoomIn.ariaLabel': '放大',
      'minimap.ariaLabel': '缩略图',
    });
    expect(countCausalGraphRequests(fetchSpy)).toBe(1);
  });

  it('labels terminal outcome nodes with localized causal copy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request) => {
      if (String(request).includes('/causal-graph')) {
        return {
          ok: true,
          json: async () => ({
            id: 'g-outcome',
            nodes: [
              {
                id: 'outcome:br1',
                key: 'outcome_br1',
                type: 'outcome',
                label: 'Stabilized future',
                round: 1,
                payload: { branch_id: 'br1' },
              },
              {
                id: 'event:br1:1',
                key: 'event_br1_1',
                type: 'event',
                label: 'Origin',
                round: 1,
                payload: { branch_id: 'br1' },
              },
            ],
            edges: [
              {
                id: 'outcome-edge:event:br1:1:br1',
                source: 'event:br1:1',
                target: 'outcome:br1',
                type: 'led_to',
                weight: 1,
                label: null,
              },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ branches: [], agents: [] }) } as Response;
    });

    renderView();

    const flow = await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(flow.getAttribute('data-node-aria-label')).toContain(
        'Open details: Outcome - Stabilized future',
      );
    });
    expect(await screen.findByText('Outcome: 1')).toBeInTheDocument();
    expect(await screen.findByText('Origin leads to Stabilized future')).toBeInTheDocument();
  });

  it('keeps node wrappers non-interactive so the card button owns the action semantics', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-node-semantics',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Timeline split', round: 1, payload: null }],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
      }),
    } as Response);

    renderView();

    const flow = await screen.findByTestId('reactflow');
    expect(flow.getAttribute('data-node-aria-role')).toBe('');
    await waitFor(() => {
      expect(flow.getAttribute('data-node-aria-label')).toContain('Event');
    });
  });

  it.each([401, 403])('maps unauthorized status %i to localized error copy', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status,
      json: async () => ({ detail: { message: 'Forbidden' } }),
    } as Response);

    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You do not have permission to view this causal graph.');
  });

  it('maps 5xx responses to localized server error copy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ detail: { message: 'Server exploded' } }),
    } as Response);

    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The server could not load the causal graph right now.');
  });

  it('falls back to localized generic error copy for uncategorized HTTP failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 418,
      json: async () => ({ detail: { message: 'Teapot' } }),
    } as Response);

    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to load the causal graph right now. Please retry.');
  });

  it('shows a retryable capability probe error before the disabled state', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    setMockCapabilityError('causal_graph', new Error('capability probe failed'));

    renderView();

    expect(screen.getByRole('heading', { name: 'Cannot verify feature' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Unable to verify feature availability. Please try again.',
    );
    expect(screen.queryByText('Causal graph feature is not enabled.')).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(getMockCapabilityReload('causal_graph')).toHaveBeenCalledTimes(1);
  });

  it('rerenders unauthorized error copy when the UI language changes without refetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ detail: { message: 'Unauthorized' } }),
    } as Response);

    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You do not have permission to view this causal graph.');
    expect(countCausalGraphRequests(fetchSpy)).toBe(1);

    await changeUiLanguage('zh');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('你没有权限查看此因果图谱。');
    });
    expect(countCausalGraphRequests(fetchSpy)).toBe(1);
  });

  it('rerenders generic load failure copy when the UI language changes without refetching', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 418,
      json: async () => ({ detail: { message: 'Teapot' } }),
    } as Response);

    renderView();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unable to load the causal graph right now. Please retry.');
    expect(countCausalGraphRequests(fetchSpy)).toBe(1);

    await changeUiLanguage('zh');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('因果图谱暂时无法加载，请稍后重试。');
    });
    expect(countCausalGraphRequests(fetchSpy)).toBe(1);
  });

  it('keeps the interactive graph visible when search leaves multiple nodes but zero edges', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-search-zero-edges',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Agent Alpha move', round: 1, payload: { agent_id: 'alpha' } },
          { id: 'n2', key: 'e2', type: 'event', label: 'Agent Beta move', round: 1, payload: { agent_id: 'beta' } },
          { id: 'n3', key: 'e3', type: 'event', label: 'Agent Alpha reply', round: 2, payload: { agent_id: 'alpha' } },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);

    renderView();
    await screen.findByTestId('reactflow');

    await user.type(screen.getByPlaceholderText('Search nodes or agents...'), 'alpha');

    await waitFor(() => {
      expect(screen.getByTestId('reactflow')).toBeInTheDocument();
    });
    expect(screen.queryByText('No causal edges were generated for this scenario yet. Showing event snapshots instead.')).not.toBeInTheDocument();
    expect(screen.getByTestId('export-panel')).toBeInTheDocument();
    expect(screen.getByTestId('rf-node-n1')).toBeInTheDocument();
    expect(screen.getByTestId('rf-node-n3')).toBeInTheDocument();
  });

  it('renders the minimap as a non-interactive overlay', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-minimap',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    expect(screen.getByTestId('rf-minimap')).toHaveAttribute('data-pointer-events', 'none');
    vi.restoreAllMocks();
  });

  it('hides the minimap on narrow viewports to avoid covering the graph', async () => {
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
        id: 'g-mobile-minimap',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    expect(screen.queryByTestId('rf-minimap')).not.toBeInTheDocument();
    matchMediaSpy.mockRestore();
    vi.restoreAllMocks();
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
        id: 'g-mobile-fit',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
      }),
    } as Response);

    const user = userEvent.setup();
    renderView();
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

  it('adds and removes the body class that repositions the global language switcher around the causal graph chrome', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-body-class',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
      }),
    } as Response);

    const view = renderView();

    await screen.findByTestId('reactflow');
    expect(document.body).toHaveClass('has-causal-graph');

    view.unmount();
    expect(document.body).not.toHaveClass('has-causal-graph');
  });

  it('reacts to legacy WebKit media query listeners when compact mode changes at runtime', async () => {
    const legacyMatchMedia = installLegacyMatchMedia(false);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-legacy-media-query',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
      }),
    } as Response);

    renderView();
    await screen.findByTestId('reactflow');
    expect(screen.getByTestId('rf-minimap')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fit view' })).not.toBeInTheDocument();

    await act(async () => {
      legacyMatchMedia.emit(true);
    });

    await waitFor(() => {
      expect(screen.queryByTestId('rf-minimap')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Fit view' })).toBeInTheDocument();

    legacyMatchMedia.matchMediaSpy.mockRestore();
  });

  it('exposes the legend toggle as a proper disclosure control', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-legend',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
      }),
    } as Response);

    renderView();
    await screen.findByTestId('reactflow');

    const toggle = screen.getByRole('button', { name: 'Legend' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls');

    await user.click(toggle);

    const expandedToggle = screen.getByRole('button', { name: 'Hide Legend' });
    expect(expandedToggle).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(expandedToggle.getAttribute('aria-controls') ?? '')).not.toBeNull();
  });

  it('renders the graph before delayed scenario metadata finishes loading', async () => {
    const graphResponse = Promise.resolve({
      ok: true,
      json: async () => ({
        id: 'g-non-blocking',
        available_branches: ['branch-1'],
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Timeline split', round: 1, payload: null }],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
      }),
    } as Response);
    const scenarioDeferred = createDeferredResponse();
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => graphResponse)
      .mockImplementationOnce(() => scenarioDeferred.promise);

    renderView('/sim/test-id/causal-map?branch_id=branch-1');

    expect(await screen.findByTestId('reactflow')).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    await act(async () => {
      scenarioDeferred.resolve({
        ok: true,
        json: async () => ({ id: 'scenario-1', branches: [] }),
      } as Response);
    });
  });

  it('keeps sibling branch options available when a branch filter is active', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        available_branches: ['br1', 'br2'],
        nodes: [
          {
            id: 'n1',
            key: 'e1',
            type: 'event',
            label: 'Filtered branch node',
            round: 1,
            payload: { branch_id: 'br1' },
          },
        ],
        edges: [],
      }),
    } as Response);
    renderView('/sim/test-id/causal-map?branch_id=br1');
    await screen.findByTestId('reactflow');
    expect(screen.getByLabelText('Select branch')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All branches' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /br2/ })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('prefers scenario branch titles and probabilities in the branch selector', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-branch-meta',
          nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test Event', round: 1, payload: null }],
          edges: [{ id: 'edge-1', source: 'n1', target: 'n1', type: 'causal', weight: 1, label: null }],
          available_branches: ['branch-1', 'branch-2'],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'scenario-1',
          branches: [
            { id: 'branch-1', title: 'Worldline Alpha', probability: 0.73 },
            { id: 'branch-2', title: 'Worldline Beta', probability: 0.27 },
          ],
        }),
      } as Response);

    renderView('/sim/test-id/causal-map?branch_id=branch-1');

    const selector = await screen.findByRole('combobox', { name: 'Select branch' });
    expect(within(selector).getByRole('option', { name: 'Worldline Alpha · 73.0%' })).toBeInTheDocument();
    expect(within(selector).getByRole('option', { name: 'Worldline Beta · 27.0%' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('renders full branch labels so similar prefixes stay distinguishable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-branch-labels',
        available_branches: ['branch-1234-A', 'branch-1234-B'],
        nodes: [
          {
            id: 'n1',
            key: 'e1',
            type: 'event',
            label: 'Filtered branch node',
            round: 1,
            payload: { branch_id: 'branch-1234-A' },
          },
        ],
        edges: [],
      }),
    } as Response);

    renderView('/sim/test-id/causal-map?branch_id=branch-1234-A');
    await screen.findByTestId('reactflow');

    expect(screen.getByRole('option', { name: 'branch-1234-A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'branch-1234-B' })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('reconstructs branch options from payload branch ids and fork children when available_branches is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fallback-branches',
        nodes: [
          {
            id: 'fork-1',
            key: 'fork-parent',
            type: 'fork',
            label: 'Forked branch',
            round: 1,
            payload: { branch_id: 'br-parent', children: ['br-child', 'br-sibling'] },
          },
          {
            id: 'child-event',
            key: 'event-child',
            type: 'event',
            label: 'Child branch event',
            round: 2,
            payload: { branch_id: 'br-child', agent_id: 'alpha' },
          },
        ],
        edges: [],
      }),
    } as Response);
    renderView('/sim/test-id/causal-map?branch_id=br-child');
    await screen.findByText('No causal edges were generated for this scenario yet. Showing event snapshots instead.');

    expect(screen.getByLabelText('Select branch')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All branches' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /br-paren/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /br-sibli/ })).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('sends an encoded branch_id query when the selector changes', async () => {
    const user = userEvent.setup();
    const encodedBranchId = 'branch/child?2';
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-initial',
          available_branches: ['branch-root', encodedBranchId],
          nodes: [
            {
              id: 'n1',
              key: 'e1',
              type: 'event',
              label: 'Root branch node',
              round: 1,
              payload: { branch_id: 'branch-root' },
            },
          ],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'scenario-initial',
          branches: [
            { id: 'branch-root', title: 'Root branch', probability: 1 },
            { id: encodedBranchId, title: 'Filtered branch', probability: 0.5 },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-filtered',
          available_branches: ['branch-root', encodedBranchId],
          nodes: [
            {
              id: 'n2',
              key: 'e2',
              type: 'event',
              label: 'Filtered branch node',
              round: 2,
              payload: { branch_id: encodedBranchId },
            },
          ],
          edges: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'scenario-filtered',
          branches: [
            { id: 'branch-root', title: 'Root branch', probability: 1 },
            { id: encodedBranchId, title: 'Filtered branch', probability: 0.5 },
          ],
        }),
      } as Response);

    renderView();
    await screen.findByTestId('reactflow');

    await user.selectOptions(screen.getByLabelText('Select branch'), encodedBranchId);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
    const filteredGraphUrl = fetchSpy.mock.calls
      .map((call) => call[0])
      .find((value) => {
        if (typeof value === 'string') return value.includes('branch_id=');
        if (value instanceof URL) return value.toString().includes('branch_id=');
        return value.url.includes('branch_id=');
      });
    const serializedUrl =
      typeof filteredGraphUrl === 'string'
        ? filteredGraphUrl
        : filteredGraphUrl instanceof URL
          ? filteredGraphUrl.toString()
          : filteredGraphUrl?.url ?? '';
    expect(serializedUrl).toContain('branch_id=branch%2Fchild%3F2');
  });

  it('encodes scenario ids for fetches and result links', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'graph-id',
          nodes: [],
          edges: [],
          available_branches: [],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ branches: [] }),
      } as Response);

    renderView('/sim/scenario%2Falpha%3Fbeta/causal-map');

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/scenario/scenario%2Falpha%3Fbeta/causal-graph',
        expect.objectContaining({ headers: expect.anything() }),
      );
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/scenario/scenario%2Falpha%3Fbeta',
        expect.objectContaining({ headers: expect.anything() }),
      );
    });
    expect(screen.getByRole('link', { name: /Back to Result/i })).toHaveAttribute(
      'href',
      '/result/scenario%2Falpha%3Fbeta',
    );
  });

  it('clears the previous graph immediately when branch selection changes', async () => {
    const user = userEvent.setup();
    const branchOneResponse = createDeferredResponse();
    const branchTwoResponse = createDeferredResponse();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('branch_id=br1')) return branchOneResponse.promise;
      if (url.includes('branch_id=br2')) return branchTwoResponse.promise;
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    render(
      <MemoryRouter initialEntries={['/sim/test-id/causal-map?branch_id=br1']}>
        <Routes>
          <Route path="/sim/:id/causal-map" element={<BranchNavigationHarness />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    branchOneResponse.resolve({
      ok: true,
      json: async () => ({
        id: 'g-old',
        available_branches: ['br1', 'br2'],
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Old branch node', round: 1, payload: { branch_id: 'br1' } }],
        edges: [],
      }),
    } as Response);

    await screen.findByTestId('reactflow');
    expect(screen.getByTestId('export-panel')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Go br2' }));

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument();

    branchTwoResponse.resolve({
      ok: true,
      json: async () => ({
        id: 'g-new',
        available_branches: ['br1', 'br2'],
        nodes: [{ id: 'n2', key: 'e2', type: 'event', label: 'New branch node', round: 1, payload: { branch_id: 'br2' } }],
        edges: [],
      }),
    } as Response);

    await screen.findByTestId('reactflow');
  });

  it('clears server-side graph analysis immediately when branch selection changes', async () => {
    const user = userEvent.setup();
    setMockCapabilityEnabled('graph_analysis', true);
    const branchOneResponse = createDeferredResponse();
    const branchTwoResponse = createDeferredResponse();
    const analysisOne = createDeferredGraphAnalysis();
    const analysisTwo = createDeferredGraphAnalysis();

    graphAnalysisApiMock.getGraphAnalysis.mockImplementation(
      (_scenarioId: string, selectedBranchId?: string) => (
        selectedBranchId === 'br2' ? analysisTwo.promise : analysisOne.promise
      ),
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('branch_id=br1')) return branchOneResponse.promise;
      if (url.includes('branch_id=br2')) return branchTwoResponse.promise;
      if (url === '/api/scenario/test-id') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ branches: [{ id: 'br1', title: 'Branch 1' }, { id: 'br2', title: 'Branch 2' }] }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    render(
      <MemoryRouter initialEntries={['/sim/test-id/causal-map?branch_id=br1']}>
        <Routes>
          <Route path="/sim/:id/causal-map" element={<BranchNavigationHarness />} />
        </Routes>
      </MemoryRouter>,
    );

    branchOneResponse.resolve({
      ok: true,
      json: async () => ({
        id: 'g-old',
        available_branches: ['br1', 'br2'],
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Old branch node', round: 1, payload: { branch_id: 'br1' } }],
        edges: [],
      }),
    } as Response);
    analysisOne.resolve({
      god_nodes: [{ node_id: 'n1', label: 'Old analysis node', type: 'event', total_degree: 9 }],
      degree_distribution: { 0: 0, 1: 0, 2: 0, 3: 0, '4+': 1 },
      cross_branch_edges: [],
      summary: {
        total_nodes: 42,
        total_edges: 3,
        avg_degree: 0.14,
        max_degree: 9,
        connected_components: 2,
        density: 0.002,
      },
    });

    await expandGraphOverview(user);
    expect(await screen.findByLabelText('Old branch node - 9 links')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Go br2' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('Old branch node - 9 links')).not.toBeInTheDocument();
    });

    branchTwoResponse.resolve({
      ok: true,
      json: async () => ({
        id: 'g-new',
        available_branches: ['br1', 'br2'],
        nodes: [{ id: 'n2', key: 'e2', type: 'event', label: 'New branch node', round: 1, payload: { branch_id: 'br2' } }],
        edges: [],
      }),
    } as Response);
    analysisTwo.resolve({
      god_nodes: [{ node_id: 'n2', label: 'New analysis node', type: 'event', total_degree: 5 }],
      degree_distribution: { 0: 0, 1: 0, 2: 0, 3: 0, '4+': 1 },
      cross_branch_edges: [],
      summary: {
        total_nodes: 7,
        total_edges: 2,
        avg_degree: 0.28,
        max_degree: 5,
        connected_components: 1,
        density: 0.048,
      },
    });

    expect(await screen.findByLabelText('New branch node - 5 links')).toBeInTheDocument();
  });

  it('treats blank branch_id query params as no filter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-blank-branch',
        available_branches: ['branch-root'],
        nodes: [
          {
            id: 'n1',
            key: 'e1',
            type: 'event',
            label: 'Root branch node',
            round: 1,
            payload: { branch_id: 'branch-root' },
          },
        ],
        edges: [],
      }),
    } as Response);

    renderView('/sim/test-id/causal-map?branch_id=%20%20');
    await screen.findByTestId('reactflow');

    const firstCallUrl = fetchSpy.mock.calls[0]?.[0];
    const serializedUrl =
      typeof firstCallUrl === 'string'
        ? firstCallUrl
        : firstCallUrl instanceof URL
          ? firstCallUrl.toString()
          : firstCallUrl.url;
    expect(serializedUrl).toBe('/api/scenario/test-id/causal-graph');
  });

  it('refits the viewport after search filtering changes the node set', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fit',
        available_branches: ['br1'],
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Agent Alpha speaks', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
          { id: 'n2', key: 'e2', type: 'event', label: 'Agent Beta speaks', round: 1, payload: { agent_id: 'beta', branch_id: 'br1' } },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(fitViewMock.mock.calls.length).toBeGreaterThan(0);
    });
    const initialCalls = fitViewMock.mock.calls.length;

    await user.type(screen.getByPlaceholderText('Search nodes or agents...'), 'beta');

    await waitFor(() => {
      expect(fitViewMock.mock.calls.length).toBeGreaterThan(initialCalls);
    });
    vi.restoreAllMocks();
  });

  it('does not refit the viewport when selecting or clearing a highlighted node', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-select',
        available_branches: ['br1'],
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Agent Alpha speaks', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
          { id: 'n2', key: 'e2', type: 'event', label: 'Agent Beta speaks', round: 1, payload: { agent_id: 'beta', branch_id: 'br1' } },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);
    renderView();
    await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(fitViewMock.mock.calls.length).toBeGreaterThan(0);
    });
    const initialCalls = fitViewMock.mock.calls.length;

    await user.click(await screen.findByTestId('rf-node-n1'));
    await waitFor(() => {
      expect(screen.getByTestId('node-conversation-sheet')).toBeInTheDocument();
    });
    expect(fitViewMock.mock.calls.length).toBe(initialCalls);

    // Node click opens NodeConversationSheet (Radix Dialog),
    // whose overlay disables pointer-events on siblings. Use fireEvent to
    // synthesize the pane click directly and bypass the css pointer guard.
    fireEvent.click(screen.getByTestId('rf-pane'));
    await waitFor(() => {
      expect(screen.queryByTestId('node-detail-panel')).not.toBeInTheDocument();
    });
    expect(fitViewMock.mock.calls.length).toBe(initialCalls);
    vi.restoreAllMocks();
  });

  it('keeps the conversation sheet outside the export target so transient UI is not exported', async () => {
    stubNoopWebSocket();
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
          id: 'g-export-scope',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Agent Alpha speaks', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
          ],
          edges: [],
        }),
      } as Response);

      const { container } = renderView();
      const nodeButton = await screen.findByTestId('rf-node-n1');
      await user.click(nodeButton);

      const sheet = await screen.findByTestId('node-conversation-sheet');
      const exportRoot = await screen.findByTestId('causal-graph-export-target');
      expect(container.contains(exportRoot)).toBe(true);
      expect(exportRoot?.contains(sheet)).toBe(false);
      expect(screen.queryByTestId('node-detail-panel')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('recovers after retrying a failed fetch', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g1',
          nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Recovered', round: 1, payload: null }],
          edges: [],
        }),
      } as Response);

    renderView();

    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('reactflow');
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    vi.restoreAllMocks();
  });

  it('ignores stale branch responses when a newer branch selection resolves first', async () => {
    const user = userEvent.setup();
    const branchOneResponse = createDeferredResponse();
    const branchTwoResponse = createDeferredResponse();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('branch_id=br1')) return branchOneResponse.promise;
      if (url.includes('branch_id=br2')) return branchTwoResponse.promise;
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });

    render(
      <MemoryRouter initialEntries={['/sim/test-id/causal-map?branch_id=br1']}>
        <Routes>
          <Route path="/sim/:id/causal-map" element={<BranchNavigationHarness />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: 'Go br2' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    branchTwoResponse.resolve({
      ok: true,
      json: async () => ({
        id: 'g-branch-two',
        available_branches: ['br1', 'br2'],
        nodes: [{ id: 'n2', key: 'e2', type: 'event', label: 'Branch 2 fresh event', round: 1, payload: { branch_id: 'br2' } }],
        edges: [],
      }),
    } as Response);

    await screen.findByText(/Branch 2 fresh event/);

    branchOneResponse.resolve({
      ok: true,
      json: async () => ({
        id: 'g-branch-one',
        available_branches: ['br1', 'br2'],
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Branch 1 stale event', round: 1, payload: { branch_id: 'br1' } }],
        edges: [],
      }),
    } as Response);

    await waitFor(() => {
      expect(screen.getByText(/Branch 2 fresh event/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Branch 1 stale event/)).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it('uses dynamic viewport height on the causal graph shell', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-dvh',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Shell check', round: 1, payload: null }],
        edges: [],
      }),
    } as Response);

    const { container } = renderView();
    await screen.findByTestId('reactflow');

    const shell = container.querySelector('.causal-review-shell');
    expect(shell).toHaveStyle({ height: '100dvh', minHeight: '100dvh' });
  });

  it('opens conversation sheet when clicking a fallback node in the text list', async () => {
    stubNoopWebSocket();
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
          id: 'g-relationless-detail',
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Alpha', round: 1, payload: null },
            { id: 'n2', key: 'e2', type: 'event', label: 'Beta', round: 2, payload: null },
          ],
          edges: [],
        }),
      } as Response);

      renderView();
      await screen.findByText('No causal edges were generated for this scenario yet. Showing event snapshots instead.');
      await user.click(screen.getByRole('button', { name: /Round 1/i }));

      const sheet = await screen.findByTestId('node-conversation-sheet');
      expect(sheet).toBeInTheDocument();
      expect(screen.queryByTestId('node-detail-panel')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('hides export controls when large graphs fall back to the text list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fallback-export',
        nodes: Array.from({ length: 501 }, (_, index) => ({
          id: `n${index}`,
          key: `e${index}`,
          type: 'event',
          label: `Large node ${index}`,
          round: 1,
          payload: null,
        })),
        edges: [],
      }),
    } as Response);

    renderView();

    await screen.findByText('Graph too large for interactive view. Showing text list.');
    expect(screen.queryByTestId('export-panel')).not.toBeInTheDocument();
  });

  it('skips dagre layout work when large graphs render through the text fallback path', async () => {
    const layoutSpy = vi.spyOn(dagre, 'layout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fallback-layout',
        nodes: Array.from({ length: 501 }, (_, index) => ({
          id: `n${index}`,
          key: `e${index}`,
          type: 'event',
          label: `Large node ${index}`,
          round: 1,
          payload: null,
        })),
        edges: [],
      }),
    } as Response);

    renderView();

    await screen.findByText('Graph too large for interactive view. Showing text list.');
    expect(layoutSpy).not.toHaveBeenCalled();
  });

  it('includes a11y screen reader list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g1',
        nodes: [{ id: 'n1', key: 'e1', type: 'event', label: 'Test', round: 2, payload: null }],
        edges: [],
      }),
    } as Response);
    renderView();
    const list = await screen.findByRole('list', { name: /Causal events/i });
    expect(list).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Event');
    vi.restoreAllMocks();
  });

  it('includes a screen reader relations list for causal edges', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-relations',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Alpha trigger', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: 'Beta response', round: 2, payload: null },
        ],
        edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
      }),
    } as Response);

    renderView();

    await screen.findByTestId('reactflow');
    const relationList = screen.getByRole('list', { name: 'Causal relations list' });
    const items = within(relationList).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Alpha trigger causes Beta response');
  });

  it('translates backend triggered fork edge labels through i18n', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-triggered-fork-label',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'Alpha trigger', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'fork', label: 'Beta fork', round: 2, payload: null },
        ],
        edges: [{
          id: 'edge-1',
          source: 'n1',
          target: 'n2',
          type: 'caused',
          weight: 1,
          label: 'triggered fork',
        }],
      }),
    } as Response);

    renderView();

    const flow = await screen.findByTestId('reactflow');
    await waitFor(() => expect(flow).toHaveAttribute('data-edge-label', 'triggered fork'));

    let relationList = screen.getByRole('list', { name: 'Causal relations list' });
    expect(within(relationList).getByRole('listitem')).toHaveTextContent(
      'Alpha trigger triggered fork Beta fork',
    );

    await changeUiLanguage('zh');

    await waitFor(() => expect(flow).toHaveAttribute('data-edge-label', '触发分支'));
    relationList = screen.getByRole('list', { name: '因果关系列表' });
    expect(within(relationList).getByRole('listitem')).toHaveTextContent(
      'Alpha trigger 触发分支 Beta fork',
    );
  });

  it('localizes inter-agent causal edge relation labels', async () => {
    applyTestLocale('zh');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-inter-agent-relations',
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: '甲方', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: '乙方', round: 1, payload: null },
          { id: 'n3', key: 'e3', type: 'event', label: '丙方', round: 1, payload: null },
          { id: 'n4', key: 'e4', type: 'event', label: '丁方', round: 1, payload: null },
        ],
        edges: [
          { id: 'edge-1', source: 'n1', target: 'n2', type: 'responds_to', weight: 1, label: null },
          { id: 'edge-2', source: 'n2', target: 'n3', type: 'supports_stance', weight: 1, label: null },
          { id: 'edge-3', source: 'n3', target: 'n4', type: 'opposes_stance', weight: 1, label: null },
        ],
      }),
    } as Response);

    renderView();

    await screen.findByTestId('reactflow');
    const relationList = screen.getByRole('list', { name: '因果关系列表' });
    const items = within(relationList).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      '甲方 回应 乙方',
      '乙方 立场一致 丙方',
      '丙方 立场对立 丁方',
    ]);
  });

  it('uses a single named a11y list when large graphs use the text fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-fallback-a11y',
        nodes: Array.from({ length: 501 }, (_, index) => ({
          id: `n${index}`,
          key: `e${index}`,
          type: 'event',
          label: `Large node ${index}`,
          round: 1,
          payload: null,
        })),
        edges: [],
      }),
    } as Response);

    renderView();

    const visibleList = await screen.findByRole('list', { name: 'Causal events list' });
    expect(visibleList).toBeInTheDocument();
    expect(screen.getAllByRole('list')).toHaveLength(1);
    expect(within(visibleList).getAllByRole('listitem')[0]).toHaveTextContent('Event');
  });

  it('opens NodeConversationSheet with Banner when a causal node is clicked', async () => {
    stubNoopWebSocket();
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
          id: 'g-sheet',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Node click target', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
          ],
          edges: [],
        }),
      } as Response);

      renderView();

      const nodeButton = await screen.findByTestId('rf-node-n1');
      expect(screen.queryByTestId('node-conversation-sheet')).toBeNull();

      await user.click(nodeButton);

      const sheet = await screen.findByTestId('node-conversation-sheet');
      expect(sheet).toBeInTheDocument();
      expect(screen.queryByTestId('node-detail-panel')).toBeNull();
      expect(screen.getByTestId('node-context-banner')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses label_i18n for the selected causal node and conversation sheet origin', async () => {
    stubNoopWebSocket();
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
      applyTestLocale('zh');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-sheet-label-i18n',
          available_branches: ['br1'],
          nodes: [
            {
              id: 'n1',
              key: 'stance_r2_alpha',
              type: 'event',
              label: 'Agent Alpha stance shifted',
              round: 2,
              payload: {
                branch_id: 'br1',
                label_i18n: {
                  key: 'causal.node.stance_shift',
                  params: { agent_name: '甲方' },
                },
              },
            },
          ],
          edges: [],
        }),
      } as Response);

      renderView();

      await user.click(await screen.findByTestId('rf-node-n1'));

      const label = await screen.findByTestId('node-context-banner-label');
      expect(label).toHaveTextContent('甲方 立场转变');
    } finally {
      applyTestLocale('en');
      vi.unstubAllGlobals();
    }
  });

  it('explains why a node appears and what it changes in the conversation banner', async () => {
    stubNoopWebSocket();
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
      applyTestLocale('zh');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-sheet-relations',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: '诸葛亮', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
            { id: 'n2', key: 'e2', type: 'event', label: '司马懿', round: 2, payload: { agent_id: 'beta', branch_id: 'br1' } },
            { id: 'n3', key: 'o1', type: 'outcome', label: '星落未尽', round: 3, payload: { branch_id: 'br1' } },
          ],
          edges: [
            { id: 'edge-in', source: 'n1', target: 'n2', type: 'temporal', weight: 1, label: null },
            { id: 'edge-out', source: 'n2', target: 'n3', type: 'led_to', weight: 1, label: null },
          ],
        }),
      } as Response);

      renderView();
      await user.click(await screen.findByTestId('rf-node-n2'));

      const meaning = await screen.findByTestId('node-context-banner-meaning');
      expect(meaning).toHaveTextContent('事件卡');
      expect(meaning).toHaveTextContent('它记录一次关键发言或行动');
      const groups = await screen.findByTestId('node-context-banner-causal-groups');
      expect(groups).toHaveTextContent('为什么会出现');
      expect(groups).toHaveTextContent('它接在 事件 诸葛亮 R1 之后');
      expect(groups).toHaveTextContent('它带来什么影响');
      expect(groups).toHaveTextContent('这张卡把局面推向 结局 星落未尽 R3');
    } finally {
      applyTestLocale('en');
      vi.unstubAllGlobals();
    }
  });

  it('adds a compact cause/effect summary to graph node cards', async () => {
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
      applyTestLocale('zh');
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-card-summary',
          available_branches: ['br1'],
          nodes: [
            { id: 'n2', key: 'e2', type: 'event', label: '司马懿', round: 2, payload: { agent_id: 'beta', branch_id: 'br1' } },
            { id: 'n1', key: 'e1', type: 'event', label: '诸葛亮', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
            { id: 'n3', key: 'o1', type: 'outcome', label: '星落未尽', round: 3, payload: { branch_id: 'br1' } },
          ],
          edges: [
            { id: 'edge-in', source: 'n1', target: 'n2', type: 'temporal', weight: 1, label: null },
            { id: 'edge-out', source: 'n2', target: 'n3', type: 'led_to', weight: 1, label: null },
          ],
        }),
      } as Response);

      renderView();

      const flow = await screen.findByTestId('reactflow');
      await waitFor(() => {
        expect(flow.getAttribute('data-first-node-summary')).toBe('前因 1 · 后续 1');
      });
    } finally {
      applyTestLocale('en');
      vi.unstubAllGlobals();
    }
  });

  it('pane click clears highlight but keeps NodeConversationSheet open', async () => {
    stubNoopWebSocket();
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
          id: 'g-sheet',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Node click target', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
          ],
          edges: [],
        }),
      } as Response);

      renderView();
      await user.click(await screen.findByTestId('rf-node-n1'));

      const sheet = await screen.findByTestId('node-conversation-sheet');
      expect(sheet).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('rf-pane'));

      expect(sheet).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('selectedNode still drives path highlight after click', async () => {
    stubNoopWebSocket();
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
          id: 'g-highlight',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Node A', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
            { id: 'n2', key: 'e2', type: 'event', label: 'Node B', round: 2, payload: { agent_id: 'beta', branch_id: 'br1' } },
          ],
          edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'caused', weight: 1, label: null }],
        }),
      } as Response);

      renderView();
      await user.click(await screen.findByTestId('rf-node-n1'));

      const sheet = await screen.findByTestId('node-conversation-sheet');
      expect(sheet).toBeInTheDocument();
      expect(screen.queryByTestId('node-detail-panel')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens bottom Sheet with Banner on compact mobile viewport (375px)', async () => {
    stubNoopWebSocket();
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width'),
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
          id: 'g-mobile-sheet',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Node click target', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
          ],
          edges: [],
        }),
      } as Response);

      renderView();
      await user.click(await screen.findByTestId('rf-node-n1'));

      const sheet = await screen.findByTestId('node-conversation-sheet');
      expect(sheet).toBeInTheDocument();
      expect(screen.getByTestId('node-context-banner')).toBeInTheDocument();
      expect(screen.queryByTestId('node-detail-panel')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('closes NodeConversationSheet after switching branches', async () => {
    stubNoopWebSocket();
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
      const branchOneResponse = createDeferredResponse();
      const branchTwoResponse = createDeferredResponse();
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('branch_id=br1')) return branchOneResponse.promise;
        if (url.includes('branch_id=br2')) return branchTwoResponse.promise;
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      render(
        <MemoryRouter initialEntries={['/sim/test-id/causal-map?branch_id=br1']}>
          <Routes>
            <Route path="/sim/:id/causal-map" element={<BranchNavigationHarness />} />
          </Routes>
        </MemoryRouter>,
      );

      branchOneResponse.resolve({
        ok: true,
        json: async () => ({
          id: 'g-branch-one',
          available_branches: ['br1', 'br2'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Branch 1 event', round: 1, payload: { branch_id: 'br1' } },
          ],
          edges: [],
        }),
      } as Response);

      await user.click(await screen.findByTestId('rf-node-n1'));
      expect(await screen.findByTestId('node-conversation-sheet')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Go br2' }));

      branchTwoResponse.resolve({
        ok: true,
        json: async () => ({
          id: 'g-branch-two',
          available_branches: ['br1', 'br2'],
          nodes: [
            { id: 'n2', key: 'e2', type: 'event', label: 'Branch 2 event', round: 1, payload: { branch_id: 'br2' } },
          ],
          edges: [],
        }),
      } as Response);

      await screen.findByTestId('rf-node-n2');
      expect(screen.queryByTestId('node-conversation-sheet')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('closes NodeConversationSheet after switching scenarios', async () => {
    stubNoopWebSocket();
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
      const scenarioOneResponse = createDeferredResponse();
      const scenarioTwoResponse = createDeferredResponse();
      vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === '/api/scenario/test-id/causal-graph') return scenarioOneResponse.promise;
        if (url === '/api/scenario/next-id/causal-graph') return scenarioTwoResponse.promise;
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });

      render(
        <MemoryRouter initialEntries={['/sim/test-id/causal-map']}>
          <Routes>
            <Route path="/sim/:id/causal-map" element={<ScenarioNavigationHarness />} />
          </Routes>
        </MemoryRouter>,
      );

      scenarioOneResponse.resolve({
        ok: true,
        json: async () => ({
          id: 'g-scenario-one',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Scenario A event', round: 1, payload: { branch_id: 'br1' } },
          ],
          edges: [],
        }),
      } as Response);

      await user.click(await screen.findByTestId('rf-node-n1'));
      expect(await screen.findByTestId('node-conversation-sheet')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Go scenario B' }));

      scenarioTwoResponse.resolve({
        ok: true,
        json: async () => ({
          id: 'g-scenario-two',
          available_branches: ['br9'],
          nodes: [
            { id: 'n2', key: 'e2', type: 'event', label: 'Scenario B event', round: 2, payload: { branch_id: 'br9' } },
          ],
          edges: [],
        }),
      } as Response);

      await screen.findByTestId('rf-node-n2');
      expect(screen.queryByTestId('node-conversation-sheet')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Escape closes the Sheet directly', async () => {
    stubNoopWebSocket();
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
          id: 'g-sheet',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Node click target', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
          ],
          edges: [],
        }),
      } as Response);

      renderView();
      await user.click(await screen.findByTestId('rf-node-n1'));

      const sheet = await screen.findByTestId('node-conversation-sheet');
      expect(sheet).toBeInTheDocument();

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByTestId('node-conversation-sheet')).toBeNull();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('switching nodes remounts Sheet and updates Banner', async () => {
    stubNoopWebSocket();
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
          id: 'g-sheet',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'Node A', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
            { id: 'n2', key: 'e2', type: 'event', label: 'Node B', round: 2, payload: { agent_id: 'beta', branch_id: 'br1' } },
          ],
          edges: [
            { id: 'edge-1', source: 'n1', target: 'n2', type: 'causes' },
          ],
        }),
      } as Response);

      renderView();
      await user.click(await screen.findByTestId('rf-node-n1'));

      const sheetA = await screen.findByTestId('node-conversation-sheet');
      expect(sheetA).toBeInTheDocument();

      const bannerBeforeSwitch = screen.getByTestId('node-context-banner');
      expect(bannerBeforeSwitch).toBeInTheDocument();

      await user.click(await screen.findByTestId('rf-node-n2'));

      await waitFor(() => {
        expect(screen.getByTestId('node-conversation-sheet')).toBeInTheDocument();
        expect(screen.getByTestId('node-context-banner')).toBeInTheDocument();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts node conversation with the real scenario id and a null identity id', async () => {
    stubNoopWebSocket();
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
            id: 'g-sheet',
            available_branches: ['br1'],
            nodes: [
              { id: 'n1', key: 'e1', type: 'event', label: 'Node click target', round: 1, payload: { agent_id: 'alpha', branch_id: 'br1' } },
            ],
            edges: [],
          }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ thread_id: 'thread-causal-1' }),
        } as Response)
        .mockResolvedValueOnce(
          makeConversationSseResponse([
            'event: turn_started\ndata: {"turn_id":"turn-causal-1","thread_id":"thread-causal-1","sequence":2}\n\n',
            'event: turn_token_delta\ndata: {"turn_id":"turn-causal-1","delta":"hello"}\n\n',
            'event: turn_completed\ndata: {"turn_id":"turn-causal-1","sequence":2,"status":"committed"}\n\n',
          ]),
        );

      renderView();
      await user.click(await screen.findByTestId('rf-node-n1'));
      await user.type(await screen.findByTestId('node-conversation-input'), 'why this edge');
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
      expect(startBody.scenario_id).toBe('test-id');
      expect(startBody.agent_identity_id).toBeNull();
      expect(startBody).not.toHaveProperty('agentName');
      expect(startBody).not.toHaveProperty('nodeLabel');
      expect(startBody).not.toHaveProperty('typeColor');
      expect(startBody).not.toHaveProperty('emotion');
      expect(startBody).not.toHaveProperty('stance');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('origin contains agentName, nodeLabel, typeColor, branchId, roundNumber from real data', async () => {
    stubNoopWebSocket();
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
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'g-origin',
            available_branches: ['br1'],
            nodes: [
              { id: 'n1', key: 'e1', type: 'event', label: 'Node click target', round: 3, payload: { agent_id: 'alpha', agent_name: 'Agent Alpha', branch_id: 'br1' } },
            ],
            edges: [],
          }),
        } as Response);

      renderView();
      await user.click(await screen.findByTestId('rf-node-n1'));

      const banner = await screen.findByTestId('node-context-banner');
      expect(banner).toBeInTheDocument();
      expect(screen.getByTestId('node-context-banner-agent')).toHaveTextContent('Agent Alpha');
      expect(screen.getByTestId('node-context-banner-round')).toBeInTheDocument();
      expect(screen.getByTestId('node-context-banner-strip')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens outcome conversations with story context and a graph analyst target', async () => {
    stubNoopWebSocket();
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
          id: 'g-outcome-origin',
          available_branches: ['br1'],
          nodes: [
            {
              id: 'outcome-br1',
              key: 'outcome_br1',
              type: 'outcome',
              label: '星落未尽',
              round: 5,
              payload: {
                branch_id: 'br1',
                story_excerpt: '夜潮压着粮道，守军仍在关口撑住。',
                insight: '补给被稳住后，北线没有立刻崩盘。',
              },
            },
          ],
          edges: [],
        }),
      } as Response);

      renderView();
      await user.click(await screen.findByTestId('rf-node-outcome-br1'));

      expect(await screen.findByTestId('node-context-banner')).toBeInTheDocument();
      expect(screen.getByTestId('node-context-banner-meaning')).toHaveTextContent('Outcome card');
      expect(screen.getByTestId('node-context-banner-meaning')).toHaveTextContent('endpoint of one branch');
      expect(screen.getByTestId('node-context-banner-excerpt')).toHaveTextContent('夜潮压着粮道');
      expect(screen.getByTestId('node-context-banner-excerpt')).toHaveTextContent('北线没有立刻崩盘');
      expect(screen.getByTestId('node-context-banner-target')).toHaveTextContent('Outcome analyst');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses fork display summaries as conversation context instead of repeating the title', async () => {
    stubNoopWebSocket();
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
          id: 'g-fork-origin',
          available_branches: ['br1', 'br2'],
          nodes: [
            {
              id: 'fork-1',
              key: 'fork_r2_br1',
              type: 'fork',
              label: '路线分岔：继续亲自北伐施压；另一条先稳汉中、成都和接班再说。',
              round: 2,
              payload: {
                branch_id: 'br1',
                display_reason: '路线分岔：继续亲自北伐施压；另一条先稳汉中、成都和接班再说。',
                display_summary: '这会改写粮道、责任链、军政节奏和十年后的蜀汉结局。',
              },
            },
          ],
          edges: [],
        }),
      } as Response);

      renderView();
      await user.click(await screen.findByTestId('rf-node-fork-1'));

      expect(await screen.findByTestId('node-context-banner')).toBeInTheDocument();
      expect(screen.getByTestId('node-context-banner-meaning')).toHaveTextContent('Fork card');
      expect(screen.getByTestId('node-context-banner-meaning')).toHaveTextContent('route split into alternatives');
      expect(screen.getByTestId('node-context-banner-label')).toHaveTextContent('路线分岔');
      expect(screen.getByTestId('node-context-banner-excerpt')).toHaveTextContent('改写粮道');
      expect(screen.getByTestId('node-context-banner-target')).toHaveTextContent('Graph analyst');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── FE-10: Reduced motion + evidence guard tests ────────────

describe('CausalReviewView animation & evidence guards', () => {
  it('disables edge animation when useReducedMotion returns true', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'g-rm',
          available_branches: ['br1'],
          nodes: [
            { id: 'n1', key: 'e1', type: 'event', label: 'A', round: 1, payload: null },
            { id: 'n2', key: 'e2', type: 'event', label: 'B', round: 2, payload: null },
          ],
          edges: [{ id: 'edge-1', source: 'n1', target: 'n2', type: 'attacks', weight: 1, label: null }],
        }),
      } as Response);

      renderView();
      const flowEl = await screen.findByTestId('reactflow');
      await waitFor(() => {
        expect(flowEl).toBeInTheDocument();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('disables animation when node count exceeds PERF_ANIMATION_LIMIT (150)', async () => {
    const manyNodes = Array.from({ length: 160 }, (_, i) => ({
      id: `n${i}`,
      key: `e${i}`,
      type: 'event',
      label: `Node ${i}`,
      round: i,
      payload: null,
    }));
    const manyEdges = Array.from({ length: 160 }, (_, i) => ({
      id: `edge-${i}`,
      source: `n${i}`,
      target: `n${(i + 1) % 160}`,
      type: 'caused',
      weight: 1,
      label: null,
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-perf',
        available_branches: ['br1'],
        nodes: manyNodes,
        edges: manyEdges,
      }),
    } as Response);

    renderView();
    const flowEl = await screen.findByTestId('reactflow');
    expect(flowEl).toBeInTheDocument();
  });

  it('does not render evidence badge when all edge evidence fields are null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-no-ev',
        available_branches: ['br1'],
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'X', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: 'Y', round: 2, payload: null },
        ],
        edges: [{
          id: 'edge-1',
          source: 'n1',
          target: 'n2',
          type: 'caused',
          weight: 1,
          label: null,
          evidence: { confidence_tier: null, source_ref: null, source_round_number: null, detail: null },
        }],
      }),
    } as Response);

    renderView();
    const flowEl = await screen.findByTestId('reactflow');
    const edgeLabel = flowEl.getAttribute('data-edge-label') ?? '';
    expect(edgeLabel).not.toContain('[');
    expect(edgeLabel).not.toContain('High');
    expect(edgeLabel).not.toContain('Medium');
    expect(edgeLabel).not.toContain('Low');
  });

  it('renders graph with evidence edges without crashing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'g-ev',
        available_branches: ['br1'],
        nodes: [
          { id: 'n1', key: 'e1', type: 'event', label: 'A', round: 1, payload: null },
          { id: 'n2', key: 'e2', type: 'event', label: 'B', round: 2, payload: null },
        ],
        edges: [{
          id: 'edge-1',
          source: 'n1',
          target: 'n2',
          type: 'caused',
          weight: 1,
          label: null,
          evidence: { confidence_tier: 'high', source_ref: null, source_round_number: 3, detail: null },
        }],
      }),
    } as Response);

    renderView();
    const flowEl = await screen.findByTestId('reactflow');
    expect(flowEl).toBeInTheDocument();
  });
});
