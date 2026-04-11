import i18n from '../i18n/config';
import { create } from 'zustand';

import {
  appendEndingRoomThreadUserTurn,
  appendEndingRoomUserTurn,
  createEndingRoom,
  createEndingRoomThread,
  getEndingRoom,
  getEndingRoomResult,
  getEndingRoomThread,
} from '../api/client';
import { getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import type {
  AppendEndingRoomUserTurnRequest,
  CreateEndingRoomRequest,
  CreateEndingRoomThreadRequest,
  EndingRoomInteractionMode,
  EndingRoomPhase,
  EndingRoomResult,
  EndingRoomResultPayload,
  EndingRoomSnapshot,
  EndingRoomStatus,
  EndingRoomThread,
  EndingRoomThreadSnapshot,
  EndingRoomTurn,
} from '../types';

export interface EndingRoomDraft {
  turnId: string;
  threadId: string | null;
  participantId: string;
  phase: EndingRoomPhase;
  sequence: number;
  content: string;
}

interface DraftStartPayload {
  room_id: string;
  thread_id?: string | null;
  turn_id: string;
  participant_id: string;
  phase: EndingRoomPhase;
  sequence: number;
}

interface DraftDeltaPayload {
  room_id: string;
  thread_id?: string | null;
  turn_id: string;
  participant_id: string;
  delta: string;
  chunk_index: number;
}

interface DraftErrorPayload {
  room_id: string;
  thread_id?: string | null;
  turn_id: string;
  participant_id?: string;
  message?: string;
  error?: string;
  code?: string;
  recoverable?: boolean;
}

interface ScopeNoticePayload {
  threadId: string;
  memoryPartitionId: string;
}

interface EndingRoomState {
  snapshot: EndingRoomSnapshot | null;
  result: EndingRoomResult | null;
  threadsById: Record<string, EndingRoomThreadSnapshot>;
  threadOrder: string[];
  activeThreadId: string | null;
  interactionMode: EndingRoomInteractionMode;
  composerDraft: string;
  scopeNotice: ScopeNoticePayload | null;
  sending: boolean;
  status: 'idle' | 'loading' | 'draft' | 'live' | 'done' | 'error';
  error: string | null;
  errorCode: string | null;
  pendingDrafts: Record<string, EndingRoomDraft>;
  openRoom: (scenarioId: string, payload: CreateEndingRoomRequest) => Promise<string>;
  loadRoom: (roomId: string) => Promise<void>;
  loadThread: (threadId: string) => Promise<void>;
  hydrateSnapshot: (snapshot: EndingRoomSnapshot) => void;
  hydrateResult: (payload: EndingRoomResultPayload) => void;
  hydrateThread: (thread: EndingRoomThreadSnapshot) => void;
  setPhase: (phase: EndingRoomPhase) => void;
  setStatus: (status: EndingRoomStatus, error?: unknown) => void;
  startDraft: (payload: DraftStartPayload) => void;
  appendDraft: (payload: DraftDeltaPayload) => void;
  handleTurnError: (payload: DraftErrorPayload) => void;
  commitTurn: (turn: EndingRoomTurn) => void;
  setResult: (result: EndingRoomResult) => void;
  setActiveThread: (threadId: string | null) => void;
  setInteractionMode: (mode: EndingRoomInteractionMode) => void;
  setComposerDraft: (value: string) => void;
  setScopeNotice: (payload: ScopeNoticePayload | null) => void;
  createThread: (roomId: string, payload: CreateEndingRoomThreadRequest) => Promise<EndingRoomThreadSnapshot>;
  appendUserTurn: (payload: AppendEndingRoomUserTurnRequest) => Promise<void>;
  setError: (message: unknown, fallbackMessage?: string) => void;
  reset: () => void;
}

const initialState = {
  snapshot: null as EndingRoomSnapshot | null,
  result: null as EndingRoomResult | null,
  threadsById: {} as Record<string, EndingRoomThreadSnapshot>,
  threadOrder: [] as string[],
  activeThreadId: null as string | null,
  interactionMode: 'archivist_route' as EndingRoomInteractionMode,
  composerDraft: '',
  scopeNotice: null as ScopeNoticePayload | null,
  sending: false,
  status: 'idle' as const,
  error: null as string | null,
  errorCode: null as string | null,
  pendingDrafts: {} as Record<string, EndingRoomDraft>,
};

const PHASE_ORDER: EndingRoomPhase[] = [
  'opening',
  'crossfire',
  'rebuttal',
  'closing',
  'verdict',
];

function translate(key: string): string {
  return i18n.t(key) as unknown as string;
}

function sortTurns(turns: EndingRoomTurn[]): EndingRoomTurn[] {
  return [...turns].sort((left, right) => left.sequence - right.sequence);
}

function sortThreads(threads: EndingRoomThread[]): EndingRoomThread[] {
  return [...threads].sort((left, right) => {
    const byCreatedAt = left.created_at.localeCompare(right.created_at);
    if (byCreatedAt !== 0) return byCreatedAt;
    return left.id.localeCompare(right.id);
  });
}

function mergeTurns(current: EndingRoomTurn[], incoming: EndingRoomTurn[]): EndingRoomTurn[] {
  const merged = new Map<string, EndingRoomTurn>();
  for (const turn of current) {
    merged.set(turn.id, turn);
  }
  for (const turn of incoming) {
    merged.set(turn.id, turn);
  }
  return sortTurns([...merged.values()]);
}

function laterPhase(left: EndingRoomPhase, right: EndingRoomPhase): EndingRoomPhase {
  return PHASE_ORDER.indexOf(left) >= PHASE_ORDER.indexOf(right) ? left : right;
}

function moreFinalStatus(left: EndingRoomStatus, right: EndingRoomStatus): EndingRoomStatus {
  const rank: Record<EndingRoomStatus, number> = {
    draft: 0,
    live: 1,
    done: 2,
    error: 3,
  };
  return rank[left] >= rank[right] ? left : right;
}

function resolveStateStatus(status: EndingRoomStatus): EndingRoomState['status'] {
  return status;
}

function resolveDefaultThreadId(snapshot: EndingRoomSnapshot | null): string | null {
  if (!snapshot) return null;
  return snapshot.threads.find((thread) => thread.mode === 'room')?.id
    ?? snapshot.threads[0]?.id
    ?? null;
}

function resolveDraftThreadId(
  threadId: string | null | undefined,
  snapshot: EndingRoomSnapshot | null,
): string | null {
  if (threadId) return threadId;
  return resolveDefaultThreadId(snapshot);
}

function mergeThreadSnapshot(
  current: EndingRoomThreadSnapshot | undefined,
  incoming: EndingRoomThreadSnapshot,
): EndingRoomThreadSnapshot {
  if (!current || current.id !== incoming.id) {
    return { ...incoming, turns: sortTurns(incoming.turns) };
  }
  return {
    ...incoming,
    turns: mergeTurns(current.turns, incoming.turns),
  };
}

function mergeThreadsById(
  current: Record<string, EndingRoomThreadSnapshot>,
  threads: EndingRoomThread[],
  roomTurns: EndingRoomTurn[],
  roomMeta: Pick<EndingRoomSnapshot, 'room_type' | 'title' | 'status' | 'language'>,
): Record<string, EndingRoomThreadSnapshot> {
  const next = { ...current };
  for (const thread of threads) {
    const snapshotTurns = roomTurns.filter((turn) => turn.thread_id === thread.id);
    next[thread.id] = mergeThreadSnapshot(next[thread.id], {
      ...thread,
      room_type: roomMeta.room_type,
      room_title: roomMeta.title,
      room_status: roomMeta.status,
      language: roomMeta.language,
      turns: snapshotTurns.length > 0 ? snapshotTurns : (next[thread.id]?.turns ?? []),
    });
  }
  return next;
}

function collectCommittedTurnIds(
  snapshot: EndingRoomSnapshot | null,
  threadsById: Record<string, EndingRoomThreadSnapshot>,
): Set<string> {
  const committedTurnIds = new Set<string>();
  snapshot?.turns.forEach((turn) => committedTurnIds.add(turn.id));
  Object.values(threadsById).forEach((thread) => {
    thread.turns.forEach((turn) => committedTurnIds.add(turn.id));
  });
  return committedTurnIds;
}

function prunePendingDrafts(
  pendingDrafts: Record<string, EndingRoomDraft>,
  committedTurnIds: Set<string>,
): Record<string, EndingRoomDraft> {
  if (Object.keys(pendingDrafts).length === 0) {
    return pendingDrafts;
  }
  let changed = false;
  const next: Record<string, EndingRoomDraft> = {};
  Object.entries(pendingDrafts).forEach(([turnId, draft]) => {
    if (committedTurnIds.has(turnId)) {
      changed = true;
      return;
    }
    next[turnId] = draft;
  });
  return changed ? next : pendingDrafts;
}

function mergeSnapshot(
  current: EndingRoomSnapshot | null,
  incoming: EndingRoomSnapshot,
): EndingRoomSnapshot {
  if (!current || current.id !== incoming.id) {
    return {
      ...incoming,
      turns: sortTurns(incoming.turns),
      threads: sortThreads(incoming.threads),
    };
  }

  return {
    ...incoming,
    turns: mergeTurns(current.turns, incoming.turns),
    threads: sortThreads(incoming.threads.length > 0 ? incoming.threads : current.threads),
    current_phase: laterPhase(current.current_phase, incoming.current_phase),
    status: moreFinalStatus(current.status, incoming.status),
    result_ready: current.result_ready || incoming.result_ready,
    participants: incoming.participants.length > 0 ? incoming.participants : current.participants,
  };
}

export const useEndingRoomStore = create<EndingRoomState>((set, get) => ({
  ...initialState,

  openRoom: async (scenarioId, payload) => {
    set({
      ...initialState,
      status: 'loading',
    });

    try {
      const snapshot = await createEndingRoom(scenarioId, payload);
      get().hydrateSnapshot(snapshot);
      if (snapshot.result_ready) {
        await get().loadRoom(snapshot.id);
      }
      return snapshot.id;
    } catch (error) {
      get().setError(error, translate('ending_room.start_failed'));
      throw error;
    }
  },

  loadRoom: async (roomId) => {
    set((state) => ({
      status: state.snapshot?.id === roomId ? state.status : 'loading',
      error: null,
      errorCode: null,
    }));

    try {
      const snapshot = await getEndingRoom(roomId);
      get().hydrateSnapshot(snapshot);
      if (snapshot.result_ready) {
        try {
          const payload = await getEndingRoomResult(roomId);
          get().hydrateResult(payload);
        } catch {
          // Result not yet available — room is still usable, will retry on next WS event
        }
      }
    } catch (error) {
      get().setError(error, translate('ending_room.load_failed'));
    }
  },

  loadThread: async (threadId) => {
    try {
      const payload = await getEndingRoomThread(threadId);
      get().hydrateThread(payload);
    } catch (error) {
      get().setError(error, translate('ending_room.load_failed'));
    }
  },

  hydrateSnapshot: (snapshot) => set((state) => {
    const merged = mergeSnapshot(state.snapshot, snapshot);
    const threadsById = mergeThreadsById(state.threadsById, merged.threads, merged.turns, {
      room_type: merged.room_type,
      title: merged.title,
      status: merged.status,
      language: merged.language,
    });
    const committedTurnIds = collectCommittedTurnIds(merged, threadsById);
    const threadOrder = sortThreads(merged.threads).map((thread) => thread.id);
    const defaultThreadId = resolveDefaultThreadId(merged);
    return {
      snapshot: merged,
      threadsById,
      threadOrder,
      activeThreadId: state.activeThreadId && threadsById[state.activeThreadId]
        ? state.activeThreadId
        : defaultThreadId,
      status: resolveStateStatus(merged.status),
      error: null,
      errorCode: null,
      result: state.result && state.snapshot?.id === merged.id ? state.result : state.result,
      pendingDrafts: merged.status === 'done' || merged.status === 'error'
        ? {}
        : prunePendingDrafts(state.pendingDrafts, committedTurnIds),
    };
  }),

  hydrateResult: (payload) => set((state) => {
    const merged = mergeSnapshot(state.snapshot, payload);
    const threadsById = mergeThreadsById(state.threadsById, merged.threads, merged.turns, {
      room_type: merged.room_type,
      title: merged.title,
      status: merged.status,
      language: merged.language,
    });
    const committedTurnIds = collectCommittedTurnIds(merged, threadsById);
    return {
      snapshot: merged,
      threadsById,
      threadOrder: sortThreads(merged.threads).map((thread) => thread.id),
      activeThreadId: state.activeThreadId && threadsById[state.activeThreadId]
        ? state.activeThreadId
        : resolveDefaultThreadId(merged),
      result: payload.result,
      status: resolveStateStatus(payload.status),
      error: null,
      errorCode: null,
      pendingDrafts: payload.status === 'done' || payload.status === 'error'
        ? {}
        : prunePendingDrafts(state.pendingDrafts, committedTurnIds),
    };
  }),

  hydrateThread: (thread) => set((state) => {
    const snapshot = state.snapshot?.id === thread.room_id
      ? {
          ...state.snapshot,
          threads: sortThreads([
            ...state.snapshot.threads.filter((currentThread) => currentThread.id !== thread.id),
            thread,
          ]),
        }
      : state.snapshot;
    const threadsById = {
      ...state.threadsById,
      [thread.id]: mergeThreadSnapshot(state.threadsById[thread.id], thread),
    };
    const committedTurnIds = collectCommittedTurnIds(snapshot, threadsById);
    return {
      snapshot,
      threadsById,
      threadOrder: state.threadOrder.includes(thread.id)
        ? state.threadOrder
        : [...state.threadOrder, thread.id],
      activeThreadId: state.activeThreadId ?? thread.id,
      pendingDrafts: prunePendingDrafts(state.pendingDrafts, committedTurnIds),
    };
  }),

  setPhase: (phase) => set((state) => {
    if (!state.snapshot) return state;
    return {
      snapshot: {
        ...state.snapshot,
        current_phase: laterPhase(state.snapshot.current_phase, phase),
      },
    };
  }),

  setStatus: (status, error) => set((state) => {
    const next = {
      status: resolveStateStatus(status),
      error: null as string | null,
      errorCode: null as string | null,
      pendingDrafts: status === 'done' || status === 'error' ? {} : state.pendingDrafts,
      snapshot: state.snapshot
        ? {
            ...state.snapshot,
            status: moreFinalStatus(state.snapshot.status, status),
          }
        : state.snapshot,
    };
    if (status === 'error' && error !== undefined) {
      next.errorCode = getApiErrorCode(error);
      next.error = getLocalizedApiErrorMessage(
        error,
        translate,
        translate('ending_room.load_failed'),
      );
    }
    return next;
  }),

  startDraft: (payload) => set((state) => {
    if (collectCommittedTurnIds(state.snapshot, state.threadsById).has(payload.turn_id)) {
      return state;
    }
    return {
      pendingDrafts: {
        ...state.pendingDrafts,
        [payload.turn_id]: {
          turnId: payload.turn_id,
          threadId: resolveDraftThreadId(payload.thread_id, state.snapshot),
          participantId: payload.participant_id,
          phase: payload.phase,
          sequence: payload.sequence,
          content: '',
        },
      },
    };
  }),

  appendDraft: (payload) => set((state) => {
    if (collectCommittedTurnIds(state.snapshot, state.threadsById).has(payload.turn_id)) {
      return state;
    }
    const current = state.pendingDrafts[payload.turn_id];
    return {
      pendingDrafts: {
        ...state.pendingDrafts,
        [payload.turn_id]: {
          turnId: payload.turn_id,
          threadId: current?.threadId ?? resolveDraftThreadId(payload.thread_id, state.snapshot),
          participantId: payload.participant_id,
          phase: current?.phase ?? state.snapshot?.current_phase ?? 'opening',
          sequence: current?.sequence ?? 0,
          content: `${current?.content ?? ''}${payload.delta}`,
        },
      },
    };
  }),

  handleTurnError: (payload) => set((state) => {
    if (!payload.turn_id) {
      return state;
    }
    if (!(payload.turn_id in state.pendingDrafts)) {
      return state;
    }
    const pendingDrafts = { ...state.pendingDrafts };
    delete pendingDrafts[payload.turn_id];
    return {
      pendingDrafts,
    };
  }),

  commitTurn: (turn) => set((state) => {
    if (!state.snapshot) return state;
    const pendingDrafts = { ...state.pendingDrafts };
    delete pendingDrafts[turn.id];
    const threadId = turn.thread_id ?? resolveDefaultThreadId(state.snapshot);
    return {
      snapshot: {
        ...state.snapshot,
        turns: mergeTurns(state.snapshot.turns, [turn]),
        current_phase: laterPhase(state.snapshot.current_phase, turn.phase),
      },
      threadsById: threadId && state.threadsById[threadId]
        ? {
            ...state.threadsById,
            [threadId]: {
              ...state.threadsById[threadId],
              turns: mergeTurns(state.threadsById[threadId].turns, [turn]),
            },
          }
        : state.threadsById,
      pendingDrafts,
    };
  }),

  setResult: (result) => set(() => ({
    result,
    status: 'done',
    error: null,
    errorCode: null,
    pendingDrafts: {},
  })),

  setActiveThread: (threadId) => set(() => ({
    activeThreadId: threadId,
    scopeNotice: null,
  })),

  setInteractionMode: (mode) => set(() => ({
    interactionMode: mode,
  })),

  setComposerDraft: (value) => set(() => ({
    composerDraft: value,
  })),

  setScopeNotice: (payload) => set(() => ({
    scopeNotice: payload,
  })),

  createThread: async (roomId, payload) => {
    const thread = await createEndingRoomThread(roomId, payload);
    get().hydrateThread(thread);
    get().setActiveThread(thread.id);
    return thread;
  },

  appendUserTurn: async (payload) => {
    const state = get();
    const roomId = state.snapshot?.id;
    if (!roomId) return;
    const threadId = state.activeThreadId;
    const thread = threadId ? state.threadsById[threadId] : undefined;
    set(() => ({ sending: true, error: null, errorCode: null }));
    try {
      const response = thread && thread.mode === 'followup'
        ? await appendEndingRoomThreadUserTurn(thread.id, payload)
        : await appendEndingRoomUserTurn(roomId, payload);
      response.turns.forEach((turn) => get().commitTurn(turn));
      set(() => ({ composerDraft: '' }));
      // Follow-up APIs only return new turns. Re-read the room so derived thread state
      // and late-created participants (for example the local user turn) stay in sync.
      await get().loadRoom(roomId);
      if (thread && thread.mode === 'followup') {
        await get().loadThread(thread.id);
      }
    } catch (error) {
      get().setError(error, translate('ending_room.load_failed'));
      throw error;
    } finally {
      set(() => ({ sending: false }));
    }
  },

  setError: (message, fallbackMessage = translate('ending_room.load_failed')) => set((state) => ({
    snapshot: state.snapshot
      ? {
          ...state.snapshot,
          status: 'error',
        }
      : state.snapshot,
    status: 'error',
    errorCode: getApiErrorCode(message),
    error: getLocalizedApiErrorMessage(message, translate, fallbackMessage),
    pendingDrafts: {},
    sending: false,
  })),

  reset: () => set(initialState),
}));
