import type { TFunction } from 'i18next';
import type {
  EndingRoomInteractionMode,
  EndingRoomParticipant,
  EndingRoomThreadSnapshot,
} from '../types';
import { mapRoleToSpriteId } from '../game/managers/VizSynthesizer';

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

export function roleLabel(participant: EndingRoomParticipant, isZh: boolean, t?: TFunction): string {
  if (t) {
    switch (participant.role_slot) {
      case 'archivist':
        return t('ending_room.role_archivist');
      case 'user':
        return t('ending_room.role_user');
      case 'representative':
        return t('ending_room.role_representative');
      case 'critic':
        return t('ending_room.role_critic');
      case 'observer':
        return t('ending_room.role_observer');
      default:
        return t('ending_room.role_default');
    }
  }
  // Fallback when t is not provided (legacy callers)
  switch (participant.role_slot) {
    case 'archivist':
      return isZh ? '档案官' : 'Archivist';
    case 'user':
      return isZh ? '你' : 'You';
    case 'representative':
      return isZh ? '结局代表' : 'Representative';
    case 'critic':
      return isZh ? '评论者' : 'Critic';
    case 'observer':
      return isZh ? '旁听席' : 'Observer';
    default:
      return isZh ? '当前世界线' : 'Current worldline';
  }
}

export function threadLabel(thread: EndingRoomThreadSnapshot, isZh: boolean, t?: TFunction): string {
  if (thread.mode === 'room') {
    if (t) {
      return t('ending_room.thread_main_chamber', { title: thread.title });
    }
    return `${thread.title}${isZh ? ' · 主厅' : ' · Main Chamber'}`;
  }
  return thread.title;
}

export function participantSprite(participant: EndingRoomParticipant): string {
  const agentRole = String(participant.persona_snapshot_json?.agent_role ?? '');
  const spriteId = mapRoleToSpriteId(agentRole, participant.display_name);
  return `/assets/characters/${spriteId}.png`;
}

export function scopeText(
  thread: EndingRoomThreadSnapshot | undefined,
  scopeNotice: { threadId: string; memoryPartitionId: string } | null,
  isZh: boolean,
  t?: TFunction,
): string {
  if (scopeNotice && thread && scopeNotice.threadId === thread.id) {
    if (t) {
      return thread.mode === 'followup'
        ? t('ending_room.scope_followup_thread')
        : t('ending_room.scope_chamber_only');
    }
    return thread.mode === 'followup'
      ? (isZh ? '当前只沿这条追问继续' : 'Following this follow-up thread only')
      : (isZh ? '当前只看这间会客厅里已经摆开的线索' : 'Staying inside this chamber only');
  }
  if (thread?.mode === 'followup') {
    if (t) {
      return t('ending_room.scope_active_followup');
    }
    return isZh ? '只沿当前这条追问继续' : 'Using the active follow-up thread only';
  }
  if (t) {
    return t('ending_room.scope_default_chamber');
  }
  return isZh ? '只看当前世界线和这间会客厅' : 'Using this worldline and chamber only';
}

export function getArchivistModeLabel(isZh: boolean, t?: TFunction): string {
  if (t) return t('ending_room.mode_archivist_label');
  return isZh ? '档案官主持' : 'Archivist lead';
}

export function getHotseatModeLabel(isZh: boolean, t?: TFunction): string {
  if (t) return t('ending_room.mode_hotseat_label');
  return isZh ? '点名角色' : 'Question one role';
}

export function getAllPresentModeLabel(isZh: boolean, t?: TFunction): string {
  if (t) return t('ending_room.mode_all_present_label');
  return isZh ? '当前阵容回应' : 'Current lineup responds';
}

export function getInteractionModeNote(
  mode: EndingRoomInteractionMode,
  isZh: boolean,
  selectedName?: string | null,
  t?: TFunction,
): string {
  if (mode === 'hotseat') {
    if (t) {
      return selectedName
        ? t('ending_room.mode_note_hotseat_named', { name: selectedName })
        : t('ending_room.mode_note_hotseat');
    }
    return selectedName
      ? (isZh
        ? `只追问 ${selectedName}，适合把关键转折问透。`
        : `Push only ${selectedName}, so the hinge can be explained clearly.`)
      : (isZh
        ? '只追问一个角色，适合追责或逼问关键转折。'
        : 'Question one role only when you want the exact hinge explained.');
  }
  if (mode === 'all_present') {
    if (t) return t('ending_room.mode_note_all_present');
    return isZh
      ? '让当前阵容都接一句，更容易看见分工和分歧。'
      : 'Let the current lineup each answer once to expose roles and disagreements.';
  }
  if (mode === 'thread_followup') {
    if (t) return t('ending_room.mode_note_thread_followup');
    return isZh
      ? '把一个具体问题留在单独线程里继续追，不让旁支干扰当前结论。'
      : 'Keep one concrete question in its own follow-up thread so the verdict stays legible.';
  }
  if (mode === 'epilogue') {
    if (t) return t('ending_room.mode_note_epilogue');
    return isZh
      ? '世界线将继续推演3回合，预览后续走向。'
      : 'The worldline continues for 3 turns to preview what comes next.';
  }
  if (mode === 'evidence_card') {
    if (t) return t('ending_room.mode_note_evidence_card');
    return isZh
      ? '将另一条世界线的证据引入当前讨论，由档案官解释差异。'
      : 'Introducing evidence from another worldline; the Archivist will explain the differences.';
  }
  if (t) return t('ending_room.mode_note_default');
  return isZh
    ? '先让档案官接住问题，再把话题抛回最相关的人。'
    : 'Let the Archivist frame the question first, then route it to the most relevant voice.';
}

export function buildEndingVerdictPrompt(summary: string, isZh: boolean, t?: TFunction): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    if (t) return t('ending_room.verdict_prompt_default');
    return isZh
      ? '沿着当前结局继续追问：为什么这个结论会成立？'
      : 'Continue from this ending: why did this verdict hold?';
  }
  if (t) return t('ending_room.verdict_prompt', { summary: trimmed });
  return isZh
    ? `沿着当前结局继续追问：为什么"${trimmed}"会成立？`
    : `Continue from this ending: why did "${trimmed}" hold?`;
}

export function buildEndingInsightPrompt(insight: string, isZh: boolean, t?: TFunction): string {
  const trimmed = insight.trim();
  if (!trimmed) {
    if (t) return t('ending_room.insight_prompt_default');
    return isZh
      ? '围绕这条洞察继续追问：哪一步才是真正的转折？'
      : 'Push on this insight: which move was the true hinge?';
  }
  if (t) return t('ending_room.insight_prompt', { insight: trimmed });
  return isZh
    ? `围绕这条洞察继续追问：${trimmed}`
    : `Push on this insight: ${trimmed}`;
}

export function buildEndingAnchorId(kind: 'verdict' | 'insight' | 'key_moment' | 'quote', scope: string, extra?: string | number): string {
  return extra == null
    ? `ending:${kind}:${scope}`
    : `ending:${kind}:${scope}:${String(extra)}`;
}

export function trimQuoteSnippet(content: string, maxLength = 120): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}…`;
}

export function stripOracleReasoningText(content: string): string {
  let cleaned = String(content ?? '');
  const reasoningPrefix = /^\s*<think>[\s\S]*?(?:<\/think>\s*|$)/i;
  while (reasoningPrefix.test(cleaned)) {
    cleaned = cleaned.replace(reasoningPrefix, '');
  }
  return cleaned.trimStart();
}

export function buildEndingQuotePrompt(speaker: string, content: string, isZh: boolean, t?: TFunction): string {
  const snippet = trimQuoteSnippet(content);
  if (t) return t('ending_room.quote_prompt', { speaker, snippet });
  return isZh
    ? `沿着这句继续追问：${speaker} 提到"${snippet}"。这句话真正指向了哪一步转折？`
    : `Follow this quote: ${speaker} said "${snippet}". Which hinge was this line really pointing at?`;
}

export function getEndingAnchorKindLabel(kind: string, isZh: boolean, t?: TFunction): string {
  if (t) {
    switch (kind) {
      case 'verdict':
        return t('ending_room.anchor_kind_verdict');
      case 'insight':
        return t('ending_room.anchor_kind_insight');
      case 'key_moment':
        return t('ending_room.anchor_kind_key_moment');
      case 'quote':
        return t('ending_room.anchor_kind_quote');
      default:
        return t('ending_room.anchor_kind_default');
    }
  }
  switch (kind) {
    case 'verdict':
      return isZh ? '档案结论' : 'Verdict';
    case 'insight':
      return isZh ? '当前洞察' : 'Insight';
    case 'key_moment':
      return isZh ? '关键转折' : 'Key moment';
    case 'quote':
      return isZh ? '引用句' : 'Quote';
    default:
      return isZh ? '锚点' : 'Anchor';
  }
}

export function describeEndingAnchor(
  anchorIds: string[] | null | undefined,
  isZh: boolean,
  keyMoments: string[],
  turns: Array<{ key: string; content: string }>,
  t?: TFunction,
): AnchorSummary | null {
  if (!anchorIds || anchorIds.length === 0) {
    return null;
  }
  const [domain, rawKind, , ...extraParts] = anchorIds[0].split(':');
  const kind = rawKind ?? 'unknown';
  const kindLabel = getEndingAnchorKindLabel(kind, isZh, t);
  const extra = extraParts.join(':');
  if (domain !== 'ending') {
    return {
      ids: anchorIds,
      kind: 'unknown',
      kindLabel,
      label: trimQuoteSnippet(anchorIds[0], 48),
    };
  }
  if (kind === 'key_moment') {
    const index = Number(extra);
    const label = Number.isFinite(index) && keyMoments[index]
      ? `${kindLabel} · ${trimQuoteSnippet(keyMoments[index], 48)}`
      : kindLabel;
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
