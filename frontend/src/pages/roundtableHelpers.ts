import type {
  EndingRoomParticipant,
  EndingRoomThreadSnapshot,
  RoundtableSelectionRecipe,
  RoundtableWitnessSelection,
  StoryData,
} from '../types';
import type { EndingRoomCandidate } from '../lib/endingRoomCandidates';
import type { OracleReplayPayload } from '../lib/oracleReplay';
import {
  detectCandidateVoiceVariant,
  extractBranchLexicon,
} from '../lib/roundtableSelection';
import { getEndingRoomPhaseLabel } from '../lib/endingRoomLabels';
import { mapRoleToSpriteId } from '../game/managers/VizSynthesizer';

export type RoundtableSelectionMode = RoundtableSelectionRecipe;

export const MANUAL_SHORTLIST_MIN = 2;
export const MANUAL_SHORTLIST_MAX = 4;
export const ROUNDTABLE_COLLAPSED_TURN_MAX_LINES = 6;

export interface WitnessCandidate {
  branchId: string;
  branchTitle: string;
  agentId: string;
  name: string;
  role: string;
  persona?: string;
  impactScore: number;
}

export interface AnchorAction {
  anchorIds: string[];
  prompt: string;
  threadTitle?: string | null;
}

export interface AnchorSummary {
  ids: string[];
  kind: string;
  kindLabel: string;
  label: string;
}

export function isRoundtableParticipant(participant: EndingRoomParticipant) {
  return participant.role_slot === 'representative';
}

export function getParticipantSprite(participant: EndingRoomParticipant) {
  const agentRole = String(participant.persona_snapshot_json?.agent_role ?? '');
  return `/assets/characters/${mapRoleToSpriteId(agentRole, participant.display_name)}.png`;
}

export function getThreadLabel(thread: EndingRoomThreadSnapshot, isZh: boolean) {
  return thread.mode === 'room'
    ? (isZh ? '主桌记录' : 'Main table')
    : thread.title;
}

export function getParticipantImpactScore(participant: EndingRoomParticipant) {
  return Number(participant.persona_snapshot_json?.impact_score ?? 0);
}

export function getSelectionReasonLabel(reason: string, isZh: boolean) {
  switch (reason) {
    case 'user_selected':
      return isZh ? '你点的' : 'Your pick';
    case 'fallback':
    case 'fallback_cast':
      return isZh ? '兜底阵容' : 'Fallback lineup';
    case 'top_impact':
      return isZh ? '高影响代表' : 'High impact';
    default:
      return reason
        ? (isZh ? `原因：${reason}` : reason)
        : '';
  }
}

export function getArchivistModeLabel(isZh: boolean): string {
  return isZh ? '档案官主持' : 'Archivist lead';
}

export function getRepresentativeHotseatLabel(isZh: boolean): string {
  return isZh ? '点名代表' : 'Question one representative';
}

export function getRoundtableModeNote(
  mode: EndingRoomThreadSnapshot['interaction_mode'],
  isZh: boolean,
  selectedName?: string | null,
): string {
  if (mode === 'hotseat') {
    return selectedName
      ? (isZh
        ? `只追问 ${selectedName}，适合看这条线如何为自己辩解。`
        : `Push only ${selectedName} when you want this worldline to defend itself.`)
      : (isZh
        ? '只追问一个代表，适合把这条线的解释问透。'
        : 'Question one representative when you want a single worldline to answer cleanly.');
  }
  if (mode === 'thread_followup') {
    return isZh
      ? '把一个具体分歧留在单独线程里继续追，不让主桌记录变成杂音堆叠。'
      : 'Keep one concrete disagreement in its own follow-up thread so the main table stays legible.';
  }
  return isZh
    ? '先让档案官收束争点，再把问题抛回最相关的代表。'
    : 'Let the Archivist collapse the disagreement first, then hand it to the most relevant rep.';
}

export function buildRoundtableVerdictPrompt(summary: string, isZh: boolean): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    return isZh
      ? '沿着当前圆桌继续追问：这桌最后为什么会收敛成这个结论？'
      : 'Continue from this table: why did the roundtable settle on this verdict?';
  }
  return isZh
    ? `沿着当前圆桌继续追问：为什么"${trimmed}"会成为这桌结论？`
    : `Continue from this table: why did "${trimmed}" become the table verdict?`;
}

export function buildRoundtablePhasePrompt(label: string, stakes: string, isZh: boolean): string {
  const trimmed = stakes.trim();
  if (!trimmed) {
    return isZh
      ? `围绕"${label}"这一阶段继续追问：这一轮真正的分歧是什么？`
      : `Push on "${label}": what was the real disagreement in this phase?`;
  }
  return isZh
    ? `围绕"${label}"这一阶段继续追问：${trimmed}`
    : `Push on "${label}": ${trimmed}`;
}

export function buildRoundtableAnchorId(kind: 'verdict' | 'phase' | 'quote', scope: string, extra?: string | number): string {
  return extra == null
    ? `roundtable:${kind}:${scope}`
    : `roundtable:${kind}:${scope}:${String(extra)}`;
}

export function trimQuoteSnippet(content: string, maxLength = 120): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}…`;
}

export function buildRoundtableQuotePrompt(speaker: string, content: string, isZh: boolean): string {
  const snippet = trimQuoteSnippet(content);
  return isZh
    ? `沿着这句继续追问：${speaker} 提到"${snippet}"。这句真正卡住了本桌哪条分歧？`
    : `Follow this quote: ${speaker} said "${snippet}". Which disagreement on this table does that line actually lock in?`;
}

export function branchListChanged(current: string[], next: string[]) {
  return current.length !== next.length || current.some((value, index) => value !== next[index]);
}

export function sameWitnessSelection(
  current: RoundtableWitnessSelection | null,
  next: RoundtableWitnessSelection | null,
) {
  if (current === next) return true;
  if (!current || !next) return false;
  return current.branchId === next.branchId && current.agentId === next.agentId;
}

export function getRoundtableAnchorKindLabel(kind: string, isZh: boolean): string {
  switch (kind) {
    case 'verdict':
      return isZh ? '档案总结' : 'Archive verdict';
    case 'phase':
      return isZh ? '阶段洞察' : 'Phase';
    case 'quote':
      return isZh ? '引用句' : 'Quote';
    default:
      return isZh ? '锚点' : 'Anchor';
  }
}

export function describeRoundtableAnchor(
  anchorIds: string[] | null | undefined,
  isZh: boolean,
  phaseInsights: Array<{ phase: string; stakes: string }>,
  turns: Array<{ key: string; content: string }>,
  t: (key: string) => string,
): AnchorSummary | null {
  if (!anchorIds || anchorIds.length === 0) {
    return null;
  }
  const [domain, rawKind, , ...extraParts] = anchorIds[0].split(':');
  const kind = rawKind ?? 'unknown';
  const kindLabel = getRoundtableAnchorKindLabel(kind, isZh);
  const extra = extraParts.join(':');
  if (domain !== 'roundtable') {
    return {
      ids: anchorIds,
      kind: 'unknown',
      kindLabel,
      label: trimQuoteSnippet(anchorIds[0], 48),
    };
  }
  if (kind === 'phase') {
    const [phaseName, phaseIndexRaw = '0'] = extra.split(/-(?=[^-]+$)/);
    const phaseIndex = Number(phaseIndexRaw);
    const phaseLabel = getEndingRoomPhaseLabel(phaseName as never, t);
    const phaseInsight = Number.isFinite(phaseIndex) ? phaseInsights[phaseIndex] : undefined;
    const label = phaseInsight?.stakes
      ? `${phaseLabel} · ${trimQuoteSnippet(phaseInsight.stakes, 48)}`
      : phaseLabel;
    return { ids: anchorIds, kind, kindLabel, label };
  }
  if (kind === 'quote') {
    const matchedTurn = turns.find((turn) => turn.key === extra);
    const label = matchedTurn
      ? `${kindLabel} · ${trimQuoteSnippet(matchedTurn.content, 48)}`
      : kindLabel;
    return { ids: anchorIds, kind, kindLabel, label };
  }
  return {
    ids: anchorIds,
    kind,
    kindLabel,
    label: kindLabel,
  };
}

export function normalizeManualShortlist(branchOrder: string[], selectedBranchIds: string[]): string[] {
  const selected = new Set(selectedBranchIds.filter((branchId) => branchOrder.includes(branchId)));
  return branchOrder.filter((branchId) => selected.has(branchId));
}

export function buildDefaultManualShortlist(branchOrder: string[]): string[] {
  return branchOrder.slice(0, Math.min(MANUAL_SHORTLIST_MIN, branchOrder.length));
}

export function chooseFaultLineBranchIds(
  branchOrder: string[],
  branchesById: Map<string, StoryData['branches'][number]>,
  branchCandidates: Record<string, EndingRoomCandidate[]>,
): string[] {
  if (branchOrder.length <= 2) {
    return [...branchOrder];
  }

  const anchorBranchId = branchOrder[0];
  const anchorBranch = branchesById.get(anchorBranchId);
  if (!anchorBranch) {
    return branchOrder.slice(0, 2);
  }
  const anchorVariant = detectCandidateVoiceVariant(branchCandidates[anchorBranchId]?.[0] ?? {
    name: '',
    role: '',
    persona: '',
  });
  const anchorLexicon = extractBranchLexicon(anchorBranch);

  let bestBranchId = branchOrder[1] ?? anchorBranchId;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const branchId of branchOrder.slice(1)) {
    const branch = branchesById.get(branchId);
    if (!branch) continue;
    const branchVariant = detectCandidateVoiceVariant(branchCandidates[branchId]?.[0] ?? {
      name: '',
      role: '',
      persona: '',
    });
    const branchLexicon = extractBranchLexicon(branch);
    const sharedTokenCount = [...anchorLexicon].filter((token) => branchLexicon.has(token)).length;
    const unionCount = new Set([...anchorLexicon, ...branchLexicon]).size || 1;
    const lexicalDistance = 1 - (sharedTokenCount / unionCount);
    const score = Math.abs((anchorBranch.probability ?? 0) - (branch.probability ?? 0)) * 100
      + (anchorVariant === branchVariant ? 0 : 34)
      + lexicalDistance * 48
      + Math.round((branchCandidates[branchId]?.[0]?.impactScore ?? 0) * 10);
    if (score > bestScore) {
      bestScore = score;
      bestBranchId = branchId;
    }
  }

  return branchOrder.filter((branchId) => branchId === anchorBranchId || branchId === bestBranchId);
}

export function chooseWitnessAugmentedSelection(
  witnessCandidates: WitnessCandidate[],
): RoundtableWitnessSelection | null {
  const ranked = [...witnessCandidates].sort((left, right) => (
    right.impactScore - left.impactScore
    || right.name.localeCompare(left.name)
  ));
  const winner = ranked.find((candidate) => candidate.branchId !== ranked[0]?.branchId) ?? ranked[0];
  return winner ? { branchId: winner.branchId, agentId: winner.agentId } : null;
}

export function buildReplayThreads(snapshot: OracleReplayPayload['roomSnapshot']) {
  return snapshot.threads.reduce<Record<string, EndingRoomThreadSnapshot>>((acc, thread) => {
    const turns = snapshot.turns
      .filter((turn) => {
        if (turn.thread_id) {
          return turn.thread_id === thread.id;
        }
        return thread.mode === 'room';
      })
      .sort((left, right) => left.sequence - right.sequence);
    acc[thread.id] = {
      ...thread,
      room_type: snapshot.room_type,
      room_title: snapshot.title,
      room_status: snapshot.status,
      language: snapshot.language,
      turns,
    };
    return acc;
  }, {});
}
