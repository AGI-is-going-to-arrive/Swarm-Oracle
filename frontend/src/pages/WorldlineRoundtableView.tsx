import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  createReplayArtifact,
  getAgents,
  getReplayArtifact,
  getScenario,
  getStory,
  importReplayScenario,
} from '../api/client';
import { copyText } from '../lib/copyText';
import {
  buildBranchEndingRoomCandidates,
  type EndingRoomCandidate,
} from '../lib/endingRoomCandidates';
import {
  buildOracleReplayLocalUrl,
  buildOracleReplayShareUrl,
  buildOracleReplayUrl,
  loadOracleReplayLocalCopy,
  normalizeOracleReplayPayload,
  readOracleReplayPayload,
  saveOracleReplayLocalCopy,
  type OracleReplayPayload,
} from '../lib/oracleReplay';
import { isReplayEnvelopeLikelyTooLarge } from '../lib/replayCodec';
import { loadScenarioMeta } from '../lib/scenarioMeta';
import {
  getEndingRoomPhaseLabel,
  getEndingRoomStatusLabel,
} from '../lib/endingRoomLabels';
import {
  getGameplayProfileFrameSrc,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
  inferGameplayProfile,
} from '../components/gameplayCards';
import { ORACLE_UI_ASSETS } from '../lib/themeRegistry';
import { mapRoleToSpriteId } from '../game/managers/VizSynthesizer';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import { useWorldlineRoundtableWS } from '../hooks/useWorldlineRoundtableWS';
import { useWorldlineRoundtableStore } from '../stores/worldlineRoundtableStore';
import type {
  AgentInfo,
  EndingRoomParticipant,
  RoundtableRepresentativeSelection,
  RoundtableSelectionRecipe,
  RoundtableWitnessSelection,
  EndingRoomThreadSnapshot,
  Scenario,
  StoryData,
} from '../types';
import './WorldlineRoundtable.css';
import '../components/EndingChatModal.css';

function isRoundtableParticipant(participant: EndingRoomParticipant) {
  return participant.role_slot === 'representative';
}

function getParticipantSprite(participant: EndingRoomParticipant) {
  const agentRole = String(participant.persona_snapshot_json?.agent_role ?? '');
  return `/assets/characters/${mapRoleToSpriteId(agentRole, participant.display_name)}.png`;
}

function getThreadLabel(thread: EndingRoomThreadSnapshot, isZh: boolean) {
  return thread.mode === 'room'
    ? (isZh ? '主桌记录' : 'Main table')
    : thread.title;
}

function getParticipantImpactScore(participant: EndingRoomParticipant) {
  return Number(participant.persona_snapshot_json?.impact_score ?? 0);
}

function getSelectionReasonLabel(reason: string, isZh: boolean) {
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

function getArchivistModeLabel(isZh: boolean): string {
  return isZh ? '档案官主持' : 'Archivist lead';
}

function getRepresentativeHotseatLabel(isZh: boolean): string {
  return isZh ? '点名代表' : 'Question one representative';
}

function getRoundtableModeNote(
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

function buildRoundtableVerdictPrompt(summary: string, isZh: boolean): string {
  const trimmed = summary.trim();
  if (!trimmed) {
    return isZh
      ? '沿着当前圆桌继续追问：这桌最后为什么会收敛成这个结论？'
      : 'Continue from this table: why did the roundtable settle on this verdict?';
  }
  return isZh
    ? `沿着当前圆桌继续追问：为什么“${trimmed}”会成为这桌结论？`
    : `Continue from this table: why did "${trimmed}" become the table verdict?`;
}

function buildRoundtablePhasePrompt(label: string, stakes: string, isZh: boolean): string {
  const trimmed = stakes.trim();
  if (!trimmed) {
    return isZh
      ? `围绕“${label}”这一阶段继续追问：这一轮真正的分歧是什么？`
      : `Push on "${label}": what was the real disagreement in this phase?`;
  }
  return isZh
    ? `围绕“${label}”这一阶段继续追问：${trimmed}`
    : `Push on "${label}": ${trimmed}`;
}

function buildRoundtableAnchorId(kind: 'verdict' | 'phase' | 'quote', scope: string, extra?: string | number): string {
  return extra == null
    ? `roundtable:${kind}:${scope}`
    : `roundtable:${kind}:${scope}:${String(extra)}`;
}

function trimQuoteSnippet(content: string, maxLength = 120): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}…`;
}

function buildRoundtableQuotePrompt(speaker: string, content: string, isZh: boolean): string {
  const snippet = trimQuoteSnippet(content);
  return isZh
    ? `沿着这句继续追问：${speaker} 提到“${snippet}”。这句真正卡住了本桌哪条分歧？`
    : `Follow this quote: ${speaker} said "${snippet}". Which disagreement on this table does that line actually lock in?`;
}

type RoundtableSelectionMode = RoundtableSelectionRecipe;

const MANUAL_SHORTLIST_MIN = 2;
const MANUAL_SHORTLIST_MAX = 4;

interface WitnessCandidate {
  branchId: string;
  branchTitle: string;
  agentId: string;
  name: string;
  role: string;
  persona?: string;
  impactScore: number;
}

interface AnchorAction {
  anchorIds: string[];
  prompt: string;
  threadTitle?: string | null;
}

function chooseRepresentativeDefaults(
  branchOrder: string[],
  branchCandidates: Record<string, ReturnType<typeof buildBranchEndingRoomCandidates>[string]>,
  current: Record<string, string>,
): { next: Record<string, string>; changed: boolean } {
  const next: Record<string, string> = {};
  const reservedAgentIds = new Set<string>();
  let changed = false;

  for (const branchId of branchOrder) {
    const candidates = branchCandidates[branchId] ?? [];
    const currentAgentId = current[branchId];
    const currentStillValid = currentAgentId && candidates.some((candidate) => candidate.id === currentAgentId);

    if (currentStillValid) {
      next[branchId] = currentAgentId;
      reservedAgentIds.add(currentAgentId);
      continue;
    }

    const fallbackCandidate = candidates[0];
    const diversifiedCandidate = candidates.find((candidate) => !reservedAgentIds.has(candidate.id));
    const chosenAgentId = diversifiedCandidate?.id ?? fallbackCandidate?.id;
    if (chosenAgentId) {
      next[branchId] = chosenAgentId;
      reservedAgentIds.add(chosenAgentId);
    }
    if (currentAgentId !== chosenAgentId) {
      changed = true;
    }
  }

  return { next, changed };
}

function normalizeManualShortlist(branchOrder: string[], selectedBranchIds: string[]): string[] {
  const selected = new Set(selectedBranchIds.filter((branchId) => branchOrder.includes(branchId)));
  return branchOrder.filter((branchId) => selected.has(branchId));
}

function buildDefaultManualShortlist(branchOrder: string[]): string[] {
  return branchOrder.slice(0, Math.min(MANUAL_SHORTLIST_MIN, branchOrder.length));
}

type CandidateVoiceVariant =
  | 'imperial'
  | 'field'
  | 'finance'
  | 'market'
  | 'faith'
  | 'industry'
  | 'frontier'
  | 'survival'
  | 'scholar'
  | 'civic'
  | 'plain';

function detectCandidateVoiceVariant(candidate: Pick<EndingRoomCandidate, 'name' | 'role' | 'persona'>): CandidateVoiceVariant {
  const normalized = `${candidate.name} ${candidate.role} ${candidate.persona ?? ''}`.trim().toLowerCase();
  if (/(皇|king|queen|emperor|crown|court)/u.test(normalized)) return 'imperial';
  if (/(将|统帅|指挥官|舰队|commander|captain|marshal|fleet|guard)/u.test(normalized)) return 'field';
  if (/(银行|行长|财政|金融|清算|流动性|bank|banker|finance|treasury|settlement|liquidity)/u.test(normalized)) return 'finance';
  if (/(摊主|商户|商贩|市场|港口|贸易|货运|vendor|merchant|market|port|trade|freight)/u.test(normalized)) return 'market';
  if (/(祭司|祭坛|神官|神谕|priest|cleric|oracle|temple|faith|ritual|covenant)/u.test(normalized)) return 'faith';
  if (/(工程|工厂|电网|产能|后勤|调度|engineer|factory|industrial|grid|throughput|logistics|plant)/u.test(normalized)) return 'industry';
  if (/(边疆|拓荒|殖民|轨道|补给舱|生命维持|pilot|orbital|frontier|colony|expedition|convoy|airlock|life support)/u.test(normalized)) return 'frontier';
  if (/(避难|药品|口粮|撤离|医疗|scout|medic|refuge|ration|evacuation|shelter|survival)/u.test(normalized)) return 'survival';
  if (/(史官|书记官|学者|档案|证人|scribe|scholar|historian|witness|record|ledger|clerk)/u.test(normalized)) return 'scholar';
  if (/(议长|书记|委员|minister|speaker|council|administrator|governor|civic)/u.test(normalized)) return 'civic';
  return 'plain';
}

function chooseTraitMixRepresentatives(
  branchOrder: string[],
  branchCandidates: Record<string, EndingRoomCandidate[]>,
  current: Record<string, string>,
): { next: Record<string, string>; changed: boolean } {
  const defaultRepresentatives = chooseRepresentativeDefaults(branchOrder, branchCandidates, current).next;
  const next = { ...defaultRepresentatives };
  const usedVariants = new Map<CandidateVoiceVariant, number>();
  let changed = false;

  branchOrder.forEach((branchId, branchIndex) => {
    const candidates = branchCandidates[branchId] ?? [];
    if (candidates.length === 0) return;
    const rotationIndex = branchIndex % candidates.length;
    const rotated = [
      ...candidates.slice(rotationIndex),
      ...candidates.slice(0, rotationIndex),
    ];
    const ranked = rotated.sort((left, right) => {
      const leftVariant = detectCandidateVoiceVariant(left);
      const rightVariant = detectCandidateVoiceVariant(right);
      const leftScore = Math.round(left.impactScore * 100)
        + left.keyMomentHits * 14
        + left.contributionCount * 5
        + left.lastRound
        + ((usedVariants.get(leftVariant) ?? 0) === 0 ? 38 : 0)
        - (usedVariants.get(leftVariant) ?? 0) * 28
        - (leftVariant === 'plain' ? 10 : 0)
        - (left.fallbackCast ? 6 : 0)
        + (defaultRepresentatives[branchId] === left.id ? 2 : 0);
      const rightScore = Math.round(right.impactScore * 100)
        + right.keyMomentHits * 14
        + right.contributionCount * 5
        + right.lastRound
        + ((usedVariants.get(rightVariant) ?? 0) === 0 ? 38 : 0)
        - (usedVariants.get(rightVariant) ?? 0) * 28
        - (rightVariant === 'plain' ? 10 : 0)
        - (right.fallbackCast ? 6 : 0)
        + (defaultRepresentatives[branchId] === right.id ? 2 : 0);
      return rightScore - leftScore || right.name.localeCompare(left.name);
    });
    const chosen = ranked[0];
    if (!chosen) return;
    if (next[branchId] !== chosen.id) {
      next[branchId] = chosen.id;
      changed = true;
    }
    const chosenVariant = detectCandidateVoiceVariant(chosen);
    usedVariants.set(chosenVariant, (usedVariants.get(chosenVariant) ?? 0) + 1);
  });

  const stayedDefault = branchOrder.every((branchId) => (
    next[branchId] != null && next[branchId] === defaultRepresentatives[branchId]
  ));
  if (stayedDefault) {
    for (const [branchIndex, branchId] of branchOrder.entries()) {
      const candidates = branchCandidates[branchId] ?? [];
      const alternative = candidates[(branchIndex + 1) % candidates.length];
      if (!alternative) continue;
      next[branchId] = alternative.id;
      changed = true;
      break;
    }
  }

  return { next, changed };
}

function extractBranchLexicon(branch: { title: string; insight: string; key_moments?: string[] }): Set<string> {
  const joined = `${branch.title} ${branch.insight} ${(branch.key_moments ?? []).join(' ')}`.toLowerCase();
  return new Set(joined.match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function chooseFaultLineBranchIds(
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

function chooseWitnessAugmentedSelection(
  witnessCandidates: WitnessCandidate[],
): RoundtableWitnessSelection | null {
  const ranked = [...witnessCandidates].sort((left, right) => (
    right.impactScore - left.impactScore
    || right.name.localeCompare(left.name)
  ));
  const winner = ranked.find((candidate) => candidate.branchId !== ranked[0]?.branchId) ?? ranked[0];
  return winner ? { branchId: winner.branchId, agentId: winner.agentId } : null;
}

function buildReplayThreads(snapshot: OracleReplayPayload['roomSnapshot']) {
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

export default function WorldlineRoundtableView() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');

  const replayShareId = searchParams.get('roomShare') ?? searchParams.get('share');
  const replayLocalId = searchParams.get('roomLocal') ?? searchParams.get('local');
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [storyData, setStoryData] = useState<StoryData | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [replayPayload, setReplayPayload] = useState<OracleReplayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [permalinkCopied, setPermalinkCopied] = useState(false);
  const [localCopySaved, setLocalCopySaved] = useState(false);
  const [selectedRepresentativeId, setSelectedRepresentativeId] = useState<string | null>(null);
  const [replayActiveThreadId, setReplayActiveThreadId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState<RoundtableSelectionMode>('representative');
  const [selectedRepresentatives, setSelectedRepresentatives] = useState<Record<string, string>>({});
  const [manualShortlistBranchIds, setManualShortlistBranchIds] = useState<string[]>([]);
  const [selectedWitness, setSelectedWitness] = useState<RoundtableWitnessSelection | null>(null);
  const [editingRepresentatives, setEditingRepresentatives] = useState(false);
  const [launchingRoom, setLaunchingRoom] = useState(false);
  const [importingReplay, setImportingReplay] = useState(false);
  const [importError, setImportError] = useState('');
  const [briefCopied, setBriefCopied] = useState(false);
  const [pendingQuestionAnchorIds, setPendingQuestionAnchorIds] = useState<string[]>([]);
  const transcriptAutoStickRef = useRef(false);
  const transcriptListRef = useRef<HTMLDivElement>(null);

  const {
    snapshot,
    result,
    threadsById,
    threadOrder,
    activeThreadId,
    interactionMode,
    composerDraft,
    scopeNotice,
    sending,
    status,
    pendingDrafts,
    openRoom,
    loadRoom,
    loadThread,
    createThread,
    appendUserTurn,
    setActiveThread,
    setInteractionMode,
    setComposerDraft,
    reset,
  } = useWorldlineRoundtableStore();

  const replaySnapshot = replayPayload?.roomSnapshot ?? null;
  const replayThreadsById = useMemo(
    () => (replaySnapshot ? buildReplayThreads(replaySnapshot) : {}),
    [replaySnapshot],
  );
  const effectiveSnapshot = replaySnapshot ?? snapshot;
  const effectiveResult = replayPayload?.roomResult ?? result;
  const effectiveThreadsById = replaySnapshot ? replayThreadsById : threadsById;
  const effectiveThreadOrder = replaySnapshot
    ? replaySnapshot.threads.map((thread) => thread.id)
    : threadOrder;
  const uiLanguage: 'zh' | 'en' = isZh ? 'zh' : 'en';
  const oracleProfile = useMemo(
    () => inferGameplayProfile(
      replayPayload?.scenarioReplay?.scenario.question
        ?? scenario?.question
        ?? storyData?.question
        ?? '',
      replayPayload?.scenarioReplay?.scenario.scene_theme
        ?? scenario?.scene_theme
        ?? null,
    ),
    [replayPayload?.scenarioReplay?.scenario.question, replayPayload?.scenarioReplay?.scenario.scene_theme, scenario?.question, scenario?.scene_theme, storyData?.question],
  );
  const oracleProfileLabel = getGameplayProfileLabel(oracleProfile.id, isZh);
  const oracleProfileHooks = getGameplayProfileSignatureHooks(oracleProfile.id, isZh);
  const oracleProfileFrameSrc = getGameplayProfileFrameSrc(oracleProfile.id);
  const defaultThreadId = useMemo(
    () => effectiveSnapshot?.threads.find((thread) => thread.mode === 'room')?.id
      ?? effectiveSnapshot?.threads[0]?.id
      ?? null,
    [effectiveSnapshot?.threads],
  );
  const effectiveActiveThreadId = replayPayload
    ? (replayActiveThreadId ?? replayPayload.activeThreadId ?? defaultThreadId)
    : activeThreadId;

  const activeThread = useMemo(
    () => (
      effectiveActiveThreadId
        ? effectiveThreadsById[effectiveActiveThreadId]
        : null
    ) ?? (
      defaultThreadId
        ? effectiveThreadsById[defaultThreadId]
        : null
    ) ?? null,
    [defaultThreadId, effectiveActiveThreadId, effectiveThreadsById],
  );

  const threadList = useMemo(
    () => effectiveThreadOrder
      .map((threadId) => effectiveThreadsById[threadId])
      .filter(Boolean),
    [effectiveThreadOrder, effectiveThreadsById],
  );

  useWorldlineRoundtableWS(
    snapshot?.id,
    !replayPayload && Boolean(snapshot?.id) && status !== 'error',
  );

  useEffect(() => {
    let cancelled = false;

    const applyReplay = (nextReplay: OracleReplayPayload) => {
      if (!nextReplay.scenarioReplay) {
        throw new Error(isZh ? '世界线圆桌回放缺少基础场景快照。' : 'Roundtable replay is missing its base scenario snapshot.');
      }
      setReplayPayload(nextReplay);
      setScenario(nextReplay.scenarioReplay.scenario);
      setStoryData(nextReplay.scenarioReplay.storyData);
      setAgents(nextReplay.scenarioReplay.agents ?? []);
      const preferredTarget = nextReplay.roomSnapshot.participants.find((participant) => isRoundtableParticipant(participant));
      setSelectedRepresentativeId(preferredTarget?.id ?? null);
      setLoading(false);
    };

    const load = async () => {
      setLoading(true);
      setError('');
      setImportError('');

      try {
        if (replayShareId || replayLocalId || searchParams.get('roomReplay')) {
          const rawReplay = replayLocalId
            ? loadOracleReplayLocalCopy(replayLocalId, 'worldline_roundtable_v1')
            : replayShareId
              ? await Promise.resolve()
                .then(() => getReplayArtifact(replayShareId))
                .then((artifact) => normalizeOracleReplayPayload(artifact.payload, 'worldline_roundtable_v1'))
              : await readOracleReplayPayload(searchParams, 'worldline_roundtable_v1');
          if (!rawReplay) {
            throw new Error(isZh ? '世界线圆桌回放链接无效。' : 'This roundtable replay link is invalid.');
          }
          if (!cancelled) {
            applyReplay(rawReplay);
          }
          return;
        }

        if (!id) {
          throw new Error(isZh ? '缺少可用的场景 ID。' : 'Missing scenario id.');
        }

        const [nextScenario, nextStory, nextAgents] = await Promise.all([
          getScenario(id),
          getStory(id),
          getAgents(id),
        ]);
        const nextStoryData = {
          ...nextStory,
          question: nextStory.question || nextScenario.question,
        };

        if (cancelled) return;
        setScenario(nextScenario);
        setStoryData(nextStoryData);
        setAgents(nextAgents);

        if (nextScenario.status !== 'done') {
          throw new Error(isZh ? '结果尚未完成，暂时不能发起世界线圆桌。' : 'The result is not finished yet, so the roundtable is not available.');
        }
        if ((nextStoryData.branches?.length ?? 0) < 2) {
          throw new Error(isZh ? '只有一条结局时不展示世界线圆桌。' : 'The roundtable needs at least two endings.');
        }

        if (!cancelled) {
          setLoading(false);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : String(nextError));
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      reset();
    };
  }, [id, isZh, replayLocalId, replayShareId, reset, searchParams]);

  const branchesById = useMemo(
    () => new Map((storyData?.branches ?? []).map((branch) => [branch.id, branch])),
    [storyData?.branches],
  );
  const branchCandidates = useMemo(
    () => buildBranchEndingRoomCandidates({
      agents,
      branches: storyData?.branches ?? [],
      messages: scenario?.messages ?? [],
      isZh,
    }),
    [agents, isZh, scenario?.messages, storyData?.branches],
  );
  const branchOrder = useMemo(
    () => (storyData?.branches ?? []).map((branch) => branch.id),
    [storyData?.branches],
  );
  const manualShortlistMax = Math.min(MANUAL_SHORTLIST_MAX, branchOrder.length);
  const manualShortlistMin = Math.min(MANUAL_SHORTLIST_MIN, manualShortlistMax);

  useEffect(() => {
    if (replayPayload || branchOrder.length === 0) {
      return;
    }
    setSelectedRepresentatives((current) => {
      const { next, changed } = chooseRepresentativeDefaults(branchOrder, branchCandidates, current);
      if (!changed && Object.keys(current).length === Object.keys(next).length) {
        return current;
      }
      return next;
    });
  }, [branchCandidates, branchOrder, replayPayload]);

  useEffect(() => {
    if (replayPayload || branchOrder.length === 0) {
      return;
    }
    setManualShortlistBranchIds((current) => {
      const normalized = normalizeManualShortlist(branchOrder, current);
      if (normalized.length > 0) {
        return normalized;
      }
      return buildDefaultManualShortlist(branchOrder);
    });
  }, [branchOrder, replayPayload]);

  const participants = useMemo(
    () => effectiveSnapshot?.participants ?? [],
    [effectiveSnapshot?.participants],
  );
  const representatives = useMemo(
    () => participants.filter((participant) => isRoundtableParticipant(participant)),
    [participants],
  );
  const resolveThreadRepresentativeId = useCallback((thread: EndingRoomThreadSnapshot | null | undefined) => {
    const targetRef = thread?.addressed_agent_ids_json?.[0] ?? null;
    if (!targetRef) {
      return representatives[0]?.id ?? null;
    }
    return representatives.find((participant) => (
      participant.id === targetRef
      || participant.worldline_echo_key === targetRef
      || participant.source_agent_id === targetRef
    ))?.id ?? null;
  }, [representatives]);
  const participantsById = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants],
  );
  const showRepresentativePicker = !loading && !error && !replayPayload && (!effectiveSnapshot || editingRepresentatives);

  useEffect(() => {
    const currentStillValid = selectedRepresentativeId
      ? representatives.some((participant) => participant.id === selectedRepresentativeId)
      : false;
    if (currentStillValid) return;
    if (representatives.length > 0) {
      setSelectedRepresentativeId(representatives[0].id);
      return;
    }
    if (selectedRepresentativeId !== null) {
      setSelectedRepresentativeId(null);
    }
  }, [representatives, selectedRepresentativeId]);

  useEffect(() => {
    if (replayPayload || !effectiveSnapshot || representatives.length === 0 || editingRepresentatives) {
      return;
    }
    setSelectedRepresentatives((current) => {
      let changed = false;
      const next = { ...current };
      for (const participant of representatives) {
        if (!participant.source_branch_id || !participant.source_agent_id) continue;
        if (next[participant.source_branch_id] === participant.source_agent_id) continue;
        next[participant.source_branch_id] = participant.source_agent_id;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [editingRepresentatives, effectiveSnapshot, replayPayload, representatives]);

  useEffect(() => {
    if (replayPayload || !effectiveSnapshot?.id || branchOrder.length === 0 || representatives.length === 0 || editingRepresentatives) {
      return;
    }
    const liveBranchIds = normalizeManualShortlist(
      branchOrder,
      representatives
        .map((participant) => participant.source_branch_id)
        .filter((value): value is string => Boolean(value)),
    );
    if (liveBranchIds.length === 0) {
      return;
    }
    setManualShortlistBranchIds(liveBranchIds);
    setSelectionMode(
      effectiveSnapshot?.selection_recipe
      ?? (liveBranchIds.length < branchOrder.length ? 'manual_shortlist' : 'representative'),
    );
  }, [branchOrder, editingRepresentatives, effectiveSnapshot?.id, effectiveSnapshot?.selection_recipe, replayPayload, representatives]);

  useEffect(() => {
    if (replayPayload || !effectiveSnapshot || editingRepresentatives) {
      return;
    }
    const witness = participants.find((participant) => participant.role_slot === 'critic');
    if (!witness?.source_branch_id || !witness.source_agent_id) {
      return;
    }
    if (effectiveSnapshot.selection_recipe === 'witness_augmented') {
      setSelectionMode('witness_augmented');
    } else {
      setSelectionMode('expert_witness');
    }
    setSelectedWitness({
      branchId: witness.source_branch_id,
      agentId: witness.source_agent_id,
    });
  }, [editingRepresentatives, effectiveSnapshot, participants, replayPayload]);

  useEffect(() => {
    setReplayActiveThreadId(replayPayload?.activeThreadId ?? null);
  }, [replayPayload?.activeThreadId, replayPayload?.roomSnapshot?.id]);

  useEffect(() => {
    if (!replayPayload) {
      return;
    }
    const replayRepresentativeBranches = normalizeManualShortlist(
      branchOrder,
      replayPayload.roomSnapshot.participants
        .filter((participant) => participant.role_slot === 'representative')
        .map((participant) => participant.source_branch_id)
        .filter((value): value is string => Boolean(value)),
    );
    if (replayRepresentativeBranches.length > 0) {
      setManualShortlistBranchIds(replayRepresentativeBranches);
    }
    if (replayPayload.roomSnapshot.selection_recipe) {
      setSelectionMode(replayPayload.roomSnapshot.selection_recipe);
      return;
    }
    const hasWitness = replayPayload.roomSnapshot.participants.some((participant) => participant.role_slot === 'critic');
    setSelectionMode(
      hasWitness
        ? 'expert_witness'
      : (replayRepresentativeBranches.length > 0 && replayRepresentativeBranches.length < branchOrder.length
          ? 'manual_shortlist'
          : 'representative'),
    );
  }, [branchOrder, replayPayload]);

  useEffect(() => {
    if (!replayPayload) {
      return;
    }
    const nextMode = activeThread?.mode === 'followup'
      ? activeThread.interaction_mode
      : 'archivist_route';
    if (interactionMode !== nextMode) {
      setInteractionMode(nextMode);
    }
    const nextRepresentativeId = resolveThreadRepresentativeId(activeThread);
    if (selectedRepresentativeId !== nextRepresentativeId) {
      setSelectedRepresentativeId(nextRepresentativeId);
    }
  }, [
    activeThread,
    interactionMode,
    replayPayload,
    resolveThreadRepresentativeId,
    selectedRepresentativeId,
    setInteractionMode,
  ]);

  const currentTurns = useMemo(() => {
    const roomTurns = effectiveSnapshot?.turns ?? [];
    const turns = activeThread?.mode === 'followup'
      ? activeThread.turns
      : roomTurns.filter((turn) => {
        if (turn.thread_id && defaultThreadId) {
          return turn.thread_id === defaultThreadId;
        }
        return !turn.thread_id || turn.memory_partition_id === effectiveSnapshot?.memory_partition_id;
      });

    return turns.map((turn) => {
      const participant = participantsById.get(turn.participant_id);
      return {
        key: turn.id,
        content: turn.content,
        phase: getEndingRoomPhaseLabel(turn.phase, t),
        participantId: turn.participant_id,
        roleSlot: participant?.role_slot ?? (turn.source === 'user_turn' ? 'user' : null),
        speaker: participant?.display_name
          ?? (turn.source === 'user_turn' ? (isZh ? '你' : 'You') : (isZh ? '未知角色' : 'Unknown')),
      };
    });
  }, [activeThread, defaultThreadId, effectiveSnapshot?.memory_partition_id, effectiveSnapshot?.turns, isZh, participantsById, t]);

  const sortedDrafts = useMemo(
    () => Object.values(pendingDrafts).sort((left, right) => left.sequence - right.sequence),
    [pendingDrafts],
  );
  const visibleDrafts = useMemo(
    () => {
      const targetThreadId = activeThread?.id ?? defaultThreadId;
      if (!targetThreadId) return sortedDrafts;
      if (activeThread?.mode === 'followup') {
        return sortedDrafts.filter((draft) => draft.threadId === activeThread.id);
      }
      return sortedDrafts.filter((draft) => draft.threadId === targetThreadId);
    },
    [activeThread?.id, activeThread?.mode, defaultThreadId, sortedDrafts],
  );

  const composerEnabled = !replayPayload && Boolean(effectiveResult) && Boolean(snapshot?.id);
  const selectedRepresentative = representatives.find(
    (participant) => participant.id === selectedRepresentativeId,
  ) ?? null;
  const displayedDrafts = useMemo(
    () => {
      if (visibleDrafts.length > 0) {
        return visibleDrafts.map((draft) => ({
          key: draft.turnId,
          participantId: draft.participantId,
          phase: draft.phase,
          content: draft.content.trim()
            ? draft.content
            : (
              interactionMode === 'hotseat'
                ? (isZh ? '当前代表正在组织回应…' : 'The selected representative is lining up a reply…')
                : (isZh ? '档案官正在把问题分给最合适的代表…' : 'The Archivist is routing the question to the right representative…')
            ),
          variant: draft.content.trim() ? ('stream' as const) : ('placeholder' as const),
        }));
      }
      if (replayPayload || !sending || !composerEnabled) {
        return [];
      }
      const placeholderParticipantId = interactionMode === 'hotseat'
        ? (selectedRepresentativeId ?? null)
        : participants.find((participant) => participant.role_slot === 'archivist')?.id
          ?? representatives[0]?.id
          ?? null;
      const placeholderContent = interactionMode === 'hotseat'
        ? (isZh ? '当前代表正在组织回应…' : 'The selected representative is lining up a reply…')
        : (isZh ? '档案官正在把问题分给最合适的代表…' : 'The Archivist is routing the question to the right representative…');
      return [
        {
          key: '__local-pending__',
          participantId: placeholderParticipantId,
          phase: activeThread?.turns.at(-1)?.phase
            ?? effectiveSnapshot?.current_phase
            ?? 'verdict',
          content: placeholderContent,
          variant: 'placeholder' as const,
        },
      ];
    },
    [
      activeThread?.turns,
      composerEnabled,
      effectiveSnapshot?.current_phase,
      interactionMode,
      isZh,
      participants,
      replayPayload,
      representatives,
      selectedRepresentativeId,
      sending,
      visibleDrafts,
    ],
  );
  const activeSpeakerTurnKey = displayedDrafts.at(-1)?.key ?? currentTurns.at(-1)?.key ?? null;
  const currentSpeakerParticipantId = displayedDrafts.at(-1)?.participantId
    ?? currentTurns.at(-1)?.participantId
    ?? null;
  const hotseatParticipantId = interactionMode === 'hotseat' ? selectedRepresentativeId : null;

  useEffect(() => {
    const transcriptList = transcriptListRef.current;
    if (!transcriptList) return;
    if (!transcriptAutoStickRef.current) return;
    transcriptList.scrollTop = transcriptList.scrollHeight;
    if (displayedDrafts.length === 0) {
      transcriptAutoStickRef.current = false;
    }
  }, [currentTurns.length, displayedDrafts.length]);
  const addressedAgentIds = useMemo(
    () => (interactionMode === 'hotseat' && selectedRepresentativeId
      ? [selectedRepresentativeId]
      : []),
    [interactionMode, selectedRepresentativeId],
  );
  const transcriptSubtitle = scopeNotice && activeThread && scopeNotice.threadId === activeThread.id
    ? (
      activeThread.mode === 'followup'
        ? (isZh ? '当前只沿这条圆桌追问继续' : 'Following this roundtable thread only')
        : (isZh ? '当前只看本桌记录与异线摘要' : 'Using this table and crossline summaries only')
    )
    : (
      activeThread?.mode === 'followup'
        ? (isZh ? '只沿当前这条圆桌追问继续' : 'Using the active roundtable thread only')
        : (isZh ? '只看本桌记录与异线摘要' : 'Using this table and crossline summaries')
    );
  const threadDisplayLabels = useMemo(() => {
    const seen = new Map<string, number>();
    const labels: Record<string, string> = {};
    for (const thread of threadList) {
      const base = getThreadLabel(thread, isZh);
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      labels[thread.id] = count === 1
        ? base
        : `${base}${isZh ? ` · 线程 ${count}` : ` · Thread ${count}`}`;
    }
    return labels;
  }, [isZh, threadList]);
  const interactionModeNote = replayPayload
    ? (isZh ? '回放模式下只读查看当前桌面。' : 'Replay mode is read-only for this table.')
    : getRoundtableModeNote(interactionMode, isZh, selectedRepresentative?.display_name ?? null);
  const verdictPrompt = useMemo(
    () => buildRoundtableVerdictPrompt(effectiveResult?.summary ?? '', isZh),
    [effectiveResult?.summary, isZh],
  );
  const verdictAnchorAction = useMemo<AnchorAction>(
    () => ({
      anchorIds: [buildRoundtableAnchorId('verdict', effectiveSnapshot?.id ?? 'table')],
      prompt: verdictPrompt,
      threadTitle: isZh ? '档案总结' : 'Archive Verdict',
    }),
    [effectiveSnapshot?.id, isZh, verdictPrompt],
  );
  const phaseActionPrompts = useMemo(
    () => (effectiveResult?.phase_insights ?? []).slice(0, 3).map((insight, index) => {
      const label = getEndingRoomPhaseLabel(insight.phase, t);
      return {
        key: `${insight.phase}-${index}`,
        label,
        action: {
          anchorIds: [buildRoundtableAnchorId('phase', effectiveSnapshot?.id ?? 'table', `${insight.phase}-${index}`)],
          prompt: buildRoundtablePhasePrompt(label, insight.stakes, isZh),
          threadTitle: label,
        } satisfies AnchorAction,
      };
    }),
    [effectiveResult?.phase_insights, effectiveSnapshot?.id, isZh, t],
  );
  const meetingBrief = useMemo(() => {
    const lines = [
      `# ${t('roundtable.title')}`,
      '',
      isZh ? '## 当前问题' : '## Current Question',
      storyData?.question ?? '—',
      '',
      isZh ? '## 当前范围' : '## Scope',
      transcriptSubtitle,
    ];
    if (effectiveResult?.summary) {
      lines.push('', isZh ? '## 档案总结' : '## Archivist Verdict', effectiveResult.summary);
    }
    if (effectiveResult?.archivist_note) {
      lines.push('', isZh ? '## 档案官注记' : '## Archivist Note', effectiveResult.archivist_note);
    }
    if ((effectiveResult?.phase_insights?.length ?? 0) > 0) {
      lines.push('', isZh ? '## 阶段洞察' : '## Phase Insights');
      (effectiveResult?.phase_insights ?? []).slice(0, 3).forEach((insight) => {
        lines.push(`- ${getEndingRoomPhaseLabel(insight.phase, t)}: ${insight.stakes}`);
      });
    }
    if (representatives.length > 0) {
      lines.push('', isZh ? '## 当前代表席' : '## Current Representatives');
      representatives.forEach((participant) => {
        lines.push(`- ${participant.display_name}`);
      });
    }
    return lines.join('\n');
  }, [effectiveResult?.archivist_note, effectiveResult?.phase_insights, effectiveResult?.summary, isZh, representatives, storyData?.question, t, transcriptSubtitle]);

  const handleCopyBrief = useCallback(async () => {
    if (!meetingBrief) return;
    await copyText(meetingBrief);
    setBriefCopied(true);
    window.setTimeout(() => setBriefCopied(false), 1800);
  }, [meetingBrief]);

  const activateAnchor = useCallback((action: AnchorAction) => {
    setComposerDraft(action.prompt);
    setPendingQuestionAnchorIds(action.anchorIds);
  }, [setComposerDraft]);

  const handleStartAnchoredThread = useCallback(async (action: AnchorAction) => {
    if (!snapshot?.id || replayPayload) return;
    const thread = await createThread(snapshot.id, {
      title: action.threadTitle ?? null,
      questionAnchorIds: action.anchorIds,
      interactionMode: 'thread_followup',
    });
    setActiveThread(thread.id);
    setInteractionMode('thread_followup');
    await loadThread(thread.id);
    activateAnchor(action);
  }, [activateAnchor, createThread, loadThread, replayPayload, setActiveThread, setInteractionMode, snapshot?.id]);
  const handleFollowQuote = useCallback((anchorId: string, speaker: string, content: string) => {
    activateAnchor({
      anchorIds: [anchorId],
      prompt: buildRoundtableQuotePrompt(speaker, content, isZh),
      threadTitle: speaker,
    });
  }, [activateAnchor, isZh]);
  const handleQuoteThread = useCallback(async (anchorId: string, speaker: string, content: string) => {
    await handleStartAnchoredThread({
      anchorIds: [anchorId],
      prompt: buildRoundtableQuotePrompt(speaker, content, isZh),
      threadTitle: speaker,
    });
  }, [handleStartAnchoredThread, isZh]);

  const scenarioReplaySnapshot = useMemo(
    () => replayPayload?.scenarioReplay ?? (
      scenario && storyData
        ? {
            scenario,
            storyData,
            agents: scenario.agents ?? [],
            predictions: [],
            scenarioMeta: loadScenarioMeta(scenario.id),
            campaignScenarioSummary: null,
            campaignSummary: null,
            isDailyChallenge: false,
          }
        : null
    ),
    [replayPayload?.scenarioReplay, scenario, storyData],
  );

  const effectiveReplayPayload = useMemo<OracleReplayPayload | null>(
    () => {
      if (!effectiveSnapshot || !scenarioReplaySnapshot || !effectiveResult) return null;
      return replayPayload ?? {
        kind: 'worldline_roundtable_v1',
        scenarioReplay: scenarioReplaySnapshot,
        roomSnapshot: effectiveSnapshot,
        roomResult: effectiveResult,
        activeThreadId: effectiveActiveThreadId ?? defaultThreadId,
        branchId: null,
        selectedAgentIds: representatives.map((participant) => participant.id),
      };
    },
    [
      defaultThreadId,
      effectiveActiveThreadId,
      effectiveResult,
      effectiveSnapshot,
      replayPayload,
      representatives,
      scenarioReplaySnapshot,
    ],
  );

  const handleCopyPermalink = useCallback(async () => {
    const copyWindowMs = 1800;
    const finalizeCopyState = (usedLocalFallback: boolean) => {
      setPermalinkCopied(true);
      window.setTimeout(() => setPermalinkCopied(false), copyWindowMs);
      if (usedLocalFallback) {
        setLocalCopySaved(true);
        window.setTimeout(() => setLocalCopySaved(false), copyWindowMs);
      }
    };

    try {
      if (!effectiveReplayPayload) return;
      const artifact = await createReplayArtifact(
        'worldline_roundtable_v1',
        effectiveReplayPayload as unknown as Record<string, unknown>,
      ).catch(() => null);
      let permalink: string;
      let usedLocalFallback = false;
      if (artifact) {
        permalink = buildOracleReplayShareUrl(window.location.origin, effectiveReplayPayload, artifact.id);
      } else if (isReplayEnvelopeLikelyTooLarge('worldline_roundtable_v1', effectiveReplayPayload)) {
        const localId = saveOracleReplayLocalCopy(effectiveReplayPayload);
        permalink = buildOracleReplayLocalUrl(window.location.origin, effectiveReplayPayload, localId);
        usedLocalFallback = true;
      } else {
        permalink = await buildOracleReplayUrl(window.location.origin, effectiveReplayPayload);
      }
      await copyText(permalink);
      finalizeCopyState(usedLocalFallback);
    } catch (error) {
      if (!effectiveReplayPayload) return;
      console.warn('[WorldlineRoundtableView] Falling back to local roundtable replay copy', error);
      const localId = saveOracleReplayLocalCopy(effectiveReplayPayload);
      await copyText(buildOracleReplayLocalUrl(window.location.origin, effectiveReplayPayload, localId));
      finalizeCopyState(true);
    }
  }, [effectiveReplayPayload]);

  const automationInteractionMode = replayPayload
    ? (activeThread?.mode === 'followup'
      ? activeThread.interaction_mode
      : 'archivist_route')
    : interactionMode;

  const handleSaveLocalCopy = useCallback(() => {
    if (!effectiveReplayPayload) return;
    const localId = saveOracleReplayLocalCopy(effectiveReplayPayload);
    navigate(`/roundtable/replay?roomLocal=${localId}`, { replace: true });
    setLocalCopySaved(true);
    window.setTimeout(() => setLocalCopySaved(false), 1800);
  }, [effectiveReplayPayload, navigate]);

  const handleImportReplay = useCallback(async () => {
    if (!replayPayload?.scenarioReplay || importingReplay) return;
    setImportingReplay(true);
    setImportError('');
    try {
      const imported = await importReplayScenario(replayPayload.scenarioReplay.scenario);
      navigate(`/sim/${imported.id}`);
    } catch (nextError) {
      setImportError(
        nextError instanceof Error
          ? nextError.message
          : (isZh ? '导入圆桌回放失败' : 'Failed to import roundtable replay'),
      );
    } finally {
      setImportingReplay(false);
    }
  }, [importingReplay, isZh, navigate, replayPayload]);

  const selectionUsesShortlist = selectionMode === 'manual_shortlist' || selectionMode === 'fault_line_first';
  const selectedBranchIdsForLaunch = useMemo(
    () => (
      selectionUsesShortlist
        ? normalizeManualShortlist(branchOrder, manualShortlistBranchIds)
        : branchOrder
    ),
    [branchOrder, manualShortlistBranchIds, selectionUsesShortlist],
  );
  const witnessCandidates = useMemo<WitnessCandidate[]>(
    () => selectedBranchIdsForLaunch.flatMap((branchId) => {
      const branch = branchesById.get(branchId);
      const representativeAgentId = selectedRepresentatives[branchId];
      return (branchCandidates[branchId] ?? [])
        .filter((candidate) => candidate.id !== representativeAgentId)
        .map((candidate) => ({
          branchId,
          branchTitle: branch?.title ?? branchId,
          agentId: candidate.id,
          name: candidate.name,
          role: candidate.role,
          persona: candidate.persona,
          impactScore: candidate.impactScore,
        }));
    }),
    [branchCandidates, branchesById, selectedBranchIdsForLaunch, selectedRepresentatives],
  );

  useEffect(() => {
    if (replayPayload || branchOrder.length === 0) {
      return;
    }
    if (selectionMode === 'trait_mix') {
      setSelectedRepresentatives((current) => {
        const { next, changed } = chooseTraitMixRepresentatives(branchOrder, branchCandidates, current);
        return changed ? next : current;
      });
      setSelectedWitness(null);
      return;
    }
    if (selectionMode === 'fault_line_first') {
      setManualShortlistBranchIds(chooseFaultLineBranchIds(branchOrder, branchesById, branchCandidates));
      setSelectedWitness(null);
      return;
    }
    if (selectionMode === 'witness_augmented') {
      setSelectedWitness((current) => current ?? chooseWitnessAugmentedSelection(witnessCandidates));
    }
  }, [branchCandidates, branchOrder, branchesById, replayPayload, selectionMode, witnessCandidates]);

  useEffect(() => {
    if (replayPayload || witnessCandidates.length === 0) {
      return;
    }
    setSelectedWitness((current) => {
      if (selectionMode !== 'expert_witness') {
        return current;
      }
      if (current && witnessCandidates.some((candidate) => (
        candidate.branchId === current.branchId && candidate.agentId === current.agentId
      ))) {
        return current;
      }
      return {
        branchId: witnessCandidates[0].branchId,
        agentId: witnessCandidates[0].agentId,
      };
    });
  }, [replayPayload, selectionMode, witnessCandidates]);

  const toggleManualShortlistBranch = useCallback((branchId: string) => {
    if (!branchOrder.includes(branchId)) {
      return;
    }
    setManualShortlistBranchIds((current) => {
      const normalized = normalizeManualShortlist(branchOrder, current);
      if (normalized.includes(branchId)) {
        if (normalized.length <= manualShortlistMin) {
          return normalized;
        }
        return normalized.filter((item) => item !== branchId);
      }
      if (normalized.length >= manualShortlistMax) {
        return normalized;
      }
      return normalizeManualShortlist(branchOrder, [...normalized, branchId]);
    });
  }, [branchOrder, manualShortlistMax, manualShortlistMin]);

  const handleSelectionModeChange = useCallback((nextMode: RoundtableSelectionMode) => {
    setSelectionMode(nextMode);
    if (nextMode === 'manual_shortlist') {
      setManualShortlistBranchIds((current) => {
        const normalized = normalizeManualShortlist(branchOrder, current);
        if (normalized.length >= manualShortlistMin && normalized.length <= manualShortlistMax) {
          return normalized;
        }
        return buildDefaultManualShortlist(branchOrder);
      });
    }
    if (nextMode === 'fault_line_first') {
      setManualShortlistBranchIds(chooseFaultLineBranchIds(branchOrder, branchesById, branchCandidates));
      setSelectedWitness(null);
    }
    if (nextMode === 'trait_mix') {
      setSelectedRepresentatives((current) => chooseTraitMixRepresentatives(branchOrder, branchCandidates, current).next);
      setSelectedWitness(null);
    }
    if (nextMode === 'expert_witness') {
      setSelectedWitness((current) => current ?? (witnessCandidates[0]
        ? { branchId: witnessCandidates[0].branchId, agentId: witnessCandidates[0].agentId }
        : null));
    }
    if (nextMode === 'witness_augmented') {
      setSelectedWitness(chooseWitnessAugmentedSelection(witnessCandidates));
    }
  }, [branchCandidates, branchOrder, branchesById, manualShortlistMax, manualShortlistMin, witnessCandidates]);

  const handleLaunchRoundtable = useCallback(async () => {
    if (!scenario?.id || launchingRoom || selectedBranchIdsForLaunch.length === 0) return;
    setLaunchingRoom(true);
    setError('');
    try {
      reset();
      const roomId = await openRoom(scenario.id, {
        roomType: 'worldline_roundtable',
        selectedBranchIds: selectedBranchIdsForLaunch,
        selectedRepresentatives: selectedBranchIdsForLaunch
          .map((branchId) => {
            const agentId = selectedRepresentatives[branchId];
            return agentId
              ? { branchId, agentId }
              : null;
          })
          .filter((value): value is RoundtableRepresentativeSelection => Boolean(value)),
        selectedWitness: (selectionMode === 'expert_witness' || selectionMode === 'witness_augmented')
          ? (
            selectedWitness
            ?? (witnessCandidates[0]
              ? { branchId: witnessCandidates[0].branchId, agentId: witnessCandidates[0].agentId }
              : null)
          )
          : null,
        selectionRecipe: selectionMode,
        language: uiLanguage,
      });
      await loadRoom(roomId);
      setEditingRepresentatives(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLaunchingRoom(false);
    }
  }, [launchingRoom, loadRoom, openRoom, reset, scenario?.id, selectedBranchIdsForLaunch, selectedRepresentatives, selectedWitness, selectionMode, uiLanguage, witnessCandidates]);

  const handleEditRepresentatives = useCallback(() => {
    setEditingRepresentatives(true);
    if (typeof window.scrollTo === 'function') {
      try {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } catch {
        // jsdom does not implement window.scrollTo; ignore in tests.
      }
    }
  }, []);

  const handleSend = useCallback(async () => {
    const content = composerDraft.trim();
    if (!content) return;
    transcriptAutoStickRef.current = true;
    if (interactionMode === 'hotseat' && selectedRepresentativeId && snapshot?.id) {
      const currentTargetRef = activeThread?.addressed_agent_ids_json?.[0] ?? null;
      const currentTarget = representatives.find((participant) => (
        participant.id === currentTargetRef
        || participant.worldline_echo_key === currentTargetRef
        || participant.source_agent_id === currentTargetRef
      ))?.id ?? currentTargetRef;
      const existingHotseatThread = threadList.find((thread) => {
        if (thread.mode !== 'followup' || thread.interaction_mode !== 'hotseat') {
          return false;
        }
        const threadTargetRef = thread.addressed_agent_ids_json?.[0] ?? null;
        const threadTarget = representatives.find((participant) => (
          participant.id === threadTargetRef
          || participant.worldline_echo_key === threadTargetRef
          || participant.source_agent_id === threadTargetRef
        ))?.id ?? threadTargetRef;
        return threadTarget === selectedRepresentativeId;
      });
      const needsThread = !activeThread
        || activeThread.mode !== 'followup'
        || activeThread.interaction_mode !== 'hotseat'
        || currentTarget !== selectedRepresentativeId;
      if (needsThread) {
        if (existingHotseatThread) {
          setActiveThread(existingHotseatThread.id);
          await loadThread(existingHotseatThread.id);
        } else {
          const selectedRepresentative = representatives.find((participant) => participant.id === selectedRepresentativeId);
          const thread = await createThread(snapshot.id, {
            title: selectedRepresentative?.display_name ?? null,
            addressedAgentIds,
            questionAnchorIds: pendingQuestionAnchorIds,
            interactionMode: 'hotseat',
          });
          await loadThread(thread.id);
        }
      }
    }
    await appendUserTurn({
      content,
      addressedAgentIds,
      questionAnchorIds: pendingQuestionAnchorIds,
      interactionMode,
    });
    setPendingQuestionAnchorIds([]);
  }, [
    activeThread,
    addressedAgentIds,
    appendUserTurn,
    composerDraft,
    createThread,
    interactionMode,
    loadThread,
    pendingQuestionAnchorIds,
    representatives,
    selectedRepresentativeId,
    setActiveThread,
    snapshot?.id,
    threadList,
  ]);

  useEffect(() => {
    const win = window as AutomationWindow & {
      advanceTime?: (ms: number) => Promise<void>;
    };
    const render = () => stringifyAutomationPayload(
      {
        question: storyData?.question ?? null,
        status: loading ? 'loading' : error ? 'error' : effectiveSnapshot?.status ?? 'idle',
        currentRound: effectiveSnapshot?.turns.length ?? 0,
        totalRounds: effectiveSnapshot?.turns.length ?? 0,
        viewMode: 'classic',
        visualizationEnabled: true,
        isSimulationComplete: Boolean(effectiveResult),
        messageCount: currentTurns.length + displayedDrafts.length,
        agentCount: participants.length,
        branchCount: storyData?.branches.length ?? 0,
      },
      effectiveSnapshot ? {
        scene: 'WorldlineRoundtable',
        phase: effectiveSnapshot.current_phase,
        room_id: effectiveSnapshot.id,
        visible_turn_count: currentTurns.length + displayedDrafts.length,
      } : null,
      {
        route: window.location.pathname,
        kind: 'worldline_roundtable',
        error: error ? { code: 'ROUNDTABLE_ERROR', label: error } : null,
        controls: {
          can_send: composerEnabled,
          is_read_only: Boolean(replayPayload),
          showing_picker: showRepresentativePicker,
          selection_mode: selectionMode,
          selected_branch_count: selectedBranchIdsForLaunch.length,
          has_witness: participants.some((participant) => participant.role_slot === 'critic'),
          active_thread_id: activeThread?.id ?? null,
          thread_count: threadList.length,
          interaction_mode: automationInteractionMode,
          participant_count: participants.length,
          representative_count: representatives.length,
          has_result: Boolean(effectiveResult),
          can_reseat_representatives: !replayPayload && Boolean(effectiveSnapshot),
        },
      },
    );
    win.render_game_to_text = render;
    win.advanceTime = async (ms: number) => {
      await new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
    };
    return () => {
      if (win.render_game_to_text === render) {
        delete win.render_game_to_text;
      }
      if (win.advanceTime) {
        delete win.advanceTime;
      }
    };
  }, [
    activeThread?.id,
    composerEnabled,
    currentTurns.length,
    participants,
    effectiveResult,
    effectiveSnapshot,
    error,
    interactionMode,
    automationInteractionMode,
    loading,
    displayedDrafts.length,
    replayPayload,
    representatives.length,
    selectedBranchIdsForLaunch.length,
    selectionMode,
    showRepresentativePicker,
    storyData?.branches.length,
    storyData?.question,
    threadList.length,
  ]);

  const handleBack = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate(scenario ? `/result/${scenario.id}` : '/');
  }, [navigate, scenario]);

  return (
    <div
      className={`worldline-roundtable-view oracle-skin oracle-skin--${oracleProfile.id} ${effectiveSnapshot && !replayPayload ? 'is-live-room' : ''} ${showRepresentativePicker ? 'is-picker-open' : ''}`}
      data-profile={oracleProfile.id}
      style={{ '--oracle-profile-frame': `url(${oracleProfileFrameSrc})` } as CSSProperties}
    >
      <header className="worldline-roundtable-hero">
        <div className="worldline-roundtable-hero__topline">
          <button type="button" className="btn btn-ghost" onClick={handleBack}>
            {isZh ? '返回结果页' : 'Back to results'}
          </button>
          <div className="worldline-roundtable-hero__actions">
            {!replayPayload && effectiveSnapshot && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  if (editingRepresentatives) {
                    setEditingRepresentatives(false);
                    return;
                  }
                  handleEditRepresentatives();
                }}
              >
                {editingRepresentatives
                  ? (isZh ? '返回当前圆桌' : 'Back to current table')
                  : (isZh ? '改选代表并重开' : 'Reseat and reopen')}
              </button>
            )}
            <button
              type="button"
              className="btn"
              onClick={() => void handleCopyPermalink()}
              disabled={!effectiveReplayPayload}
            >
              {permalinkCopied
                ? (isZh ? '回放链接已复制' : 'Replay link copied')
                : (isZh ? '复制回放' : 'Copy replay')}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleSaveLocalCopy}
              disabled={!effectiveReplayPayload}
            >
              {localCopySaved
                ? (isZh ? '只读副本已保存' : 'Read-only copy saved')
                : (isZh ? '保存只读副本' : 'Save read-only copy')}
            </button>
            {replayPayload?.scenarioReplay && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void handleImportReplay()}
                disabled={importingReplay}
              >
                {importingReplay
                  ? (isZh ? '导入中…' : 'Importing…')
                  : (isZh ? '导入本地运行' : 'Import local run')}
              </button>
            )}
          </div>
        </div>
        <div className="worldline-roundtable-hero__body">
          <div className="worldline-roundtable-hero__copy">
            <p className="worldline-roundtable-hero__kicker">{t('roundtable.entry_cta')}</p>
            <h1>{t('roundtable.title')}</h1>
            <p>{storyData?.question ?? t('roundtable.entry_hint')}</p>
            <div className="worldline-roundtable-hero__meta">
              <span className="archive-chip archive-chip--primary">
                {getEndingRoomStatusLabel(loading ? 'loading' : (effectiveSnapshot?.status ?? 'draft'), t)}
              </span>
              <span className="archive-chip">
                {(storyData?.branches.length ?? 0)} {isZh ? '条世界线' : 'worldlines'}
              </span>
              <span className="archive-chip">
                {representatives.length} {isZh ? '位代表' : 'representatives'}
              </span>
              <span className="archive-chip">
                {threadList.length} {isZh ? '条线程' : 'threads'}
              </span>
              {replayPayload && (
                <span className="archive-chip">{isZh ? '只读回放' : 'Read-only replay'}</span>
              )}
              <span className="archive-chip archive-chip--profile">{oracleProfileLabel}</span>
            </div>
            <div className="worldline-roundtable-theme-strip" aria-label={isZh ? '题材提示' : 'Theme cues'}>
              {oracleProfileHooks.slice(0, 3).map((hook) => (
                <span key={hook} className="worldline-roundtable-theme-chip">{hook}</span>
              ))}
            </div>
          </div>
          <div
            className="worldline-roundtable-hero__stage"
            style={{ backgroundImage: `url(${ORACLE_UI_ASSETS.roundtablePanel})` }}
          >
            <div className="worldline-roundtable-hero__stage-head">
              <img
                className="worldline-roundtable-hero__stage-badge"
                src={ORACLE_UI_ASSETS.badgeWorldlineRoundtable}
                alt=""
                aria-hidden="true"
              />
              <div>
                <p className="worldline-roundtable-hero__stage-kicker">
                  {isZh ? '本桌状态' : 'Table status'}
                </p>
                <strong>{effectiveResult?.summary ?? t('roundtable.entry_hint')}</strong>
              </div>
            </div>
            <div className="worldline-roundtable-hero__stage-metrics">
              <span>{isZh ? '档案官主持' : 'Archivist hosted'}</span>
              <span>{loading ? t('common.loading') : getEndingRoomStatusLabel(effectiveSnapshot?.status ?? 'draft', t)}</span>
              <span>{isZh ? '只允许本桌追问' : 'Scope stays inside this table'}</span>
            </div>
            <p className="worldline-roundtable-hero__stage-note">
              {effectiveResult?.archivist_note
                ?? (isZh
                  ? '继续追问时，只允许读取本桌 transcript 与已归档的多线摘要。'
                  : 'Follow-up turns only read the current table transcript and archived crossline summaries.')}
            </p>
          </div>
        </div>
      </header>

      {loading && <div className="worldline-roundtable-empty">{t('roundtable.loading')}</div>}
      {!loading && error && <div className="worldline-roundtable-empty worldline-roundtable-empty--error">{error}</div>}
      {!loading && !error && importError && <div className="worldline-roundtable-empty worldline-roundtable-empty--error">{importError}</div>}

      {showRepresentativePicker && (
        <section className="worldline-roundtable-card worldline-roundtable-card--picker">
          <div className="worldline-roundtable-card__heading worldline-roundtable-card__heading--stacked">
            <div>
              <h3>{isZh ? '改选每条世界线的代表' : 'Reseat each worldline representative'}</h3>
              <p className="worldline-roundtable-picker__hint">
                {selectionMode === 'manual_shortlist'
                  ? t('roundtable.shortlist_hint')
                  : selectionMode === 'trait_mix'
                    ? t('roundtable.trait_mix_hint')
                    : selectionMode === 'fault_line_first'
                      ? t('roundtable.fault_line_hint')
                      : selectionMode === 'witness_augmented'
                        ? t('roundtable.witness_augmented_hint')
                  : (isZh
                    ? (effectiveSnapshot
                      ? '当前桌面会保留到你重新开桌为止。改完代表后，再用新的阵容重建这桌圆桌。'
                      : '每条结局只派一位代表入席。系统会优先按影响度预选，并尽量错开代表，让这桌更有比较价值。')
                    : (effectiveSnapshot
                      ? 'The current table stays available until you reopen it. Swap representatives here, then rebuild the roundtable with the new lineup.'
                      : 'Seat one representative for each ending. The table starts with high-impact picks while trying to avoid the same voice on every worldline.'))}
              </p>
              <div className="worldline-roundtable-picker__mode-switch" role="group" aria-label={isZh ? '圆桌桌型' : 'Roundtable seating mode'}>
                <button
                  type="button"
                  className={`worldline-roundtable-picker__mode-pill ${selectionMode === 'representative' ? 'is-active' : ''}`}
                  onClick={() => handleSelectionModeChange('representative')}
                >
                  {t('roundtable.selection_mode_representative')}
                </button>
                <button
                  type="button"
                  className={`worldline-roundtable-picker__mode-pill ${selectionMode === 'manual_shortlist' ? 'is-active' : ''}`}
                  onClick={() => handleSelectionModeChange('manual_shortlist')}
                >
                  {t('roundtable.selection_mode_manual_shortlist')}
                </button>
                <button
                  type="button"
                  className={`worldline-roundtable-picker__mode-pill ${selectionMode === 'expert_witness' ? 'is-active' : ''}`}
                  onClick={() => handleSelectionModeChange('expert_witness')}
                  disabled={witnessCandidates.length === 0}
                >
                  {t('roundtable.selection_mode_expert_witness')}
                </button>
                <button
                  type="button"
                  className={`worldline-roundtable-picker__mode-pill ${selectionMode === 'trait_mix' ? 'is-active' : ''}`}
                  onClick={() => handleSelectionModeChange('trait_mix')}
                >
                  {t('roundtable.selection_mode_trait_mix')}
                </button>
                <button
                  type="button"
                  className={`worldline-roundtable-picker__mode-pill ${selectionMode === 'fault_line_first' ? 'is-active' : ''}`}
                  onClick={() => handleSelectionModeChange('fault_line_first')}
                  disabled={branchOrder.length < 2}
                >
                  {t('roundtable.selection_mode_fault_line_first')}
                </button>
                <button
                  type="button"
                  className={`worldline-roundtable-picker__mode-pill ${selectionMode === 'witness_augmented' ? 'is-active' : ''}`}
                  onClick={() => handleSelectionModeChange('witness_augmented')}
                  disabled={witnessCandidates.length === 0}
                >
                  {t('roundtable.selection_mode_witness_augmented')}
                </button>
                {selectionUsesShortlist && (
                  <span className="worldline-roundtable-picker__count">
                    {t('roundtable.shortlist_count', {
                      count: selectedBranchIdsForLaunch.length,
                      max: manualShortlistMax,
                    })}
                  </span>
                )}
              </div>
            </div>
            <div className="worldline-roundtable-picker__actions">
              {effectiveSnapshot && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setEditingRepresentatives(false)}
                  disabled={launchingRoom}
                >
                  {isZh ? '返回当前圆桌' : 'Back to current table'}
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => void handleLaunchRoundtable()}
                disabled={
                  launchingRoom
                  || selectedBranchIdsForLaunch.length === 0
                  || selectedBranchIdsForLaunch.some((branchId) => !selectedRepresentatives[branchId])
                }
              >
                {launchingRoom
                  ? (isZh ? '正在开桌…' : 'Launching…')
                  : (effectiveSnapshot
                    ? (isZh ? '按当前阵容重开' : 'Reopen this lineup')
                    : (isZh ? '按当前代表开桌' : 'Open this lineup'))}
              </button>
            </div>
          </div>
          <div className="worldline-roundtable-picker-grid">
            {(storyData?.branches ?? []).map((branch) => {
              const candidates = branchCandidates[branch.id] ?? [];
              const branchSelected = !selectionUsesShortlist || selectedBranchIdsForLaunch.includes(branch.id);
              const branchToggleDisabled = !selectionUsesShortlist
                || (
                  branchSelected
                    ? selectedBranchIdsForLaunch.length <= manualShortlistMin
                    : selectedBranchIdsForLaunch.length >= manualShortlistMax
                );
              return (
                <article key={branch.id} className={`worldline-roundtable-picker-branch ${branchSelected ? 'is-active' : 'is-muted'}`}>
                  <header className="worldline-roundtable-picker-branch__header">
                    <div>
                      <strong>{branch.title}</strong>
                      <span>{Math.round((branch.probability ?? 0) * 100)}%</span>
                    </div>
                {selectionUsesShortlist && branchOrder.length > MANUAL_SHORTLIST_MIN && (
                      <button
                        type="button"
                        className={`worldline-roundtable-picker-branch__toggle ${branchSelected ? 'is-active' : ''}`}
                        onClick={() => toggleManualShortlistBranch(branch.id)}
                        disabled={branchToggleDisabled}
                      >
                        {branchSelected ? t('roundtable.shortlist_toggle_off') : t('roundtable.shortlist_toggle_on')}
                      </button>
                    )}
                    <p>{branch.insight}</p>
                  </header>
                  <div className="worldline-roundtable-picker-branch__options">
                    {candidates.map((candidate) => {
                      const selected = selectedRepresentatives[branch.id] === candidate.id;
                      return (
                        <button
                          key={`${branch.id}-${candidate.id}`}
                          type="button"
                          className={`worldline-roundtable-picker-card ${selected ? 'is-selected' : ''}`}
                          disabled={!branchSelected}
                          onClick={() => setSelectedRepresentatives((current) => ({
                            ...current,
                            [branch.id]: candidate.id,
                          }))}
                        >
                          <div className="worldline-roundtable-picker-card__title">
                            <strong>{candidate.name}</strong>
                            {selected && <span>{isZh ? '已选代表' : 'Selected'}</span>}
                          </div>
                          <span>{candidate.role}</span>
                          {candidate.persona && <small>{candidate.persona}</small>}
                          <em>
                            {isZh
                              ? `影响 ${Math.round(candidate.impactScore * 100)} · 发言 ${candidate.contributionCount} 次 · 转折命中 ${candidate.keyMomentHits} · 最近 R${candidate.lastRound}`
                              : `Impact ${Math.round(candidate.impactScore * 100)} · ${candidate.contributionCount} turns · ${candidate.keyMomentHits} hinge hits · latest R${candidate.lastRound}`}
                          </em>
                        </button>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
          {(selectionMode === 'expert_witness' || selectionMode === 'witness_augmented') && (
            <section className="worldline-roundtable-picker-witness">
              <div className="worldline-roundtable-card__heading">
                <h3>{selectionMode === 'witness_augmented' ? t('roundtable.witness_augmented_section') : t('roundtable.witness_section')}</h3>
                {selectedWitness && (
                  <span className="worldline-roundtable-picker__count">
                    {t('roundtable.witness_selected')}
                  </span>
                )}
              </div>
              <p className="worldline-roundtable-picker__hint">
                {selectionMode === 'witness_augmented' ? t('roundtable.witness_augmented_hint') : t('roundtable.witness_hint')}
              </p>
              <div className="worldline-roundtable-picker-witness__options">
                {witnessCandidates.map((candidate) => {
                  const selected = selectedWitness?.branchId === candidate.branchId && selectedWitness?.agentId === candidate.agentId;
                  return (
                    <button
                      key={`${candidate.branchId}-${candidate.agentId}`}
                      type="button"
                      className={`worldline-roundtable-picker-card ${selected ? 'is-selected' : ''}`}
                      onClick={() => setSelectedWitness({ branchId: candidate.branchId, agentId: candidate.agentId })}
                    >
                      <div className="worldline-roundtable-picker-card__title">
                        <strong>{candidate.name}</strong>
                        {selected && <span>{t('roundtable.witness_badge')}</span>}
                      </div>
                      <span>{candidate.branchTitle}</span>
                      <small>{candidate.role}</small>
                      {candidate.persona && <small>{candidate.persona}</small>}
                      <em>{isZh ? `影响 ${Math.round(candidate.impactScore * 100)}` : `Impact ${Math.round(candidate.impactScore * 100)}`}</em>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </section>
      )}

      {!loading && !error && effectiveSnapshot && !showRepresentativePicker && (
        <div className="worldline-roundtable-shell">
          <aside className="worldline-roundtable-sidebar">
            <section
              className="worldline-roundtable-card worldline-roundtable-card--summary"
              style={{ backgroundImage: `url(${ORACLE_UI_ASSETS.roundtablePanel})` }}
            >
              <img
                className="worldline-roundtable-card__banner"
                src={ORACLE_UI_ASSETS.roundtableBanner}
                alt=""
                aria-hidden="true"
              />
              <div className="worldline-roundtable-summary__top">
                <div>
                  <span className="worldline-roundtable-summary__eyebrow">{t('roundtable.phase_verdict')}</span>
                  <h2>{effectiveResult?.summary ?? t('roundtable.loading')}</h2>
                </div>
                <div className="worldline-roundtable-summary__actions">
                  {!replayPayload && (
                    <>
                      <button
                        type="button"
                        className="ending-chat-inline-button"
                        onClick={() => activateAnchor(verdictAnchorAction)}
                        disabled={!composerEnabled}
                      >
                        {t('roundtable.action_continue')}
                      </button>
                      <button
                        type="button"
                        className="ending-chat-inline-button"
                        onClick={() => void handleStartAnchoredThread(verdictAnchorAction)}
                        disabled={!composerEnabled}
                      >
                        {t('roundtable.action_new_thread')}
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="ending-chat-inline-button"
                    onClick={() => void handleCopyBrief()}
                    disabled={!meetingBrief}
                  >
                    {briefCopied ? t('roundtable.action_brief_copied') : t('roundtable.action_copy_brief')}
                  </button>
                </div>
              </div>
              {effectiveResult?.archivist_note && <p>{effectiveResult.archivist_note}</p>}
            </section>

            <section className="worldline-roundtable-card">
              <div className="worldline-roundtable-card__heading">
                <h3>{isZh ? '代表席' : 'Representatives'}</h3>
                <div className="worldline-roundtable-card__heading-actions">
                  <span>{representatives.length}</span>
                </div>
              </div>
              <div className="worldline-roundtable-roster">
                {participants.map((participant) => {
                  const branch = participant.source_branch_id
                    ? branchesById.get(participant.source_branch_id)
                    : null;
                  const isHotseatTarget = interactionMode === 'hotseat' && participant.role_slot === 'representative';
                  const selected = selectedRepresentativeId === participant.id;
                  const isCurrentSpeaker = currentSpeakerParticipantId === participant.id;
                  const isHotseatFocus = hotseatParticipantId === participant.id;
                  const impactScore = getParticipantImpactScore(participant);
                  const selectionReason = getSelectionReasonLabel(
                    String(participant.persona_snapshot_json?.selection_reason ?? ''),
                    isZh,
                  );
                  return (
                    <button
                      key={participant.id}
                      type="button"
                      className={`worldline-roundtable-seat ${selected ? 'is-selected' : ''} ${participant.role_slot === 'archivist' ? 'is-archivist' : ''} ${participant.role_slot === 'representative' ? 'is-representative' : ''} ${isCurrentSpeaker ? 'is-current-speaker' : ''} ${isHotseatFocus ? 'is-hotseat-target' : ''}`}
                      onClick={() => {
                        if (!isHotseatTarget) return;
                        setSelectedRepresentativeId(participant.id);
                      }}
                      disabled={!isHotseatTarget || Boolean(replayPayload)}
                    >
                      <span className="worldline-roundtable-seat__frame" aria-hidden="true" />
                      <img src={getParticipantSprite(participant)} alt="" aria-hidden="true" />
                      <div className="worldline-roundtable-seat__copy">
                        <div className="worldline-roundtable-seat__title">
                          <strong>{participant.display_name}</strong>
                          {isCurrentSpeaker && (
                            <span className="worldline-roundtable-seat__status">
                              {isZh ? '当前发言' : 'Speaking'}
                            </span>
                          )}
                          {!isCurrentSpeaker && isHotseatFocus && (
                            <span className="worldline-roundtable-seat__status worldline-roundtable-seat__status--hotseat">
                              {isZh ? '热座目标' : 'Hotseat'}
                            </span>
                          )}
                        </div>
                        <span>
                          {participant.role_slot === 'archivist'
                            ? t('roundtable.role_archivist')
                            : participant.role_slot === 'critic'
                              ? t('roundtable.role_witness')
                            : (branch?.title ?? t('roundtable.role_representative'))}
                        </span>
                        {branch && (
                          <small>
                            {Math.round((branch.probability ?? 0) * 100)}%
                            {' · '}
                            {branch.insight}
                          </small>
                        )}
                        <div className="worldline-roundtable-seat__metrics">
                          {impactScore > 0 && (
                            <span>{isZh ? `影响 ${Math.round(impactScore * 100)}` : `Impact ${Math.round(impactScore * 100)}`}</span>
                          )}
                          {selectionReason && <span>{selectionReason}</span>}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {effectiveResult?.phase_insights?.length ? (
              <section className="worldline-roundtable-card">
                <div className="worldline-roundtable-card__heading">
                  <h3>{isZh ? '阶段洞察' : 'Phase insights'}</h3>
                </div>
                <div className="worldline-roundtable-insights">
                  {effectiveResult.phase_insights.map((insight, index) => (
                    <article key={`${insight.phase}-${index}`} className="worldline-roundtable-insight">
                      <strong>{getEndingRoomPhaseLabel(insight.phase, t)}</strong>
                      <p>{insight.stakes}</p>
                      {!replayPayload && (
                        <div className="worldline-roundtable-insight__actions">
                          <button
                            type="button"
                            className="ending-chat-inline-button"
                            onClick={() => activateAnchor(phaseActionPrompts[index].action)}
                            disabled={!composerEnabled}
                          >
                            {t('roundtable.action_follow_phase')}
                          </button>
                          <button
                            type="button"
                            className="ending-chat-inline-button"
                            onClick={() => void handleStartAnchoredThread(phaseActionPrompts[index].action)}
                            disabled={!composerEnabled}
                          >
                            {t('roundtable.action_new_thread')}
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}
          </aside>

          <section className="worldline-roundtable-main">
            <div className="ending-chat-transcript-header worldline-roundtable-transcript-header">
              <div>
                <h3>{isZh ? '圆桌记录' : 'Roundtable transcript'}</h3>
                <p>{transcriptSubtitle}</p>
              </div>
              <span className="ending-chat-note">
                {activeThread ? (threadDisplayLabels[activeThread.id] ?? getThreadLabel(activeThread, isZh)) : t('roundtable.loading')}
              </span>
            </div>

            {threadList.length > 0 && (
              <div className="ending-chat-thread-rail" role="tablist" aria-label={isZh ? '圆桌线程' : 'Roundtable threads'}>
                {threadList.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`ending-chat-thread-chip ${(activeThread?.id ?? defaultThreadId) === thread.id ? 'is-active' : ''} ${thread.mode === 'room' ? 'is-room-thread' : ''} ${thread.interaction_mode === 'hotseat' ? 'is-hotseat-thread' : ''}`}
                    onClick={() => {
                      const nextMode = thread.mode === 'followup' ? thread.interaction_mode : 'archivist_route';
                      if (replayPayload) {
                        setReplayActiveThreadId(thread.id);
                      } else {
                        setActiveThread(thread.id);
                      }
                      setInteractionMode(nextMode);
                      setSelectedRepresentativeId(resolveThreadRepresentativeId(thread));
                      if (!replayPayload && thread.mode === 'followup') {
                        void loadThread(thread.id);
                      }
                    }}
                  >
                    {threadDisplayLabels[thread.id] ?? getThreadLabel(thread, isZh)}
                  </button>
                ))}
              </div>
            )}

              <div ref={transcriptListRef} className="ending-chat-transcript-list worldline-roundtable-transcript-list">
                {currentTurns.map((turn) => (
                  <article
                    key={turn.key}
                    className={`ending-chat-bubble ${turn.roleSlot === 'archivist' ? 'is-archivist' : ''} ${turn.key === activeSpeakerTurnKey ? 'is-current-speaker' : ''} ${turn.participantId === hotseatParticipantId ? 'is-hotseat-target' : ''}`}
                  >
                    <header>
                      {turn.roleSlot === 'archivist' && (
                        <span className="ending-chat-bubble__icon ending-chat-bubble__icon--archivist" aria-hidden="true" />
                      )}
                      <strong>{turn.speaker}</strong>
                      {turn.key === activeSpeakerTurnKey && (
                        <span className="worldline-roundtable-transcript-badge">
                          {isZh ? '当前发言' : 'Speaking'}
                        </span>
                      )}
                      {turn.participantId === hotseatParticipantId && (
                        <span className="worldline-roundtable-transcript-badge worldline-roundtable-transcript-badge--hotseat">
                          {isZh ? '热座' : 'Hotseat'}
                        </span>
                      )}
                      <span>{turn.phase}</span>
                    </header>
                    <p>{turn.content}</p>
                    {composerEnabled && turn.roleSlot !== 'user' && (
                      <div className="ending-chat-bubble__actions">
                        <button
                          type="button"
                          className="ending-chat-inline-button"
                          onClick={() => handleFollowQuote(buildRoundtableAnchorId('quote', activeThread?.id ?? 'table', turn.key), turn.speaker, turn.content)}
                        >
                          {t('roundtable.action_follow_quote')}
                        </button>
                        <button
                          type="button"
                          className="ending-chat-inline-button"
                          onClick={() => void handleQuoteThread(buildRoundtableAnchorId('quote', activeThread?.id ?? 'table', turn.key), turn.speaker, turn.content)}
                        >
                          {t('roundtable.action_new_thread')}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              {!replayPayload && displayedDrafts.map((draft) => (
                <article
                  key={draft.key}
                  className={`ending-chat-bubble ending-chat-bubble--draft ${draft.variant === 'placeholder' ? 'ending-chat-bubble--placeholder' : ''} ${draft.key === activeSpeakerTurnKey ? 'is-current-speaker' : ''}`}
                  aria-busy={draft.variant === 'placeholder'}
                >
                  <header>
                    <strong>{participantsById.get(draft.participantId ?? '')?.display_name ?? (isZh ? '未知角色' : 'Unknown')}</strong>
                    <span>{getEndingRoomPhaseLabel(draft.phase, t)}</span>
                  </header>
                  <p>{draft.content}</p>
                </article>
              ))}
            </div>

            <div className="ending-chat-composer worldline-roundtable-composer">
              <div className="ending-chat-composer__row">
                <div className="ending-chat-mode-switch" role="group" aria-label={isZh ? '圆桌追问模式' : 'Roundtable follow-up mode'}>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'archivist_route' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('archivist_route')}
                    disabled={!composerEnabled}
                  >
                    {getArchivistModeLabel(isZh)}
                  </button>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'hotseat' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('hotseat')}
                    disabled={!composerEnabled || representatives.length === 0}
                  >
                    {getRepresentativeHotseatLabel(isZh)}
                  </button>
                </div>
                <span className="ending-chat-scope-notice">{transcriptSubtitle}</span>
              </div>
              <span className="ending-chat-mode-note">{interactionModeNote}</span>

              {phaseActionPrompts.length > 0 && (
                <div className="ending-chat-anchor-row">
                  <button
                    type="button"
                    className="ending-chat-anchor-chip"
                    onClick={() => activateAnchor(verdictAnchorAction)}
                    disabled={!composerEnabled}
                  >
                    <span>{t('roundtable.phase_verdict')}</span>
                  </button>
                  {phaseActionPrompts.map((prompt) => (
                    <button
                      key={prompt.key}
                      type="button"
                      className="ending-chat-anchor-chip"
                      onClick={() => activateAnchor(prompt.action)}
                      disabled={!composerEnabled}
                    >
                      <span>{prompt.label}</span>
                    </button>
                  ))}
                </div>
              )}

              {pendingQuestionAnchorIds.length > 0 && composerDraft.trim().length > 0 && (
                <div className="ending-chat-anchor-actions">
                  <button
                    type="button"
                    className="ending-chat-inline-button"
                    disabled={!composerEnabled}
                    onClick={() => void handleStartAnchoredThread({
                      anchorIds: pendingQuestionAnchorIds,
                      prompt: composerDraft,
                      threadTitle: null,
                    })}
                  >
                    {t('roundtable.action_thread_from_anchor')}
                  </button>
                </div>
              )}

              {interactionMode === 'hotseat' && representatives.length > 0 && (
                <div className="ending-chat-hotseat-row">
                  {representatives.map((participant) => (
                    <button
                      key={participant.id}
                      type="button"
                      className={`ending-chat-hotseat-pill ${selectedRepresentativeId === participant.id ? 'is-active' : ''}`}
                      onClick={() => setSelectedRepresentativeId(participant.id)}
                      disabled={!composerEnabled}
                    >
                      {participant.display_name}
                    </button>
                  ))}
                </div>
              )}

              <div className="ending-chat-composer__row">
                <textarea
                  className="ending-chat-composer__input"
                  value={composerDraft}
                  placeholder={
                    isZh
                      ? '继续追问这桌代表的分歧，答案仍然只会落在本桌范围内。'
                      : 'Keep pressing this table’s disagreement; the answer will stay inside this table.'
                  }
                  onChange={(event) => setComposerDraft(event.target.value)}
                  disabled={!composerEnabled || sending}
                  rows={2}
                />
                <button
                  type="button"
                  className="ending-chat-send"
                  onClick={() => void handleSend()}
                  disabled={!composerEnabled || sending || composerDraft.trim().length === 0}
                >
                  {sending ? (isZh ? '发送中…' : 'Sending…') : (isZh ? '发送追问' : 'Send')}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
