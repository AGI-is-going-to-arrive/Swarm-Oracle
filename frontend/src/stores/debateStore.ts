import { create } from 'zustand';

import { createDebate, getDebate } from '../api/client';
import type {
  DebateResultSummary,
  DebateScore,
  DebateSnapshot,
  DebateTurn,
} from '../types';

interface DebateState {
  debate: DebateSnapshot | null;
  status: 'idle' | 'loading' | 'live' | 'done' | 'error';
  error: string | null;
  startDebate: (question: string) => Promise<string>;
  loadDebate: (id: string) => Promise<void>;
  setDebate: (debate: DebateSnapshot) => void;
  appendTurn: (turn: DebateTurn) => void;
  setPhase: (phase: DebateSnapshot['current_phase']) => void;
  setScore: (score: DebateScore) => void;
  setVerdict: (verdict: DebateResultSummary) => void;
  setError: (message: string) => void;
  reset: () => void;
}

const initialState = {
  debate: null,
  status: 'idle' as const,
  error: null as string | null,
};

function sortTurns(turns: DebateTurn[]): DebateTurn[] {
  return [...turns].sort((a, b) => a.sequence - b.sequence);
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
      });
      return debate.id;
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to start debate',
      });
      throw error;
    }
  },

  loadDebate: async (id: string) => {
    set((state) => ({ status: state.debate?.id === id ? state.status : 'loading', error: null }));
    try {
      const debate = await getDebate(id);
      set({
        debate: { ...debate, turns: sortTurns(debate.turns) },
        status: debate.status === 'done' ? 'done' : debate.status === 'error' ? 'error' : 'live',
        error: null,
      });
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to load debate',
      });
    }
  },

  setDebate: (debate) => set({
    debate: { ...debate, turns: sortTurns(debate.turns) },
    status: debate.status === 'done' ? 'done' : debate.status === 'error' ? 'error' : 'live',
    error: null,
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
        current_phase: phase,
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

  setVerdict: (verdict) => set((state) => {
    if (!state.debate) return state;
    return {
      debate: {
        ...state.debate,
        status: 'done',
        current_phase: 'verdict',
        score: verdict.score,
        result_ready: true,
      },
      status: 'done',
    };
  }),

  setError: (message) => set((state) => ({
    debate: state.debate ? { ...state.debate, status: 'error' } : state.debate,
    status: 'error',
    error: message,
  })),

  reset: () => set(initialState),
}));
