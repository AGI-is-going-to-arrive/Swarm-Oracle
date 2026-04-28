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
    ? (isZh ? '主桌讨论' : 'Main table')
    : thread.title;
}

export function getParticipantImpactScore(participant: EndingRoomParticipant) {
  return Number(participant.persona_snapshot_json?.impact_score ?? 0);
}

export function getSelectionReasonLabel(reason: string, isZh: boolean) {
  switch (reason) {
    case 'user_selected':
      return isZh ? '你选的' : 'Your pick';
    case 'fallback':
    case 'fallback_cast':
      return isZh ? '自动补位' : 'Auto-filled';
    case 'top_impact':
      return isZh ? '高影响力' : 'High impact';
    default:
      return reason
        ? (isZh ? reason : reason)
        : '';
  }
}

export function getArchivistModeLabel(isZh: boolean): string {
  return isZh ? '主持人引导' : 'Host-guided';
}

export function getRepresentativeHotseatLabel(isZh: boolean): string {
  return isZh ? '单独追问' : 'Question one rep';
}

export function getRoundtableModeNote(
  mode: EndingRoomThreadSnapshot['interaction_mode'],
  isZh: boolean,
  selectedName?: string | null,
): string {
  if (mode === 'hotseat') {
    return selectedName
      ? (isZh
        ? `只对 ${selectedName} 提问，让这条世界线解释清楚自己的立场。`
        : `Focus on ${selectedName} — let this worldline explain its position.`)
      : (isZh
        ? '选一位代表单独提问，把这条世界线的逻辑问清楚。'
        : 'Pick one rep to question — get a clear answer from one worldline.');
  }
  if (mode === 'thread_followup') {
    return isZh
      ? '把某个具体分歧单独拎出来聊，主桌讨论保持清晰。'
      : 'Split off one disagreement into its own thread so the main discussion stays clean.';
  }
  return isZh
    ? '主持人先梳理分歧，再把问题交给最合适的代表回答。'
    : 'The host sorts out the disagreement first, then passes it to the right rep.';
}

export function buildRoundtableVerdictPrompt(summary: string, isZh: boolean): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    return isZh
      ? '为什么圆桌最后得出了这个结论？'
      : 'Why did the roundtable reach this conclusion?';
  }
  return isZh
    ? `为什么"${trimmed}"成了最终结论？`
    : `Why did "${trimmed}" become the verdict?`;
}

export function buildRoundtablePhasePrompt(label: string, stakes: string, isZh: boolean): string {
  const trimmed = stakes.trim();
  if (!trimmed) {
    return isZh
      ? `"${label}"阶段真正的分歧是什么？`
      : `What was the real disagreement in "${label}"?`;
  }
  return isZh
    ? `关于"${label}"：${trimmed}`
    : `About "${label}": ${trimmed}`;
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
    ? `${speaker} 说"${snippet}"——这句话到底卡在哪个分歧上？`
    : `${speaker} said "${snippet}" — which disagreement does this get at?`;
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
      return isZh ? '最终结论' : 'Verdict';
    case 'phase':
      return isZh ? '阶段要点' : 'Phase';
    case 'quote':
      return isZh ? '引用' : 'Quote';
    default:
      return isZh ? '参考点' : 'Anchor';
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
