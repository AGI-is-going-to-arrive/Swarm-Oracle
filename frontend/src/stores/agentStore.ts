/* ═══════════════════════════════════════════════════════════
   Phase 3 F1/F3 — Agent Identity Store (Zustand)
   ═══════════════════════════════════════════════════════════ */

import { create } from 'zustand';
import { getSessionBoundUserId, listAgentIdentities } from '../api/client';
import type { AgentIdentityInfo } from '../types';

interface AgentStoreState {
  identities: AgentIdentityInfo[];
  loading: boolean;
  error: string | null;
  selectedIds: Set<string>;
  loadedUserId: string | null;
  requestSeq: number;

  fetchIdentities: (userId: string) => Promise<void>;
  toggleSelection: (id: string, maxSelected?: number) => void;
  pruneSelectionToSize: (maxSize: number) => void;
  clearSelection: () => void;
  setIdentities: (identities: AgentIdentityInfo[]) => void;
}

const pruneSelectedIds = (
  selectedIds: Set<string>,
  identities: AgentIdentityInfo[],
): Set<string> => {
  if (selectedIds.size === 0) return selectedIds;
  const validIds = new Set(identities.map((a) => a.id));
  const next = new Set<string>();
  for (const id of selectedIds) {
    if (validIds.has(id)) next.add(id);
  }
  return next;
};

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  identities: [],
  loading: false,
  error: null,
  selectedIds: new Set(),
  loadedUserId: null,
  requestSeq: 0,

  fetchIdentities: async (userId: string) => {
    const effectiveUserId = getSessionBoundUserId(userId);
    const state = get();

    // Skip if already loaded for same user (cache hit)
    if (state.loadedUserId === effectiveUserId && state.identities.length > 0 && !state.loading) {
      return;
    }

    // If userId changed, clear stale data immediately
    if (state.loadedUserId !== null && state.loadedUserId !== effectiveUserId) {
      set({ identities: [], selectedIds: new Set() });
    }

    const reqId = state.requestSeq + 1;
    set({ loading: true, error: null, requestSeq: reqId });

    try {
      const data = await listAgentIdentities<AgentIdentityInfo[]>(effectiveUserId);

      // Ignore stale responses (newer request was issued)
      if (get().requestSeq !== reqId) return;

      const prunedSelected = pruneSelectedIds(get().selectedIds, data);
      set({
        identities: data,
        loading: false,
        loadedUserId: effectiveUserId,
        selectedIds: prunedSelected,
      });
    } catch (err) {
      // Ignore stale errors
      if (get().requestSeq !== reqId) return;
      set({ error: (err as Error).message, loading: false });
    }
  },

  toggleSelection: (id: string, maxSelected?: number) => {
    const current = get().selectedIds;
    const next = new Set(current);
    if (next.has(id)) {
      next.delete(id);
    } else {
      const cap =
        typeof maxSelected === 'number' && maxSelected >= 0
          ? maxSelected
          : Number.POSITIVE_INFINITY;
      if (next.size < cap) next.add(id);
    }
    set({ selectedIds: next });
  },

  pruneSelectionToSize: (maxSize: number) => {
    const current = get().selectedIds;
    const cap = Math.max(0, Math.trunc(maxSize));
    if (current.size <= cap) return;
    const kept = new Set(Array.from(current).slice(0, cap));
    set({ selectedIds: kept });
  },

  clearSelection: () => set({ selectedIds: new Set() }),

  setIdentities: (identities) => {
    const prunedSelected = pruneSelectedIds(get().selectedIds, identities);
    set({ identities, selectedIds: prunedSelected });
  },
}));
