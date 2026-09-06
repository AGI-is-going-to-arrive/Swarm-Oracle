import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from './agentStore';
import type { AgentIdentityInfo } from '../types';

const apiMock = vi.hoisted(() => ({
  getSessionBoundUserId: vi.fn((fallback?: string | null) => fallback?.trim() || 'test_user'),
  listAgentIdentities: vi.fn(),
}));

vi.mock('../api/client', () => ({
  getSessionBoundUserId: apiMock.getSessionBoundUserId,
  listAgentIdentities: apiMock.listAgentIdentities,
}));

function makeAgent(id: string): AgentIdentityInfo {
  return {
    id,
    user_id: 'test_user',
    kind: 'custom',
    display_name: id,
    role: 'Analyst',
    persona: null,
    decision_bias: null,
    decision_bias_json: null,
    preferred_tier: null,
    continuity_key: id,
    created_at: '2026-07-12T00:00:00Z',
    updated_at: '2026-07-12T00:00:00Z',
  };
}

describe('agentStore', () => {
  beforeEach(() => {
    apiMock.getSessionBoundUserId.mockReset().mockImplementation((fallback?: string | null) => fallback?.trim() || 'test_user');
    apiMock.listAgentIdentities.mockReset();
    useAgentStore.setState({
      selectedIds: new Set(),
      identities: [],
      loading: false,
      error: null,
      loadedUserId: null,
      loadingUserId: null,
      requestSeq: 0,
      cacheValid: false,
    });
  });

  describe('mutation refresh', () => {
    it('refreshes a populated cache and keeps valid home selections', async () => {
      useAgentStore.getState().setIdentities([makeAgent('existing')]);
      useAgentStore.getState().toggleSelection('existing');
      apiMock.listAgentIdentities.mockResolvedValue([
        { ...makeAgent('existing'), display_name: 'Edited name' },
        makeAgent('created'),
      ]);

      await useAgentStore.getState().fetchIdentities('test_user');
      expect(apiMock.listAgentIdentities).not.toHaveBeenCalled();
      await useAgentStore.getState().refreshIdentities('test_user');

      expect(useAgentStore.getState().identities.map((agent) => agent.display_name)).toEqual(['Edited name', 'created']);
      expect([...useAgentStore.getState().selectedIds]).toEqual(['existing']);
      await useAgentStore.getState().fetchIdentities('test_user');
      expect(apiMock.listAgentIdentities).toHaveBeenCalledTimes(1);
    });

    it('supersedes a fetch already in flight when an import commits', async () => {
      let resolveOld!: (identities: AgentIdentityInfo[]) => void;
      apiMock.listAgentIdentities
        .mockImplementationOnce(() => new Promise<AgentIdentityInfo[]>((resolve) => { resolveOld = resolve; }))
        .mockResolvedValueOnce([makeAgent('imported')]);

      const oldFetch = useAgentStore.getState().fetchIdentities('test_user');
      await useAgentStore.getState().refreshIdentities('test_user');
      resolveOld([makeAgent('before-import')]);
      await oldFetch;
      expect(useAgentStore.getState().identities.map((agent) => agent.id)).toEqual(['imported']);
      expect(apiMock.listAgentIdentities).toHaveBeenCalledTimes(2);
    });

    it('retries a failed refresh on the next ordinary read of a populated library', async () => {
      useAgentStore.getState().setIdentities([makeAgent('old')]);
      apiMock.listAgentIdentities.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([makeAgent('new')]);

      await expect(useAgentStore.getState().refreshIdentities('test_user')).rejects.toThrow('offline');
      expect(useAgentStore.getState().cacheValid).toBe(false);
      await useAgentStore.getState().fetchIdentities('test_user');
      expect(useAgentStore.getState().identities.map((agent) => agent.id)).toEqual(['new']);
      expect(useAgentStore.getState().error).toBeNull();
    });

    it('caches an authoritative empty library', async () => {
      apiMock.listAgentIdentities.mockResolvedValue([]);
      await useAgentStore.getState().fetchIdentities('test_user');
      await useAgentStore.getState().fetchIdentities('test_user');
      expect(apiMock.listAgentIdentities).toHaveBeenCalledTimes(1);
    });

    it('discards a late response after the session owner changes without a new fetch', async () => {
      let currentUser = 'owner-a';
      apiMock.getSessionBoundUserId.mockImplementation(() => currentUser);
      let resolveOld!: (identities: AgentIdentityInfo[]) => void;
      apiMock.listAgentIdentities.mockImplementationOnce(() => new Promise<AgentIdentityInfo[]>((resolve) => { resolveOld = resolve; }));
      const pending = useAgentStore.getState().refreshIdentities('owner-a');
      currentUser = 'owner-b';
      resolveOld([makeAgent('private-a')]);
      await pending;

      expect(useAgentStore.getState().identities).toEqual([]);
      expect(useAgentStore.getState().loading).toBe(false);
      expect(useAgentStore.getState().loadedUserId).toBeNull();
    });

    it('clears old-owner selections and ignores late replacements while another owner loads', async () => {
      let currentUser = 'owner-a';
      apiMock.getSessionBoundUserId.mockImplementation(() => currentUser);
      useAgentStore.getState().setIdentities([makeAgent('a')], 'owner-a');
      useAgentStore.getState().toggleSelection('a');
      currentUser = 'owner-b';
      apiMock.listAgentIdentities.mockResolvedValue([makeAgent('b')]);
      const pending = useAgentStore.getState().fetchIdentities('owner-b');
      expect(useAgentStore.getState().identities).toEqual([]);
      expect(useAgentStore.getState().selectedIds.size).toBe(0);
      useAgentStore.getState().setIdentities([makeAgent('late-a')], 'owner-a');
      await pending;
      expect(useAgentStore.getState().identities.map((agent) => agent.id)).toEqual(['b']);
      expect(useAgentStore.getState().loadedUserId).toBe('owner-b');
    });
  });

  describe('authoritative identity replacement', () => {
    it('keeps a post-import replacement when an older fetch resolves later', async () => {
      let resolveOldFetch!: (value: AgentIdentityInfo[]) => void;
      apiMock.listAgentIdentities.mockImplementationOnce(() => new Promise((resolve) => {
        resolveOldFetch = resolve;
      }));

      const oldFetch = useAgentStore.getState().fetchIdentities('test_user');
      expect(useAgentStore.getState().loading).toBe(true);
      expect(useAgentStore.getState().requestSeq).toBe(1);

      useAgentStore.getState().setIdentities([makeAgent('fresh-import')]);
      resolveOldFetch([makeAgent('stale-before-import')]);
      await oldFetch;

      const state = useAgentStore.getState();
      expect(state.identities.map((identity) => identity.id)).toEqual(['fresh-import']);
      expect(state.requestSeq).toBe(2);
      expect(state.loading).toBe(false);
      expect(state.loadingUserId).toBeNull();
      expect(state.loadedUserId).toBe('test_user');
      expect(state.error).toBeNull();
    });

    it('ignores an older fetch error after a post-import replacement', async () => {
      let rejectOldFetch!: (reason: Error) => void;
      apiMock.listAgentIdentities.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        rejectOldFetch = reject;
      }));

      const oldFetch = useAgentStore.getState().fetchIdentities('test_user');
      useAgentStore.getState().setIdentities([makeAgent('fresh-import')]);
      rejectOldFetch(new Error('stale fetch failed'));
      await oldFetch;

      const state = useAgentStore.getState();
      expect(state.identities.map((identity) => identity.id)).toEqual(['fresh-import']);
      expect(state.error).toBeNull();
      expect(state.loading).toBe(false);
    });
  });

  describe('toggleSelection', () => {
    it('adds id when under default limit (no maxSelected provided)', () => {
      useAgentStore.getState().toggleSelection('a');
      useAgentStore.getState().toggleSelection('b');
      useAgentStore.getState().toggleSelection('c');
      expect(Array.from(useAgentStore.getState().selectedIds)).toEqual(['a', 'b', 'c']);
    });

    it('respects custom maxSelected=3', () => {
      const { toggleSelection } = useAgentStore.getState();
      toggleSelection('a', 3);
      toggleSelection('b', 3);
      toggleSelection('c', 3);
      toggleSelection('d', 3);
      const ids = Array.from(useAgentStore.getState().selectedIds);
      expect(ids.length).toBe(3);
      expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('removes id when already selected regardless of max', () => {
      const { toggleSelection } = useAgentStore.getState();
      toggleSelection('a', 5);
      toggleSelection('b', 5);
      expect(useAgentStore.getState().selectedIds.has('a')).toBe(true);
      toggleSelection('a', 0);
      expect(useAgentStore.getState().selectedIds.has('a')).toBe(false);
      expect(useAgentStore.getState().selectedIds.has('b')).toBe(true);
    });

    it('does not add when at maxSelected cap', () => {
      const { toggleSelection } = useAgentStore.getState();
      toggleSelection('a', 2);
      toggleSelection('b', 2);
      toggleSelection('c', 2);
      expect(useAgentStore.getState().selectedIds.size).toBe(2);
      expect(useAgentStore.getState().selectedIds.has('c')).toBe(false);
    });

    it('handles uncapped (no maxSelected) up to many items', () => {
      const { toggleSelection } = useAgentStore.getState();
      for (let i = 0; i < 12; i++) toggleSelection(`agent-${i}`);
      expect(useAgentStore.getState().selectedIds.size).toBe(12);
    });

    it('treats maxSelected=0 as a hard cap (no additions)', () => {
      const { toggleSelection } = useAgentStore.getState();
      toggleSelection('a', 0);
      expect(useAgentStore.getState().selectedIds.size).toBe(0);
    });
  });

  describe('pruneSelectionToSize', () => {
    it('no-ops when size <= maxSize', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b']) });
      useAgentStore.getState().pruneSelectionToSize(5);
      expect(Array.from(useAgentStore.getState().selectedIds)).toEqual(['a', 'b']);
    });

    it('truncates to maxSize keeping insertion order', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b', 'c', 'd', 'e']) });
      useAgentStore.getState().pruneSelectionToSize(3);
      expect(Array.from(useAgentStore.getState().selectedIds)).toEqual(['a', 'b', 'c']);
    });

    it('clears all when maxSize is 0', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b', 'c']) });
      useAgentStore.getState().pruneSelectionToSize(0);
      expect(useAgentStore.getState().selectedIds.size).toBe(0);
    });

    it('coerces negative maxSize to 0', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b']) });
      useAgentStore.getState().pruneSelectionToSize(-3);
      expect(useAgentStore.getState().selectedIds.size).toBe(0);
    });

    it('truncates fractional maxSize via Math.trunc', () => {
      useAgentStore.setState({ selectedIds: new Set(['a', 'b', 'c', 'd']) });
      useAgentStore.getState().pruneSelectionToSize(2.9);
      expect(Array.from(useAgentStore.getState().selectedIds)).toEqual(['a', 'b']);
    });
  });
});
