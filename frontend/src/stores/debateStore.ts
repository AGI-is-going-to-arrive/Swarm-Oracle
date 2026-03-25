import i18n from '../i18n/config';
import { getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { create } from 'zustand';

import { createDebate, getDebate } from '../api/client';
import type {
  DebateCounterplayResult,
  DebateVerdictEventPayload,
  DebateScore,
  DebateSnapshot,
  DebateTurn,
} from '../types';

interface DebateState {
  debate: DebateSnapshot | null;
  status: 'idle' | 'loading' | 'live' | 'done' | 'error';
  error: string | null;
  errorCode: string | null;
  startDebate: (question: string) => Promise<string>;
  loadDebate: (id: string) => Promise<void>;
  setDebate: (debate: DebateSnapshot) => void;
  appendTurn: (turn: DebateTurn) => void;
  setPhase: (phase: DebateSnapshot['current_phase']) => void;
  setScore: (score: DebateScore) => void;
  setCounterplay: (counterplay: DebateCounterplayResult) => void;
  setVerdict: (verdict: DebateVerdictEventPayload) => void;
  setError: (message: unknown) => void;
  reset: () => void;
}

const initialState = {
  debate: null,
  status: 'idle' as const,
  error: null as string | null,
  errorCode: null as string | null,
};

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
  };
  return rank[left] >= rank[right] ? left : right;
}

function mergeDebateSnapshot(
  current: DebateSnapshot | null,
  incoming: DebateSnapshot,
): DebateSnapshot {
  if (!current || current.id !== incoming.id) {
    return { ...incoming, turns: sortTurns(incoming.turns) };
  }

  return {
    ...incoming,
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

export const useDebateStore = create<DebateState>((set) => ({
  ...initialState,

  startDebate: async (question: string) => {
    set({ status: 'loading', error: null });
    try {
      const debate = await createDebate(question);
      set({
        debate,
        status: debate.status === 'done' ? 'done' : debate.status === 'error' ? 'error' : 'live',
        error: null,
        errorCode: null,
      });
      return debate.id;
    } catch (error) {
      set({
        status: 'error',
        errorCode: getApiErrorCode(error),
        error: getLocalizedApiErrorMessage(
          error,
          translate,
          translate('common.api_errors.debate_start_failed'),
        ),
      });
      throw error;
    }
  },

  loadDebate: async (id: string) => {
    set((state) => ({ status: state.debate?.id === id ? state.status : 'loading', error: null }));
    try {
      const debate = await getDebate(id);
      set((state) => {
        const merged = mergeDebateSnapshot(state.debate, debate);
        return {
          debate: merged,
          status: merged.status === 'done' ? 'done' : merged.status === 'error' ? 'error' : 'live',
          error: null,
          errorCode: null,
        };
      });
    } catch (error) {
      set({
        status: 'error',
        errorCode: getApiErrorCode(error),
        error: getLocalizedApiErrorMessage(
          error,
          translate,
          translate('common.api_errors.debate_load_failed'),
        ),
      });
    }
  },

  setDebate: (debate) => set((state) => {
    const merged = mergeDebateSnapshot(state.debate, debate);
    return {
      debate: merged,
      status: merged.status === 'done' ? 'done' : merged.status === 'error' ? 'error' : 'live',
      error: null,
      errorCode: null,
    };
  }),

  appendTurn: (turn) => set((state) => {
    if (!state.debate) return state;
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
    if (!state.debate) return state;
    return {
      debate: {
        ...state.debate,
        current_phase: laterPhase(state.debate.current_phase, phase),
      },
    };
  }),

  setScore: (score) => set((state) => {
    if (!state.debate) return state;
    return {
      debate: {
        ...state.debate,
        score,
      },
    };
  }),

  setCounterplay: (counterplay) => set((state) => {
    if (!state.debate) return state;
    return {
      debate: {
        ...state.debate,
        counterplay,
      },
    };
  }),

  setVerdict: (verdict) => set((state) => {
    if (!state.debate) return state;
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

  setError: (message) => set((state) => ({
    debate: state.debate ? { ...state.debate, status: 'error' } : state.debate,
    status: 'error',
    errorCode: getApiErrorCode(message),
    error: getLocalizedApiErrorMessage(
      message,
      translate,
      translate('common.api_errors.debate_load_failed'),
    ),
  })),

  reset: () => set(initialState),
}));
