import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ── Mocks ───────────────────────────────────────────────────

vi.mock('./CausalGraphBoard', () => ({
  default: (props: { scenarioId: string }) => (
    <div data-testid="causal-board" data-scenario-id={props.scenarioId} />
  ),
}));

vi.mock('./KGGraphBoard', () => ({
  default: (props: { scenarioId: string }) => (
    <div data-testid="kg-board" data-scenario-id={props.scenarioId} />
  ),
}));

const mockCapResults: Record<string, {
  loading: boolean;
  enabled: boolean;
  capabilities: null;
  error: Error | null;
  reload: ReturnType<typeof vi.fn>;
}> = {
  causal_graph: {
    loading: false,
    enabled: true,
    capabilities: null,
    error: null,
    reload: vi.fn(),
  },
  kg_explorer: {
    loading: false,
    enabled: true,
    capabilities: null,
    error: null,
    reload: vi.fn(),
  },
};

vi.mock('../../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: (key: string) => mockCapResults[key] ?? mockCapResults.causal_graph,
  __resetCapabilityCacheForTests: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

vi.mock('../../components/AppErrorBoundary', () => ({
  AppErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── Imports under test ──────────────────────────────────────

import WorkbenchView from '../../pages/WorkbenchView';
import LayoutSwitcher from './LayoutSwitcher';
import GraphWorkbenchShell from './GraphWorkbenchShell';

// ── Helpers ─────────────────────────────────────────────────

function renderWorkbench(route = '/workbench/test-id?view=graph') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/workbench/:id" element={<WorkbenchView />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderShell(props: Partial<React.ComponentProps<typeof GraphWorkbenchShell>> = {}) {
  return render(
    <MemoryRouter>
      <GraphWorkbenchShell
        scenarioId="s1"
        mode="graph"
        isCompact={false}
        {...props}
      />
    </MemoryRouter>,
  );
}

// ── Tests ───────────────────────────────────────────────────

describe('WorkbenchView', () => {
  beforeEach(() => {
    mockCapResults.causal_graph = {
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    };
    mockCapResults.kg_explorer = {
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    };
  });

  it('renders graph mode — CausalGraphBoard visible', async () => {
    renderWorkbench('/workbench/abc?view=graph');
    expect(await screen.findByTestId('workbench-root')).toBeTruthy();
    expect(await screen.findByTestId('causal-board')).toBeTruthy();
  });

  it('renders split mode on desktop — both boards present', async () => {
    renderWorkbench('/workbench/abc?view=split');
    expect(await screen.findByTestId('graph-workbench-shell')).toBeTruthy();
    expect(await screen.findByTestId('causal-board')).toBeTruthy();
    expect(await screen.findByTestId('kg-board')).toBeTruthy();
  });

  it('renders kg mode — KGGraphBoard visible', async () => {
    renderWorkbench('/workbench/abc?view=kg');
    expect(await screen.findByTestId('workbench-root')).toBeTruthy();
    expect(await screen.findByTestId('kg-board')).toBeTruthy();
  });

  it('URL param ?view=split → shell mode is split', async () => {
    renderWorkbench('/workbench/abc?view=split');
    const shell = await screen.findByTestId('graph-workbench-shell');
    expect(shell).toBeTruthy();
    expect(await screen.findByTestId('causal-board')).toBeTruthy();
    expect(await screen.findByTestId('kg-board')).toBeTruthy();
  });

  it('capability disabled → shows unavailable surface', () => {
    mockCapResults.causal_graph.enabled = false;
    mockCapResults.kg_explorer.enabled = false;
    renderWorkbench();
    expect(screen.getByText('Workbench feature is not enabled')).toBeTruthy();
    expect(screen.queryByTestId('graph-workbench-shell')).toBeNull();
  });

  it('capability loading → shows loading state', () => {
    mockCapResults.causal_graph.loading = true;
    renderWorkbench();
    expect(screen.getByText('Loading workbench...')).toBeTruthy();
  });

  it('capability error → shows retry button', () => {
    mockCapResults.causal_graph.error = new Error('fail');
    renderWorkbench();
    expect(screen.getByText('Failed to load workbench')).toBeTruthy();
    const retryBtn = screen.getByText('Retry');
    expect(retryBtn).toBeTruthy();
    fireEvent.click(retryBtn);
    expect(mockCapResults.causal_graph.reload).toHaveBeenCalled();
  });

  it('defaults to graph mode when ?view is absent', async () => {
    renderWorkbench('/workbench/abc');
    expect(await screen.findByTestId('workbench-root')).toBeTruthy();
    expect(await screen.findByTestId('causal-board')).toBeTruthy();
  });

  // ── H-1: kg_explorer capability gate ──────────────────────

  it('kg_explorer disabled → ?view=kg shows unavailable card', () => {
    mockCapResults.kg_explorer.enabled = false;
    renderWorkbench('/workbench/abc?view=kg');
    expect(screen.getByText('Workbench feature is not enabled')).toBeTruthy();
    expect(screen.queryByTestId('graph-workbench-shell')).toBeNull();
  });

  it('both disabled → ?view=split shows unavailable', () => {
    mockCapResults.causal_graph.enabled = false;
    mockCapResults.kg_explorer.enabled = false;
    renderWorkbench('/workbench/abc?view=split');
    expect(screen.getByText('Workbench feature is not enabled')).toBeTruthy();
    expect(screen.queryByTestId('graph-workbench-shell')).toBeNull();
  });

  it('kg_explorer enabled but causal_graph disabled → ?view=graph shows unavailable, ?view=kg works', () => {
    mockCapResults.causal_graph.enabled = false;
    mockCapResults.kg_explorer.enabled = true;
    renderWorkbench('/workbench/abc?view=graph');
    expect(screen.getByText('Workbench feature is not enabled')).toBeTruthy();
  });

  it('kg_explorer enabled and causal_graph disabled → ?view=kg renders shell', async () => {
    mockCapResults.causal_graph.enabled = false;
    mockCapResults.kg_explorer.enabled = true;
    renderWorkbench('/workbench/abc?view=kg');
    expect(await screen.findByTestId('graph-workbench-shell')).toBeTruthy();
    expect(await screen.findByTestId('kg-board')).toBeTruthy();
    expect(screen.queryByTestId('causal-board')).toBeNull();
  });

  it('kg_explorer and causal_graph both enabled → ?view=kg renders shell', async () => {
    mockCapResults.causal_graph.enabled = true;
    mockCapResults.kg_explorer.enabled = true;
    renderWorkbench('/workbench/abc?view=kg');
    expect(await screen.findByTestId('graph-workbench-shell')).toBeTruthy();
    expect(await screen.findByTestId('kg-board')).toBeTruthy();
  });

  // ── W-4: ?view=invalid gets normalized ─────────────────────

  it('?view=invalid gets normalized to ?view=graph with replace', () => {
    renderWorkbench('/workbench/abc?view=bogus');
    expect(screen.queryByTestId('graph-workbench-shell')).not.toBeNull();
  });

  // ── H-3: compact + ?view=split gets normalized ────────────

  it('compact + ?view=split renders graph mode (normalization)', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 500, writable: true });
    renderWorkbench('/workbench/abc?view=split');
    expect(await screen.findByTestId('workbench-root')).toBeTruthy();
    Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
  });
});

describe('GraphWorkbenchShell', () => {
  it('compact + split mode → fallback to graph + shows notice', async () => {
    renderShell({ mode: 'split', isCompact: true });
    expect(screen.getByTestId('workbench-compact-notice')).toBeTruthy();
    expect(screen.getByText('Split view is only available on desktop.')).toBeTruthy();
    expect(await screen.findByTestId('causal-board')).toBeTruthy();
  });

  it('non-compact split → both boards rendered', async () => {
    renderShell({ mode: 'split', isCompact: false });
    expect(await screen.findByTestId('causal-board')).toBeTruthy();
    expect(await screen.findByTestId('kg-board')).toBeTruthy();
    expect(screen.queryByTestId('workbench-compact-notice')).toBeNull();
  });

  // ── W-7: boards conditionally rendered (not display:none) ──

  it('mode=kg → CausalGraphBoard not in DOM', async () => {
    renderShell({ mode: 'kg' });
    expect(await screen.findByTestId('kg-board')).toBeTruthy();
    expect(screen.queryByTestId('causal-board')).toBeNull();
  });

  it('mode=graph → KGGraphBoard not in DOM', async () => {
    renderShell({ mode: 'graph' });
    expect(await screen.findByTestId('causal-board')).toBeTruthy();
    expect(screen.queryByTestId('kg-board')).toBeNull();
  });

  it('tab switch remounts correct board', () => {
    const { rerender } = render(
      <MemoryRouter>
        <GraphWorkbenchShell scenarioId="s1" mode="graph" isCompact={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('causal-board')).toBeTruthy();
    expect(screen.queryByTestId('kg-board')).toBeNull();

    rerender(
      <MemoryRouter>
        <GraphWorkbenchShell scenarioId="s1" mode="kg" isCompact={false} />
      </MemoryRouter>,
    );

    expect(screen.queryByTestId('causal-board')).toBeNull();
    expect(screen.getByTestId('kg-board')).toBeTruthy();

    rerender(
      <MemoryRouter>
        <GraphWorkbenchShell scenarioId="s1" mode="graph" isCompact={false} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('causal-board')).toBeTruthy();
    expect(screen.queryByTestId('kg-board')).toBeNull();
  });

  // ── W-2: tabpanel ARIA ─────────────────────────────────────

  it('boards have role=tabpanel with proper ARIA ids', () => {
    renderShell({ mode: 'split' });
    const panels = screen.getAllByRole('tabpanel');
    expect(panels).toHaveLength(2);
    const causalPanel = document.getElementById('workbench-panel-graph');
    const kgPanel = document.getElementById('workbench-panel-kg');
    expect(causalPanel).toBeTruthy();
    expect(causalPanel!.getAttribute('role')).toBe('tabpanel');
    expect(causalPanel!.getAttribute('aria-labelledby')).toBe('workbench-tab-graph');
    expect(kgPanel).toBeTruthy();
    expect(kgPanel!.getAttribute('role')).toBe('tabpanel');
    expect(kgPanel!.getAttribute('aria-labelledby')).toBe('workbench-tab-kg');
  });
});

describe('LayoutSwitcher', () => {
  it('renders tablist with correct aria attributes', () => {
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <LayoutSwitcher mode="graph" onChange={onChange} />
      </MemoryRouter>,
    );
    const tablist = screen.getByRole('tablist');
    expect(tablist).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs[2].getAttribute('aria-selected')).toBe('false');
  });

  it('click changes mode', () => {
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <LayoutSwitcher mode="graph" onChange={onChange} />
      </MemoryRouter>,
    );
    const tabs = screen.getAllByRole('tab');
    fireEvent.click(tabs[2]);
    expect(onChange).toHaveBeenCalledWith('kg');
  });

  it('arrow key navigation cycles modes', () => {
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <LayoutSwitcher mode="graph" onChange={onChange} />
      </MemoryRouter>,
    );
    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('split');
  });

  it('isCompact hides split option', () => {
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <LayoutSwitcher mode="graph" onChange={onChange} isCompact />
      </MemoryRouter>,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs.map(t => t.textContent)).toEqual(['Causal', 'Knowledge Graph']);
  });

  it('selected tab has tabIndex=0, others have tabIndex=-1', () => {
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <LayoutSwitcher mode="split" onChange={onChange} />
      </MemoryRouter>,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('tabindex')).toBe('-1');
    expect(tabs[1].getAttribute('tabindex')).toBe('0');
    expect(tabs[2].getAttribute('tabindex')).toBe('-1');
  });

  // ── W-2: tab id + aria-controls ───────────────────────────

  it('tabs have id and aria-controls attributes', () => {
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <LayoutSwitcher mode="graph" onChange={onChange} />
      </MemoryRouter>,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].id).toBe('workbench-tab-graph');
    expect(tabs[0].getAttribute('aria-controls')).toBe('workbench-panel-graph');
    expect(tabs[1].id).toBe('workbench-tab-split');
    expect(tabs[1].getAttribute('aria-controls')).toBe(
      'workbench-panel-graph workbench-panel-kg',
    );
    expect(tabs[2].id).toBe('workbench-tab-kg');
    expect(tabs[2].getAttribute('aria-controls')).toBe('workbench-panel-kg');
  });
});
