/* ═══════════════════════════════════════════════════════════
   Phase 3 F2 — Causal Review View
   Displays a DAG of causal events extracted from a simulation.
   Uses @xyflow/react (already a dependency) with dagre layout.
   Phase C: icons, OKLCH cards, edge styling, neighbor highlight,
            tooltips, agent search.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { buildSessionHeaders, getGraphAnalysis, type GraphAnalysisResponse } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import useReducedMotion from '../hooks/useReducedMotion';
import useMediaQueryState from '../hooks/useMediaQueryState';
import { ExportPanel } from '../components/ExportPanel';
import type { NodeDetail } from '../components/NodeDetailPanel';
import GraphNodeCard from '../components/GraphNodeCard';
import AnimatedEdge from '../components/AnimatedEdge';
import { NodeConversationSheet, type NodeConversationOrigin } from '../components/kg/NodeConversationSheet';
import dagre from 'dagre';
import * as Tooltip from '@radix-ui/react-tooltip';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type FitViewOptions,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './CausalReviewView.css';
import { useSearchParams } from 'react-router-dom';
import {
  NODE_TYPE_COLORS_HEX,
  EDGE_STYLES,
  NODE_ICONS,
  TYPE_LABEL_I18N as GRAPH_TYPE_LABEL_I18N,
  EVIDENCE_TIER_COLORS,
} from '../lib/graphTokens';
import { traceConnectedPath, buildParallelEdgeIndex, PERF_ANIMATION_LIMIT } from '../lib/graphTraversal';
import { resolveCausalNodeColors } from '../lib/dagEditorialTokens';

// ── Custom node type (stable reference) ────────────────────

const nodeTypes = { graphCard: GraphNodeCard };

// ── Dark-surface color tokens ───────────────────────────────
// Every text entry here is verified ≥4.5:1 on `surfaceField` (#1a1a2e) and
// `surfacePanel` (#17172a) so body / button / hint copy stays WCAG AA-compliant
// even at 11-12px sizes that appear in legend + guide panels.
// `decorativeLegendFallback` is *never* applied to text – it only paints the
// 8px swatches in the legend/guide type rows, so the low ratio is intentional.
const CAUSAL_COLORS = {
  textPrimary: '#f1f4fb',      // ~15:1 on #1a1a2e
  textStrong: '#e4e8f1',       // ~12:1 on #1a1a2e (guide strong labels)
  textSecondary: '#c9d3e7',    // ~10.2:1 on #1a1a2e
  textBody: '#b8c1d1',         // ~8:1 on #1a1a2e — list bodies / guide body
  textMuted: '#9aa4b2',        // ~6.8:1 on #1a1a2e — meta, hints, counts
  textLink: '#8ab4f8',         // ~7.2:1 on #1a1a2e — CTAs + links
  textError: '#ff7a70',        // ~6.4:1 on #1a1a2e (replaces #e74c3c, which fails AA on dark)
  surfacePanel: '#17172a',
  surfaceField: '#1a1a2e',
  borderDefault: '#555',
  borderSubtle: '#333',
  borderHairline: '#222',
  inputText: '#ffffff',            // <input>/<select> value text on surfaceField, ~18:1.
  // Decorative only — never used for text / focusable controls.
  decorativeLegendFallback: '#666',
  decorativeNodeFallback: '#555',  // ReactFlow MiniMap + node bg fallback.
  decorativeEdgeFallback: '#888',  // SVG edge stroke fallback, not text.
} as const;

const GUIDE_KEY_NODE_LABEL_MAX_WIDTH = 72;
const GUIDE_KEY_NODE_LABEL_SUFFIX_WIDTH = 3;

function formatGuideKeyNodeLabel(label: string): string {
  const compactLabel = label.replace(/\s+/g, ' ').trim();
  let displayWidth = 0;
  let endIndex = compactLabel.length;

  for (let index = 0; index < compactLabel.length; index += 1) {
    const charWidth = compactLabel.charCodeAt(index) <= 0x7f ? 1 : 2;
    const nextWidth = displayWidth + charWidth;
    if (nextWidth > GUIDE_KEY_NODE_LABEL_MAX_WIDTH - GUIDE_KEY_NODE_LABEL_SUFFIX_WIDTH) {
      endIndex = index;
      break;
    }
    displayWidth = nextWidth;
  }

  if (endIndex === compactLabel.length) return compactLabel;
  return `${compactLabel.slice(0, endIndex).trimEnd()}...`;
}

interface GuidePreviewTextProps {
  label: string;
  fullText?: string;
  t: TFunction<'translation', undefined>;
  tone?: 'strong' | 'body';
}

function GuidePreviewText({ label, fullText, t, tone = 'strong' }: GuidePreviewTextProps) {
  const summaryLabel = cleanNodeDisplayText(label);
  const expandedLabel = cleanNodeDisplayText(fullText || label);
  const compactLabel = formatGuideKeyNodeLabel(summaryLabel);
  const isTruncated = compactLabel !== summaryLabel || expandedLabel !== summaryLabel;
  const textColor = tone === 'strong' ? CAUSAL_COLORS.textStrong : CAUSAL_COLORS.textBody;

  if (!isTruncated) {
    return (
      <span title={expandedLabel} style={{ color: textColor, fontWeight: tone === 'strong' ? 600 : 500, overflowWrap: 'anywhere' }}>
        {expandedLabel}
      </span>
    );
  }

  return (
    <details title={expandedLabel} style={{ minWidth: 0 }}>
      <summary
        aria-label={t('causal.guide_preview_aria', {
          label: expandedLabel,
          defaultValue: 'Show full text: {{label}}',
        })}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          color: textColor,
          fontWeight: tone === 'strong' ? 600 : 500,
          cursor: 'pointer',
          listStyle: 'none',
        }}
      >
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {compactLabel}
        </span>
        <span style={{ flex: '0 0 auto', color: CAUSAL_COLORS.textLink, fontSize: '0.66rem', fontWeight: 600 }}>
          {t('causal.guide_preview_action', 'View full')}
        </span>
      </summary>
      <div style={{ marginTop: 5, color: CAUSAL_COLORS.textBody, fontSize: '0.74rem', lineHeight: 1.45, overflowWrap: 'anywhere' }}>
        {expandedLabel}
      </div>
    </details>
  );
}

// ── Types ───────────────────────────────────────────────────

interface GraphNodeData {
  id: string;
  key: string;
  type: string;
  label: string;
  round: number | null;
  payload: unknown;
}

interface EdgeEvidence {
  confidence_tier: 'low' | 'medium' | 'high' | null;
  source_ref: string | null;
  source_round_number: number | null;
  detail: string | null;
}

interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  type: string;
  weight: number | null;
  label: string | null;
  evidence?: EdgeEvidence | null;
}

interface CausalGraphData {
  id: string;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  available_branches?: string[];
}

interface GuideNodeSummary {
  id: string;
  label: string;
  fullText?: string;
  type: string;
  degree: number;
  inDegree: number;
  outDegree: number;
}

interface GuideRouteSummary {
  id: string;
  sourceLabel: string;
  targetLabels: string[];
  targetCount: number;
}

interface GuideStats {
  godNodes: GuideNodeSummary[];
  typeCounts: Record<string, number>;
  totalNodes: number;
  totalEdges: number;
  forkCount: number;
  eventCount: number;
  outcomeCount: number;
  routeSummaries: GuideRouteSummary[];
  connectedComponents?: number;
  density?: number;
  avgDegree?: number;
}

type GuideMode = 'summary' | 'details' | 'closed';

interface ScenarioBranchOption {
  id: string;
  title: string;
  probability: number | null;
}

interface CausalGraphErrorState {
  code: string | null;
  status: number | null;
}

interface NodeConversationSheetState {
  open: boolean;
  scenarioId: string;
  identityId: string | null;
  origin: NodeConversationOrigin;
}

function createClosedSheetState(): NodeConversationSheetState {
  return {
    open: false,
    scenarioId: '',
    identityId: null,
    origin: { nodeId: '', nodeType: '' },
  };
}

function buildGuideDegreeMap(graphData: CausalGraphData | null): Map<string, { inDegree: number; outDegree: number }> {
  const degreeMap = new Map<string, { inDegree: number; outDegree: number }>();
  if (!graphData) return degreeMap;

  for (const node of graphData.nodes) {
    degreeMap.set(node.id, { inDegree: 0, outDegree: 0 });
  }
  for (const edge of graphData.edges) {
    const sourceDegree = degreeMap.get(edge.source);
    if (sourceDegree) sourceDegree.outDegree += 1;
    const targetDegree = degreeMap.get(edge.target);
    if (targetDegree) targetDegree.inDegree += 1;
  }
  return degreeMap;
}

function buildGuideRouteSummaries(graphData: CausalGraphData | null): GuideRouteSummary[] {
  if (!graphData) return [];
  const nodeMap = new Map(graphData.nodes.map((node) => [node.id, node]));
  const outgoingBySource = new Map<string, GraphEdgeData[]>();
  for (const edge of graphData.edges) {
    const existing = outgoingBySource.get(edge.source) ?? [];
    existing.push(edge);
    outgoingBySource.set(edge.source, existing);
  }

  return graphData.nodes
    .filter((node) => node.type === 'fork')
    .map((forkNode) => {
      const outgoing = outgoingBySource.get(forkNode.id) ?? [];
      const targets = outgoing
        .map((edge) => nodeMap.get(edge.target))
        .filter((node): node is GraphNodeData => Boolean(node));
      const outcomeTargets = targets.filter((node) => node.type === 'outcome' || node.type === 'verdict');
      const displayTargets = (outcomeTargets.length > 0 ? outcomeTargets : targets).slice(0, 2);
      return {
        id: forkNode.id,
        sourceLabel: forkNode.label,
        targetLabels: displayTargets.map((node) => node.label),
        targetCount: targets.length,
      };
    })
    .filter((route) => route.targetCount > 0)
    .slice(0, 3);
}

function extractApiErrorState(payload: unknown, status: number): CausalGraphErrorState {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const detail = record.detail;
    if (detail && typeof detail === 'object') {
      const detailRecord = detail as Record<string, unknown>;
      const code = detailRecord.code;
      if (typeof code === 'string' && code.trim()) {
        return { code: code.trim(), status };
      }
    }
    const code = record.code;
    if (typeof code === 'string' && code.trim()) {
      return { code: code.trim(), status };
    }
  }
  return { code: null, status };
}

const DIVERGE_MARKER_RE = /\s*\[DIVERGE:[^\]]+\]\s*/gi;

function cleanNodeDisplayText(value: string): string {
  return value.replace(DIVERGE_MARKER_RE, ' ').replace(/\s+/g, ' ').trim();
}

function readPayloadString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' ? value.trim() : '';
}

function buildNodeConversationExcerpt(raw: GraphNodeData, payload: Record<string, unknown>): string {
  const content = readPayloadString(payload, 'content');
  if (raw.type === 'outcome') {
    const outcomeExcerpt = cleanNodeDisplayText([
      readPayloadString(payload, 'story_excerpt'),
      readPayloadString(payload, 'insight'),
    ].filter(Boolean).join(' '));
    if (outcomeExcerpt) return outcomeExcerpt;
  }
  if (raw.type === 'fork') {
    const forkExcerpt = cleanNodeDisplayText(
      readPayloadString(payload, 'display_summary')
        || readPayloadString(payload, 'display_reason')
        || readPayloadString(payload, 'reason'),
    );
    if (forkExcerpt) return forkExcerpt;
  }
  const cleanedContent = cleanNodeDisplayText(content);
  return cleanedContent || raw.label || raw.key;
}

function buildGuideNodeFullText(node: GraphNodeData | undefined, fallbackLabel: string): string {
  const fallback = cleanNodeDisplayText(fallbackLabel);
  if (!node) return fallback;
  const payload = getPayloadRecord(node);
  const excerpt = cleanNodeDisplayText(buildNodeConversationExcerpt(node, payload));
  const label = cleanNodeDisplayText(node.label || node.key || fallback);
  if (!excerpt || excerpt === label) return label || fallback;
  if (node.type === 'event') {
    const agentName = readPayloadString(payload, 'agent_name');
    return cleanNodeDisplayText(agentName ? `${agentName}: ${excerpt}` : excerpt);
  }
  return Array.from(excerpt).length > Array.from(label).length ? excerpt : label;
}

function getCausalErrorMessage(
  error: CausalGraphErrorState,
  t: (key: string, fallback: string) => string,
): string {
  switch (error.code) {
    case 'NETWORK_ERROR':
      return t('causal.error.network', 'Unable to load the causal graph. Check your connection and try again.');
    case 'BRANCH_NOT_FOUND':
      return t('causal.error.branch_not_found', 'The selected branch is no longer available for this scenario.');
    case 'FEATURE_DISABLED':
      return t('causal.feature_disabled', 'Causal graph feature is not enabled.');
    default:
      break;
  }

  if (error.status === 401 || error.status === 403) {
    return t('causal.error.unauthorized', 'You do not have permission to view this causal graph.');
  }
  if (error.status != null && error.status >= 500) {
    return t('causal.error.server', 'The server could not load the causal graph right now.');
  }
  return t('causal.error.load_failed', 'Unable to load the causal graph right now. Please retry.');
}

// ── Constants ───────────────────────────────────────────────

const NODE_W = 280;
const NODE_H = 120;
const LARGE_GRAPH_NODE_W = NODE_W;
const LARGE_GRAPH_NODE_H = 58;
const LARGE_GRAPH_NODESEP = 16;
const LARGE_GRAPH_RANKSEP = 60;
const LARGE_GRAPH_THRESHOLD = 50;
const LARGE_GRAPH_FIT_MIN_ZOOM = 0.35;
const PERF_TOOLTIP_LIMIT = 150;
const PERF_TEXT_FALLBACK_LIMIT = 500;
const NO_ARROW_TYPES = new Set(['temporal']);
const GRAPH_COMPACT_MEDIA_QUERY = '(max-width: 768px)';
const NODE_RELATION_CONTEXT_LIMIT = 3;
const NODE_RELATION_LABEL_MAX_CHARS = 36;
type CausalFitViewOptions = FitViewOptions<Node>;
type CausalTranslate = TFunction<'translation', undefined>;

function useCompactGraphViewport() {
  return useMediaQueryState(GRAPH_COMPACT_MEDIA_QUERY);
}

function getCausalTypeLabel(type: string, t: (key: string, fallback: string) => string): string {
  const pair = GRAPH_TYPE_LABEL_I18N[type];
  return pair ? t(pair[0], pair[1]) : type;
}

function getCausalNodeActionLabel(
  typeLabel: string,
  label: string,
  t: (key: string, fallback: string) => string,
): string {
  return `${t('causal.open_details', 'Open details')}: ${typeLabel} - ${label}`;
}

const BACKEND_CAUSAL_EDGE_LABEL_I18N: Record<string, [string, string]> = {
  'triggered fork': ['causal.edge_triggered_fork', 'triggered fork'],
};

function getCausalEdgeBaseRelationLabel(
  edge: GraphEdgeData,
  t: (key: string, fallback: string) => string,
): string {
  const rawLabel = edge.label?.trim();
  if (rawLabel) {
    const labelMapping = BACKEND_CAUSAL_EDGE_LABEL_I18N[rawLabel.toLowerCase()];
    if (labelMapping) return t(labelMapping[0], labelMapping[1]);
    return rawLabel;
  }
  let base: string;
  if (edge.type === 'temporal') base = t('causal.edge_temporal', 'precedes');
  else if (edge.type === 'led_to') base = t('causal.edge_led_to', 'leads to');
  else if (edge.type === 'responds_to') base = t('causal.edge_responds_to', 'responds to');
  else if (edge.type === 'supports_stance') base = t('causal.edge_supports_stance', 'aligns with');
  else if (edge.type === 'opposes_stance') base = t('causal.edge_opposes_stance', 'opposes');
  else base = t('causal.edge_caused', 'causes');
  return base;
}

function getCausalEdgeRelationLabel(
  edge: GraphEdgeData,
  t: (key: string, fallback: string) => string,
): string {
  return getCausalEdgeBaseRelationLabel(edge, t);
}

// Backend-generated causal node labels carry an optional structured `label_i18n`
// payload ({ key, params }) so the frontend can localize them. Fall back to the
// raw backend `label` when absent or malformed (backward compatible).
function resolveCausalNodeLabel(node: GraphNodeData, t: CausalTranslate): string {
  const fallback = node.label || node.key;
  const payload = node.payload;
  if (payload && typeof payload === 'object') {
    const labelI18n = (payload as Record<string, unknown>).label_i18n;
    if (labelI18n && typeof labelI18n === 'object') {
      const record = labelI18n as Record<string, unknown>;
      if (typeof record.key === 'string') {
        const params =
          record.params && typeof record.params === 'object'
            ? (record.params as Record<string, unknown>)
            : {};
        return t(record.key, { ...params, defaultValue: fallback });
      }
    }
  }
  return fallback;
}

function getEvidenceTierContextLabel(
  tier: 'low' | 'medium' | 'high',
  t: CausalTranslate,
): string {
  return t(`causal.evidence_${tier}_context`, getEvidenceTierLabel(tier, t));
}

function getCausalEdgeContextLabel(edge: GraphEdgeData, t: CausalTranslate): string | null {
  const contextParts: string[] = [];
  const roundNum = edge.evidence?.source_round_number;
  if (roundNum != null) {
    contextParts.push(t('causal.edge_round_context', {
      round: roundNum,
      defaultValue: 'Round {{round}}',
    }));
  }
  const tier = edge.evidence?.confidence_tier;
  if (tier) {
    contextParts.push(t('causal.edge_confidence_context', {
      tier: getEvidenceTierContextLabel(tier, t),
      defaultValue: 'confidence: {{tier}}',
    }));
  }
  return contextParts.length > 0 ? contextParts.join(' · ') : null;
}

function truncateRelationNodeLabel(label: string): string {
  const normalized = cleanNodeDisplayText(label);
  const chars = Array.from(normalized);
  if (chars.length <= NODE_RELATION_LABEL_MAX_CHARS) return normalized;
  return `${chars.slice(0, NODE_RELATION_LABEL_MAX_CHARS).join('').trimEnd()}...`;
}

function getPayloadRecord(node: GraphNodeData): Record<string, unknown> {
  return node.payload && typeof node.payload === 'object' && !Array.isArray(node.payload)
    ? node.payload as Record<string, unknown>
    : {};
}

function getCompactNodeName(node: GraphNodeData): string {
  const payload = getPayloadRecord(node);
  const agentName = readPayloadString(payload, 'agent_name');
  if (agentName) return truncateRelationNodeLabel(agentName);
  const label = cleanNodeDisplayText(node.label || node.key);
  if (node.type === 'event') {
    const [speaker] = label.split(/[：:]/);
    const normalizedSpeaker = speaker?.trim();
    if (normalizedSpeaker && normalizedSpeaker !== label && Array.from(normalizedSpeaker).length <= 16) {
      return normalizedSpeaker;
    }
  }
  return truncateRelationNodeLabel(label || node.key);
}

function formatRelatedNodeLabel(node: GraphNodeData, t: CausalTranslate): string {
  const typeLabel = getCausalTypeLabel(node.type, t);
  const nodeLabel = getCompactNodeName(node);
  const roundLabel = node.round != null
    ? t('node_context_banner.round', { round: node.round, defaultValue: 'R{{round}}' })
    : '';
  return [typeLabel, nodeLabel, roundLabel].filter(Boolean).join(' ');
}

interface NodeCausalMeaning {
  meaningTitle: string;
  meaningDescription: string;
  causeContext: string[];
  effectContext: string[];
  relationContext: string[];
  cardSummary: string;
}

function getNodeMeaningCopy(type: string, t: CausalTranslate): Pick<NodeCausalMeaning, 'meaningTitle' | 'meaningDescription'> {
  if (type === 'fork') {
    return {
      meaningTitle: t('node_context_banner.meaning_fork_title', { defaultValue: 'Fork card' }),
      meaningDescription: t('node_context_banner.meaning_fork_description', {
        defaultValue: 'This marks where one route split into alternatives. The links explain what triggered the split and what it opened.',
      }),
    };
  }
  if (type === 'outcome') {
    return {
      meaningTitle: t('node_context_banner.meaning_outcome_title', { defaultValue: 'Outcome card' }),
      meaningDescription: t('node_context_banner.meaning_outcome_description', {
        defaultValue: 'This is the endpoint of one branch. Incoming links explain which earlier moves carried the branch here.',
      }),
    };
  }
  return {
    meaningTitle: t('node_context_banner.meaning_event_title', { defaultValue: 'Event card' }),
    meaningDescription: t('node_context_banner.meaning_event_description', {
      defaultValue: 'This records one important move. The links explain why it matters and what it changes next.',
    }),
  };
}

function limitCausalContextLines(lines: string[], t: CausalTranslate): string[] {
  if (lines.length <= NODE_RELATION_CONTEXT_LIMIT) return lines;
  return [
    ...lines.slice(0, NODE_RELATION_CONTEXT_LIMIT),
    t('node_context_banner.relation_more', {
      defaultValue: '+{{count}} more nearby links',
      count: lines.length - NODE_RELATION_CONTEXT_LIMIT,
    }),
  ];
}

function buildNodeCardSummary(
  raw: GraphNodeData,
  t: CausalTranslate,
  causeCount: number,
  effectCount: number,
  relationCount: number,
): string {
  const linkCount = causeCount + effectCount + relationCount;
  if (linkCount === 0) {
    return t('causal.node_card_summary_isolated', {
      defaultValue: 'No nearby links yet',
    });
  }
  if (raw.type === 'fork') {
    return t('causal.node_card_summary_fork', {
      defaultValue: 'Fork point · {{effectCount}} follow-ups',
      effectCount,
    });
  }
  if (raw.type === 'outcome') {
    return t('causal.node_card_summary_outcome', {
      defaultValue: 'Endpoint · {{causeCount}} sources',
      causeCount,
    });
  }
  if (relationCount > 0) {
    return t('causal.node_card_summary_event_with_relations', {
      defaultValue: 'Causes {{causeCount}} · effects {{effectCount}} · links {{relationCount}}',
      causeCount,
      effectCount,
      relationCount,
    });
  }
  return t('causal.node_card_summary_event', {
    defaultValue: 'Causes {{causeCount}} · effects {{effectCount}}',
    causeCount,
    effectCount,
  });
}

function buildNodeCausalMeaning(
  raw: GraphNodeData,
  edges: GraphEdgeData[],
  nodeMap: Map<string, GraphNodeData>,
  t: CausalTranslate,
): NodeCausalMeaning {
  const causeContext: string[] = [];
  const effectContext: string[] = [];
  const relationContext: string[] = [];
  for (const edge of edges) {
    if (edge.source !== raw.id && edge.target !== raw.id) continue;
    const outgoing = edge.source === raw.id;
    const relatedNode = nodeMap.get(outgoing ? edge.target : edge.source);
    if (!relatedNode) continue;
    const relation = getCausalEdgeBaseRelationLabel(edge, t);
    const node = formatRelatedNodeLabel(relatedNode, t);

    if (edge.type === 'supports_stance') {
      relationContext.push(t('node_context_banner.relation_supports', {
        defaultValue: 'It aligns with {{node}} in the same round.',
        node,
      }));
      continue;
    }
    if (edge.type === 'opposes_stance') {
      relationContext.push(t('node_context_banner.relation_opposes', {
        defaultValue: 'It conflicts with {{node}} in the same round.',
        node,
      }));
      continue;
    }
    if (edge.type === 'temporal') {
      if (outgoing) {
        effectContext.push(t('node_context_banner.effect_temporal', {
          defaultValue: '{{node}} happens after this card, so this card sets up the next beat.',
          node,
        }));
      } else {
        causeContext.push(t('node_context_banner.cause_temporal', {
          defaultValue: 'It follows {{node}}, so it continues that timeline.',
          node,
        }));
      }
      continue;
    }
    if (edge.type === 'led_to') {
      if (outgoing) {
        effectContext.push(t('node_context_banner.effect_led_to', {
          defaultValue: 'This card pushes the story toward {{node}}.',
          node,
        }));
      } else {
        causeContext.push(t('node_context_banner.cause_led_to', {
          defaultValue: '{{node}} pushed the story toward this card.',
          node,
        }));
      }
      continue;
    }
    if (edge.type === 'responds_to') {
      if (outgoing) {
        causeContext.push(t('node_context_banner.cause_responds_to', {
          defaultValue: 'It responds to or names {{node}}, so that earlier card is the direct context.',
          node,
        }));
      } else {
        effectContext.push(t('node_context_banner.effect_responds_to', {
          defaultValue: '{{node}} responds to or names this card, so this card becomes what is being answered.',
          node,
        }));
      }
      continue;
    }

    if (outgoing) {
      effectContext.push(t('node_context_banner.effect_default', {
        defaultValue: 'This card links onward to {{node}} by {{relation}}.',
        node,
        relation,
      }));
    } else {
      causeContext.push(t('node_context_banner.cause_default', {
        defaultValue: '{{node}} links into this card by {{relation}}.',
        node,
        relation,
      }));
    }
  }

  const causeCount = causeContext.length;
  const effectCount = effectContext.length;
  const relationCount = relationContext.length;
  const meaningCopy = getNodeMeaningCopy(raw.type, t);
  return {
    ...meaningCopy,
    causeContext: limitCausalContextLines(causeContext, t),
    effectContext: limitCausalContextLines(effectContext, t),
    relationContext: limitCausalContextLines(relationContext, t),
    cardSummary: buildNodeCardSummary(raw, t, causeCount, effectCount, relationCount),
  };
}

function getEvidenceTierLabel(
  tier: 'low' | 'medium' | 'high',
  t: (key: string, fallback: string) => string,
): string {
  return t(`causal.evidence_${tier}`, tier);
}


function extractAvailableBranches(data: Pick<CausalGraphData, 'nodes' | 'available_branches'>): string[] {
  const explicit = Array.isArray(data.available_branches)
    ? data.available_branches.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
  if (explicit.length > 0) return [...new Set(explicit)].sort();

  const branchSet = new Set<string>();
  for (const node of data.nodes ?? []) {
    const payload = (typeof node.payload === 'object' && node.payload && !Array.isArray(node.payload))
      ? node.payload as Record<string, unknown>
      : {};
    const branch = payload.branch_id;
    if (typeof branch === 'string' && branch) branchSet.add(branch);
    const children = payload.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        if (typeof child === 'string' && child) branchSet.add(child);
      }
    }
  }
  return [...branchSet].sort();
}

// ── Layout ──────────────────────────────────────────────────

function layoutDagre(
  nodes: GraphNodeData[],
  edges: GraphEdgeData[],
  t: CausalTranslate,
  compactViewport: boolean,
  reducedMotion: boolean,
): { nodes: Node[]; edges: Edge[] } {
  const isLargeGraph = nodes.length > LARGE_GRAPH_THRESHOLD;
  const nodeW = isLargeGraph ? LARGE_GRAPH_NODE_W : NODE_W;
  const nodeH = isLargeGraph ? LARGE_GRAPH_NODE_H : NODE_H;
  const useTB = compactViewport;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: useTB ? 'TB' : 'LR',
    ranksep: isLargeGraph ? LARGE_GRAPH_RANKSEP : 120,
    nodesep: isLargeGraph ? LARGE_GRAPH_NODESEP : 100,
  });

  for (const n of nodes) g.setNode(n.id, { width: nodeW, height: nodeH });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  const animationsDisabled = reducedMotion || nodes.length > PERF_ANIMATION_LIMIT || edges.length > PERF_ANIMATION_LIMIT;
  const tooltipDisabled = nodes.length > PERF_TOOLTIP_LIMIT;
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  const flowNodes: Node[] = nodes.map(n => {
    const pos = g.node(n.id);
    const fullLabel = resolveCausalNodeLabel(n, t);
    const label = fullLabel.length > 50 ? fullLabel.slice(0, 50) + '\u2026' : fullLabel;
    const typeLabel = getCausalTypeLabel(n.type, t);
    const roundLabel = t('causal.round_label', 'Round');
    const ariaLabel = getCausalNodeActionLabel(typeLabel, fullLabel, t);
    const causalMeaning = buildNodeCausalMeaning(n, edges, nodeMap, t);
    return {
      id: n.id,
      type: 'graphCard',
      position: { x: pos.x - nodeW / 2, y: pos.y - nodeH / 2 },
      focusable: false,
      ariaLabel,
      data: {
        label,
        fullLabel,
        meta: n.round != null ? `${typeLabel} · ${roundLabel} ${n.round}` : typeLabel,
        ariaLabel,
        iconName: NODE_ICONS[n.type] ?? '',
        bgColor: NODE_TYPE_COLORS_HEX[n.type] ?? CAUSAL_COLORS.decorativeNodeFallback,
        borderColor: '',
        accentColor: resolveCausalNodeColors(n.type, 'dark').accent,
        round: n.round ?? undefined,
        summary: isLargeGraph ? undefined : causalMeaning.cardSummary,
        dimmed: false,
        selected: false,
        connected: false,
        expanded: false,
        disableNodeDrag: false,
        tooltipDisabled,
        sourcePos: compactViewport ? 'bottom' : 'right',
        targetPos: compactViewport ? 'top' : 'left',
      },
    };
  });

  // C2: Edge styling from EDGE_STYLES + evidence badge + parallel offset
  const parallelOffsets = buildParallelEdgeIndex(edges);
  const flowEdges: Edge[] = edges.map(e => {
    const style = EDGE_STYLES[e.type];
    const stroke = style?.stroke ?? CAUSAL_COLORS.decorativeEdgeFallback;
    const hasEvidence = e.evidence != null && (
      e.evidence.confidence_tier != null ||
      e.evidence.source_ref != null ||
      e.evidence.source_round_number != null ||
      e.evidence.detail != null
    );
    const tier = hasEvidence ? e.evidence!.confidence_tier : null;
    const tierColor = tier ? EVIDENCE_TIER_COLORS[tier] ?? undefined : undefined;
    const edgeLabel = getCausalEdgeRelationLabel(e, t);
    const evidenceContext = getCausalEdgeContextLabel(e, t);
    const edgeDetail = [evidenceContext, e.evidence?.detail].filter(Boolean).join('\n');
    const parallelOffset = parallelOffsets.get(e.id);
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: edgeLabel,
      animated: animationsDisabled ? false : (style?.animated ?? false),
      style: { stroke, strokeDasharray: style?.strokeDasharray },
      labelStyle: tierColor ? { fill: tierColor, fontSize: 10, fontWeight: 600 } : undefined,
      markerEnd: NO_ARROW_TYPES.has(e.type) ? undefined : { type: MarkerType.ArrowClosed, color: stroke },
      data: {
        ...(edgeLabel ? { label: edgeLabel } : {}),
        ...(edgeDetail ? { detail: edgeDetail } : {}),
        ...(parallelOffset != null ? { parallelOffset } : {}),
      },
      ...(parallelOffset != null ? {
        className: `causal-edge-offset-${parallelOffset > 0 ? 'pos' : parallelOffset < 0 ? 'neg' : 'zero'}`,
        pathOptions: { offset: parallelOffset },
      } : {}),
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}


// ── Component ───────────────────────────────────────────────

export function CausalReviewView() {
  const { t, i18n } = useTranslation();
  const isCompactViewport = useCompactGraphViewport();
  const reducedMotion = useReducedMotion();
  const {
    loading: capLoading,
    enabled,
    error: capabilityError,
    reload: reloadCapability,
  } = useCapabilityCheck('causal_graph');
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawBranchId = searchParams.get('branch_id');
  const branchId = rawBranchId && rawBranchId.trim() ? rawBranchId.trim() : undefined;
  const [graphData, setGraphData] = useState<CausalGraphData | null>(null);
  const [resolvedGraphKey, setResolvedGraphKey] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchOptions, setBranchOptions] = useState<ScenarioBranchOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<CausalGraphErrorState | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeDetail | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [analysisPanelOpen, setAnalysisPanelOpen] = useState(false);
  const [guideMode, setGuideMode] = useState<GuideMode>('summary');
  const { enabled: graphAnalysisEnabled } = useCapabilityCheck('graph_analysis');
  const [serverAnalysis, setServerAnalysis] = useState<GraphAnalysisResponse | null>(null);
  const analysisPanelId = `causal-analysis-${useId().replace(/:/g, '-')}`;
  const [agentNameMap, setAgentNameMap] = useState<Map<string, string>>(new Map());
  // FE-3-seq: append-only sheet state for NodeConversationSheet trigger.
  const [sheetState, setSheetState] = useState<NodeConversationSheetState>(createClosedSheetState);
  // P6 Phase 2: path highlighting
  const [highlightedPath, setHighlightedPath] = useState<Set<string> | null>(null);
  const edgeTypes = useMemo(() => ({ animated: AnimatedEdge }), []);
  // P6 Phase 3: track initial layout for entrance animation
  const layoutAppliedRef = useRef(false);
  const prevFilteredDataRef = useRef<unknown>(null);
  // C5: Agent search
  const [agentSearch, setAgentSearch] = useState('');
  const exportRootId = `causal-graph-${useId().replace(/:/g, '-')}`;
  const legendPanelId = `causal-legend-${useId().replace(/:/g, '-')}`;
  const reactFlowRef = useRef<{ fitView?: (options?: CausalFitViewOptions) => void } | null>(null);
  const pendingFitSignatureRef = useRef<string | null>(null);
  const latestRequestIdRef = useRef(0);
  const detailRestoreFocusRef = useRef<HTMLElement | null>(null);
  const encodedScenarioId = id ? encodeURIComponent(id) : '';

  const currentGraphKey = `${id ?? ''}:${branchId ?? ''}`;
  const previousGraphKeyRef = useRef(currentGraphKey);

  const fetchGraph = useCallback(async () => {
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    setLoading(true);
    setSelectedNode(null);
    setError(null);
    setBranchOptions([]);
    try {
      const url = branchId
        ? `/api/scenario/${encodedScenarioId}/causal-graph?branch_id=${encodeURIComponent(branchId)}`
        : `/api/scenario/${encodedScenarioId}/causal-graph`;
      const res = await fetch(url, { headers: buildSessionHeaders() });
      if (!res.ok) {
        let payload: unknown = null;
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
        throw extractApiErrorState(payload, res.status);
      }
      const data = await res.json();
      if (requestId !== latestRequestIdRef.current) return;
      setGraphData(data);
      setResolvedGraphKey(currentGraphKey);
      setError(null);
      setBranches(extractAvailableBranches(data));
      void (async () => {
        let scenarioBranchOptions: ScenarioBranchOption[] = [];
        try {
          const scenarioRes = await fetch(`/api/scenario/${encodedScenarioId}`, { headers: buildSessionHeaders() });
          if (scenarioRes.ok) {
            const scenarioPayload = await scenarioRes.json();
            const scenarioBranches: unknown[] = Array.isArray(scenarioPayload?.branches)
              ? scenarioPayload.branches
              : [];
            scenarioBranchOptions = scenarioBranches
              .filter((branch): branch is Record<string, unknown> => (
                typeof branch === 'object'
                && branch !== null
                && typeof (branch as Record<string, unknown>).id === 'string'
              ))
              .map((branch) => ({
                id: branch.id as string,
                title: typeof branch.title === 'string' && branch.title.trim().length > 0
                  ? branch.title
                  : branch.id as string,
                probability: typeof branch.probability === 'number' ? branch.probability : null,
              }));
            const agents: unknown[] = Array.isArray(scenarioPayload?.agents) ? scenarioPayload.agents : [];
            const nameMap = new Map<string, string>();
            for (const a of agents) {
              if (a && typeof a === 'object') {
                const rec = a as Record<string, unknown>;
                if (typeof rec.id === 'string' && typeof rec.name === 'string') {
                  nameMap.set(rec.id, rec.name);
                }
              }
            }
            if (nameMap.size > 0) setAgentNameMap(nameMap);
          }
        } catch {
          scenarioBranchOptions = [];
        }
        if (requestId !== latestRequestIdRef.current) return;
        setBranchOptions(scenarioBranchOptions);
      })();
    } catch (err) {
      if (requestId !== latestRequestIdRef.current) return;
      if (err && typeof err === 'object' && ('code' in err || 'status' in err)) {
        const record = err as Partial<CausalGraphErrorState>;
        setResolvedGraphKey(currentGraphKey);
        setError({
          code: typeof record.code === 'string' ? record.code : null,
          status: typeof record.status === 'number' ? record.status : null,
        });
      } else {
        setResolvedGraphKey(currentGraphKey);
        setError({ code: 'NETWORK_ERROR', status: null });
      }
    } finally {
      if (requestId === latestRequestIdRef.current) setLoading(false);
    }
  }, [currentGraphKey, encodedScenarioId, branchId]);

  useEffect(() => {
    if (!id || capabilityError || !enabled) return;
    fetchGraph();
  }, [id, fetchGraph, enabled, capabilityError]);

  useEffect(() => {
    setServerAnalysis(null);
    if (!id || capabilityError || !graphAnalysisEnabled) return;
    let cancelled = false;
    getGraphAnalysis(id, branchId).then((data) => {
      if (!cancelled) setServerAnalysis(data);
    }).catch(() => {
      if (!cancelled) setServerAnalysis(null);
    });
    return () => { cancelled = true; };
  }, [id, branchId, graphAnalysisEnabled, capabilityError]);

  useEffect(() => {
    if (previousGraphKeyRef.current === currentGraphKey) return;
    previousGraphKeyRef.current = currentGraphKey;
    detailRestoreFocusRef.current = null;
    setSheetState(createClosedSheetState());
  }, [currentGraphKey]);

  // C5: Filtered data based on agent or node search, while keeping one-hop context.
  const searchState = useMemo(() => {
    if (!graphData) return { data: null, matchCount: 0, relatedCount: 0 };
    if (!agentSearch.trim()) return { data: graphData, matchCount: 0, relatedCount: 0 };

    const search = agentSearch.toLowerCase();
    const matchingNodes = graphData.nodes.filter(n => {
      const p = (typeof n.payload === 'object' && n.payload ? n.payload : {}) as Record<string, unknown>;
      const agentId = String(p.agent_id ?? '').toLowerCase();
      const agentName = String(p.agent_name ?? '').toLowerCase();
      const label = n.label.toLowerCase();
      return agentId.includes(search) || agentName.includes(search) || label.includes(search);
    });

    const matchedIds = new Set(matchingNodes.map((node) => node.id));
    if (matchedIds.size === 0) {
      return {
        data: { ...graphData, nodes: [], edges: [] },
        matchCount: 0,
        relatedCount: 0,
      };
    }

    const contextualIds = new Set(matchedIds);
    for (const edge of graphData.edges) {
      if (matchedIds.has(edge.source) || matchedIds.has(edge.target)) {
        contextualIds.add(edge.source);
        contextualIds.add(edge.target);
      }
    }

    const contextualNodes = graphData.nodes.filter((node) => contextualIds.has(node.id));
    const contextualEdges = graphData.edges.filter((edge) => contextualIds.has(edge.source) && contextualIds.has(edge.target));

    return {
      data: { ...graphData, nodes: contextualNodes, edges: contextualEdges },
      matchCount: matchingNodes.length,
      relatedCount: Math.max(0, contextualNodes.length - matchingNodes.length),
    };
  }, [graphData, agentSearch]);
  const filteredData = searchState.data;

  const nodeCount = filteredData?.nodes.length ?? 0;
  const edgeCount = filteredData?.edges.length ?? 0;
  const isRefreshingBranch = resolvedGraphKey !== null && resolvedGraphKey !== currentGraphKey;
  const isTextFallback = nodeCount > PERF_TEXT_FALLBACK_LIMIT;
  const hasSourceEdges = (graphData?.edges.length ?? 0) > 0;
  const isRelationlessFallback = nodeCount > 1 && edgeCount === 0 && !hasSourceEdges;
  const isNonInteractiveFallback = isTextFallback || isRelationlessFallback;
  const hasInteractiveGraph = !loading && !error && !isNonInteractiveFallback && nodeCount > 0;
  const causalListAriaLabel = t('causal.a11y_list', 'Causal events list');
  const causalRelationsAriaLabel = t('causal.a11y_relations', 'Causal relations list');

  const guideStats = useMemo<GuideStats | null>(() => {
    const routeSummaries = buildGuideRouteSummaries(graphData);
    const degreeById = buildGuideDegreeMap(graphData);
    const graphNodeById = new Map((graphData?.nodes ?? []).map((node) => [node.id, node]));
    if (serverAnalysis) {
      const godNodes = serverAnalysis.god_nodes.slice(0, 5).map((gn) => {
        const graphNode = graphNodeById.get(gn.node_id);
        const label = graphNode?.label ?? gn.label;
        return {
          id: gn.node_id,
          label,
          fullText: buildGuideNodeFullText(graphNode, label),
          degree: gn.total_degree,
          type: graphNode?.type ?? gn.type,
          inDegree: degreeById.get(gn.node_id)?.inDegree ?? gn.in_degree,
          outDegree: degreeById.get(gn.node_id)?.outDegree ?? gn.out_degree,
        };
      });
      const typeCounts: Record<string, number> = {};
      if (graphData) {
        for (const node of graphData.nodes) {
          typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1;
        }
      }
      return {
        godNodes,
        typeCounts,
        totalNodes: serverAnalysis.summary.total_nodes,
        totalEdges: serverAnalysis.summary.total_edges,
        forkCount: typeCounts.fork ?? 0,
        eventCount: typeCounts.event ?? 0,
        outcomeCount: (typeCounts.outcome ?? 0) + (typeCounts.verdict ?? 0),
        connectedComponents: serverAnalysis.summary.connected_components,
        density: serverAnalysis.summary.density,
        avgDegree: serverAnalysis.summary.avg_degree,
        routeSummaries,
      };
    }
    if (!graphData || graphData.nodes.length === 0) return null;
    const godNodes = [...degreeById.entries()]
      .map(([nodeId, degrees]) => [nodeId, degrees.inDegree + degrees.outDegree] as const)
      .filter(([, degree]) => degree > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([nid, degree]) => {
        const node = graphData.nodes.find((n) => n.id === nid);
        const degrees = degreeById.get(nid);
        const label = node?.label ?? nid;
        return {
          id: nid,
          label,
          fullText: buildGuideNodeFullText(node, label),
          degree,
          type: node?.type ?? 'event',
          inDegree: degrees?.inDegree ?? 0,
          outDegree: degrees?.outDegree ?? 0,
        };
      });
    const typeCounts: Record<string, number> = {};
    for (const node of graphData.nodes) {
      typeCounts[node.type] = (typeCounts[node.type] ?? 0) + 1;
    }
    return {
      godNodes,
      typeCounts,
      totalNodes: graphData.nodes.length,
      totalEdges: graphData.edges.length,
      forkCount: typeCounts.fork ?? 0,
      eventCount: typeCounts.event ?? 0,
      outcomeCount: (typeCounts.outcome ?? 0) + (typeCounts.verdict ?? 0),
      routeSummaries,
    };
  }, [graphData, serverAnalysis]);

  useEffect(() => {
    prevFilteredDataRef.current = filteredData;
    layoutAppliedRef.current = false;
  }, [filteredData]);

  const layoutResult = useMemo(() => {
    if (!filteredData || filteredData.nodes.length === 0 || isNonInteractiveFallback) return { nodes: [], edges: [] };
    const result = layoutDagre(filteredData.nodes, filteredData.edges, t, isCompactViewport, reducedMotion);
    if (!layoutAppliedRef.current && result.nodes.length > 0 && !reducedMotion && result.nodes.length <= LARGE_GRAPH_THRESHOLD) {
      layoutAppliedRef.current = true;
      return {
        ...result,
        nodes: result.nodes.map((n, i) => ({
          ...n,
          className: 'dag-node-enter',
          style: { ...n.style, animationDelay: `${Math.min(i * 30, 300)}ms` },
        })),
      };
    }
    if (!layoutAppliedRef.current && result.nodes.length > 0) {
      layoutAppliedRef.current = true;
    }
    return result;
  }, [filteredData, isCompactViewport, isNonInteractiveFallback, t, reducedMotion]);

  const layoutSignature = useMemo(() => (
    `${layoutResult.nodes.map(n => `${n.id}:${n.position.x}:${n.position.y}`).join('|')}::${layoutResult.edges.map(e => `${e.id}:${e.source}:${e.target}`).join('|')}`
  ), [layoutResult]);
  const layoutResetSignature = useMemo(() => (
    `${layoutSignature}::search=${agentSearch.trim().toLowerCase()}::branch=${branchId ?? ''}::lang=${i18n.language}::compact=${String(isCompactViewport)}`
  ), [agentSearch, branchId, i18n.language, isCompactViewport, layoutSignature]);

  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState(layoutResult.nodes);
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState(layoutResult.edges);
  const flowSignature = useMemo(() => (
    `${flowNodes.map(n => `${n.id}:${n.position.x}:${n.position.y}`).join('|')}::${flowEdges.map(e => `${e.id}:${e.source}:${e.target}`).join('|')}`
  ), [flowNodes, flowEdges]);

  // Sync layout result into state when data/filter changes
  useEffect(() => {
    pendingFitSignatureRef.current = layoutSignature;
    setFlowNodes(layoutResult.nodes);
    setFlowEdges(layoutResult.edges);
    // layoutResult can be re-created during node drag renders; the signature is
    // the structural reset boundary, so user-dragged positions are preserved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutResetSignature, setFlowNodes, setFlowEdges]);

  // Clear stale selection when filtered node disappears
  useEffect(() => {
    if (!selectedNode || !filteredData) return;
    if (!filteredData.nodes.some(n => n.id === selectedNode.id)) setSelectedNode(null);
  }, [selectedNode, filteredData]);

  const edgeStructureKey = useMemo(
    () => flowEdges.map(e => `${e.id}:${e.source}:${e.target}`).join('|'),
    [flowEdges],
  );

  useEffect(() => {
    if (!selectedNode || !flowEdges.length) {
      setHighlightedPath(null);
      return;
    }
    const pathSet = traceConnectedPath(selectedNode.id, flowEdges);
    setHighlightedPath(pathSet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode, edgeStructureKey]);

  const totalElements = (filteredData?.nodes.length ?? 0) + (filteredData?.edges.length ?? 0);
  const skipAnimations = reducedMotion || totalElements > PERF_ANIMATION_LIMIT;

  // Apply highlight to flow nodes
  useEffect(() => {
    setFlowNodes(prev => prev.map(n => ({
      ...n,
      style: {
        ...n.style,
        opacity: highlightedPath ? (highlightedPath.has(n.id) ? 1 : 0.2) : 1,
        transition: skipAnimations ? 'none' : 'opacity 150ms ease',
      },
      data: {
        ...n.data,
        selected: selectedNode?.id === n.id,
        connected: Boolean(highlightedPath && selectedNode?.id !== n.id && highlightedPath.has(n.id)),
        expanded: selectedNode?.id === n.id,
        controlsId: 'causal-node-detail-panel',
        dimmed: highlightedPath ? !highlightedPath.has(n.id) : false,
      },
    })));
  }, [highlightedPath, selectedNode?.id, setFlowNodes, skipAnimations]);

  // Apply highlight to flow edges
  useEffect(() => {
    setFlowEdges(prev => prev.map(e => ({
      ...e,
      type: (highlightedPath?.has(e.id) && !skipAnimations) ? 'animated' : undefined,
      selected: highlightedPath?.has(e.id) ?? false,
      style: {
        ...e.style,
        opacity: highlightedPath ? (highlightedPath.has(e.id) ? 1 : 0.2) : 1,
        transition: skipAnimations ? 'none' : 'opacity 150ms ease',
      },
    })));
  }, [highlightedPath, setFlowEdges, skipAnimations]);

  const nodes = flowNodes;
  const edges = flowEdges;
  const isLargeNodeCount = nodeCount > LARGE_GRAPH_THRESHOLD;
  const viewportFitOptions = useMemo<CausalFitViewOptions>(() => ({
    padding: isCompactViewport ? 0.2 : 0.24,
    duration: 0,
    ...(isLargeNodeCount ? { minZoom: LARGE_GRAPH_FIT_MIN_ZOOM } : {}),
  }), [isCompactViewport, isLargeNodeCount]);

  const fitPendingViewport = useCallback((expectedSignature: string) => {
    if (!pendingFitSignatureRef.current || pendingFitSignatureRef.current !== expectedSignature) return;
    if (flowNodes.length === 0 || flowNodes.length > PERF_TEXT_FALLBACK_LIMIT) {
      pendingFitSignatureRef.current = null;
      return;
    }
    if (!reactFlowRef.current) return;
    pendingFitSignatureRef.current = null;
    reactFlowRef.current.fitView?.(viewportFitOptions);
  }, [flowNodes.length, viewportFitOptions]);

  useEffect(() => {
    fitPendingViewport(flowSignature);
  }, [fitPendingViewport, flowSignature, layoutResetSignature]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const className = 'has-causal-graph';
    if (!hasInteractiveGraph) {
      document.body.classList.remove(className);
      return;
    }

    document.body.classList.add(className);
    return () => {
      document.body.classList.remove(className);
    };
  }, [hasInteractiveGraph]);

  const rawNodeMap = useMemo(() => {
    const m = new Map<string, GraphNodeData>();
    if (filteredData) for (const n of filteredData.nodes) m.set(n.id, n);
    return m;
  }, [filteredData]);
  const relationLines = useMemo(() => (
    (filteredData?.edges ?? []).map((edge) => {
      const source = rawNodeMap.get(edge.source);
      const target = rawNodeMap.get(edge.target);
      if (!source || !target) return null;
      let line = t('causal.edge_relation', {
        defaultValue: '{{source}} {{relation}} {{target}}',
        source: source.label || source.key,
        relation: getCausalEdgeRelationLabel(edge, t),
        target: target.label || target.key,
      });
      const contextLabel = getCausalEdgeContextLabel(edge, t);
      if (contextLabel) {
        line += ` ${t('causal.edge_context_suffix', {
          context: contextLabel,
          defaultValue: '({{context}})',
        })}`;
      }
      return line;
    }).filter(Boolean) as string[]
  ), [filteredData?.edges, rawNodeMap, t]);

  const availableBranches = useMemo(() => {
    if (!branchId) return branches;
    return branches.includes(branchId) ? branches : [branchId, ...branches];
  }, [branchId, branches]);

  const branchOptionMap = useMemo(() => (
    new Map(branchOptions.map((option) => [option.id, option]))
  ), [branchOptions]);

  const availableBranchOptions = useMemo(() => (
    availableBranches.map((candidateId) => {
      const option = branchOptionMap.get(candidateId);
      return option ?? {
        id: candidateId,
        title: candidateId,
        probability: null,
      };
    })
  ), [availableBranches, branchOptionMap]);

  const buildBranchOptionLabel = useCallback((option: ScenarioBranchOption) => {
    if (option.probability == null) return option.title;
    return `${option.title} · ${(option.probability * 100).toFixed(1)}%`;
  }, []);

  const graphAriaLabelConfig = useMemo(() => ({
    'node.a11yDescription.default': t('common.graph_node_a11y', 'Graph node. Press Enter or Space to open details.'),
    'node.a11yDescription.keyboardDisabled': t('common.graph_node_a11y', 'Graph node. Press Enter or Space to open details.'),
    'edge.a11yDescription.default': t('common.graph_edge_a11y', 'Graph edge. Relation details are available in the text summary below.'),
    'controls.ariaLabel': t('common.graph_controls', 'Graph controls'),
    'controls.zoomIn.ariaLabel': t('common.graph_zoom_in', 'Zoom in'),
    'controls.zoomOut.ariaLabel': t('common.graph_zoom_out', 'Zoom out'),
    'controls.fitView.ariaLabel': t('common.graph_fit_view', 'Fit view'),
    'controls.interactive.ariaLabel': t('common.graph_toggle_interactivity', 'Toggle interactivity'),
    'minimap.ariaLabel': t('common.graph_minimap', 'Mini map'),
    'handle.ariaLabel': t('common.graph_handle', 'Graph handle'),
  }), [t]);

  const openNodeDetail = useCallback((nodeId: string, triggerElement?: HTMLElement | null) => {
    const raw = rawNodeMap.get(nodeId);
    if (!raw) return;
    detailRestoreFocusRef.current = triggerElement?.isConnected ? triggerElement : null;
    const adjacentEvidence = (filteredData?.edges ?? [])
      .filter(e => e.source === nodeId || e.target === nodeId)
      .filter(e => e.evidence != null && (
        e.evidence.confidence_tier != null ||
        e.evidence.source_ref != null ||
        e.evidence.source_round_number != null ||
        e.evidence.detail != null
      ))
      .map(e => e.evidence!);
    let enrichedPayload = raw.payload;
    if (raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)) {
      const p = raw.payload as Record<string, unknown>;
      if (typeof p.agent_id === 'string' && agentNameMap.has(p.agent_id)) {
        enrichedPayload = { ...p, agent_name: agentNameMap.get(p.agent_id) };
      }
    }
    const localizedNodeLabel = resolveCausalNodeLabel(raw, t);
    setSelectedNode({
      id: raw.id,
      label: localizedNodeLabel,
      type: raw.type,
      round: raw.round,
      payload: enrichedPayload,
      ...(adjacentEvidence.length > 0 ? { evidenceList: adjacentEvidence } : {}),
    });
    const rawPayload = typeof raw.payload === 'object' && raw.payload !== null && !Array.isArray(raw.payload)
      ? raw.payload as Record<string, unknown>
      : {};
    const agentId = typeof rawPayload.agent_id === 'string' ? rawPayload.agent_id : undefined;
    const agentName = agentId ? agentNameMap.get(agentId) : undefined;
    const enrichedAgentName = typeof rawPayload.agent_name === 'string'
      ? rawPayload.agent_name
      : agentName;
    const conversationExcerpt = buildNodeConversationExcerpt(raw, rawPayload);
    const causalMeaning = buildNodeCausalMeaning(raw, filteredData?.edges ?? [], rawNodeMap, t);
    const targetLabel = enrichedAgentName
      ?? (raw.type === 'outcome'
        ? t('node_context_banner.target_outcome_analyst_label', 'Outcome analyst')
        : t('node_context_banner.target_graph_analyst_label', 'Graph analyst'));
    const targetDescription = enrichedAgentName
      ? t(
        'node_context_banner.target_agent_description',
        'Answers around this speaker and the selected graph context.',
      )
      : raw.type === 'outcome'
        ? t(
          'node_context_banner.target_outcome_analyst_description',
          'Explains this outcome from its branch, nearby events, and causal links.',
        )
        : t(
          'node_context_banner.target_graph_analyst_description',
          'Explains this node from the branch, round, and nearby causal links.',
        );
    setSheetState({
      open: true,
      scenarioId: id ?? '',
      identityId: null,
      origin: {
        surface: 'causal',
        nodeId: raw.id,
        nodeType: raw.type,
        excerpt: conversationExcerpt,
        branchId: typeof rawPayload.branch_id === 'string' ? rawPayload.branch_id : (branchId ?? null),
        roundNumber: raw.round,
        agentName: enrichedAgentName,
        nodeLabel: localizedNodeLabel,
        typeColor: NODE_TYPE_COLORS_HEX[raw.type] ?? NODE_TYPE_COLORS_HEX.event,
        targetLabel,
        targetDescription,
        meaningTitle: causalMeaning.meaningTitle,
        meaningDescription: causalMeaning.meaningDescription,
        causeContext: causalMeaning.causeContext,
        effectContext: causalMeaning.effectContext,
        relationContext: causalMeaning.relationContext,
      },
    });
  }, [rawNodeMap, filteredData, id, agentNameMap, branchId, t]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    const triggerElement = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-graph-node-card="true"]')
      : null;
    const fallbackTrigger = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    openNodeDetail(node.id, triggerElement ?? fallbackTrigger);
  }, [openNodeDetail]);

  // C3: Background click resets highlight + closes detail panel
  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setHighlightedPath(null);
  }, []);
  const resetViewport = useCallback(() => {
    reactFlowRef.current?.fitView?.(viewportFitOptions);
  }, [viewportFitOptions]);
  const guideDetailsOpen = guideMode === 'details';

  if (capLoading) return <div style={{ padding: '3rem', textAlign: 'center' }}>{t('common.loading', 'Loading...')}</div>;
  if (capabilityError) return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>
      <h1>{t('common.capability_error_title', 'Cannot verify feature')}</h1>
      <p role="alert" style={{ color: CAUSAL_COLORS.textError }}>
        {t('common.capability_error', 'Unable to verify feature availability. Please try again.')}
      </p>
      <button
        type="button"
        onClick={() => void reloadCapability?.()}
        style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${CAUSAL_COLORS.borderDefault}`, background: 'transparent', color: CAUSAL_COLORS.textLink, cursor: 'pointer', marginRight: '0.75rem' }}
      >
        {t('common.retry', 'Retry')}
      </button>
      <Link to={id ? `/result/${encodedScenarioId}` : '/'} style={{ color: CAUSAL_COLORS.textLink }}>{t('common.back_to_result', 'Back to Result')}</Link>
    </div>
  );
  if (!enabled) return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '3rem', textAlign: 'center' }}>
      <p style={{ color: CAUSAL_COLORS.textMuted }}>{t('causal.feature_disabled', 'Causal graph feature is not enabled.')}</p>
      <Link to={id ? `/result/${encodedScenarioId}` : '/'} style={{ color: CAUSAL_COLORS.textLink }}>{t('common.back_to_result', 'Back to Result')}</Link>
    </div>
  );

  if (loading || isRefreshingBranch) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1rem', textAlign: 'center' }}>
        <p>{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '3rem 1rem', textAlign: 'center' }}>
        <h1>{t('causal.title', 'Causal Graph')}</h1>
        <p role="alert" style={{ color: CAUSAL_COLORS.textError }}>{getCausalErrorMessage(error, t)}</p>
        <button
          onClick={() => void fetchGraph()}
          style={{ padding: '4px 10px', borderRadius: 4, border: `1px solid ${CAUSAL_COLORS.borderDefault}`, background: 'transparent', color: CAUSAL_COLORS.textLink, cursor: 'pointer', marginRight: '0.75rem' }}
        >
          {t('common.retry', 'Retry')}
        </button>
        <Link to={`/result/${encodedScenarioId}`} style={{ color: CAUSAL_COLORS.textLink }}>
          {t('common.back_to_result', 'Back to Result')}
        </Link>
      </div>
    );
  }

  return (
    <Tooltip.Provider delayDuration={300}>
      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .causal-review-shell .react-flow__node,
          .causal-review-shell .react-flow__edge {
            transition: none !important;
          }
          .causal-review-shell .react-flow__edge path {
            transition: none !important;
          }
        }
      `}</style>
      <div
        style={{
          height: isCompactViewport ? 'auto' : '100dvh',
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
        }}
        className="causal-review-shell"
      >
        <div
          style={{
            padding: isCompactViewport ? '0.75rem' : '1rem',
            borderBottom: `1px solid ${CAUSAL_COLORS.borderSubtle}`,
            display: 'grid',
            gap: '0.75rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: '1rem',
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'grid', gap: '0.35rem', minWidth: 0 }}>
              <Link to={`/result/${encodedScenarioId}`} style={{ color: CAUSAL_COLORS.textLink, textDecoration: 'none', fontSize: '0.92rem' }}>
                &larr; {t('common.back_to_result', 'Back to Result')}
              </Link>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', flexWrap: 'wrap' }}>
                <h1 style={{ margin: 0, fontSize: isCompactViewport ? '1.08rem' : '1.24rem' }}>{t('causal.title', 'Causal Graph')}</h1>
                <span style={{ color: CAUSAL_COLORS.textMuted, fontSize: '0.9rem' }}>
                  {nodeCount} {t('causal.nodes', 'nodes')} &middot; {edgeCount} {t('causal.edges', 'edges')}
                </span>
              </div>
            </div>
            {agentSearch.trim() ? (
              <div style={{ fontSize: '0.78rem', color: CAUSAL_COLORS.textMuted, maxWidth: 360 }}>
                {searchState.matchCount > 0
                  ? t('causal.search_summary', {
                      defaultValue: '{{matches}} direct matches · {{related}} related nodes kept for context',
                      matches: searchState.matchCount,
                      related: searchState.relatedCount,
                    })
                  : t('causal.no_results', 'No nodes match your search.')}
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {(availableBranches.length > 1 || Boolean(branchId)) && (
              <select
                value={branchId ?? ''}
                onChange={e => {
                  const val = e.target.value;
                  if (val) setSearchParams({ branch_id: val });
                  else setSearchParams({});
                }}
                style={{
                  minHeight: isCompactViewport ? 40 : 36,
                  padding: '6px 10px',
                  borderRadius: 10,
                  border: `1px solid ${CAUSAL_COLORS.borderDefault}`,
                  background: CAUSAL_COLORS.surfaceField,
                  color: CAUSAL_COLORS.inputText,
                  fontSize: '0.9rem',
                }}
                aria-label={t('causal.branch_select', 'Select branch')}
              >
                <option value="">{t('causal.all_branches', 'All branches')}</option>
                {availableBranchOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {buildBranchOptionLabel(option)}
                  </option>
                ))}
              </select>
            )}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                minWidth: isCompactViewport ? 'min(100%, 18rem)' : '18rem',
                flex: isCompactViewport ? '1 1 100%' : '0 1 auto',
              }}
            >
              <input
                type="search"
                value={agentSearch}
                onChange={e => setAgentSearch(e.target.value)}
                placeholder={t('causal.search_agent', 'Search nodes or agents...')}
                aria-label={t('causal.search_agent', 'Search nodes or agents...')}
                style={{
                  minHeight: isCompactViewport ? 40 : 36,
                  padding: '6px 10px',
                  borderRadius: 10,
                  border: `1px solid ${CAUSAL_COLORS.borderDefault}`,
                  background: CAUSAL_COLORS.surfaceField,
                  color: CAUSAL_COLORS.inputText,
                  fontSize: '0.9rem',
                  width: '100%',
                }}
              />
              {agentSearch.trim() ? (
                <button
                  type="button"
                  onClick={() => setAgentSearch('')}
                  style={{
                    minHeight: isCompactViewport ? 40 : 36,
                    padding: '6px 12px',
                    borderRadius: 10,
                    border: `1px solid ${CAUSAL_COLORS.borderDefault}`,
                    background: 'transparent',
                    color: CAUSAL_COLORS.textSecondary,
                    cursor: 'pointer',
                    fontSize: '0.85rem',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('common.clear', 'Clear')}
                </button>
              ) : null}
            </div>
            {nodeCount > 0 && !isNonInteractiveFallback && (
              <ExportPanel
                containerSelector={`.causal-graph-export-target[data-export-root="${exportRootId}"]`}
                filenamePrefix="causal-graph"
              />
            )}
            {nodeCount > 0 && !isNonInteractiveFallback && isCompactViewport && (
              <button
                type="button"
                onClick={resetViewport}
                style={{
                  minHeight: 40,
                  padding: '6px 12px',
                  borderRadius: 10,
                  border: `1px solid ${CAUSAL_COLORS.borderDefault}`,
                  background: 'transparent',
                  color: CAUSAL_COLORS.textLink,
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                {t('common.graph_fit_view', 'Fit view')}
              </button>
            )}
            <button
              type="button"
              onClick={() => setLegendOpen(v => !v)}
              aria-expanded={legendOpen}
              aria-controls={legendPanelId}
              style={{
                minHeight: isCompactViewport ? 40 : 36,
                padding: '6px 12px',
                borderRadius: 10,
                border: `1px solid ${CAUSAL_COLORS.borderDefault}`,
                background: 'transparent',
                color: CAUSAL_COLORS.textLink,
                cursor: 'pointer',
                fontSize: '0.85rem',
              }}
            >
              {legendOpen ? t('causal.hide_legend', 'Hide Legend') : t('causal.show_legend', 'Legend')}
            </button>
            {serverAnalysis && (
              <button
                type="button"
                onClick={() => setAnalysisPanelOpen(v => !v)}
                aria-expanded={analysisPanelOpen}
                aria-controls={analysisPanelId}
                style={{
                  minHeight: isCompactViewport ? 40 : 36,
                  padding: '6px 12px',
                  borderRadius: 10,
                  border: `1px solid ${CAUSAL_COLORS.borderDefault}`,
                  background: 'transparent',
                  color: CAUSAL_COLORS.textLink,
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                {t('causal.analysis_toggle', 'Show Analysis')}
              </button>
            )}
          </div>
          {nodeCount > 0 && !isNonInteractiveFallback && isCompactViewport ? (
            <span style={{ color: CAUSAL_COLORS.textMuted, fontSize: '0.76rem' }}>
              {t('common.graph_mobile_hint', 'Drag to pan. Pinch or use the graph controls to zoom.')}
            </span>
          ) : null}
        </div>
        {/* B6: Collapsible Legend */}
        {legendOpen && (
          <div id={legendPanelId} style={{ padding: '0.5rem 1rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.7rem', color: CAUSAL_COLORS.textMuted, borderBottom: `1px solid ${CAUSAL_COLORS.borderSubtle}` }}>
            {Object.entries(NODE_TYPE_COLORS_HEX).filter(([k]) => ['event', 'intervention', 'stance_shift', 'fork', 'outcome', 'verdict'].includes(k)).map(([type, color]) => (
              <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
                {t(`causal.type_${type}`, type.replace('_', ' '))}
              </span>
            ))}
          </div>
        )}

        {/* P1-2: Graph Analysis panel — gated on serverAnalysis being loaded. */}
        {serverAnalysis && analysisPanelOpen && (
          <div id={analysisPanelId} className="causal-analysis-panel" role="region" aria-label={t('causal.analysis_title', 'Graph Analysis')}>
            <div className="causal-analysis-panel__header">
              <h2 className="causal-analysis-panel__title">{t('causal.analysis_title', 'Graph Analysis')}</h2>
              <button
                type="button"
                className="causal-analysis-panel__close"
                onClick={() => setAnalysisPanelOpen(false)}
                aria-label={t('causal.guide_close', 'Close')}
              >
                ✕
              </button>
            </div>
            <div className="causal-analysis-panel__stats">
              <div className="causal-analysis-panel__stat">
                <span className="causal-analysis-panel__stat-label">{t('causal.analysis_nodes', 'Nodes')}</span>
                <span className="causal-analysis-panel__stat-value">{serverAnalysis.summary.total_nodes}</span>
              </div>
              <div className="causal-analysis-panel__stat">
                <span className="causal-analysis-panel__stat-label">{t('causal.analysis_edges', 'Edges')}</span>
                <span className="causal-analysis-panel__stat-value">{serverAnalysis.summary.total_edges}</span>
              </div>
              <div className="causal-analysis-panel__stat">
                <span className="causal-analysis-panel__stat-label">{t('causal.analysis_density', 'Density')}</span>
                <span className="causal-analysis-panel__stat-value">{(serverAnalysis.summary.density ?? 0).toFixed(3)}</span>
              </div>
              <div className="causal-analysis-panel__stat">
                <span className="causal-analysis-panel__stat-label">{t('causal.analysis_avg_max_degree', 'Avg / Max Degree')}</span>
                <span className="causal-analysis-panel__stat-value">
                  {(serverAnalysis.summary.avg_degree ?? 0).toFixed(2)} / {serverAnalysis.summary.max_degree ?? 0}
                </span>
              </div>
              <div className="causal-analysis-panel__stat">
                <span className="causal-analysis-panel__stat-label">{t('causal.analysis_components', 'Components')}</span>
                <span className="causal-analysis-panel__stat-value">{serverAnalysis.summary.connected_components}</span>
              </div>
            </div>
            {serverAnalysis.god_nodes.length > 0 && (
              <div className="causal-analysis-panel__section">
                <span className="causal-analysis-panel__section-title">{t('causal.analysis_god_nodes', 'Key Nodes')}</span>
                <div className="causal-analysis-panel__god-nodes">
                  {serverAnalysis.god_nodes.slice(0, 5).map((gn) => {
                    const typeLabel = getCausalTypeLabel(gn.type, t);
                    return (
                      <div key={gn.node_id} className="causal-analysis-panel__god-node">
                        <span className="causal-analysis-panel__god-node-label" title={gn.label}>{gn.label}</span>
                        <span className="causal-analysis-panel__god-node-meta">
                          {typeLabel} · {gn.total_degree} ({gn.in_degree} in / {gn.out_degree} out)
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {serverAnalysis.cross_branch_edges.length > 0 && (
              <div className="causal-analysis-panel__section">
                <span className="causal-analysis-panel__section-title">{t('causal.analysis_cross_branch', 'Cross-branch Edges')}</span>
                <div className="causal-analysis-panel__cross-branch">
                  {serverAnalysis.cross_branch_edges.slice(0, 8).map((edge) => (
                    <div
                      key={`${edge.source_branch}->${edge.target_branch}`}
                      className="causal-analysis-panel__cross-branch-row"
                    >
                      <span title={edge.source_branch}>{edge.source_branch.slice(0, 8)}</span>
                      <span className="causal-analysis-panel__cross-branch-arrow" aria-hidden="true">→</span>
                      <span title={edge.target_branch}>{edge.target_branch.slice(0, 8)}</span>
                      <span className="causal-analysis-panel__cross-branch-count">
                        {edge.edge_count} · {t(`causal.edge_${edge.primary_type}`, edge.primary_type)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Object.keys(serverAnalysis.degree_distribution).length > 0 && (() => {
              const entries = Object.entries(serverAnalysis.degree_distribution)
                .map(([k, v]) => [k, Number(v)] as const)
                .filter(([, v]) => Number.isFinite(v))
                .sort((a, b) => {
                  const na = Number(a[0]), nb = Number(b[0]);
                  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
                  if (Number.isFinite(na)) return -1;
                  if (Number.isFinite(nb)) return 1;
                  return a[0].localeCompare(b[0]);
                });
              if (entries.length === 0) return null;
              const maxCount = entries.reduce((max, [, count]) => Math.max(max, count), 0);
              return (
                <div className="causal-analysis-panel__section">
                  <span className="causal-analysis-panel__section-title">{t('causal.analysis_degree_distribution', 'Degree Distribution')}</span>
                  <div className="causal-analysis-panel__degree-dist">
                    {entries.map(([degree, count]) => {
                      const pct = maxCount > 0 ? Math.max(2, (count / maxCount) * 100) : 0;
                      return (
                        <div key={degree} className="causal-analysis-panel__degree-row">
                          <span className="causal-analysis-panel__degree-label">{t('causal.analysis_degree_n', 'Degree {{degree}}', { degree })}</span>
                          <span className="causal-analysis-panel__degree-bar-track" aria-hidden="true">
                            <span className="causal-analysis-panel__degree-bar-fill" style={{ width: `${pct}%` }} />
                          </span>
                          <span className="causal-analysis-panel__degree-count">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* Guide panel: summary by default; details can be expanded or fully collapsed. */}
        {guideStats && guideMode !== 'closed' && (
          <div id="causal-guide-panel" style={{ padding: '0.75rem 1rem', borderBottom: `1px solid ${CAUSAL_COLORS.borderSubtle}`, background: CAUSAL_COLORS.surfacePanel, fontSize: '0.78rem', color: CAUSAL_COLORS.textBody }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ color: CAUSAL_COLORS.textStrong, fontSize: '0.82rem' }}>
                {t('causal.guide_title', 'Graph Overview')}
                {agentSearch ? <span style={{ color: CAUSAL_COLORS.textMuted, fontWeight: 'normal', fontSize: '0.7rem' }}>{' '}({t('causal.guide_full_graph', 'full graph')})</span> : null}
              </strong>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setGuideMode(guideDetailsOpen ? 'summary' : 'details')}
                  aria-expanded={guideDetailsOpen}
                  aria-controls="causal-guide-details"
                  style={{ background: 'none', border: 'none', color: CAUSAL_COLORS.textLink, cursor: 'pointer', fontSize: '0.7rem', padding: '2px 0' }}
                >
                  {guideDetailsOpen
                    ? t('causal.guide_collapse_details', 'Hide details')
                    : t('causal.guide_expand_details', 'Show details')}
                </button>
                <button
                  type="button"
                  onClick={() => setGuideMode('closed')}
                  style={{ background: 'none', border: 'none', color: CAUSAL_COLORS.textMuted, cursor: 'pointer', fontSize: '0.7rem', padding: '2px 6px' }}
                  aria-label={t('causal.guide_close', 'Close guide')}
                  aria-expanded={true}
                  aria-controls="causal-guide-panel"
                >
                  ✕
                </button>
              </div>
            </div>
            <p style={{ color: CAUSAL_COLORS.textSecondary, fontSize: '0.76rem', lineHeight: 1.55, margin: '0 0 10px' }}>
              {guideStats.forkCount > 0 && guideStats.outcomeCount > 0
                ? t('causal.guide_story', {
                  forks: guideStats.forkCount,
                  events: guideStats.eventCount,
                  outcomes: guideStats.outcomeCount,
                  edges: guideStats.totalEdges,
                  defaultValue: 'This graph connects {{forks}} forks, {{events}} events, and {{outcomes}} outcomes through {{edges}} links. Start at the forks, then follow the events into their outcomes.',
                })
                : guideStats.forkCount > 0
                  ? t('causal.guide_story_no_outcomes', {
                    forks: guideStats.forkCount,
                    events: guideStats.eventCount,
                    edges: guideStats.totalEdges,
                    defaultValue: 'This graph has {{forks}} forks and {{events}} events, but no clear outcome node yet. Start with the events that triggered each split.',
                  })
                  : t('causal.guide_story_no_forks', {
                    events: guideStats.eventCount,
                    outcomes: guideStats.outcomeCount,
                    edges: guideStats.totalEdges,
                    defaultValue: 'This graph is mainly a cause-and-effect timeline: {{events}} events and {{outcomes}} outcomes connected by {{edges}} links.',
                  })}
            </p>
            <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: 10 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 7px', border: `1px solid ${CAUSAL_COLORS.borderSubtle}`, borderRadius: 6, background: CAUSAL_COLORS.surfaceField }}>
                {t('causal.guide_stats_label', 'Graph size')}: {guideStats.totalNodes} {t('causal.nodes', 'nodes')} · {guideStats.totalEdges} {t('causal.edges', 'edges')}
              </span>
              {Object.entries(guideStats.typeCounts).map(([type, count]) => (
                <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 7px', border: `1px solid ${CAUSAL_COLORS.borderSubtle}`, borderRadius: 6, background: CAUSAL_COLORS.surfaceField }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: NODE_TYPE_COLORS_HEX[type as keyof typeof NODE_TYPE_COLORS_HEX] ?? CAUSAL_COLORS.decorativeLegendFallback, display: 'inline-block' }} />
                  {t(`causal.type_${type}`, type.replace('_', ' '))}: {count as number}
                </span>
              ))}
              {'density' in guideStats && guideStats.density != null ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 7px', border: `1px solid ${CAUSAL_COLORS.borderSubtle}`, borderRadius: 6, background: CAUSAL_COLORS.surfaceField }}>
                  {t('causal.density', 'density')}: {(guideStats.density as number).toFixed(3)}
                </span>
              ) : null}
              {'connectedComponents' in guideStats && guideStats.connectedComponents != null ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 7px', border: `1px solid ${CAUSAL_COLORS.borderSubtle}`, borderRadius: 6, background: CAUSAL_COLORS.surfaceField }}>
                  {t('causal.components', 'components')}: {guideStats.connectedComponents as number}
                </span>
              ) : null}
            </div>
            {guideDetailsOpen && (
              <div id="causal-guide-details">
                {guideStats.routeSummaries.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ color: CAUSAL_COLORS.textMuted, fontSize: '0.7rem', marginBottom: 5 }}>{t('causal.guide_routes_title', 'How branches resolve')}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 6 }}>
                      {guideStats.routeSummaries.map((route) => {
                        const hiddenTargetCount = Math.max(0, route.targetCount - route.targetLabels.length);
                        return (
                          <div key={route.id} style={{ border: `1px solid ${CAUSAL_COLORS.borderSubtle}`, borderRadius: 8, padding: '7px 8px', background: CAUSAL_COLORS.surfaceField, minWidth: 0 }}>
                            <div style={{ minWidth: 0 }}>
                              <GuidePreviewText label={route.sourceLabel} t={t} />
                            </div>
                            <div style={{ color: CAUSAL_COLORS.textMuted, fontSize: '0.7rem', marginTop: 3 }}>
                              {t('causal.guide_route_connector', 'leads to')}
                            </div>
                            <div style={{ display: 'grid', gap: 4, color: CAUSAL_COLORS.textBody, marginTop: 3, overflowWrap: 'anywhere' }}>
                              {route.targetLabels.map((label) => (
                                <GuidePreviewText key={label} label={label} t={t} tone="body" />
                              ))}
                              {hiddenTargetCount > 0 ? ` ${t('causal.guide_route_more', { count: hiddenTargetCount, defaultValue: '+{{count}} more' })}` : ''}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {guideStats.godNodes.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{ color: CAUSAL_COLORS.textMuted, fontSize: '0.7rem', marginBottom: 5 }}>{t('causal.guide_key_nodes', 'Start with these nodes')}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 6 }}>
                      {guideStats.godNodes.map((gn) => {
                      const typeLabel = getCausalTypeLabel(gn.type, t);
                      const guideLabel = gn.fullText ?? gn.label;
                      const fullLabel = `${guideLabel} - ${t('causal.guide_link_count', { count: gn.degree, defaultValue: '{{count}} links' })}`;
                      const reasonKey = gn.type === 'fork'
                        ? 'causal.guide_key_node_reason_fork'
                        : gn.type === 'outcome' || gn.type === 'verdict'
                          ? 'causal.guide_key_node_reason_outcome'
                          : gn.type === 'intervention'
                            ? 'causal.guide_key_node_reason_intervention'
                            : 'causal.guide_key_node_reason_event';
                      return (
                        <div key={gn.id} aria-label={fullLabel} title={fullLabel} style={{ border: `1px solid ${CAUSAL_COLORS.borderSubtle}`, borderRadius: 8, padding: '7px 8px', background: CAUSAL_COLORS.surfaceField, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, minWidth: 0 }}>
                            <span style={{ flex: '0 0 auto', color: CAUSAL_COLORS.textMuted, fontSize: '0.68rem' }}>{typeLabel}</span>
                            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                              <GuidePreviewText label={gn.label} fullText={gn.fullText} t={t} />
                            </div>
                          </div>
                          <div style={{ color: CAUSAL_COLORS.textMuted, fontSize: '0.68rem', marginBottom: 4 }}>
                            {t('causal.guide_link_count', { count: gn.degree, defaultValue: '{{count}} links' })}
                            {' · '}
                            {t('causal.guide_link_breakdown', { incoming: gn.inDegree, outgoing: gn.outDegree, defaultValue: '{{incoming}} in · {{outgoing}} out' })}
                          </div>
                          <div style={{ color: CAUSAL_COLORS.textBody, lineHeight: 1.45 }}>
                            {t(reasonKey, 'High-connectivity node: read its causes and follow-ups to understand the route.')}
                          </div>
                        </div>
                      );
                    })}
                    </div>
                  </div>
                )}
                <p style={{ color: CAUSAL_COLORS.textMuted, fontSize: '0.7rem', margin: '0 0 4px' }}>
                  {t('causal.guide_relation_explainer', 'Link count means incoming plus outgoing relationships. It is context size, not a quality score.')}
                </p>
                <p style={{ color: CAUSAL_COLORS.textMuted, fontSize: '0.7rem', margin: 0 }}>
                  {t('causal.guide_hint', 'Click a node to read its full card, causes, effects, and chat target.')}
                </p>
              </div>
            )}
          </div>
        )}
        {guideStats && guideMode === 'closed' && (
          <button
            type="button"
            onClick={() => setGuideMode('summary')}
            aria-expanded={false}
            aria-controls="causal-guide-panel"
            style={{ display: 'block', width: '100%', padding: '4px 1rem', background: 'none', border: 'none', borderBottom: `1px solid ${CAUSAL_COLORS.borderHairline}`, color: CAUSAL_COLORS.textMuted, fontSize: '0.68rem', cursor: 'pointer', textAlign: 'left' }}
          >
            <span aria-hidden="true">{'▶'} </span>{t('causal.guide_show', 'Show graph overview')}
          </button>
        )}

        {nodeCount === 0 && !agentSearch ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
            <div className="dag-empty-ghost" data-testid="dag-empty-state">
              <div className="dag-empty-skeleton dag-empty-shimmer">
                <div className="dag-empty-node" />
                <div className="dag-empty-edge" />
                <div className="dag-empty-node" />
                <div className="dag-empty-edge" />
                <div className="dag-empty-node" />
              </div>
              <p className="dag-empty-text">{t('dag.empty_state_title', 'No graph data yet')}</p>
              <p className="dag-empty-text" style={{ fontSize: '0.78rem' }}>
                {t('dag.empty_state_body', 'Run a simulation to generate causal relationships')}
              </p>
              <Link to="/" className="dag-empty-cta">
                {t('dag.empty_state_cta', 'Back to input')}
              </Link>
            </div>
          </div>
        ) : nodeCount === 0 && agentSearch ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <p style={{ color: CAUSAL_COLORS.textMuted }}>{t('causal.no_results', 'No nodes match your search.')}</p>
          </div>
        ) : isNonInteractiveFallback ? (
          <div style={{ flex: 1, overflow: 'auto', padding: '1rem', position: 'relative' }} className="causal-graph-container">
            <p style={{ color: CAUSAL_COLORS.textMuted, marginBottom: '0.5rem' }}>
              {isTextFallback
                ? t('causal.text_fallback', 'Graph too large for interactive view. Showing text list.')
                : (t(
                    'causal.relationless_snapshot',
                    'No causal edges were generated for this scenario yet. Showing event snapshots instead.',
                  ))}
            </p>
            <div data-testid="causal-events-list" role="list" aria-label={causalListAriaLabel}>
              {filteredData?.nodes.map(n => (
                <div key={n.id} role="listitem" style={{ fontSize: '0.8rem', color: CAUSAL_COLORS.textBody, padding: '2px 0' }}>
                  <button
                    type="button"
                    onClick={(event) => openNodeDetail(n.id, event.currentTarget)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      border: `1px solid ${CAUSAL_COLORS.borderSubtle}`,
                      borderRadius: 6,
                      background: CAUSAL_COLORS.surfacePanel,
                      color: CAUSAL_COLORS.textStrong,
                      padding: '0.55rem 0.7rem',
                      cursor: 'pointer',
                    }}
                  >
                    {`${t('causal.round_label', 'Round')} ${n.round ?? '?'} · ${getCausalTypeLabel(n.type, t)}: ${n.label}`}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            style={{
              flex: isCompactViewport ? 'none' : 1,
              position: 'relative',
              height: isCompactViewport ? 'min(66dvh, 560px)' : undefined,
              minHeight: isCompactViewport ? 360 : 0,
            }}
            className="causal-graph-container"
          >
            <div
              className="causal-graph-export-target"
              data-testid="causal-graph-export-target"
              data-export-root={exportRootId}
              style={{ position: 'absolute', inset: 0 }}
            >
              <ReactFlow
                nodes={nodes}
                edges={edges}
                ariaLabelConfig={graphAriaLabelConfig}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onNodeClick={onNodeClick}
                onPaneClick={onPaneClick}
                minZoom={0.02}
                maxZoom={4}
                onInit={(instance) => {
                  reactFlowRef.current = instance;
                  const fitAfterInit = () => {
                    if (reactFlowRef.current !== instance) return;
                    fitPendingViewport(flowSignature);
                  };
                  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                    window.requestAnimationFrame(fitAfterInit);
                  } else {
                    fitAfterInit();
                  }
                }}
                fitView
                fitViewOptions={viewportFitOptions}
                deleteKeyCode={null}
                selectionKeyCode={null}
                panActivationKeyCode={null}
                zoomActivationKeyCode={null}
                panOnDrag={[0, 1]}
                nodesDraggable
                nodesFocusable={false}
                edgesFocusable={false}
                elementsSelectable
                zoomOnDoubleClick={!isCompactViewport}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
                <Controls className="graph-export-chrome" />
                {!isCompactViewport && (
                  <MiniMap
                    className="graph-export-chrome"
                    nodeColor={(n) => (n.data?.bgColor as string) || CAUSAL_COLORS.decorativeNodeFallback}
                    nodeStrokeWidth={3}
                    style={{ background: CAUSAL_COLORS.surfaceField, pointerEvents: 'none' }}
                  />
                )}
              </ReactFlow>
            </div>
          </div>
        )}

        {!isNonInteractiveFallback && (
          <>
            <div data-testid="causal-events-list" className="sr-only" role="list" aria-label={causalListAriaLabel}>
              {(filteredData?.nodes ?? graphData?.nodes ?? []).map(n => (
                <div key={n.id} role="listitem">
                  {`${getCausalTypeLabel(n.type, t)}: ${n.label} (${t('causal.round_label', 'Round')} ${n.round ?? '?'})`}
                </div>
              ))}
            </div>
            <div className="sr-only" role="list" aria-label={causalRelationsAriaLabel}>
              {relationLines.map((line, index) => (
                <div key={`${line}-${index}`} role="listitem">{line}</div>
              ))}
            </div>
          </>
        )}
        {sheetState.open && (
          <NodeConversationSheet
            key={`${sheetState.scenarioId}:${sheetState.origin.nodeId}:${sheetState.origin.branchId ?? ''}:${sheetState.origin.roundNumber ?? ''}`}
            open={sheetState.open}
            onOpenChange={(next) => setSheetState((prev) => ({ ...prev, open: next }))}
            onClose={() => setSheetState((prev) => ({ ...prev, open: false }))}
            scenarioId={sheetState.scenarioId}
            identityId={sheetState.identityId}
            origin={sheetState.origin}
          />
        )}
      </div>
    </Tooltip.Provider>
  );
}

export default CausalReviewView;
