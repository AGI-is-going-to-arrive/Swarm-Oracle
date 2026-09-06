import i18n, { normalizeLanguage } from '../i18n/config';
import { getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { create } from 'zustand';
import { createCompatUuid } from '../lib/compatUuid';

import { createDebate, getDebate } from '../api/client';
import type {
  DebateCounterplayResult,
  DebateParticipant,
  DebateVerdictEventPayload,
  DebateScore,
  DebateSnapshot,
  DebateTurn,
} from '../types';

interface DebateState {
  debate: DebateSnapshot | null;
  pendingParticipants: { debateId: string | null; participants: DebateParticipant[] } | null;
  status: 'idle' | 'loading' | 'live' | 'done' | 'error' | 'cancelled' | 'deleted';
  activeDebateId: string | null;
  deletedDebateId: string | null;
  error: string | null;
  errorCode: string | null;
  startDebate: (question: string) => Promise<string>;
  loadDebate: (id: string) => Promise<void>;
  setDebate: (debate: DebateSnapshot, expectedDebateId?: string) => void;
  setTerminalStatus: (status: 'cancelled' | 'deleted', debateId: string) => void;
  appendTurn: (turn: DebateTurn) => void;
  setPhase: (phase: DebateSnapshot['current_phase']) => void;
  setParticipants: (participants: DebateParticipant[], debateId?: string | null) => void;
  setScore: (score: DebateScore) => void;
  setCounterplay: (counterplay: DebateCounterplayResult) => void;
  setVerdict: (verdict: DebateVerdictEventPayload) => void;
  setError: (message: unknown) => void;
  reset: () => void;
}

const initialState = {
  debate: null,
  activeDebateId: null as string | null,
  deletedDebateId: null as string | null,
  pendingParticipants: null as { debateId: string | null; participants: DebateParticipant[] } | null,
  status: 'idle' as const,
  error: null as string | null,
  errorCode: null as string | null,
};

let loadEpoch = 0;
let pendingStart: { intent: string; requestId: string; promise?: Promise<string> } | null = null;

function uiStatus(status: DebateSnapshot['status']): DebateState['status'] {
  return status === 'queued' ? 'live' : status;
}

function runtimeUpdatesClosed(state: DebateState): boolean {
  return ['deleted', 'cancelled'].includes(state.status) || Boolean(state.debate && ['done', 'error', 'cancelled'].includes(state.debate.status));
}

const PHASE_ORDER: DebateSnapshot['current_phase'][] = [
  'opening',
  'crossfire',
  'rebuttal',
  'closing',
  'verdict',
];

function sortTurns(turns: DebateTurn[]): DebateTurn[] {
  return [...turns].sort((a, b) => a.sequence - b.sequence);
}

function mergeTurns(current: DebateTurn[], incoming: DebateTurn[]): DebateTurn[] {
  const merged = new Map<string, DebateTurn>();
  for (const turn of current) {
    merged.set(turn.id, turn);
  }
  for (const turn of incoming) {
    merged.set(turn.id, turn);
  }
  return sortTurns([...merged.values()]);
}

function mergeParticipants(
  current: DebateParticipant[],
  incoming: DebateParticipant[],
): DebateParticipant[] {
  const incomingBySide = new Map(incoming.map((participant) => [participant.side, participant]));
  const currentSides = new Set(current.map((participant) => participant.side));
  return [
    ...current.map((participant) => {
      const next = incomingBySide.get(participant.side);
      if (!next) return participant;
      return {
        ...participant,
        ...next,
        name: next.name?.trim() ? next.name : participant.name,
        role: next.role?.trim() ? next.role : participant.role,
        persona: next.persona ?? participant.persona,
      };
    }),
    ...incoming.filter((participant) => !currentSides.has(participant.side)),
  ];
}

function laterPhase(
  left: DebateSnapshot['current_phase'],
  right: DebateSnapshot['current_phase'],
): DebateSnapshot['current_phase'] {
  return PHASE_ORDER.indexOf(left) >= PHASE_ORDER.indexOf(right) ? left : right;
}

function moreFinalStatus(
  left: DebateSnapshot['status'],
  right: DebateSnapshot['status'],
): DebateSnapshot['status'] {
  const rank: Record<DebateSnapshot['status'], number> = {
    queued: 0,
    live: 1,
    done: 2,
    error: 3,
    cancelled: 4,
  };
  return rank[left] >= rank[right] ? left : right;
}

function mergeDebateSnapshot(
  current: DebateSnapshot | null,
  incoming: DebateSnapshot,
  pendingParticipants?: { debateId: string | null; participants: DebateParticipant[] } | null,
): DebateSnapshot {
  const participants = pendingParticipants
    && (pendingParticipants.debateId == null || pendingParticipants.debateId === incoming.id)
    ? mergeParticipants(incoming.participants, pendingParticipants.participants)
    : incoming.participants;

  if (!current || current.id !== incoming.id) {
    return { ...incoming, participants, turns: sortTurns(incoming.turns) };
  }
  if (current.status === 'cancelled' && incoming.status !== 'cancelled') return current;
  if (incoming.status === 'cancelled') {
    return { ...incoming, participants, turns: sortTurns(incoming.turns), result_ready: false };
  }
  if (['done', 'error'].includes(current.status) && incoming.status !== current.status) return current;

  return {
    ...incoming,
    participants: mergeParticipants(current.participants, participants),
    turns: mergeTurns(current.turns, incoming.turns),
    current_phase: laterPhase(current.current_phase, incoming.current_phase),
    status: moreFinalStatus(current.status, incoming.status),
    result_ready: current.result_ready || incoming.result_ready,
    phase_insights: incoming.phase_insights?.length
      ? incoming.phase_insights
      : current.phase_insights,
    counterplay: incoming.counterplay ?? current.counterplay,
  };
}

function translate(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, options as never) as unknown as string;
}

export const useDebateStore = create<DebateState>((set, get) => ({
  ...initialState,

  startDebate: async (question: string) => {
    const language = normalizeLanguage(i18n.language);
    const intent = JSON.stringify([question.trim(), language]);
    if (pendingStart?.intent === intent && pendingStart.promise) return pendingStart.promise;
    const requestId = pendingStart?.intent === intent ? pendingStart.requestId : createCompatUuid();
    const epoch = ++loadEpoch;
    set({ status: 'loading', error: null });
    const promise = createDebate(question, undefined, { language, clientRequestId: requestId })
      .then((debate) => {
        if (epoch === loadEpoch) set({
          debate, activeDebateId: debate.id, pendingParticipants: null,
          status: uiStatus(debate.status), error: null, errorCode: null,
        });
        if (pendingStart?.requestId === requestId) pendingStart = null;
        return debate.id;
      })
      .catch((error: unknown) => {
        if (epoch === loadEpoch) set({
          status: 'error', errorCode: getApiErrorCode(error),
          error: getLocalizedApiErrorMessage(error, translate, translate('common.api_errors.debate_start_failed')),
        });
        if (pendingStart?.requestId === requestId) pendingStart = { intent, requestId };
        throw error;
      });
    pendingStart = { intent, requestId, promise };
    return promise;
  },

  loadDebate: async (id: string) => {
    const epoch = ++loadEpoch;
    set((state) => state.activeDebateId === id || state.debate?.id === id
      ? { activeDebateId: id, error: null }
      : { ...initialState, activeDebateId: id, status: 'loading' });
    try {
      const debate = await getDebate(id);
      if (epoch !== loadEpoch || get().activeDebateId !== id) return;
      set((state) => {
        if (state.deletedDebateId === id) return state;
        const merged = mergeDebateSnapshot(state.debate, debate, state.pendingParticipants);
        return {
          debate: merged,
          pendingParticipants: null,
          status: uiStatus(merged.status),
          error: null,
          errorCode: null,
        };
      });
    } catch (error) {
      if (epoch !== loadEpoch || get().activeDebateId !== id || get().deletedDebateId === id) return;
      set({
        status: get().debate?.status === 'cancelled' ? 'cancelled' : 'error',
        errorCode: getApiErrorCode(error),
        error: getLocalizedApiErrorMessage(
          error,
          translate,
          translate('common.api_errors.debate_load_failed'),
        ),
      });
    }
  },

  setDebate: (debate, expectedDebateId) => set((state) => {
    if (state.deletedDebateId === debate.id) return state;
    if (expectedDebateId && state.activeDebateId && state.activeDebateId !== expectedDebateId) return state;
    if (state.activeDebateId !== debate.id) loadEpoch += 1;
    const merged = mergeDebateSnapshot(state.debate, debate, state.pendingParticipants);
    return {
      debate: merged,
      activeDebateId: debate.id,
      pendingParticipants: null,
      status: uiStatus(merged.status),
      error: null,
      errorCode: null,
    };
  }),

  setTerminalStatus: (status, debateId) => set((state) => {
    if (state.activeDebateId && state.activeDebateId !== debateId) return state;
    if (state.debate && state.debate.id !== debateId) return state;
    if (state.deletedDebateId === debateId) return state;
    if (status === 'deleted') {
      loadEpoch += 1;
      return { ...initialState, status: 'deleted', activeDebateId: debateId, deletedDebateId: debateId };
    }
    return {
      status: 'cancelled', activeDebateId: debateId, error: null, errorCode: null,
      debate: state.debate ? { ...state.debate, status: 'cancelled', result_ready: false } : null,
    };
  }),

  appendTurn: (turn) => set((state) => {
    if (!state.debate || runtimeUpdatesClosed(state)) return state;
    const exists = state.debate.turns.some((item) => item.id === turn.id);
    if (exists) return state;
    return {
      debate: {
        ...state.debate,
        turns: sortTurns([
          ...state.debate.turns,
          { ...turn, created_at: turn.created_at ?? new Date().toISOString() },
        ]),
      },
    };
  }),

  setPhase: (phase) => set((state) => {
    if (!state.debate || runtimeUpdatesClosed(state)) return state;
    return {
      debate: {
        ...state.debate,
        current_phase: laterPhase(state.debate.current_phase, phase),
      },
    };
  }),

  setParticipants: (participants, debateId = null) => set((state) => {
    if (runtimeUpdatesClosed(state)) return state;
    if (!state.debate) {
      return { pendingParticipants: { debateId, participants } };
    }
    if (debateId && state.debate.id !== debateId) return state;
    return {
      debate: {
        ...state.debate,
        participants: mergeParticipants(state.debate.participants, participants),
      },
    };
  }),

  setScore: (score) => set((state) => {
    if (!state.debate || runtimeUpdatesClosed(state)) return state;
    return {
      debate: {
        ...state.debate,
        score,
      },
    };
  }),

  setCounterplay: (counterplay) => set((state) => {
    if (!state.debate || runtimeUpdatesClosed(state)) return state;
    return {
      debate: {
        ...state.debate,
        counterplay,
      },
    };
  }),

  setVerdict: (verdict) => set((state) => {
    if (!state.debate || state.status === 'deleted' || ['error', 'cancelled'].includes(state.debate.status)) return state;
    return {
      debate: {
        ...state.debate,
        status: 'done',
        current_phase: 'verdict',
        score: verdict.score,
        phase_insights: verdict.phase_insights ?? state.debate.phase_insights,
        result_ready: true,
      },
      status: 'done',
    };
  }),

  setError: (message) => set((state) => runtimeUpdatesClosed(state) ? state : ({
    debate: state.debate ? { ...state.debate, status: 'error' } : state.debate,
    status: 'error',
    errorCode: getApiErrorCode(message),
    error: getLocalizedApiErrorMessage(
      message,
      translate,
      translate('common.api_errors.debate_load_failed'),
    ),
  })),

  reset: () => {
    loadEpoch += 1;
    pendingStart = null;
    set(initialState);
  },
}));
