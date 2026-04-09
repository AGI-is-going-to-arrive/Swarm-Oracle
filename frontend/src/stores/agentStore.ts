/* ═══════════════════════════════════════════════════════════
   Phase 3 F1/F3 — Agent Identity Store (Zustand)
   ═══════════════════════════════════════════════════════════ */

import { create } from 'zustand';
import type { AgentIdentityInfo } from '../types';

interface AgentStoreState {
  identities: AgentIdentityInfo[];
  loading: boolean;
  error: string | null;
  selectedIds: Set<string>;

  fetchIdentities: (userId: string) => Promise<void>;
  toggleSelection: (id: string) => void;
  clearSelection: () => void;
  setIdentities: (identities: AgentIdentityInfo[]) => void;
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  identities: [],
  loading: false,
  error: null,
  selectedIds: new Set(),

  fetchIdentities: async (userId: string) => {
    set({ loading: true, error: null });
    try {
      const res = await fetch(`/api/agents/identities?user_id=${encodeURIComponent(userId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: AgentIdentityInfo[] = await res.json();
      set({ identities: data, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  toggleSelection: (id: string) => {
    const current = get().selectedIds;
    const next = new Set(current);
    if (next.has(id)) {
      next.delete(id);
    } else if (next.size < 5) {
      next.add(id);
    }
    set({ selectedIds: next });
  },

  clearSelection: () => set({ selectedIds: new Set() }),

  setIdentities: (identities) => set({ identities }),
}));
