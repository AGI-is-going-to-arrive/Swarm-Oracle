import {
  estimateBubbleHeight,
  ORACLE_TEXT_LAYOUT_CONTRACTS,
  predictTextOverflow,
  type TextLayoutContract,
} from './textOverflowPredictor';

export type OracleTranscriptBubbleKind =
  | 'ending_turn'
  | 'ending_draft'
  | 'roundtable_turn'
  | 'roundtable_draft';

export interface OracleTranscriptLayoutItem {
  key: string;
  content: string;
}

export interface OracleTranscriptBubbleLayout {
  minHeightPx: number;
  lineCount: number;
  overflow: boolean;
  overflowLines: number;
}

export interface OracleTranscriptLayoutTelemetry {
  turn_count: number;
  draft_count: number;
  max_turn_lines: number;
  max_draft_lines: number;
  overflow_turn_count: number;
  overflow_draft_count: number;
  collapsible_turn_count: number;
  collapsed_turn_count: number;
  max_turn_min_height_px: number;
  max_draft_min_height_px: number;
  scroll_bottom_offset_px: number | null;
  scroll_height_px: number | null;
  client_height_px: number | null;
  is_bottom_anchored: boolean | null;
}

interface OracleTranscriptLayoutSummaryOptions {
  collapseLineLimit?: number;
  collapsedTurnCount?: number;
}

export interface TranscriptScrollSnapshot {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  bottomOffset: number;
}

interface TranscriptScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

function resolveBubbleContract(kind: OracleTranscriptBubbleKind): TextLayoutContract {
  switch (kind) {
    case 'ending_draft':
      return ORACLE_TEXT_LAYOUT_CONTRACTS.endingRoomDraftBubble;
    case 'roundtable_turn':
    case 'roundtable_draft':
      return ORACLE_TEXT_LAYOUT_CONTRACTS.roundtableTranscriptBubble;
    case 'ending_turn':
    default:
      return ORACLE_TEXT_LAYOUT_CONTRACTS.endingRoomBubble;
  }
}

function resolveContractWithLocale(
  kind: OracleTranscriptBubbleKind,
  locale?: string | null,
): TextLayoutContract {
  const contract = resolveBubbleContract(kind);
  const normalizedLocale = locale?.trim();
  return normalizedLocale ? { ...contract, locale: normalizedLocale } : contract;
}

export function predictOracleTranscriptBubbleLayout(
  text: string,
  kind: OracleTranscriptBubbleKind,
  locale?: string | null,
): OracleTranscriptBubbleLayout {
  const safeText = text.trim() ? text : ' ';
  const contract = resolveContractWithLocale(kind, locale);
  const prediction = predictTextOverflow(safeText, contract);

  return {
    minHeightPx: Math.max(
      contract.lineHeightPx + (contract.chromeHeightPx ?? 0),
      estimateBubbleHeight(safeText, contract),
    ),
    lineCount: prediction.lineCount,
    overflow: prediction.overflow,
    overflowLines: prediction.overflowLines,
  };
}

export function buildOracleTranscriptLayoutMap(
  items: OracleTranscriptLayoutItem[],
  kind: OracleTranscriptBubbleKind,
  locale?: string | null,
): Record<string, OracleTranscriptBubbleLayout> {
  return Object.fromEntries(
    items.map((item) => [item.key, predictOracleTranscriptBubbleLayout(item.content, kind, locale)]),
  );
}

export function captureTranscriptScrollSnapshot(
  metrics: TranscriptScrollMetrics,
): TranscriptScrollSnapshot {
  return {
    scrollHeight: metrics.scrollHeight,
    scrollTop: metrics.scrollTop,
    clientHeight: metrics.clientHeight,
    bottomOffset: Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop),
  };
}

export function computeBottomAnchoredScrollTop(
  metrics: Pick<TranscriptScrollMetrics, 'scrollHeight' | 'clientHeight'>,
  previous: TranscriptScrollSnapshot | null,
): number {
  const nextBottomOffset = previous?.bottomOffset ?? 0;
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - nextBottomOffset);
}

export function summarizeOracleTranscriptLayout(
  turnLayouts: Record<string, OracleTranscriptBubbleLayout>,
  draftLayouts: Record<string, OracleTranscriptBubbleLayout>,
  scrollSnapshot: TranscriptScrollSnapshot | null,
  options: OracleTranscriptLayoutSummaryOptions = {},
): OracleTranscriptLayoutTelemetry {
  const turnValues = Object.values(turnLayouts);
  const draftValues = Object.values(draftLayouts);
  const collapseLineLimit = options.collapseLineLimit ?? Number.POSITIVE_INFINITY;
  const collapsibleTurnCount = Number.isFinite(collapseLineLimit)
    ? turnValues.filter((layout) => layout.lineCount > collapseLineLimit).length
    : 0;

  return {
    turn_count: turnValues.length,
    draft_count: draftValues.length,
    max_turn_lines: Math.max(0, ...turnValues.map((layout) => layout.lineCount)),
    max_draft_lines: Math.max(0, ...draftValues.map((layout) => layout.lineCount)),
    overflow_turn_count: turnValues.filter((layout) => layout.overflow).length,
    overflow_draft_count: draftValues.filter((layout) => layout.overflow).length,
    collapsible_turn_count: collapsibleTurnCount,
    collapsed_turn_count: Math.min(options.collapsedTurnCount ?? 0, collapsibleTurnCount),
    max_turn_min_height_px: Math.max(0, ...turnValues.map((layout) => layout.minHeightPx)),
    max_draft_min_height_px: Math.max(0, ...draftValues.map((layout) => layout.minHeightPx)),
    scroll_bottom_offset_px: scrollSnapshot?.bottomOffset ?? null,
    scroll_height_px: scrollSnapshot?.scrollHeight ?? null,
    client_height_px: scrollSnapshot?.clientHeight ?? null,
    is_bottom_anchored: scrollSnapshot ? scrollSnapshot.bottomOffset <= 4 : null,
  };
}
