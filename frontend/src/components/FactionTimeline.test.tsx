/**
 * Phase 3 F5 — FactionTimeline tests
 */
import { cleanup, render, screen } from '@testing-library/react';
import i18next, { type i18n as I18nInstance } from 'i18next';
import { type ComponentProps } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '../i18n/locales/en.json';
import zh from '../i18n/locales/zh.json';
import { FactionTimeline } from './FactionTimeline';

type TestLanguage = 'en' | 'zh';

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

const localeExpectations = {
  en: {
    title: 'Faction Timeline',
    empty: 'No faction data available.',
    a11yLabel: 'Faction evolution timeline',
    roundLabel: 'Round 1',
    branchScope: 'Branch scope: Archive Branch',
    roundSpan: 'Round span: Round 1',
    membersSummary: '2 members',
    stanceSummary: 'Stance 0.12',
    confidenceSummary: 'Confidence 0.50',
    betrayal: 'betrayal',
    allianceFormed: 'alliance formed',
    actor: 'Actor a1',
    faction: 'Faction Moderates',
    unknownEvent: 'Unknown event',
    unknownType: 'Type shadow merger',
    fallbackMetric: 'Stance —',
  },
  zh: {
    title: '阵营时间线',
    empty: '暂无阵营数据。',
    a11yLabel: '阵营演化时间线',
    roundLabel: '第 1 轮',
    branchScope: '分支范围: Archive Branch',
    roundSpan: '轮次跨度: 第 1 轮',
    membersSummary: '2 名成员',
    stanceSummary: '立场 0.12',
    confidenceSummary: '置信度 0.50',
    betrayal: '背叛',
    allianceFormed: '结盟',
    actor: '行动者 a1',
    faction: '阵营 Moderates',
    unknownEvent: '未知事件',
    unknownType: '类型 shadow merger',
    fallbackMetric: '立场 —',
  },
} satisfies Record<TestLanguage, {
  title: string;
  empty: string;
  a11yLabel: string;
  roundLabel: string;
  branchScope: string;
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
    expect(en.translation.factions.badge_title).toBe('{{label}}: {{count}} members, stance {{stance}}');
    expect(zh.translation.factions.badge_title).toBe('{{label}}：{{count}} 名成员，立场 {{stance}}');
    expect(en.translation.factions.event_labels.betrayal).toBe(localeExpectations.en.betrayal);
    expect(zh.translation.factions.event_labels.betrayal).toBe(localeExpectations.zh.betrayal);
    expect(en.translation.factions.event_labels.alliance_formed).toBe(localeExpectations.en.allianceFormed);
    expect(zh.translation.factions.event_labels.alliance_formed).toBe(localeExpectations.zh.allianceFormed);
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

  it.each([
    ['en', localeExpectations.en],
    ['zh', localeExpectations.zh],
  ] as const)('renders localized title, scope framing, visible faction stats, and event details in %s', async (language, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse([
        {
          round: 1,
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
    expect(screen.getAllByText(expected.branchScope)).toHaveLength(2);
    expect(screen.getByText(expected.roundSpan)).toBeInTheDocument();
    expect(screen.getByText(expected.membersSummary)).toBeInTheDocument();
    expect(screen.getByText(expected.stanceSummary)).toBeInTheDocument();
    expect(screen.getByText(expected.confidenceSummary)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(expected.betrayal))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(expected.allianceFormed))).toBeInTheDocument();
    expect(screen.getByText(expected.actor)).toBeInTheDocument();
    expect(screen.getAllByText(expected.faction)).toHaveLength(2);
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
    ['en', localeExpectations.en.fallbackMetric, 'Confidence —'],
    ['zh', localeExpectations.zh.fallbackMetric, '置信度 —'],
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
});
