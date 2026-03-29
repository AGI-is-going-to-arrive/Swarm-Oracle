import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
} from '../lib/endingRoomCandidates';
import {
  buildOracleReplayShareUrl,
  buildOracleReplayUrl,
  loadOracleReplayLocalCopy,
  normalizeOracleReplayPayload,
  readOracleReplayPayload,
  saveOracleReplayLocalCopy,
  type OracleReplayPayload,
} from '../lib/oracleReplay';
import { loadScenarioMeta } from '../lib/scenarioMeta';
import {
  getEndingRoomPhaseLabel,
  getEndingRoomStatusLabel,
} from '../lib/endingRoomLabels';
import { ORACLE_UI_ASSETS } from '../lib/themeRegistry';
import { mapRoleToSpriteId } from '../game/managers/VizSynthesizer';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import { useWorldlineRoundtableWS } from '../hooks/useWorldlineRoundtableWS';
import { useWorldlineRoundtableStore } from '../stores/worldlineRoundtableStore';
import type {
  AgentInfo,
  EndingRoomParticipant,
  RoundtableRepresentativeSelection,
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
    ? (isZh ? '主桌记录' : 'Main desk')
    : thread.title;
}

function getParticipantImpactScore(participant: EndingRoomParticipant) {
  return Number(participant.persona_snapshot_json?.impact_score ?? 0);
}

function getSelectionReasonLabel(reason: string, isZh: boolean) {
  switch (reason) {
    case 'user_selected':
      return isZh ? '手动点名' : 'User selected';
    case 'fallback':
    case 'fallback_cast':
      return isZh ? '兜底阵容' : 'Fallback cast';
    case 'top_impact':
      return isZh ? '高影响代表' : 'Top impact';
    default:
      return reason
        ? (isZh ? `原因：${reason}` : reason)
        : '';
  }
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
  const [selectedRepresentatives, setSelectedRepresentatives] = useState<Record<string, string>>({});
  const [editingRepresentatives, setEditingRepresentatives] = useState(false);
  const [launchingRoom, setLaunchingRoom] = useState(false);
  const [importingReplay, setImportingReplay] = useState(false);
  const [importError, setImportError] = useState('');
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

  useEffect(() => {
    if (replayPayload || branchOrder.length === 0) {
      return;
    }
    setSelectedRepresentatives((current) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const branchId of branchOrder) {
        const candidates = branchCandidates[branchId] ?? [];
        const currentAgentId = current[branchId];
        const currentStillValid = currentAgentId && candidates.some((candidate) => candidate.id === currentAgentId);
        if (currentStillValid) {
          next[branchId] = currentAgentId;
          continue;
        }
        const fallbackAgentId = candidates[0]?.id;
        if (fallbackAgentId) {
          next[branchId] = fallbackAgentId;
        }
        if (currentAgentId !== fallbackAgentId) {
          changed = true;
        }
      }
      if (!changed && Object.keys(current).length === Object.keys(next).length) {
        return current;
      }
      return next;
    });
  }, [branchCandidates, branchOrder, replayPayload]);

  const participants = useMemo(
    () => effectiveSnapshot?.participants ?? [],
    [effectiveSnapshot?.participants],
  );
  const representatives = useMemo(
    () => participants.filter((participant) => isRoundtableParticipant(participant)),
    [participants],
  );
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
    if (replayPayload || !effectiveSnapshot || representatives.length === 0) {
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
  }, [effectiveSnapshot?.id, replayPayload, representatives]);

  useEffect(() => {
    setReplayActiveThreadId(replayPayload?.activeThreadId ?? null);
  }, [replayPayload?.activeThreadId, replayPayload?.roomSnapshot?.id]);

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
  const currentSpeakerParticipantId = sortedDrafts.at(-1)?.participantId
    ?? currentTurns.at(-1)?.participantId
    ?? null;
  const hotseatParticipantId = interactionMode === 'hotseat' ? selectedRepresentativeId : null;

  useEffect(() => {
    const transcriptList = transcriptListRef.current;
    if (!transcriptList) return;
    if (!transcriptAutoStickRef.current) return;
    transcriptList.scrollTop = transcriptList.scrollHeight;
    if (sortedDrafts.length === 0) {
      transcriptAutoStickRef.current = false;
    }
  }, [currentTurns.length, sortedDrafts.length]);

  const composerEnabled = !replayPayload && Boolean(effectiveResult) && Boolean(snapshot?.id);
  const addressedAgentIds = interactionMode === 'hotseat' && selectedRepresentativeId
    ? [selectedRepresentativeId]
    : [];
  const transcriptSubtitle = scopeNotice && activeThread && scopeNotice.threadId === activeThread.id
    ? (
      activeThread.mode === 'followup'
        ? (isZh ? '当前只基于这条圆桌追问线程' : 'Scoped to this roundtable follow-up thread only')
        : (isZh ? '当前只基于这桌 transcript 与他线摘要' : 'Scoped to this table transcript plus crossline summaries only')
    )
    : (
      activeThread?.mode === 'followup'
        ? (isZh ? '只基于当前追问线程与本桌 scope' : 'Only using the active follow-up thread and this table scope')
        : (isZh ? '只基于本桌 transcript 与他线摘要' : 'Only using this table transcript and crossline summaries')
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

  const createPermalink = useCallback(async () => {
    if (!effectiveReplayPayload) return null;
    const artifact = await createReplayArtifact(
      'worldline_roundtable_v1',
      effectiveReplayPayload as unknown as Record<string, unknown>,
    ).catch(() => null);
    return artifact
      ? buildOracleReplayShareUrl(window.location.origin, effectiveReplayPayload, artifact.id)
      : buildOracleReplayUrl(window.location.origin, effectiveReplayPayload);
  }, [effectiveReplayPayload]);

  const handleCopyPermalink = useCallback(async () => {
    const permalink = await createPermalink();
    if (!permalink) return;
    await copyText(permalink);
    setPermalinkCopied(true);
    window.setTimeout(() => setPermalinkCopied(false), 1800);
  }, [createPermalink]);

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

  const handleLaunchRoundtable = useCallback(async () => {
    if (!scenario?.id || launchingRoom || branchOrder.length === 0) return;
    setLaunchingRoom(true);
    setError('');
    try {
      reset();
      const roomId = await openRoom(scenario.id, {
        roomType: 'worldline_roundtable',
        selectedBranchIds: branchOrder,
        selectedRepresentatives: branchOrder
          .map((branchId) => {
            const agentId = selectedRepresentatives[branchId];
            return agentId
              ? { branchId, agentId }
              : null;
          })
          .filter((value): value is RoundtableRepresentativeSelection => Boolean(value)),
        language: isZh ? 'zh' : 'en',
      });
      await loadRoom(roomId);
      setEditingRepresentatives(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLaunchingRoom(false);
    }
  }, [branchOrder, launchingRoom, loadRoom, openRoom, reset, scenario?.id, selectedRepresentatives]);

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
      const needsThread = !activeThread
        || activeThread.mode !== 'followup'
        || activeThread.interaction_mode !== 'hotseat'
        || currentTarget !== selectedRepresentativeId;
      if (needsThread) {
        const selectedRepresentative = representatives.find((participant) => participant.id === selectedRepresentativeId);
        const thread = await createThread(snapshot.id, {
          title: selectedRepresentative?.display_name ?? null,
          addressedAgentIds,
          interactionMode: 'hotseat',
        });
        await loadThread(thread.id);
      }
    }
    await appendUserTurn({
      content,
      addressedAgentIds,
      interactionMode,
    });
  }, [
    activeThread,
    addressedAgentIds,
    appendUserTurn,
    composerDraft,
    createThread,
    interactionMode,
    loadThread,
    representatives,
    selectedRepresentativeId,
    snapshot?.id,
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
        isSimulationComplete: effectiveSnapshot?.result_ready ?? false,
        messageCount: currentTurns.length,
        agentCount: participants.length,
        branchCount: storyData?.branches.length ?? 0,
      },
      effectiveSnapshot ? {
        scene: 'WorldlineRoundtable',
        phase: effectiveSnapshot.current_phase,
        room_id: effectiveSnapshot.id,
        visible_turn_count: currentTurns.length,
      } : null,
      {
        route: window.location.pathname,
        kind: 'worldline_roundtable',
        error: error ? { code: 'ROUNDTABLE_ERROR', label: error } : null,
        controls: {
          can_send: composerEnabled,
          is_read_only: Boolean(replayPayload),
          showing_picker: showRepresentativePicker,
          active_thread_id: activeThread?.id ?? null,
          thread_count: threadList.length,
          interaction_mode: interactionMode,
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
    effectiveResult,
    effectiveSnapshot,
    error,
    interactionMode,
    loading,
    participants.length,
    replayPayload,
    representatives.length,
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
      className={`worldline-roundtable-view ${effectiveSnapshot && !replayPayload ? 'is-live-room' : ''} ${showRepresentativePicker ? 'is-picker-open' : ''}`}
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
                : (isZh ? '复制圆桌回放' : 'Copy roundtable replay')}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleSaveLocalCopy}
              disabled={!effectiveReplayPayload}
            >
              {localCopySaved
                ? (isZh ? '已保存本地只读副本' : 'Saved local read-only copy')
                : (isZh ? '保存本地只读副本' : 'Save local read-only copy')}
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
                  : (isZh ? '导入为本地运行' : 'Import as Local Run')}
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
                {isZh
                  ? (effectiveSnapshot
                    ? '当前桌面会保留到你重新开桌为止。改完代表后，再用新的阵容重建这桌圆桌。'
                    : '每条结局只派一位代表入席。默认已按影响度预选，你可以逐条改选后再开桌。')
                  : (effectiveSnapshot
                    ? 'The current table stays available until you reopen it. Swap representatives here, then rebuild the roundtable with the new lineup.'
                    : 'Seat one representative for each ending. The table is prefilled by impact, but you can swap seats before opening the roundtable.')}
              </p>
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
                disabled={launchingRoom || branchOrder.some((branchId) => !selectedRepresentatives[branchId])}
              >
                {launchingRoom
                  ? (isZh ? '正在开桌…' : 'Launching…')
                  : (effectiveSnapshot
                    ? (isZh ? '按当前改选重建圆桌' : 'Rebuild the roundtable with this seating')
                    : (isZh ? '以当前代表开桌' : 'Open with selected representatives'))}
              </button>
            </div>
          </div>
          <div className="worldline-roundtable-picker-grid">
            {(storyData?.branches ?? []).map((branch) => {
              const candidates = branchCandidates[branch.id] ?? [];
              return (
                <article key={branch.id} className="worldline-roundtable-picker-branch">
                  <header className="worldline-roundtable-picker-branch__header">
                    <div>
                      <strong>{branch.title}</strong>
                      <span>{Math.round((branch.probability ?? 0) * 100)}%</span>
                    </div>
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
              <h2>{effectiveResult?.summary ?? t('roundtable.loading')}</h2>
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
                      if (replayPayload) {
                        setReplayActiveThreadId(thread.id);
                      } else {
                        setActiveThread(thread.id);
                        setInteractionMode(thread.mode === 'followup' ? thread.interaction_mode : 'archivist_route');
                      }
                      const targetRef = thread.addressed_agent_ids_json?.[0] ?? null;
                      const resolvedTargetId = representatives.find((participant) => (
                        participant.id === targetRef
                        || participant.worldline_echo_key === targetRef
                        || participant.source_agent_id === targetRef
                      ))?.id ?? targetRef;
                      setSelectedRepresentativeId(resolvedTargetId);
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
                    className={`ending-chat-bubble ${turn.roleSlot === 'archivist' ? 'is-archivist' : ''} ${turn.participantId === currentSpeakerParticipantId ? 'is-current-speaker' : ''} ${turn.participantId === hotseatParticipantId ? 'is-hotseat-target' : ''}`}
                  >
                    <header>
                      {turn.roleSlot === 'archivist' && (
                        <span className="ending-chat-bubble__icon ending-chat-bubble__icon--archivist" aria-hidden="true" />
                      )}
                      <strong>{turn.speaker}</strong>
                      {turn.participantId === currentSpeakerParticipantId && (
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
                  </article>
                ))}
              {!replayPayload && sortedDrafts.map((draft) => (
                <article key={draft.turnId} className="ending-chat-bubble ending-chat-bubble--draft">
                  <header>
                    <strong>{participantsById.get(draft.participantId)?.display_name ?? (isZh ? '未知角色' : 'Unknown')}</strong>
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
                    {isZh ? '档案官路由' : 'Archivist route'}
                  </button>
                  <button
                    type="button"
                    className={`ending-chat-mode-pill ${interactionMode === 'hotseat' ? 'is-active' : ''}`}
                    onClick={() => setInteractionMode('hotseat')}
                    disabled={!composerEnabled || representatives.length === 0}
                  >
                    {isZh ? '代表热座' : 'Representative hotseat'}
                  </button>
                </div>
                <span className="ending-chat-scope-notice">{transcriptSubtitle}</span>
              </div>

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
                      ? '围绕这桌代表的分歧继续追问，但仍然只允许读取本桌 scope。'
                      : 'Keep probing the disagreement at this table while staying inside the current roundtable scope.'
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
