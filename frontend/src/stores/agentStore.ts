/* ═══════════════════════════════════════════════════════════
   Phase 3 F1/F3 — Agent Identity Store (Zustand)
   ═══════════════════════════════════════════════════════════ */

import { create } from 'zustand';
import { getSessionBoundUserId, listAgentIdentities } from '../api/client';
import type { AgentIdentityInfo } from '../types';
import { captureApiError, type ApiErrorState } from '../lib/apiErrorMessage';

interface AgentStoreState {
  identities: AgentIdentityInfo[];
  loading: boolean;
  error: string | null;
  errorDetails: ApiErrorState | null;
  selectedIds: Set<string>;
  loadedUserId: string | null;
  loadingUserId: string | null;
  requestSeq: number;
  cacheValid: boolean;

  fetchIdentities: (userId: string) => Promise<void>;
  refreshIdentities: (userId: string) => Promise<void>;
  toggleSelection: (id: string, maxSelected?: number) => void;
  pruneSelectionToSize: (maxSize: number) => void;
  clearSelection: () => void;
  setIdentities: (identities: AgentIdentityInfo[], userId?: string) => void;
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

export const useAgentStore = create<AgentStoreState>((set, get) => {
  const loadIdentities = async (userId: string, force: boolean): Promise<void> => {
    const effectiveUserId = getSessionBoundUserId(userId);
    const sessionUserId = getSessionBoundUserId();
    const state = get();

    if (!force && state.loading && state.loadingUserId === effectiveUserId) {
      return;
    }

    // An authoritative empty library is also a cache hit.
    if (!force && state.cacheValid && state.loadedUserId === effectiveUserId && !state.loading) {
      return;
    }

    // If userId changed, clear stale data immediately
    const previousUserId = state.loadingUserId ?? state.loadedUserId;
    if (previousUserId !== null && previousUserId !== effectiveUserId) {
      set({ identities: [], selectedIds: new Set(), loadedUserId: null });
    }

    const reqId = state.requestSeq + 1;
    set({ loading: true, loadingUserId: effectiveUserId, error: null, errorDetails: null, requestSeq: reqId, cacheValid: false });

    const isCurrentRequest = (): boolean => {
      if (get().requestSeq !== reqId) return false;
      if (getSessionBoundUserId() === sessionUserId) return true;
      // A session can change without mounting another library consumer.
      set({
        identities: [], selectedIds: new Set(), loadedUserId: null,
        loading: false, loadingUserId: null, error: null, errorDetails: null, cacheValid: false,
        requestSeq: reqId + 1,
      });
      return false;
    };

    try {
      const data = await listAgentIdentities<AgentIdentityInfo[]>(effectiveUserId);

      // Ignore stale responses (newer request was issued)
      if (!isCurrentRequest()) return;

      const prunedSelected = pruneSelectedIds(get().selectedIds, data);
      set({
        identities: data,
        loading: false,
        loadingUserId: null,
        loadedUserId: effectiveUserId,
        selectedIds: prunedSelected,
        cacheValid: true,
      });
    } catch (err) {
      // Ignore stale errors
      if (!isCurrentRequest()) return;
      set({ error: err instanceof Error ? err.message : 'Failed to load agents', errorDetails: captureApiError(err), loading: false, loadingUserId: null });
      // Import dialogs distinguish a committed write from a failed refresh.
      if (force) throw err;
    }
  };

  return {
    identities: [],
    loading: false,
    error: null,
    errorDetails: null,
    selectedIds: new Set(),
    loadedUserId: null,
    loadingUserId: null,
    requestSeq: 0,
    cacheValid: false,

    fetchIdentities: (userId) => loadIdentities(userId, false),
    refreshIdentities: (userId) => loadIdentities(userId, true),

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

    setIdentities: (identities, userId = getSessionBoundUserId()) => {
      if (userId !== getSessionBoundUserId()) return;
      set((state) => ({
        identities,
        selectedIds: state.loadedUserId !== null && state.loadedUserId !== userId
          ? new Set<string>()
          : pruneSelectedIds(state.selectedIds, identities),
        requestSeq: state.requestSeq + 1,
        loading: false,
        loadingUserId: null,
        loadedUserId: userId,
        error: null,
        errorDetails: null,
        cacheValid: true,
      }));
    },
  };
});
