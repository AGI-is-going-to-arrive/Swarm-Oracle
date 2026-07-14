import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  IdentityMemoriesResponse,
  IdentityMemoryEntry,
} from '../api/client';
import IdentityInspectorView from './IdentityInspectorView';

const {
  getIdentityMemoriesMock,
  listAgentIdentitiesMock,
  pinIdentityMemoryMock,
  unpinIdentityMemoryMock,
  setLanguage,
  getLanguage,
  translate,
} = vi.hoisted(() => {
  const getIdentityMemoriesMock = vi.fn();
  const listAgentIdentitiesMock = vi.fn();
  const pinIdentityMemoryMock = vi.fn();
  const unpinIdentityMemoryMock = vi.fn();
  let language = 'en';
  return {
    getIdentityMemoriesMock,
    listAgentIdentitiesMock,
    pinIdentityMemoryMock,
    unpinIdentityMemoryMock,
    setLanguage(next: string) {
      language = next;
    },
    getLanguage() {
      return language;
    },
    translate(
      key: string,
      defaultValueOrOptions?: string | Record<string, unknown>,
      options?: Record<string, unknown>,
    ) {
      const interpolation = typeof defaultValueOrOptions === 'string'
        ? options
        : defaultValueOrOptions;
      const fallback = typeof defaultValueOrOptions === 'string'
        ? defaultValueOrOptions
        : key;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => {
        const value = interpolation?.[token];
        return typeof value === 'string' || typeof value === 'number'
          ? String(value)
          : '';
      });
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: {
      get language() {
        return getLanguage();
      },
    },
  }),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({
    loading: false,
    enabled: true,
    capabilities: null,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    getIdentityMemories: getIdentityMemoriesMock,
    getSessionBoundUserId: () => 'test-user',
    listAgentIdentities: listAgentIdentitiesMock,
    pinIdentityMemory: pinIdentityMemoryMock,
    unpinIdentityMemory: unpinIdentityMemoryMock,
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function memoryEntry(document: string, timestamp = '2026-05-11T03:04:05.000Z'): IdentityMemoryEntry {
  return {
    document,
    metadata: {},
    timestamp,
    confidence: 0.91,
    is_compacted: false,
  };
}

function memoryResponse(document: string, timestamp?: string): IdentityMemoriesResponse {
  return {
    memories: [memoryEntry(document, timestamp)],
    total: 1,
  };
}

function NavigationHarness() {
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() => navigate('/agents/identities/fresh/memories')}
      >
        Go fresh
      </button>
      <Routes>
        <Route path="/agents/identities/:id/memories" element={<IdentityInspectorView />} />
      </Routes>
    </>
  );
}

function renderInspector(initialEntry = '/agents/identities/current/memories') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <NavigationHarness />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLanguage('en');
  getIdentityMemoriesMock.mockReset();
  listAgentIdentitiesMock.mockReset();
  listAgentIdentitiesMock.mockResolvedValue([]);
  pinIdentityMemoryMock.mockReset();
  unpinIdentityMemoryMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IdentityInspectorView', () => {
  it('ignores stale memory responses after the identity id changes', async () => {
    const stale = createDeferred<IdentityMemoriesResponse>();
    const fresh = createDeferred<IdentityMemoriesResponse>();
    getIdentityMemoriesMock
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);

    const user = userEvent.setup();
    renderInspector('/agents/identities/stale/memories');

    await waitFor(() => {
      expect(getIdentityMemoriesMock).toHaveBeenCalledWith(
        'stale',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    await user.click(screen.getByRole('button', { name: 'Go fresh' }));

    await waitFor(() => {
      expect(getIdentityMemoriesMock).toHaveBeenCalledWith(
        'fresh',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    await act(async () => {
      fresh.resolve(memoryResponse('Fresh memory document'));
      await fresh.promise;
    });

    expect(await screen.findByText('Fresh memory document')).toBeInTheDocument();

    await act(async () => {
      stale.resolve(memoryResponse('Stale memory document'));
      await stale.promise;
    });

    await waitFor(() => {
      expect(screen.getByText('Fresh memory document')).toBeInTheDocument();
      expect(screen.queryByText('Stale memory document')).not.toBeInTheDocument();
    });
  });

  it('formats memory timestamps with the active i18n language', async () => {
    setLanguage('zh-CN');
    const timestamp = '2026-05-11T03:04:05.000Z';
    const localeSpy = vi
      .spyOn(Date.prototype, 'toLocaleString')
      .mockImplementation(function toLocaleStringMock(
        this: Date,
        locales?: Intl.LocalesArgument,
      ): string {
        return `formatted:${String(locales)}`;
      });
    getIdentityMemoriesMock.mockResolvedValue(memoryResponse('Localized timestamp memory', timestamp));

    renderInspector();

    expect(await screen.findByText('Localized timestamp memory')).toBeInTheDocument();
    expect(screen.getByText('formatted:zh-CN')).toBeInTheDocument();
    expect(localeSpy).toHaveBeenCalledWith('zh-CN');
  });

  it('does not expose raw memory load errors', async () => {
    getIdentityMemoriesMock.mockRejectedValueOnce(new Error('raw memory failure'));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    renderInspector();

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load identity memories.');
    expect(screen.queryByText(/raw memory failure/i)).not.toBeInTheDocument();
    debugSpy.mockRestore();
  });

  it('labels retrieval hits as query matches rather than durable remembered writes', async () => {
    getIdentityMemoriesMock.mockResolvedValue({
      memories: [
        {
          document: 'Mem remembered',
          timestamp: '2026-05-11T03:04:05.000Z',
          confidence: 0.9,
          is_compacted: false,
          memory_id: 'mem-1',
          remembered: true,
        },
      ],
      total: 1,
    });

    renderInspector();
    expect(await screen.findByText('Mem remembered')).toBeInTheDocument();
    expect(screen.getByText('Query match')).toBeInTheDocument();
    expect(screen.queryByText('identity_inspector.remembered_label')).not.toBeInTheDocument();
  });

  it('prioritizes memory_kind and explains bounded per-agent memory provenance', async () => {
    getIdentityMemoriesMock.mockResolvedValue({
      memories: [
        {
          document: 'Agent-specific memory',
          timestamp: '2026-05-11T03:04:05.000Z',
          confidence: 0.12,
          is_compacted: false,
          metadata: {
            type: 'legacy-type',
            memory_kind: 'reflection',
            action_type: 'challenge_claim',
            observation: 'The cited number was contradicted.',
            outcome: 'The agent revised its recommendation.',
            write_reason: 'Changed the next-round decision.',
            provenance_kind: 'agent_observation',
            confidence_tier: 'high',
            branch_id: 'branch-private',
            source_message_ids: Array.from({ length: 8 }, (_, index) => `message-${index}`),
            source_event_ids: '["event-1"]',
          },
        },
      ],
      total: 1,
    });

    const user = userEvent.setup();
    renderInspector();

    expect(await screen.findAllByText('reflection')).toHaveLength(2);
    expect(screen.queryByText('legacy-type')).not.toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();

    await user.click(screen.getByText('Why this was remembered'));
    expect(screen.getByText('challenge_claim')).toBeInTheDocument();
    expect(screen.getByText('The cited number was contradicted.')).toBeInTheDocument();
    expect(screen.getByText('The agent revised its recommendation.')).toBeInTheDocument();
    expect(screen.getByText('Changed the next-round decision.')).toBeInTheDocument();
    expect(screen.getByText('agent_observation')).toBeInTheDocument();
    expect(screen.getByText('branch-private')).toBeInTheDocument();
    expect(screen.getByText('event-1')).toBeInTheDocument();
    expect(screen.getByText('message-5')).toBeInTheDocument();
    expect(screen.queryByText('message-6')).not.toBeInTheDocument();
  });

  it('toggles pin status and calls pin/unpin APIs', async () => {
    getIdentityMemoriesMock.mockResolvedValue({
      memories: [
        {
          document: 'Mem to pin',
          timestamp: '2026-05-11T03:04:05.000Z',
          confidence: 0.9,
          is_compacted: false,
          memory_id: 'mem-1',
          pinned: false,
        },
      ],
      total: 1,
    });

    pinIdentityMemoryMock.mockResolvedValue({
      identity_id: 'current',
      memory_id: 'mem-1',
      pinned: true,
      pin_count: 1,
      cap: 20,
    });

    unpinIdentityMemoryMock.mockResolvedValue({
      identity_id: 'current',
      memory_id: 'mem-1',
      pinned: false,
      pin_count: 0,
      cap: 20,
    });

    const user = userEvent.setup();
    renderInspector();

    expect(await screen.findByText('Mem to pin')).toBeInTheDocument();

    const pinBtn = screen.getByRole('button', { name: 'identity_inspector.pin_btn_pin_aria' });
    expect(pinBtn).toBeInTheDocument();

    // Click to pin
    await user.click(pinBtn);
    expect(pinIdentityMemoryMock).toHaveBeenCalledWith('current', 'mem-1');

    // Click to unpin (the label becomes Unpin memory)
    const unpinBtn = await screen.findByRole('button', { name: 'identity_inspector.pin_btn_unpin_aria' });
    await user.click(unpinBtn);
    expect(unpinIdentityMemoryMock).toHaveBeenCalledWith('current', 'mem-1');
  });

  it('disables pin buttons when cap is reached and shows explanatory message', async () => {
    getIdentityMemoriesMock.mockResolvedValue({
      memories: [
        {
          document: 'Mem 1 pinned',
          timestamp: '2026-05-11T03:04:05.000Z',
          confidence: 0.9,
          is_compacted: false,
          memory_id: 'mem-1',
          pinned: true,
        },
        {
          document: 'Mem 2 unpinned',
          timestamp: '2026-05-11T03:04:06.000Z',
          confidence: 0.8,
          is_compacted: false,
          memory_id: 'mem-2',
          pinned: false,
        },
      ],
      total: 2,
    });

    // Simulate 409 limit error
    const ApiError = (await vi.importActual<typeof import('../api/client')>('../api/client')).ApiError;
    pinIdentityMemoryMock.mockRejectedValueOnce(
      new ApiError(409, 'IDENTITY_MEMORY_PIN_LIMIT_REACHED', 'Limit reached')
    );

    const user = userEvent.setup();
    renderInspector();

    expect(await screen.findByText('Mem 1 pinned')).toBeInTheDocument();

    // The second item is unpinned. Let's try to pin it.
    const pinBtn2 = screen.getByRole('button', { name: 'identity_inspector.pin_btn_pin_aria' });
    await user.click(pinBtn2);

    // It should fail and show the cap message
    expect(await screen.findByText('At most 20 memories can be pinned per identity.')).toBeInTheDocument();

    // Pinned button should be disabled for the unpinned one
    expect(pinBtn2).toBeDisabled();
  });

  it('disables unpinned buttons when loaded pinned count reaches cap', async () => {
    const memories = [];
    for (let i = 0; i < 20; i++) {
      memories.push({
        document: `Pinned ${i}`,
        timestamp: `2026-05-11T03:04:05.${String(i).padStart(3, '0')}Z`,
        confidence: 0.9,
        is_compacted: false,
        memory_id: `mem-${i}`,
        pinned: true,
      });
    }
    memories.push({
      document: 'Unpinned last',
      timestamp: '2026-05-12T03:04:05.000Z',
      confidence: 0.9,
      is_compacted: false,
      memory_id: 'mem-unpinned',
      pinned: false,
    });

    getIdentityMemoriesMock.mockResolvedValue({
      memories,
      total: 21,
    });

    renderInspector();
    expect(await screen.findByText('Unpinned last')).toBeInTheDocument();

    const pinBtns = screen.getAllByRole('button', { name: 'identity_inspector.pin_btn_pin_aria' });
    expect(pinBtns).toHaveLength(1);
    expect(pinBtns[0]).toBeDisabled();
    expect(pinBtns[0]).toHaveAttribute('title', 'identity_inspector.pin_cap_reached');
  });

  it('handles degraded diagnostics response and shows message verbatim', async () => {
    getIdentityMemoriesMock.mockResolvedValue({
      memories: [],
      total: 0,
      error: 'memory_fetch_failed',
      diagnostics: {
        code: 'CHROMA_UNAVAILABLE',
        message: 'Diagnostics: Chroma is down',
      },
    });

    renderInspector();

    expect(await screen.findByRole('alert')).toHaveTextContent('Diagnostics: Chroma is down');
  });

  it('handles degraded error code and routes through localized safe copy', async () => {
    getIdentityMemoriesMock.mockResolvedValue({
      memories: [],
      total: 0,
      error: 'memory_fetch_failed',
    });

    renderInspector();

    expect(await screen.findByRole('alert')).toContainHTML('memory_fetch_failed');
  });
});
