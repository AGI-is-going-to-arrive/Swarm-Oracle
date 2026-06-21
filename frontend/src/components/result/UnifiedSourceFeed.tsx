/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Unified Source Feed (Option C)
   ═══════════════════════════════════════════════════════════ */

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useResultContext } from '../../pages/result/ResultContext';
import { resolveSourceCategoryState } from '../../pages/resultHelpers';
import type { SourceCategoryState, UnifiedSourceRow } from '../../types';
import { cn } from '../../lib/utils';

export interface UnifiedSourceFeedProps {
  target: 'desktop' | 'mobile';
}

type FeedFilterType = 'all' | 'polymarket' | 'finance' | 'academic' | 'news_deep' | 'web_snippets';

interface FeedElement {
  key: string;
  category: 'polymarket' | 'finance' | 'academic' | 'news_deep' | 'web_snippets';
  isStatus: boolean;
  statusState?: SourceCategoryState | 'geo_gated';
  statusReason?: string;
  isHistorical?: boolean;
  row?: UnifiedSourceRow;
}

const EXPLAINABLE_SOURCE_STATES: ReadonlySet<string> = new Set([
  'failed',
  'unsupported_provider',
  'search_skipped',
  'fallback_unconstrained',
]);

const RAW_URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;
const SITE_OPERATOR_PATTERN = /(?:^|\s)site\s*:/i;
const LOCAL_HOST_PATTERN = /\b(?:localhost|host\.docker\.internal|metadata\.google\.internal)\b/i;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

type SourceFamilyContextEntry = {
  state?: string;
  disabled_reason?: string;
  status_reason?: string;
  status_reason_code?: string;
  optimized_query?: string;
  search_pass?: 1 | 2;
  items?: unknown[];
} | null | undefined;

function isPrivateOrMetadataIp(value: string): boolean {
  for (const match of value.matchAll(IPV4_PATTERN)) {
    const parts = match[0].split('.').map((part) => Number(part));
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      continue;
    }
    const [first, second] = parts;
    if (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    ) {
      return true;
    }
  }
  return false;
}

function getDisplayableOptimizedQuery(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    RAW_URL_PATTERN.test(trimmed) ||
    SITE_OPERATOR_PATTERN.test(trimmed) ||
    LOCAL_HOST_PATTERN.test(trimmed) ||
    isPrivateOrMetadataIp(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function getDisplayText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function getStableId(prefix: string, explicitId: unknown, label: string, index: number): string {
  if (typeof explicitId === 'string' && explicitId.trim()) {
    return explicitId.trim();
  }
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${prefix}-${slug || 'item'}-${index}`;
}

function getSafeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

export function UnifiedSourceFeed({ target }: UnifiedSourceFeedProps) {
  const { t } = useTranslation();
  const {
    scenario,
    capabilities,
    webSourcesOpen,
    setWebSourcesOpen,
    blurCollapsedPanelFocus,
  } = useResultContext();

  const [activeFilter, setActiveFilter] = useState<FeedFilterType>('all');
  const [expanded, setExpanded] = useState(false);

  const ctx = scenario?.web_search_context;
  const sourceFamilyContext = ctx?.family_context ?? null;

  // 1. Resolve category structures
  const polymarketContext = sourceFamilyContext?.polymarket;
  const financeContext = sourceFamilyContext?.finance;
  const academicContext = sourceFamilyContext?.academic;
  const newsDeepContext = sourceFamilyContext?.news_deep;

  const providers = capabilities?.web_search?.providers;

  const hasItems = (entry: { items?: unknown[] } | null | undefined): boolean =>
    Boolean(entry && Array.isArray(entry.items) && entry.items.length > 0);

  const hasExplainableEntry = (entry: { state?: string } | null | undefined): boolean =>
    Boolean(entry && typeof entry.state === 'string' && EXPLAINABLE_SOURCE_STATES.has(entry.state));

  const hasPolymarketData = hasItems(polymarketContext);
  const hasFinanceData = hasItems(financeContext);
  const hasAcademicData = hasItems(academicContext);
  const hasNewsDeepData = hasItems(newsDeepContext);

  const polymarketLive = Boolean(providers?.polymarket?.enabled);
  const financeLive = Boolean(providers?.finance?.enabled);
  const academicLive = Boolean(providers?.academic?.enabled);
  const newsDeepLive = Boolean(providers?.news_deep?.enabled);

  const showPolymarket = polymarketLive || hasPolymarketData || hasExplainableEntry(polymarketContext);
  const showFinance = financeLive || hasFinanceData || hasExplainableEntry(financeContext);
  const showAcademic = academicLive || hasAcademicData || hasExplainableEntry(academicContext);
  const showNewsDeep = newsDeepLive || hasNewsDeepData || hasExplainableEntry(newsDeepContext);

  const polymarketHistorical = !polymarketLive && (hasPolymarketData || hasExplainableEntry(polymarketContext));
  const financeHistorical = !financeLive && (hasFinanceData || hasExplainableEntry(financeContext));
  const academicHistorical = !academicLive && (hasAcademicData || hasExplainableEntry(academicContext));
  const newsDeepHistorical = !newsDeepLive && (hasNewsDeepData || hasExplainableEntry(newsDeepContext));

  const polymarketCapability = capabilities?.web_search?.providers?.polymarket
    ? {
        ...capabilities.web_search.providers.polymarket,
        configured_host:
          polymarketContext?.configured_host ??
          capabilities.web_search.providers.polymarket.configured_host,
      }
    : undefined;

  const getSourceReason = (entry: SourceFamilyContextEntry) => {
    if (entry?.status_reason_code) {
      const fallback = entry.status_reason ?? entry.disabled_reason;
      return t(`source.reason.${entry.status_reason_code}`, {
        defaultValue:
          typeof fallback === 'string' && fallback.trim()
            ? fallback
            : 'Source search failed for this category.',
      });
    }
    const raw = entry?.status_reason ?? entry?.disabled_reason;
    return typeof raw === 'string' && raw.trim() ? raw : undefined;
  };

  // 2. Fetch snippets + citations
  const snippets = useMemo(() => {
    return Array.isArray(ctx?.snippets)
      ? ctx.snippets.filter(
          (s): s is { text: string; source_url: string } =>
            s != null && typeof s.text === 'string',
        )
      : [];
  }, [ctx]);

  const nativeCitations = useMemo(() => {
    return Array.isArray(ctx?.native_citations)
      ? ctx.native_citations
          .map((citation) => {
            if (citation == null || typeof citation.text !== 'string') {
              return null;
            }
            const safeUrl = getSafeHttpUrl(citation.source_url);
            return safeUrl ? { text: citation.text, source_url: safeUrl } : null;
          })
          .filter((citation): citation is { text: string; source_url: string } => citation != null)
      : [];
  }, [ctx]);

  const fallbackItemTitle = t('source.feed.untitled', { defaultValue: 'Untitled source' });

  // 3. Assemble all rows (items + status rows)
  const allElements: FeedElement[] = (() => {
    const list: FeedElement[] = [];

    // Polymarket
    if (showPolymarket) {
      if (polymarketCapability?.configured_host === 'non-us') {
        list.push({
          key: 'status-polymarket-geo-gated',
          category: 'polymarket',
          isStatus: true,
          statusState: 'geo_gated',
          isHistorical: polymarketHistorical,
        });
      } else {
        const state = resolveSourceCategoryState(polymarketContext);
        const items = polymarketContext?.items ?? [];
        if (ctx && (state !== 'ready' || items.length === 0)) {
          list.push({
            key: 'status-polymarket',
            category: 'polymarket',
            isStatus: true,
            statusState: state,
            statusReason: getSourceReason(polymarketContext),
            isHistorical: polymarketHistorical,
          });
        }
        if (state === 'ready' || state === 'fallback_unconstrained') {
          items.forEach((item, index) => {
            const question = getDisplayText(item.question, fallbackItemTitle);
            const rowId = getStableId('pm', item.id, question, index);
            list.push({
              key: `item-polymarket-${rowId}`,
              category: 'polymarket',
              isStatus: false,
              isHistorical: polymarketHistorical,
              row: {
                type: 'polymarket',
                id: rowId,
                question,
                probability: item.probability,
                url: item.url,
                isHistorical: polymarketHistorical,
              },
            });
          });
        }
      }
    }

    // Finance
    if (showFinance) {
      const state = resolveSourceCategoryState(financeContext);
      const items = financeContext?.items ?? [];
      if (ctx && (state !== 'ready' || items.length === 0)) {
        list.push({
          key: 'status-finance',
          category: 'finance',
          isStatus: true,
          statusState: state,
          statusReason: getSourceReason(financeContext),
          isHistorical: financeHistorical,
        });
      }
      if (state === 'ready' || state === 'fallback_unconstrained') {
        items.forEach((item, index) => {
          const title = getDisplayText(item.title, fallbackItemTitle);
          const rowId = getStableId('fin', item.id, title, index);
          list.push({
            key: `item-finance-${rowId}`,
            category: 'finance',
            isStatus: false,
            isHistorical: financeHistorical,
            row: {
              type: 'finance',
              id: rowId,
              title,
              summary: typeof item.summary === 'string' ? item.summary : undefined,
              source: item.source,
              url: item.url,
              isHistorical: financeHistorical,
            },
          });
        });
      }
    }

    // Academic
    if (showAcademic) {
      const state = resolveSourceCategoryState(academicContext);
      const items = academicContext?.items ?? [];
      if (ctx && (state !== 'ready' || items.length === 0)) {
        list.push({
          key: 'status-academic',
          category: 'academic',
          isStatus: true,
          statusState: state,
          statusReason: getSourceReason(academicContext),
          isHistorical: academicHistorical,
        });
      }
      if (state === 'ready' || state === 'fallback_unconstrained') {
        items.forEach((item, index) => {
          const title = getDisplayText(item.title, fallbackItemTitle);
          const rowId = getStableId('acad', item.id, title, index);
          list.push({
            key: `item-academic-${rowId}`,
            category: 'academic',
            isStatus: false,
            isHistorical: academicHistorical,
            row: {
              type: 'academic',
              id: rowId,
              title,
              authors: item.authors,
              citationCount: item.citationCount,
              abstract: typeof item.abstract === 'string' ? item.abstract : undefined,
              url: item.url,
              isHistorical: academicHistorical,
            },
          });
        });
      }
    }

    // News Deep
    if (showNewsDeep) {
      const state = resolveSourceCategoryState(newsDeepContext);
      const items = newsDeepContext?.items ?? [];
      if (ctx && (state !== 'ready' || items.length === 0)) {
        list.push({
          key: 'status-news_deep',
          category: 'news_deep',
          isStatus: true,
          statusState: state,
          statusReason: getSourceReason(newsDeepContext),
          isHistorical: newsDeepHistorical,
        });
      }
      if (state === 'ready' || state === 'fallback_unconstrained') {
        items.forEach((item, index) => {
          const title = getDisplayText(item.title, fallbackItemTitle);
          const rowId = getStableId('news', item.id, title, index);
          list.push({
            key: `item-news_deep-${rowId}`,
            category: 'news_deep',
            isStatus: false,
            isHistorical: newsDeepHistorical,
            row: {
              type: 'news_deep',
              id: rowId,
              title,
              source: item.source,
              publishedAt: item.publishedAt,
              description: typeof item.description === 'string' ? item.description : undefined,
              url: item.url,
              isHistorical: newsDeepHistorical,
            },
          });
        });
      }
    }

    // Snippets & Citations
    snippets.forEach((s, idx) => {
      list.push({
        key: `item-snippet-${idx}`,
        category: 'web_snippets',
        isStatus: false,
        row: {
          type: 'snippet',
          id: `snippet-${idx}`,
          text: s.text,
          source_url: s.source_url,
        },
      });
    });

    nativeCitations.forEach((c, idx) => {
      list.push({
        key: `item-citation-${idx}`,
        category: 'web_snippets',
        isStatus: false,
        row: {
          type: 'citation',
          id: `citation-${idx}`,
          text: c.text,
          source_url: c.source_url,
        },
      });
    });

    // If both snippets and citations are empty
    if (ctx && snippets.length === 0 && nativeCitations.length === 0) {
      list.push({
        key: 'status-web_snippets-empty',
        category: 'web_snippets',
        isStatus: true,
        statusState: 'empty',
      });
    }

    return list;
  })();

  // 4. Calculate filter chip counts (items only)
  const counts = useMemo(() => {
    const c = {
      all: 0,
      polymarket: 0,
      finance: 0,
      academic: 0,
      news_deep: 0,
      web_snippets: 0,
    };
    allElements.forEach((el) => {
      if (!el.isStatus) {
        c.all++;
        c[el.category]++;
      }
    });
    return c;
  }, [allElements]);

  // 5. Filter elements
  const filteredElements = useMemo(() => {
    if (activeFilter === 'all') {
      return allElements;
    }
    return allElements.filter((el) => el.category === activeFilter);
  }, [allElements, activeFilter]);

  // 6. Cap display
  const filteredItemCount = useMemo(
    () => filteredElements.filter((el) => !el.isStatus).length,
    [filteredElements],
  );

  const displayedElements = useMemo(() => {
    if (expanded) {
      return filteredElements;
    }
    let itemCount = 0;
    return filteredElements.filter((el) => {
      if (el.isStatus) {
        return true;
      }
      if (itemCount < 6) {
        itemCount += 1;
        return true;
      }
      return false;
    });
  }, [filteredElements, expanded]);

  const displayedItemCount = useMemo(
    () => displayedElements.filter((el) => !el.isStatus).length,
    [displayedElements],
  );

  const visibleKeys = useMemo(() => {
    return new Set(displayedElements.map((el) => el.key));
  }, [displayedElements]);

  const showCapControl = filteredItemCount > 6;

  // Helpers for labels and rendering
  const historicalLabel = t('result.source_historical', { defaultValue: 'Recorded' });
  const historicalTooltip = t('result.source_historical_tooltip', {
    defaultValue: 'This data was recorded when the scenario was created',
  });

  const renderHistoricalBadge = () => (
    <span
      className="ml-2 inline-block rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500 uppercase tracking-wider"
      title={historicalTooltip}
      aria-label={`${historicalLabel}: ${historicalTooltip}`}
    >
      {historicalLabel}
    </span>
  );

  const getStatusText = (category: string, state: SourceCategoryState | 'geo_gated') => {
    if (state === 'geo_gated') {
      return t('source.polymarket.geo_gated_title', {
        defaultValue: 'Polymarket is geo-gated (US host required)',
      });
    }
    if (state === 'empty') {
      return t(`source.${category}.empty`, { defaultValue: 'No results found.' });
    }
    if (state === 'loading') {
      return t('source.loading', { defaultValue: 'Loading sources...' });
    }
    if (state === 'rate_limited') {
      return t(`source.${category}.rate_limited`, { defaultValue: 'Rate limit reached. Please retry later.' });
    }
    if (state === 'network_error') {
      return t(`source.${category}.network_error`, { defaultValue: 'Network error while fetching sources.' });
    }
    if (state === 'failed') {
      return t(`source.${category}.failed`, { defaultValue: 'Source search failed.' });
    }
    if (state === 'unsupported_provider') {
      return t(`source.${category}.unsupported_provider`, { defaultValue: 'Current provider does not support this category.' });
    }
    if (state === 'fallback_unconstrained') {
      return t(`source.${category}.fallback_unconstrained`, { defaultValue: 'Search scope expanded — domain filtering unavailable.' });
    }
    if (state === 'search_skipped') {
      return t(`source.${category}.search_skipped`, { defaultValue: 'Search skipped.' });
    }
    return '';
  };

  const getStatusIcon = (state: SourceCategoryState | 'geo_gated') => {
    switch (state) {
      case 'loading':
        return '⌛';
      case 'empty':
        return '∅';
      case 'geo_gated':
      case 'unsupported_provider':
        return 'ℹ️';
      case 'search_skipped':
        return '⏭';
      case 'rate_limited':
      case 'network_error':
      case 'failed':
      case 'fallback_unconstrained':
      default:
        return '⚠️';
    }
  };

  const renderStatusRow = (el: FeedElement) => {
    const state = el.statusState!;
    const reason = el.statusReason;
    const reasonId = `status-${target}-${el.key}-reason`;
    const label = getStatusText(el.category, state);
    const icon = getStatusIcon(state);

    if (state === 'loading') {
      return (
        <div
          key={el.key}
          className="rounded-lg border border-dashed border-border-default bg-surface/50 p-4"
          aria-busy="true"
          data-testid={`unified-feed-status-${el.category}-loading`}
        >
          <div className="flex animate-pulse flex-col gap-2">
            <div className="h-4 w-1/4 rounded bg-border-default" />
            <div className="h-3 w-1/2 rounded bg-border-default/60" />
            <div className="h-3 w-1/3 rounded bg-border-default/40" />
          </div>
        </div>
      );
    }

    return (
      <div
        key={el.key}
        className={cn(
          "rounded-lg border border-dashed p-4 text-xs flex flex-col gap-1",
          state === 'empty'
            ? 'border-border-default bg-surface/30 text-text-secondary'
            : state === 'geo_gated' || state === 'unsupported_provider' || state === 'search_skipped'
            ? 'border-blue-500/20 bg-blue-500/5 text-blue-400'
            : 'border-amber-500/20 bg-amber-500/5 text-amber-400'
        )}
        data-testid={`unified-feed-status-${el.category}`}
        aria-describedby={reason ? reasonId : undefined}
      >
        <div className="flex items-center gap-1.5 font-medium">
          <span aria-hidden="true">{icon}</span>
          <span className="font-semibold uppercase tracking-wider text-[10px] opacity-75">
            {t(`source.feed.type.${el.category === 'web_snippets' ? 'snippet' : el.category}`)}
          </span>
          {el.isHistorical && renderHistoricalBadge()}
        </div>
        <p className="mt-1 font-medium">{label}</p>
        {reason && (
          <span id={reasonId} className="text-[11px] opacity-80 italic mt-0.5">
            {reason}
          </span>
        )}
      </div>
    );
  };

  const renderItemRow = (el: FeedElement) => {
    const row = el.row!;
    const typeLabel = t(`source.feed.type.${row.type}`);
    const openLabel = t('source.feed.open', { defaultValue: 'Open' });

    // 统一行模板（方案 B）：细线顶格单行流 = 徽章 + 标题(2 行 clamp, flex:1)
    //   + 不被截断的右侧元信息(概率/引用数/历史标记) + 「打开 →」
    const badge = (
      <span className="usf-row__badge" data-type={row.type}>
        {typeLabel}
      </span>
    );
    // M2：概率/引用数/历史标记移出 clamp 容器，作为独立 flex 项，避免长标题把关键信号吞掉
    const renderProb = (p?: number | null) =>
      typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? (
        <span className="usf-row__prob">{Math.round(p * 100)}%</span>
      ) : null;
    const renderCitations = (n?: number | null) =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0 ? (
        <span className="usf-row__meta-tag">
          {t('source.academic.citations', { count: n, defaultValue: `${n} citations` })}
        </span>
      ) : null;
    const renderHost = (label?: string | null) =>
      typeof label === 'string' && label.trim() ? <span className="usf-row__src"> ({label.trim()})</span> : null;
    const renderSummary = (value?: string | null) => (
      typeof value === 'string' && value.trim()
        ? <span className="usf-row__summary"> — {value.trim()}</span>
        : null
    );
    const renderAuthors = (authors?: string[] | null) => {
      if (!Array.isArray(authors) || authors.length === 0) {
        return null;
      }
      const visibleAuthors = authors
        .filter((author) => typeof author === 'string' && author.trim())
        .slice(0, 3)
        .map((author) => author.trim());
      if (visibleAuthors.length === 0) {
        return null;
      }
      const suffix = authors.length > visibleAuthors.length ? ' ...' : '';
      return <span className="usf-row__src"> ({visibleAuthors.join(', ')}{suffix})</span>;
    };
    // M3：链接可访问名带来源标题上下文（截断防超长），箭头 aria-hidden
    const renderLnk = (safeUrl: string | null, itemLabel?: string | null) =>
      safeUrl ? (
        <a
          className="usf-row__lnk"
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('source.feed.open_item', {
            title: (itemLabel || '').slice(0, 60),
            defaultValue: `Open ${(itemLabel || '').slice(0, 60)}`,
          })}
        >
          {openLabel} <span aria-hidden="true">→</span>
        </a>
      ) : null;

    switch (row.type) {
      case 'polymarket': {
        const safeUrl = getSafeHttpUrl(row.url);
        return (
          <article
            key={el.key}
            className="usf-row"
            data-fam="polymarket"
            data-testid={`unified-row-polymarket-${row.id}`}
          >
            {badge}
            <p className="usf-row__title">{row.question}</p>
            {renderProb(row.probability)}
            {el.isHistorical && renderHistoricalBadge()}
            {renderLnk(safeUrl, row.question)}
          </article>
        );
      }

      case 'finance': {
        const safeUrl = getSafeHttpUrl(row.url);
        return (
          <article
            key={el.key}
            className="usf-row"
            data-fam="finance"
            data-testid={`unified-row-finance-${row.id}`}
          >
            {badge}
            <p className="usf-row__title">
              {row.title}
              {renderHost(row.source)}
              {renderSummary(row.summary)}
            </p>
            {el.isHistorical && renderHistoricalBadge()}
            {renderLnk(safeUrl, row.title)}
          </article>
        );
      }

      case 'academic': {
        const safeUrl = getSafeHttpUrl(row.url);
        return (
          <article
            key={el.key}
            className="usf-row"
            data-fam="academic"
            data-testid={`unified-row-academic-${row.id}`}
          >
            {badge}
            <p className="usf-row__title">
              {row.title}
              {renderAuthors(row.authors)}
              {renderSummary(row.abstract)}
            </p>
            {renderCitations(row.citationCount)}
            {el.isHistorical && renderHistoricalBadge()}
            {renderLnk(safeUrl, row.title)}
          </article>
        );
      }

      case 'news_deep': {
        const safeUrl = getSafeHttpUrl(row.url);
        return (
          <article
            key={el.key}
            className="usf-row"
            data-fam="news_deep"
            data-testid={`unified-row-news_deep-${row.id}`}
          >
            {badge}
            <p className="usf-row__title">
              {row.title}
              {renderHost(row.source)}
              {renderSummary(row.description)}
            </p>
            {typeof row.publishedAt === 'string' && row.publishedAt.trim() && (
              <span className="usf-row__meta-tag">{row.publishedAt.trim()}</span>
            )}
            {el.isHistorical && renderHistoricalBadge()}
            {renderLnk(safeUrl, row.title)}
          </article>
        );
      }

      case 'snippet':
      case 'citation': {
        const safeUrl = getSafeHttpUrl(row.source_url);
        return (
          <article
            key={el.key}
            className={cn(
              "usf-row",
              row.type === 'citation' ? "usf-row--native" : ""
            )}
            data-fam={row.type}
            data-testid={`unified-row-${row.type}-${row.id}`}
          >
            {badge}
            <p className="usf-row__title">{row.text}</p>
            {el.isHistorical && renderHistoricalBadge()}
            {renderLnk(safeUrl, row.text)}
          </article>
        );
      }

      default:
        return null;
    }
  };

  const renderFamilyProvenance = (
    baseTestId: string,
    context: SourceFamilyContextEntry,
    state: SourceCategoryState | 'geo_gated',
  ) => {
    const displayOptimizedQuery = getDisplayableOptimizedQuery(context?.optimized_query);
    const showBroadened = context?.search_pass === 2 && (state === 'ready' || state === 'fallback_unconstrained');
    const showSearchQuery = state === 'empty';

    if (!showBroadened && !showSearchQuery) {
      return null;
    }

    return (
      <div className="usf-family-meta" data-testid={`${baseTestId}-family-meta`}>
        {showBroadened && (
          <span className="usf-family-meta__broadened" data-testid={`${baseTestId}-broadened-badge`}>
            <span aria-hidden="true">{t('source.broadened_search')}</span>
            <span className="sr-only">{t('source.broadened_search_sr')}</span>
          </span>
        )}
        {showSearchQuery && (
          displayOptimizedQuery ? (
            <span
              className="usf-family-meta__query"
              data-testid={`${baseTestId}-search-query`}
              dir="auto"
            >
              {t('source.searched_with', { query: displayOptimizedQuery })}
            </span>
          ) : (
            <span className="usf-family-meta__query" data-testid={`${baseTestId}-search-query`}>
              {t('source.searched_with_raw_fallback')}
            </span>
          )
        )}
      </div>
    );
  };

  const renderFamilyGroup = (fam: 'polymarket' | 'finance' | 'academic' | 'news_deep') => {
    const context = fam === 'polymarket' ? polymarketContext :
                    fam === 'finance' ? financeContext :
                    fam === 'academic' ? academicContext : newsDeepContext;

    const showCategory = fam === 'polymarket' ? showPolymarket :
                         fam === 'finance' ? showFinance :
                         fam === 'academic' ? showAcademic : showNewsDeep;

    if (!showCategory) return null;

    let state: SourceCategoryState | 'geo_gated' = resolveSourceCategoryState(context);
    if (fam === 'polymarket' && polymarketCapability?.configured_host === 'non-us') {
      state = 'geo_gated';
    }
    const reason = getSourceReason(context);
    const baseTestId = target === 'desktop' ? `result-sources-${fam}` : `result-sources-mobile-${fam}`;
    const reasonId = `${baseTestId}-reason`;
    const hasReason = EXPLAINABLE_SOURCE_STATES.has(state);

    const categoryElements = allElements.filter((el) => el.category === fam && visibleKeys.has(el.key));
    if (categoryElements.length === 0) return null;

    return (
      <div
        key={`group-${fam}`}
        data-testid={baseTestId}
        data-state={state}
        data-source-family={fam}
        className="result-source-family-group flex flex-col gap-3"
        aria-describedby={hasReason ? reasonId : undefined}
      >
        <h4 id={`${baseTestId}-title`} className="sr-only">
          {t(`source.${fam}.title`)}
        </h4>
        {hasReason && (
          <>
            <span id={reasonId} data-testid={reasonId} className="sr-only">
              {reason || t(`source.${fam}.${state}`)}
            </span>
            {reason && (
              <p className="sr-only" aria-hidden="true" data-testid={`${baseTestId}-reason-detail`}>
                {reason}
              </p>
            )}
          </>
        )}
        {renderFamilyProvenance(baseTestId, context, state)}
        {categoryElements.map((el) => (el.isStatus ? renderStatusRow(el) : renderItemRow(el)))}
      </div>
    );
  };

  const renderSnippetsAndCitationsGroup = () => {
    const categoryElements = allElements.filter(
      (el) => el.category === 'web_snippets' && visibleKeys.has(el.key),
    );
    if (categoryElements.length === 0) return null;

    const snippetElements = categoryElements.filter((el) => el.row?.type === 'snippet');
    const citationElements = categoryElements.filter((el) => el.row?.type === 'citation');
    const statusElements = categoryElements.filter((el) => el.isStatus);

    return (
      <div key="group-web_snippets" className="flex flex-col gap-3">
        {statusElements.map((el) => renderStatusRow(el))}
        {snippetElements.length > 0 && (
          <div className="grid gap-3">
            {snippetElements.map((el) => renderItemRow(el))}
          </div>
        )}
        {citationElements.length > 0 && (
          <div
            className="result-web-sources__native"
            role="region"
            aria-label={t('result.native_citations_title')}
          >
            <h4 className="result-web-sources__native-heading">
              {t('result.native_citations_title')}
            </h4>
            <div className="grid gap-3">
              {citationElements.map((el) => renderItemRow(el))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const filterOptions: Array<{ key: FeedFilterType; label: string }> = [
    { key: 'all', label: t('source.feed.filter_all', { defaultValue: 'All' }) },
    { key: 'polymarket', label: t('source.feed.type.polymarket', { defaultValue: 'Prediction Markets' }) },
    { key: 'finance', label: t('source.feed.type.finance', { defaultValue: 'Finance' }) },
    { key: 'academic', label: t('source.feed.type.academic', { defaultValue: 'Academic' }) },
    { key: 'news_deep', label: t('source.feed.type.news_deep', { defaultValue: 'News' }) },
    { key: 'web_snippets', label: t('source.feed.type.snippet', { defaultValue: 'Web Snippets' }) },
  ];

  if (allElements.length === 0) {
    return null;
  }

  const feedTitle = t('source.feed.title', { defaultValue: 'Real-World Sources' });

  // Chips（方案 C：极简文本 + active 圆点）+ Load-more（方案 1：居中细线），desktop/mobile 共用单份（DRY）
  const renderFilterChips = () => (
    <div
      className="usf-chips"
      role="group"
      aria-label={t('source.feed.filters_label', { defaultValue: 'Filter sources' })}
    >
      {filterOptions.map((opt) => {
        const count = counts[opt.key];
        const isActive = activeFilter === opt.key;
        const hasFilterContent = opt.key === 'all'
          ? allElements.length > 0
          : allElements.some((el) => el.category === opt.key);
        const isDisabled = !hasFilterContent;
        return (
          <button
            key={opt.key}
            type="button"
            role="button"
            aria-pressed={isActive}
            disabled={isDisabled}
            onClick={() => {
              setActiveFilter(opt.key);
              setExpanded(false);
            }}
            className="usf-chip"
            data-active={isActive || undefined}
            data-disabled={isDisabled || undefined}
          >
            <span className="usf-chip__label">{opt.label}</span>
            <span className="usf-chip__count">{count}</span>
          </button>
        );
      })}
    </div>
  );

  const renderCapToggle = () => {
    if (!showCapControl) return null;
    const remaining = filteredItemCount - displayedItemCount;
    return (
      <div className="usf-more">
        <button
          type="button"
          className="usf-more__btn"
          onClick={() => setExpanded(!expanded)}
        >
          <span>
            {expanded
              ? t('source.feed.show_less', { defaultValue: 'Show less' })
              : t('source.feed.load_more', { defaultValue: 'Load more' })}
            {!expanded && remaining > 0 && (
              <span className="usf-more__count">
                {' '}· {t('source.feed.remaining', { count: remaining, defaultValue: `${remaining} more` })}
              </span>
            )}{' '}
            <span aria-hidden="true">{expanded ? '↑' : '↓'}</span>
          </span>
        </button>
      </div>
    );
  };

  // 7. Desktop Collapsible Shell
  if (target === 'desktop') {
    return (
      <section
        className="result-web-sources hidden md:block"
        data-testid="result-unified-feed-desktop"
      >
        <button
          type="button"
          className="result-web-sources__trigger"
          aria-expanded={webSourcesOpen}
          aria-controls="result-web-sources-body"
          onClick={() => setWebSourcesOpen((prev) => !prev)}
        >
          <span className="result-web-sources__trigger-label">
            <span>{feedTitle}</span>
            {counts.all > 0 && (
              <span className="result-web-sources__count" aria-hidden="true">
                {counts.all}
              </span>
            )}
          </span>
          <span aria-hidden="true">{webSourcesOpen ? '▲' : '▼'}</span>
        </button>
        <div
          id="result-web-sources-body"
          className={`result-web-sources__body ${webSourcesOpen ? 'is-open' : ''}`}
          aria-hidden={!webSourcesOpen}
          inert={!webSourcesOpen || undefined}
          onFocusCapture={webSourcesOpen ? undefined : blurCollapsedPanelFocus}
        >
          <div className="min-h-0 overflow-hidden flex flex-col gap-6">
            <div className="result-web-sources__meta" data-testid="result-web-sources-meta">
              <span>{t('result.web_sources_query')}: {ctx?.query}</span>
              {typeof ctx?.provider === 'string' && (
                <span>{t('result.web_sources_provider')}: {ctx.provider}</span>
              )}
              {ctx?.cached && (
                <span>{t('result.web_sources_cached')}</span>
              )}
            </div>

            {/* Filter Chips Bar */}
            {renderFilterChips()}

            {/* Feed List Container */}
            <div
              className="grid gap-3 transition-all duration-300 motion-reduce:transition-none"
              aria-live="polite"
              data-testid="result-source-grid-desktop"
            >
              {renderFamilyGroup('polymarket')}
              {renderFamilyGroup('finance')}
              {renderFamilyGroup('academic')}
              {renderFamilyGroup('news_deep')}
              {renderSnippetsAndCitationsGroup()}
            </div>

            {/* Cap control toggle */}
            {renderCapToggle()}
          </div>
        </div>
      </section>
    );
  }

  // 8. Mobile Bottom Drawer Inner Content
  return (
    <div
      className="flex flex-col gap-6"
      data-testid="result-unified-feed-mobile"
    >
      <div className="result-web-sources__meta">
        <span>{t('result.web_sources_query')}: {ctx?.query}</span>
        {typeof ctx?.provider === 'string' && (
          <span>{t('result.web_sources_provider')}: {ctx.provider}</span>
        )}
        {ctx?.cached && (
          <span>{t('result.web_sources_cached')}</span>
        )}
      </div>

      {/* Filter Chips Bar */}
      {renderFilterChips()}

      {/* Feed List Container */}
      <div
        className="grid gap-3 transition-all duration-300 motion-reduce:transition-none"
        aria-live="polite"
        data-testid="result-source-grid-mobile"
      >
        {renderFamilyGroup('polymarket')}
        {renderFamilyGroup('finance')}
        {renderFamilyGroup('academic')}
        {renderFamilyGroup('news_deep')}
        {renderSnippetsAndCitationsGroup()}
      </div>

      {/* Cap control toggle */}
      {renderCapToggle()}
    </div>
  );
}

export default UnifiedSourceFeed;
