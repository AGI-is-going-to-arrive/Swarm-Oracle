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
  setLanguage,
  getLanguage,
  translate,
} = vi.hoisted(() => {
  const getIdentityMemoriesMock = vi.fn();
  const listAgentIdentitiesMock = vi.fn();
  let language = 'en';
  return {
    getIdentityMemoriesMock,
    listAgentIdentitiesMock,
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
});
