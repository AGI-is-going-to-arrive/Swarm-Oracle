import i18n from '../i18n/config';
import { create } from 'zustand';

import {
  createEndingRoom,
  getEndingRoom,
  getEndingRoomResult,
} from '../api/client';
import { getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import type {
  CreateEndingRoomRequest,
  EndingRoomPhase,
  EndingRoomResult,
  EndingRoomResultPayload,
  EndingRoomSnapshot,
  EndingRoomStatus,
  EndingRoomTurn,
} from '../types';

export interface EndingRoomDraft {
  turnId: string;
  participantId: string;
  phase: EndingRoomPhase;
  sequence: number;
  content: string;
}

interface DraftStartPayload {
  room_id: string;
  turn_id: string;
  participant_id: string;
  phase: EndingRoomPhase;
  sequence: number;
}

interface DraftDeltaPayload {
  room_id: string;
  turn_id: string;
  participant_id: string;
  delta: string;
  chunk_index: number;
}

interface EndingRoomState {
  snapshot: EndingRoomSnapshot | null;
  result: EndingRoomResult | null;
  status: 'idle' | 'loading' | 'draft' | 'live' | 'done' | 'error';
  error: string | null;
  errorCode: string | null;
  pendingDrafts: Record<string, EndingRoomDraft>;
  openRoom: (scenarioId: string, payload: CreateEndingRoomRequest) => Promise<string>;
  loadRoom: (roomId: string) => Promise<void>;
  hydrateSnapshot: (snapshot: EndingRoomSnapshot) => void;
  hydrateResult: (payload: EndingRoomResultPayload) => void;
  setPhase: (phase: EndingRoomPhase) => void;
  setStatus: (status: EndingRoomStatus, error?: unknown) => void;
  startDraft: (payload: DraftStartPayload) => void;
  appendDraft: (payload: DraftDeltaPayload) => void;
  commitTurn: (turn: EndingRoomTurn) => void;
  setResult: (result: EndingRoomResult) => void;
  setError: (message: unknown, fallbackMessage?: string) => void;
  reset: () => void;
}

const initialState = {
  snapshot: null as EndingRoomSnapshot | null,
  result: null as EndingRoomResult | null,
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

function mergeSnapshot(
  current: EndingRoomSnapshot | null,
  incoming: EndingRoomSnapshot,
): EndingRoomSnapshot {
  if (!current || current.id !== incoming.id) {
    return { ...incoming, turns: sortTurns(incoming.turns) };
  }

  return {
    ...incoming,
    turns: mergeTurns(current.turns, incoming.turns),
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
      snapshot: null,
      status: 'loading',
      error: null,
      errorCode: null,
      result: null,
      pendingDrafts: {},
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
        const payload = await getEndingRoomResult(roomId);
        get().hydrateResult(payload);
      }
    } catch (error) {
      get().setError(error, translate('ending_room.load_failed'));
    }
  },

  hydrateSnapshot: (snapshot) => set((state) => {
    const merged = mergeSnapshot(state.snapshot, snapshot);
    return {
      snapshot: merged,
      status: resolveStateStatus(merged.status),
      error: null,
      errorCode: null,
      result: state.result && state.snapshot?.id === merged.id ? state.result : state.result,
      pendingDrafts: merged.status === 'done' || merged.status === 'error' ? {} : state.pendingDrafts,
    };
  }),

  hydrateResult: (payload) => set((state) => ({
    snapshot: mergeSnapshot(state.snapshot, payload),
    result: payload.result,
    status: resolveStateStatus(payload.status),
    error: null,
    errorCode: null,
    pendingDrafts: payload.status === 'done' || payload.status === 'error' ? {} : state.pendingDrafts,
  })),

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

  startDraft: (payload) => set((state) => ({
    pendingDrafts: {
      ...state.pendingDrafts,
      [payload.turn_id]: {
        turnId: payload.turn_id,
        participantId: payload.participant_id,
        phase: payload.phase,
        sequence: payload.sequence,
        content: '',
      },
    },
  })),

  appendDraft: (payload) => set((state) => {
    const current = state.pendingDrafts[payload.turn_id];
    return {
      pendingDrafts: {
        ...state.pendingDrafts,
        [payload.turn_id]: {
          turnId: payload.turn_id,
          participantId: payload.participant_id,
          phase: current?.phase ?? state.snapshot?.current_phase ?? 'opening',
          sequence: current?.sequence ?? 0,
          content: `${current?.content ?? ''}${payload.delta}`,
        },
      },
    };
  }),

  commitTurn: (turn) => set((state) => {
    if (!state.snapshot) return state;
    const pendingDrafts = { ...state.pendingDrafts };
    delete pendingDrafts[turn.id];
    return {
      snapshot: {
        ...state.snapshot,
        turns: mergeTurns(state.snapshot.turns, [turn]),
        current_phase: laterPhase(state.snapshot.current_phase, turn.phase),
      },
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
  })),

  reset: () => set(initialState),
}));
