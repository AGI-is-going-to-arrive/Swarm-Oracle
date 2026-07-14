/**
 * Phase 3 F5 — FactionTimeline tests
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next, { type i18n as I18nInstance } from 'i18next';
import { type ComponentProps } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '../i18n/locales/en.json';
import zh from '../i18n/locales/zh.json';
import { FactionTimeline } from './FactionTimeline';

type FactionForceGraphMockProps = {
  scenarioId: string;
  branchId: string;
  factions: Array<{ key: string; members: string[]; label?: string }>;
  totalRounds: number;
  agentNames?: Record<string, string>;
};

const mockFactionForceGraphProps = vi.hoisted(() => [] as FactionForceGraphMockProps[]);

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: vi.fn(() => ({ loading: false, enabled: true, capabilities: null, error: null })),
}));

vi.mock('./FactionForceGraph', () => ({
  FactionForceGraph: (props: FactionForceGraphMockProps) => {
    mockFactionForceGraphProps.push(props);
    return (
      <div
        data-testid="faction-force-graph-mock"
        data-scenario-id={props.scenarioId}
        data-branch-id={props.branchId}
        data-total-rounds={props.totalRounds}
      />
    );
  },
}));

const mockUseCapabilityCheck = vi.mocked(
  (await import('../hooks/useCapabilityCheck')).useCapabilityCheck,
);

type TestLanguage = 'en' | 'zh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => JSON.stringify(body),
  } as Response;
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

const localeExpectations = {
  en: {
    title: 'Faction Timeline',
    empty: 'Factions need a longer run to form alliances and splits. Try a deeper simulation to reveal their evolution.',
    a11yLabel: 'Faction evolution timeline',
    roundLabel: 'Round 1',
    branchScope: 'Branch scope: Archive Branch',
    selectedSource: 'Selected branch: Archive Branch',
    ancestorSource: 'Ancestor/source branch: ancestor…1234',
    unknownSource: 'Source branch unavailable',
    lineageScope: "This timeline follows the selected branch's effective lineage. Earlier rounds may come from a parent branch; replay branches may be self-contained. Sibling and unrelated source branches are excluded.",
    roundSpan: 'Round span: Round 1',
    membersSummary: '2 members',
    stanceSummary: 'Affect proxy 0.12',
    confidenceSummary: 'Group share 0.50',
    betrayal: 'Affect shift (proxy)',
    allianceFormed: 'alliance formed',
    actor: 'Actor a1',
    faction: 'Faction Moderates',
    unknownEvent: 'Unknown event',
    unknownType: 'Type shadow merger',
    fallbackMetric: 'Affect proxy —',
    disclosure: 'Derived from model-generated emotion/diverge fields; not verified trust, relationships, or stances.',
  },
  zh: {
    title: '阵营时间线',
    empty: '阵营需要更长的推演才会形成结盟与分裂。尝试运行更深入的模拟来观察它们的演化。',
    a11yLabel: '阵营演化时间线',
    roundLabel: '第 1 轮',
    branchScope: '分支范围: Archive Branch',
    selectedSource: '所选分支：Archive Branch',
    ancestorSource: '祖先/来源分支：ancestor…1234',
    unknownSource: '来源分支不可用',
    lineageScope: '此时间线展示所选分支的有效谱系。较早轮次可能来自父分支；回放分支也可能是自包含的。兄弟分支和无关源分支不在此范围内。',
    roundSpan: '轮次跨度: 第 1 轮',
    membersSummary: '2 名成员',
    stanceSummary: '情绪代理值 0.12',
    confidenceSummary: '群体占比 0.50',
    betrayal: '情绪变化（代理）',
    allianceFormed: '结盟',
    actor: '行动者 a1',
    faction: '阵营 Moderates',
    unknownEvent: '未知事件',
    unknownType: '类型 shadow merger',
    fallbackMetric: '情绪代理值 —',
    disclosure: '由模型生成的 emotion/diverge 字段推导；不是已验证的信任、关系或立场。',
  },
} satisfies Record<TestLanguage, {
  title: string;
  empty: string;
  a11yLabel: string;
  roundLabel: string;
  branchScope: string;
  selectedSource: string;
  ancestorSource: string;
  unknownSource: string;
  lineageScope: string;
  roundSpan: string;
  membersSummary: string;
  stanceSummary: string;
  confidenceSummary: string;
  betrayal: string;
  allianceFormed: string;
  actor: string;
  faction: string;
  unknownEvent: string;
  unknownType: string;
  fallbackMetric: string;
  disclosure: string;
}>;

async function createTestI18n(language: TestLanguage): Promise<I18nInstance> {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    resources: {
      en,
      zh,
    },
    interpolation: {
      escapeValue: false,
    },
  });
  return instance;
}

async function renderFactionTimeline(language: TestLanguage, props?: Partial<ComponentProps<typeof FactionTimeline>>) {
  const i18n = await createTestI18n(language);
  return render(
    <I18nextProvider i18n={i18n}>
      <FactionTimeline scenarioId="sc1" branchId="b1" branchLabel="Archive Branch" visible={true} {...props} />
    </I18nextProvider>,
  );
}

afterEach(() => {
  mockFactionForceGraphProps.length = 0;
  cleanup();
  vi.restoreAllMocks();
});

describe('FactionTimeline', () => {
  it('defines the required faction timeline locale keys in both resource files', () => {
    expect(en.translation.factions.title).toBe(localeExpectations.en.title);
    expect(zh.translation.factions.title).toBe(localeExpectations.zh.title);
    expect(en.translation.factions.empty).toBe(localeExpectations.en.empty);
    expect(zh.translation.factions.empty).toBe(localeExpectations.zh.empty);
    expect(en.translation.factions.a11y_label).toBe(localeExpectations.en.a11yLabel);
    expect(zh.translation.factions.a11y_label).toBe(localeExpectations.zh.a11yLabel);
    expect(en.translation.factions.round_label).toBe('Round {{round}}');
    expect(zh.translation.factions.round_label).toBe('第 {{round}} 轮');
    expect(en.translation.factions.badge_title).toBe('{{label}}: {{count}} members, affect proxy {{stance}}');
    expect(zh.translation.factions.badge_title).toBe('{{label}}：{{count}} 名成员，情绪代理值 {{stance}}');
    expect(en.translation.factions.event_labels.betrayal).toBe(localeExpectations.en.betrayal);
    expect(zh.translation.factions.event_labels.betrayal).toBe(localeExpectations.zh.betrayal);
    expect(en.translation.factions.event_labels.alliance_formed).toBe(localeExpectations.en.allianceFormed);
    expect(zh.translation.factions.event_labels.alliance_formed).toBe(localeExpectations.zh.allianceFormed);
    expect(en.translation.factions.source_selected).toBe('Selected branch: {{branch}}');
    expect(zh.translation.factions.source_selected).toBe('所选分支：{{branch}}');
    expect(en.translation.factions.source_ancestor).toBe('Ancestor/source branch: {{branch}}');
    expect(zh.translation.factions.source_ancestor).toBe('祖先/来源分支：{{branch}}');
    expect(en.translation.factions.source_unknown).toBe(localeExpectations.en.unknownSource);
    expect(zh.translation.factions.source_unknown).toBe(localeExpectations.zh.unknownSource);
    expect(en.translation.factions.scope_branch_lineage).toBe(localeExpectations.en.lineageScope);
    expect(zh.translation.factions.scope_branch_lineage).toBe(localeExpectations.zh.lineageScope);
  });

  it('returns null when not visible', async () => {
    const { container } = await renderFactionTimeline('en', { visible: false });
    expect(container.innerHTML).toBe('');
  });

  it('shows loading state while fetching', async () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(new Promise(() => {}));
    await renderFactionTimeline('en');
    expect(screen.getByText(en.translation.common.loading)).toBeInTheDocument();
  });

  it.each([
    ['en', localeExpectations.en.empty],
    ['zh', localeExpectations.zh.empty],
  ] as const)('shows localized empty state in %s', async (language, expectedEmpty) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));

    await renderFactionTimeline(language);

    expect(await screen.findByText(expectedEmpty)).toBeInTheDocument();
  });

  it('shows a retryable error state when fetching the timeline fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse([]));

    await renderFactionTimeline('en');

    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to load the faction timeline right now. Please retry.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(localeExpectations.en.empty)).toBeInTheDocument();
  });

  it.each([
    ['en', localeExpectations.en],
    ['zh', localeExpectations.zh],
  ] as const)('renders localized title, scope framing, visible faction stats, and event details in %s', async (language, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
        {
          round: 1,
          branch_id: 'b1',
          scope_kind: 'branch_lineage',
          scope_caveat: 'Raw server scope prose must not be displayed.',
          factions: [
            { key: 'moderates', label: 'Moderates', members: ['a1', 'a2'], stance_center: 0.123, confidence: 0.5 },
          ],
          events: [
            { type: 'betrayal', actor_agent_id: 'a1', faction_key: 'moderates' },
            { type: 'alliance_formed', actor_agent_id: 'a2', faction_key: 'moderates' },
          ],
        },
      ]));

    await renderFactionTimeline(language);

    expect(await screen.findByRole('heading', { name: expected.title })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: expected.a11yLabel })).toBeInTheDocument();
    expect(screen.getByText(expected.roundLabel)).toBeInTheDocument();
    expect(screen.getByText(expected.branchScope)).toBeInTheDocument();
    expect(screen.getByText(expected.selectedSource)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(expected.lineageScope);
    expect(screen.queryByText('Raw server scope prose must not be displayed.')).toBeNull();
    expect(screen.getByText(expected.roundSpan)).toBeInTheDocument();
    expect(screen.getByText(expected.membersSummary)).toBeInTheDocument();
    expect(screen.getByText(expected.stanceSummary)).toBeInTheDocument();
    expect(screen.getByText(expected.confidenceSummary)).toBeInTheDocument();
    expect(screen.getByText(expected.disclosure)).toBeInTheDocument();
    expect(screen.getByText(expected.betrayal)).toBeInTheDocument();
    expect(screen.getByText(expected.allianceFormed)).toBeInTheDocument();
    expect(screen.getByText(expected.actor)).toBeInTheDocument();
    expect(screen.getAllByText(expected.faction)).toHaveLength(2);
  });

  it.each([
    ['en', localeExpectations.en],
    ['zh', localeExpectations.zh],
  ] as const)('shows truthful selected and ancestor round sources in %s', async (language, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
      {
        round: 1,
        branch_id: 'ancestor-branch-1234',
        scope_kind: 'branch_lineage',
        scope_caveat: 'Server-authored English must stay hidden.',
        factions: [
          { key: 'root-faction', label: 'Root Faction', members: ['a1'], affect_center: 0.1, member_share: 0.5 },
        ],
        events: [],
      },
      {
        round: 3,
        branch_id: 'b1',
        scope_kind: 'branch_lineage',
        scope_caveat: 'Server-authored English must stay hidden.',
        factions: [
          { key: 'child-faction', label: 'Child Faction', members: ['a2'], affect_center: 0.2, member_share: 0.5 },
        ],
        events: [],
      },
    ]));

    await renderFactionTimeline(language);

    expect(await screen.findByText(expected.ancestorSource)).toBeInTheDocument();
    expect(screen.getByText(expected.selectedSource)).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(expected.lineageScope);
    expect(screen.queryByText('Server-authored English must stay hidden.')).toBeNull();
  });

  it('keeps a self-contained replay timeline labeled only as the selected branch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
      {
        round: 1,
        branch_id: 'replay-branch',
        scope_kind: 'branch_lineage',
        scope_caveat: 'Self-contained replay scope.',
        factions: [
          { key: 'replay-faction', label: 'Replay Faction', members: ['a1'], affect_center: 0.1, member_share: 1 },
        ],
        events: [],
      },
    ]));

    await renderFactionTimeline('en', {
      branchId: 'replay-branch',
      branchLabel: 'Replay Clone',
    });

    expect(await screen.findByText('Selected branch: Replay Clone')).toBeInTheDocument();
    expect(screen.queryByText(/Ancestor\/source branch:/)).toBeNull();
  });

  it('uses a short selected branch id when its label is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
      {
        round: 1,
        branch_id: 'selected-branch-5678',
        scope_kind: 'branch_lineage',
        factions: [
          { key: 'selected-faction', label: 'Selected Faction', members: ['a1'], affect_center: 0, member_share: 1 },
        ],
        events: [],
      },
    ]));

    await renderFactionTimeline('en', {
      branchId: 'selected-branch-5678',
      branchLabel: null,
    });

    expect(await screen.findByText('Selected branch: selected…5678')).toBeInTheDocument();
  });

  it('renders malformed round branch metadata safely without relabeling it as selected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
      {
        round: 1,
        branch_id: { unexpected: true },
        scope_kind: 'branch_lineage',
        factions: [
          { key: 'unknown-faction', label: 'Unknown Faction', members: ['a1'], affect_center: 0, member_share: 1 },
        ],
        events: [],
      },
    ]));

    await renderFactionTimeline('en');

    expect(await screen.findByText(localeExpectations.en.unknownSource)).toBeInTheDocument();
    expect(screen.queryByText(localeExpectations.en.selectedSource)).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['legacy', 'branch_segment_only'],
    ['malformed', 42],
  ])('does not claim lineage scope for %s scope metadata', async (_label, scopeKind) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
      {
        round: 1,
        branch_id: 'b1',
        ...(scopeKind === undefined ? {} : { scope_kind: scopeKind }),
        scope_caveat: 'Untrusted scope prose.',
        factions: [
          { key: 'legacy-faction', label: 'Legacy Faction', members: ['a1'], affect_center: 0, member_share: 1 },
        ],
        events: [],
      },
    ]));

    await renderFactionTimeline('en');

    expect(await screen.findByText('Legacy Faction')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.queryByText('Untrusted scope prose.')).toBeNull();
  });

  it('renders one list item per round', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
        {
          round: 1,
          factions: [
            { key: 'hawks', label: 'War Hawks', members: ['a1', 'a2'], stance_center: 0.8, confidence: 0.9 },
          ],
          events: [],
        },
        {
          round: 2,
          factions: [
            { key: 'doves', label: 'Peace Doves', members: ['a3'], stance_center: -0.6, confidence: 0.7 },
          ],
          events: [],
        },
      ]));

    await renderFactionTimeline('en');

    await screen.findByRole('list', { name: localeExpectations.en.a11yLabel });
    const items = screen.getAllByTestId('faction-timeline-round');
    expect(items).toHaveLength(2);
  });

  it('uses null label fallback to faction key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
        {
          round: 1,
          factions: [
            { key: 'unlabeled_faction', label: null, members: ['a1'], stance_center: 0, confidence: 0.5 },
          ],
          events: [],
        },
      ]));

    await renderFactionTimeline('en');

    expect(await screen.findByText('unlabeled_faction')).toBeInTheDocument();
    expect(screen.getByText('1 members')).toBeInTheDocument();
  });

  it.each([
    ['en', localeExpectations.en],
    ['zh', localeExpectations.zh],
  ] as const)('uses a safe unknown-event fallback with visible actor/faction metadata in %s', async (language, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
      {
        round: 1,
        factions: [
          { key: 'moderates', label: 'Moderates', members: ['a1'], stance_center: 0.25, confidence: 0.6 },
        ],
        events: [
          { type: 'shadow_merger', actor_agent_id: 'a1', faction_key: 'moderates' },
        ],
      },
    ]));

    await renderFactionTimeline(language);

    expect(await screen.findByText(expected.unknownEvent)).toBeInTheDocument();
    expect(screen.getByText(expected.actor)).toBeInTheDocument();
    expect(screen.getByText(expected.faction)).toBeInTheDocument();
    expect(screen.getByText(expected.unknownType)).toBeInTheDocument();
    expect(screen.getByText('❔')).toBeInTheDocument();
  });

  it.each([
    ['en', localeExpectations.en.fallbackMetric, 'Group share —'],
    ['zh', localeExpectations.zh.fallbackMetric, '群体占比 —'],
  ] as const)('renders missing stance and confidence safely in %s', async (language, expectedStance, expectedConfidence) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
      {
        round: 1,
        factions: [
          { key: 'moderates', label: 'Moderates', members: ['a1'], confidence: undefined, stance_center: undefined },
        ],
        events: [],
      },
    ]));

    await renderFactionTimeline(language);

    expect(await screen.findByText(expectedStance)).toBeInTheDocument();
    expect(screen.getByText(expectedConfidence)).toBeInTheDocument();
  });

  it('uses the encoded faction timeline client path for scenarioId and branchId', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([]));

    await renderFactionTimeline('en', {
      scenarioId: 'sc/123?',
      branchId: 'branch alpha/beta?=1',
    });

    await screen.findByText(localeExpectations.en.empty);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/scenario/sc%2F123%3F/faction-timeline?branch_id=branch%20alpha%2Fbeta%3F%3D1',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
  });

  it('ignores stale timeline responses when branch changes before the first request settles', async () => {
    const firstRequest = deferred<Response>();
    const secondRequest = deferred<Response>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    const i18n = await createTestI18n('en');
    const view = render(
      <I18nextProvider i18n={i18n}>
        <FactionTimeline scenarioId="sc1" branchId="b1" branchLabel="Archive Branch" visible={true} />
      </I18nextProvider>,
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        '/api/scenario/sc1/faction-timeline?branch_id=b1',
        expect.objectContaining({ headers: expect.any(Headers) }),
      );
    });

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <FactionTimeline scenarioId="sc1" branchId="b2" branchLabel="Late Branch" visible={true} />
      </I18nextProvider>,
    );

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        '/api/scenario/sc1/faction-timeline?branch_id=b2',
        expect.objectContaining({ headers: expect.any(Headers) }),
      );
    });

    await act(async () => {
      secondRequest.resolve(jsonResponse([
        {
          round: 2,
          branch_id: 'b2',
          factions: [
            { key: 'late-branch-faction', label: 'Late Branch Faction', members: ['b2-agent'], stance_center: 0.6, confidence: 0.8 },
          ],
          events: [],
        },
      ]));
      await Promise.resolve();
    });

    expect(await screen.findByText('Late Branch Faction')).toBeInTheDocument();
    expect(screen.getByText('Branch scope: Late Branch')).toBeInTheDocument();
    expect(screen.getByText('Selected branch: Late Branch')).toBeInTheDocument();

    await act(async () => {
      firstRequest.resolve(jsonResponse([
        {
          round: 1,
          branch_id: 'b1',
          factions: [
            { key: 'archive-faction', label: 'Archive Branch Faction', members: ['b1-agent'], stance_center: 0.1, confidence: 0.4 },
          ],
          events: [],
        },
      ]));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.getByText('Late Branch Faction')).toBeInTheDocument();
    expect(screen.queryByText('Archive Branch Faction')).toBeNull();
    expect(screen.getByText('Branch scope: Late Branch')).toBeInTheDocument();
    expect(screen.getByText('Selected branch: Late Branch')).toBeInTheDocument();
  });

  it('clears the previous timeline when the selected branch becomes unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
      {
        round: 1,
        branch_id: 'b1',
        factions: [
          { key: 'old-faction', label: 'Old Faction', members: ['agent-1'], stance_center: 0.2, confidence: 0.8 },
        ],
        events: [],
      },
    ]));
    const i18n = await createTestI18n('en');
    const view = render(
      <I18nextProvider i18n={i18n}>
        <FactionTimeline scenarioId="sc1" branchId="b1" branchLabel="Archive Branch" visible={true} />
      </I18nextProvider>,
    );
    expect(await screen.findByText('Old Faction')).toBeInTheDocument();

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <FactionTimeline scenarioId="sc1" branchId="" branchLabel="Unavailable Branch" visible={true} />
      </I18nextProvider>,
    );

    await waitFor(() => expect(screen.queryByText('Old Faction')).not.toBeInTheDocument());
    expect(screen.getByText(localeExpectations.en.empty)).toBeInTheDocument();
  });

  it('opens NodeConversationSheet when an event row is clicked (FE-3-seq wire-up)', async () => {
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
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
        {
          round: 1,
          factions: [
            { key: 'moderates', label: 'Moderates', members: ['a1'], stance_center: 0.2, confidence: 0.6 },
          ],
          events: [
            { type: 'betrayal', actor_agent_id: 'a1', faction_key: 'moderates' },
          ],
        },
      ]));

      await renderFactionTimeline('en');
      const row = await screen.findByTestId('faction-event-row-1-0');
      expect(screen.queryByTestId('node-conversation-sheet')).toBeNull();

      await user.click(row);

      const sheet = await screen.findByTestId('node-conversation-sheet');
      expect(sheet).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('starts node conversation with the timeline scenario id and a null identity id', async () => {
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
        .mockResolvedValueOnce(jsonResponse([
          {
            round: 1,
            factions: [
              { key: 'moderates', label: 'Moderates', members: ['a1'], stance_center: 0.2, confidence: 0.6 },
            ],
            events: [
              { type: 'betrayal', actor_agent_id: 'a1', faction_key: 'moderates' },
            ],
          },
        ]))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ thread_id: 'thread-faction-1' }),
        } as Response)
        .mockResolvedValueOnce(
          makeConversationSseResponse([
            'event: turn_started\ndata: {"turn_id":"turn-faction-1","thread_id":"thread-faction-1","sequence":2}\n\n',
            'event: turn_token_delta\ndata: {"turn_id":"turn-faction-1","delta":"ok"}\n\n',
            'event: turn_completed\ndata: {"turn_id":"turn-faction-1","sequence":2,"status":"committed"}\n\n',
          ]),
        );

      await renderFactionTimeline('en');
      await user.click(await screen.findByTestId('faction-event-row-1-0'));
      await user.type(await screen.findByTestId('node-conversation-input'), 'follow this event');
      await user.click(screen.getByTestId('node-conversation-send'));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          '/api/conversation/start',
          expect.objectContaining({ method: 'POST' }),
        );
      });
      const [, startOptions] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const startBody = JSON.parse(String(startOptions.body));
      expect(startBody.scenario_id).toBe('sc1');
      expect(startBody.agent_identity_id).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders FactionForceGraph when capability is enabled and timeline has data', async () => {
    mockUseCapabilityCheck.mockReturnValue({ loading: false, enabled: true, capabilities: null, error: null });
    const agentNames = {
      a1: 'Alice',
      a2: 'Bob',
      a3: 'Cleo',
      a4: 'Dane',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse([
        {
          round: 1,
          factions: [
            { key: 'faction_0', label: 'Early Hawks', members: ['a1'], stance_center: 0.5, confidence: 0.5 },
          ],
          events: [],
        },
        {
          round: 2,
          factions: [
            { key: 'faction_0', label: 'Hawks', members: ['a1', 'a2'], stance_center: 0.5, confidence: 0.5 },
            { key: 'faction_1', label: null, members: ['a3', 'a4'], stance_center: -0.5, confidence: 0.5 },
          ],
          events: [],
        },
      ]),
    );
    await renderFactionTimeline('en', { branchId: 'final-branch', agentNames });
    await waitFor(() => {
      expect(screen.getByTestId('faction-force-graph-mock')).toBeInTheDocument();
    });
    const graph = screen.getByTestId('faction-force-graph-mock');
    expect(graph).toHaveAttribute('data-scenario-id', 'sc1');
    expect(graph).toHaveAttribute('data-branch-id', 'final-branch');
    expect(graph).toHaveAttribute('data-total-rounds', '2');
    expect(mockFactionForceGraphProps.at(-1)).toEqual({
      scenarioId: 'sc1',
      branchId: 'final-branch',
      totalRounds: 2,
      factions: [
        { key: 'faction_0', members: ['a1', 'a2'], label: 'Hawks' },
        { key: 'faction_1', members: ['a3', 'a4'], label: undefined },
      ],
      agentNames,
    });
  });

  it('does not render FactionForceGraph when capability is disabled', async () => {
    mockUseCapabilityCheck.mockReturnValue({ loading: false, enabled: false, capabilities: null, error: null });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse([
        {
          round: 1,
          factions: [
            { key: 'faction_0', label: 'Hawks', members: ['a1', 'a2'], stance_center: 0.5, confidence: 0.5 },
          ],
          events: [],
        },
      ]),
    );
    await renderFactionTimeline('en');
    await waitFor(() => {
      expect(screen.getByText(en.translation.factions.title)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('faction-force-graph-mock')).not.toBeInTheDocument();
  });

  it('defines the force graph locale keys in both resource files', () => {
    expect(en.translation.factions.force_graph_title).toBe('Faction Force Graph');
    expect(zh.translation.factions.force_graph_title).toBe('阵营力导向图');
    expect(en.translation.factions.force_graph_slider_label).toBe('Round');
    expect(zh.translation.factions.force_graph_slider_label).toBe('轮次');
    expect(en.translation.factions.force_graph_relation_trust).toBe('Affect alignment');
    expect(zh.translation.factions.force_graph_relation_trust).toBe('情绪互动相似度');
    expect(en.translation.factions.force_graph_relation_opposition).toBe('Affect distance');
    expect(zh.translation.factions.force_graph_relation_opposition).toBe('情绪互动差异度');
  });
});
