import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalPackPicker } from './LocalPackPicker';
import type { CapabilitiesResponse } from '../api/client';
import type {
  LocalPackSummary,
  LocalPack,
  PackDiagnostic,
} from '../types';
import i18n from '../i18n/config';
import {
  LOCAL_PACK_PROMPT_EVIDENCE_PREFIX,
  LOCAL_PACK_PROMPT_EVIDENCE_PREFIX_ZH,
  LOCAL_PACK_PROMPT_WARNING,
  LOCAL_PACK_PROMPT_WARNING_ZH,
} from '../lib/localPackImport';

const useCapabilityCheckMock = vi.hoisted(() => vi.fn());
const listLocalPacksMock = vi.hoisted(() => vi.fn());
const getLocalPackMock = vi.hoisted(() => vi.fn());
const refreshLocalPacksMock = vi.hoisted(() => vi.fn());
const getLocalPackDiagnosticsMock = vi.hoisted(() => vi.fn());
const importLocalPackDemoSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
}));

vi.mock('../api/client', () => ({
  listLocalPacks: listLocalPacksMock,
  getLocalPack: getLocalPackMock,
  refreshLocalPacks: refreshLocalPacksMock,
  getLocalPackDiagnostics: getLocalPackDiagnosticsMock,
  importLocalPackDemoSnapshot: importLocalPackDemoSnapshotMock,
}));

// Mock clipboard API
const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
  clipboard: {
    writeText: writeTextMock,
  },
});

afterEach(() => {
  cleanup();
  useCapabilityCheckMock.mockReset();
  listLocalPacksMock.mockReset();
  getLocalPackMock.mockReset();
  refreshLocalPacksMock.mockReset();
  getLocalPackDiagnosticsMock.mockReset();
  importLocalPackDemoSnapshotMock.mockReset();
  writeTextMock.mockClear();
});

function localPackCapabilities(
  snapshotExportEnabled: boolean,
): Pick<CapabilitiesResponse, 'local_packs' | 'snapshot_export'> {
  const capabilityEntry = (enabled: boolean) => ({
    enabled,
    version: '1',
    server_only: true,
    degraded_mode: null,
  });
  return {
    local_packs: capabilityEntry(true),
    snapshot_export: capabilityEntry(snapshotExportEnabled),
  };
}

const mockPacksSummaryList: LocalPackSummary[] = [
  {
    schema_version: 1,
    id: 'pack-one',
    genre: 'society',
    title: { zh: '主题包一', en: 'Pack One' },
    description: { zh: '这是主题包一的描述', en: 'This is pack one description' },
    tags: [
      { zh: '社会', en: 'Society' },
      { zh: '科技', en: 'Tech' },
    ],
    scenario_count: 1,
    agent_cast_count: 2,
    demo_snapshot_count: 1,
    suggested_settings: {
      num_agents: 5,
      rounds: 10,
      simulation_mode: 'balanced',
      language: 'zh',
    },
    source_metadata: {
      curator: 'DeepMind',
      created_at: '2026-06-12',
      license: 'original',
      notes: { zh: '备注一', en: 'Note one' },
    },
  },
  {
    schema_version: 1,
    id: 'pack-two',
    genre: 'historical what-if',
    // Missing zh title/desc to test fallback
    title: { zh: '', en: 'Pack Two' },
    description: { zh: '', en: 'This is pack two description' },
    tags: [
      { zh: '历史', en: 'History' },
    ],
    scenario_count: 2,
    agent_cast_count: 0,
    demo_snapshot_count: 0,
    suggested_settings: {
      num_agents: 3,
      rounds: 5,
      simulation_mode: 'conservative',
      language: 'bilingual',
    },
    source_metadata: {
      curator: 'DeepMind Team',
      created_at: '2026-06-12',
      license: 'original',
      notes: { zh: '备注二', en: 'Note two' },
    },
  },
];

const mockPackDetailOne: LocalPack = {
  schema_version: 1,
  id: 'pack-one',
  genre: 'society',
  title: { zh: '主题包一', en: 'Pack One' },
  description: { zh: '这是主题包一的描述', en: 'This is pack one description' },
  tags: [
    { zh: '社会', en: 'Society' },
    { zh: '科技', en: 'Tech' },
  ],
  scenario_templates: [
    {
      id: 'template-a',
      question: { zh: '郑和下西洋发现了什么？', en: 'What did Zheng He discover?' },
      context: { zh: '历史背景描述', en: 'Historical context description' },
      prompt: { zh: '提示词一', en: 'Prompt one' },
      stakes: [
        { zh: '利益相关者一', en: 'Stakeholder one' },
      ],
    },
  ],
  agent_casts: [
    {
      id: 'agent-zheng',
      name: { zh: '郑和', en: 'Zheng He' },
      role: { zh: '航海家', en: 'Navigator' },
      perspective: { zh: '探索未知', en: 'Explore the unknown' },
    },
  ],
  demo_snapshots: [
    {
      id: 'snap-1',
      label: { zh: '演示一', en: 'Demo one' },
      filename: 'demo_one.json',
    },
  ],
  suggested_settings: {
    num_agents: 5,
    rounds: 10,
    simulation_mode: 'balanced',
    language: 'zh',
  },
  source_metadata: {
    curator: 'DeepMind',
    created_at: '2026-06-12',
    license: 'original',
    notes: { zh: '备注一', en: 'Note one' },
  },
};

// Malformed pack detail: missing optional arrays (agent_casts, demo_snapshots, stakes)
const mockPackDetailTwo: LocalPack = {
  schema_version: 1,
  id: 'pack-two',
  genre: 'historical what-if',
  title: { zh: '', en: 'Pack Two' },
  description: { zh: '', en: 'This is pack two description' },
  tags: [
    { zh: '历史', en: 'History' },
  ],
  scenario_templates: [
    {
      id: 'template-b',
      question: { zh: '假设郑和发现了美洲', en: 'What if Zheng He reached America first?' },
      context: { zh: '背景二', en: 'Context two' },
      prompt: { zh: '提示二', en: 'Prompt two' },
      // stakes missing
    },
  ],
  // agent_casts missing
  // demo_snapshots missing
  suggested_settings: {
    num_agents: 3,
    rounds: 5,
    simulation_mode: 'conservative',
    language: 'bilingual',
  },
  source_metadata: {
    curator: 'DeepMind Team',
    created_at: '2026-06-12',
    license: 'original',
    notes: { zh: '备注二', en: 'Note two' },
  },
};

const mockDiagnosticsResponse: PackDiagnostic[] = [
  {
    id_or_filename: 'invalid-pack.json',
    code: 'MALFORMED_JSON',
    message: 'Expecting value: line 1 column 1',
  },
  {
    id_or_filename: 'bad-metadata.json',
    code: 'UNKNOWN_DIAGNOSTIC_CODE_TEST',
    message: 'Unknown issue occurred in server metadata',
  },
];

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
};

describe('LocalPackPicker', () => {
  it('renders loading state when capability is loading', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: true,
      enabled: false,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    expect(screen.getByText('Loading local packs...')).toBeInTheDocument();
  });

  it('renders disabled state when capability is disabled and asserts no API calls are made', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    expect(
      screen.getByText('This feature is turned off on this server. Ask the admin to enable it.')
    ).toBeInTheDocument();

    // Negative assertions: assert endpoints are NOT called
    expect(listLocalPacksMock).not.toHaveBeenCalled();
    expect(getLocalPackDiagnosticsMock).not.toHaveBeenCalled();
  });

  it('renders error state and retry calls reload', () => {
    const reloadMock = vi.fn();
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
      error: new Error('Capability error'),
      reload: reloadMock,
    });

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    expect(screen.getByText('Capability error')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('restores demo actions from the retried local-packs capability response without remounting', async () => {
    await i18n.changeLanguage('en');
    const latestLocalPacksResult = {
      loading: false,
      enabled: false,
      capabilities: null as ReturnType<typeof localPackCapabilities> | null,
      error: new Error('Capability error') as Error | null,
      reload: vi.fn(async () => {
        latestLocalPacksResult.enabled = true;
        latestLocalPacksResult.capabilities = localPackCapabilities(true);
        latestLocalPacksResult.error = null;
      }),
    };
    useCapabilityCheckMock.mockImplementation((key: string) => (
      key === 'local_packs'
        ? latestLocalPacksResult
        : {
            loading: false,
            enabled: false,
            capabilities: null,
            error: null,
            reload: vi.fn(),
          }
    ));
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);
    const onImport = vi.fn();
    const onDemoImported = vi.fn();
    const { rerender } = render(
      <LocalPackPicker onImport={onImport} onDemoImported={onDemoImported} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(latestLocalPacksResult.reload).toHaveBeenCalledTimes(1));
    rerender(<LocalPackPicker onImport={onImport} onDemoImported={onDemoImported} />);

    expect(await screen.findByRole('button', { name: /Demo one/ })).toBeInTheDocument();
    expect(useCapabilityCheckMock).not.toHaveBeenCalledWith('snapshot_export');
  });

  it('renders demo snapshot metadata as an action when snapshot export is enabled', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: localPackCapabilities(true),
      error: null,
      reload: vi.fn(),
    });
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    expect(await screen.findByRole('button', { name: /Demo one/ })).toBeInTheDocument();
  });

  it('keeps disabled demo snapshot metadata visible without issuing an import', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: localPackCapabilities(false),
      error: null,
      reload: vi.fn(),
    });
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    const filename = await screen.findByText('demo_one.json');
    expect(filename.closest('li')).toHaveTextContent('Demo one');
    expect(screen.queryByRole('button', { name: /Demo one/ })).not.toBeInTheDocument();
    fireEvent.click(filename.closest('li')!);
    expect(importLocalPackDemoSnapshotMock).not.toHaveBeenCalled();
  });

  it('deduplicates demo snapshot clicks and reports the current success once', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: localPackCapabilities(true),
      error: null,
      reload: vi.fn(),
    });
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);
    const imported = createDeferred<{
      scenario_id: string;
      pack_id: string;
      demo_snapshot_id: string;
      status: 'imported';
    }>();
    importLocalPackDemoSnapshotMock.mockReturnValue(imported.promise);
    const onDemoImported = vi.fn();

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={onDemoImported} />);

    const action = await screen.findByRole('button', { name: /Demo one/ });
    fireEvent.click(action);
    fireEvent.click(action);

    expect(importLocalPackDemoSnapshotMock).toHaveBeenCalledTimes(1);
    expect(importLocalPackDemoSnapshotMock).toHaveBeenCalledWith('pack-one', 'snap-1', {
      signal: expect.any(AbortSignal),
    });

    await act(async () => {
      imported.resolve({
        scenario_id: 'imported-demo-1',
        pack_id: 'pack-one',
        demo_snapshot_id: 'snap-1',
        status: 'imported',
      });
      await imported.promise;
    });

    expect(onDemoImported).toHaveBeenCalledTimes(1);
    expect(onDemoImported).toHaveBeenCalledWith('imported-demo-1');
  });

  it('localizes demo snapshot failures without leaking raw text and allows retry', async () => {
    await i18n.changeLanguage('en');
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: localPackCapabilities(true),
      error: null,
      reload: vi.fn(),
    });
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);
    importLocalPackDemoSnapshotMock
      .mockRejectedValueOnce({
        status: 422,
        code: 'SNAPSHOT_IMPORT_INVALID',
        message: '<script>unsafe backend detail</script>',
      })
      .mockResolvedValueOnce({
        scenario_id: 'retried-demo',
        pack_id: 'pack-one',
        demo_snapshot_id: 'snap-1',
        status: 'imported',
      });
    const onDemoImported = vi.fn();
    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={onDemoImported} />);

    fireEvent.click(await screen.findByRole('button', { name: /Demo one/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Snapshot import failed. Please try again.',
    );
    expect(screen.queryByText(/unsafe backend detail/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Demo one/ }));
    await waitFor(() => expect(onDemoImported).toHaveBeenCalledWith('retried-demo'));
    expect(importLocalPackDemoSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it('reports a transport failure as an unknown import outcome', async () => {
    await i18n.changeLanguage('en');
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: localPackCapabilities(true),
      error: null,
      reload: vi.fn(),
    });
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);
    importLocalPackDemoSnapshotMock.mockRejectedValue(
      new Error('response lost after the server may have committed'),
    );

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Demo one/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The import result is unknown. Check Simulation History before trying again.',
    );
    expect(screen.queryByText(/response lost/)).not.toBeInTheDocument();
  });

  it('aborts a demo snapshot import on pack switch and ignores its late success', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: localPackCapabilities(true),
      error: null,
      reload: vi.fn(),
    });
    const packTwoWithDemo: LocalPack = {
      ...mockPackDetailOne,
      id: 'pack-two',
      title: { zh: '主题包二', en: 'Pack Two' },
      demo_snapshots: [{
        id: 'snap-2',
        label: { zh: '演示二', en: 'Demo two' },
        filename: 'demo_two.json',
      }],
    };
    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockImplementation((id: string) => Promise.resolve(
      id === 'pack-two' ? packTwoWithDemo : mockPackDetailOne,
    ));
    const first = createDeferred<{
      scenario_id: string;
      pack_id: string;
      demo_snapshot_id: string;
      status: 'imported';
    }>();
    const second = createDeferred<{
      scenario_id: string;
      pack_id: string;
      demo_snapshot_id: string;
      status: 'imported';
    }>();
    let firstSignal: AbortSignal | undefined;
    importLocalPackDemoSnapshotMock
      .mockImplementationOnce((_packId, _demoId, options?: { signal?: AbortSignal }) => {
        firstSignal = options?.signal;
        return first.promise;
      })
      .mockReturnValueOnce(second.promise);
    const onDemoImported = vi.fn();
    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={onDemoImported} />);

    fireEvent.click(await screen.findByRole('button', { name: /Demo one/ }));
    fireEvent.click(screen.getByRole('button', { name: /Pack Two/ }));

    expect(firstSignal?.aborted).toBe(true);
    const secondAction = await screen.findByRole('button', { name: /Demo two/ });
    fireEvent.click(secondAction);
    expect(importLocalPackDemoSnapshotMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve({
        scenario_id: 'stale-success',
        pack_id: 'pack-one',
        demo_snapshot_id: 'snap-1',
        status: 'imported',
      });
      await first.promise;
    });
    expect(onDemoImported).not.toHaveBeenCalled();
    expect(secondAction).toBeDisabled();

    await act(async () => {
      second.resolve({
        scenario_id: 'current-success',
        pack_id: 'pack-two',
        demo_snapshot_id: 'snap-2',
        status: 'imported',
      });
      await second.promise;
    });
    expect(onDemoImported).toHaveBeenCalledTimes(1);
    expect(onDemoImported).toHaveBeenCalledWith('current-success');
  });

  it('aborts a demo snapshot import on refresh and ignores its late failure', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: localPackCapabilities(true),
      error: null,
      reload: vi.fn(),
    });
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);
    refreshLocalPacksMock.mockResolvedValue({
      packs: [mockPacksSummaryList[0]],
      count: 1,
      diagnostics: [],
      diagnostic_count: 0,
    });
    const first = createDeferred<never>();
    const second = createDeferred<{
      scenario_id: string;
      pack_id: string;
      demo_snapshot_id: string;
      status: 'imported';
    }>();
    let firstSignal: AbortSignal | undefined;
    importLocalPackDemoSnapshotMock
      .mockImplementationOnce((_packId, _demoId, options?: { signal?: AbortSignal }) => {
        firstSignal = options?.signal;
        return first.promise;
      })
      .mockReturnValueOnce(second.promise);
    const onDemoImported = vi.fn();
    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={onDemoImported} />);

    fireEvent.click(await screen.findByRole('button', { name: /Demo one/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Packs' }));

    expect(firstSignal?.aborted).toBe(true);
    await waitFor(() => expect(getLocalPackMock).toHaveBeenCalledTimes(2));
    const secondAction = await screen.findByRole('button', { name: /Demo one/ });
    fireEvent.click(secondAction);
    expect(importLocalPackDemoSnapshotMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.reject(new Error('late unsafe failure'));
      await first.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(secondAction).toBeDisabled();

    await act(async () => {
      second.resolve({
        scenario_id: 'refreshed-success',
        pack_id: 'pack-one',
        demo_snapshot_id: 'snap-1',
        status: 'imported',
      });
      await second.promise;
    });
    expect(onDemoImported).toHaveBeenCalledWith('refreshed-success');
  });

  it('does not start a demo snapshot import while a refresh is pending', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: localPackCapabilities(true),
      error: null,
      reload: vi.fn(),
    });
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);
    const refresh = createDeferred<{
      packs: LocalPackSummary[];
      count: number;
      diagnostics: PackDiagnostic[];
      diagnostic_count: number;
    }>();
    refreshLocalPacksMock.mockReturnValue(refresh.promise);
    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    const demoAction = await screen.findByRole('button', { name: /Demo one/ });
    const refreshAction = screen.getByRole('button', { name: 'Refresh Packs' });
    fireEvent.click(refreshAction);
    await waitFor(() => expect(refreshAction).toBeDisabled());

    const demoWasDisabledDuringRefresh = demoAction.hasAttribute('disabled');
    demoAction.removeAttribute('disabled');
    fireEvent.click(demoAction);

    expect(importLocalPackDemoSnapshotMock).not.toHaveBeenCalled();
    expect(demoWasDisabledDuringRefresh).toBe(true);
  });

  it('aborts a demo snapshot import when the picker unmounts', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: localPackCapabilities(true),
      error: null,
      reload: vi.fn(),
    });
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);
    let importSignal: AbortSignal | undefined;
    importLocalPackDemoSnapshotMock.mockImplementation(
      (_packId, _demoId, options?: { signal?: AbortSignal }) => {
        importSignal = options?.signal;
        return new Promise(() => undefined);
      },
    );
    const { unmount } = render(
      <LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Demo one/ }));
    unmount();

    expect(importSignal?.aborted).toBe(true);
  });

  it('loads packs, renders compact tiles + genre segments, and filters by search incl. tag text', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    // P0-3 soft-select fetches the first pack's detail on mount
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(listLocalPacksMock).toHaveBeenCalledTimes(1);
      expect(getLocalPackDiagnosticsMock).toHaveBeenCalledTimes(1);
    });

    // Compact tiles render (query the tile button so the auto-selected preview title does not collide)
    expect(await screen.findByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pack Two/ })).toBeInTheDocument();

    // Genre filter segments render (All + 2 genres = 3 buttons)
    const genreGroup = screen.getByRole('group', { name: 'Genre' });
    expect(within(genreGroup).getAllByRole('button')).toHaveLength(3);

    // P0-1: the 27-chip tag wall is removed, so there is no standalone Tags group
    expect(screen.queryByRole('group', { name: 'Tags' })).not.toBeInTheDocument();

    // Text search by title
    const searchInput = screen.getByPlaceholderText('Search title, description, or genre...');
    fireEvent.change(searchInput, { target: { value: 'One' } });
    expect(screen.getByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pack Two/ })).not.toBeInTheDocument();

    // Reset search
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.getByRole('button', { name: /Pack Two/ })).toBeInTheDocument();

    // P0-1: tag text is now folded into the single search channel
    fireEvent.change(searchInput, { target: { value: 'Tech' } });
    expect(screen.getByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pack Two/ })).not.toBeInTheDocument();
  });

  it('filters packs by genre segment and toggles back to all', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    });

    // Genre segments: [0]=All, [1]=society, [2]=historical what-if (GENRE_META order)
    const genreGroup = screen.getByRole('group', { name: 'Genre' });
    fireEvent.click(within(genreGroup).getAllByRole('button')[1]);
    expect(screen.getByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pack Two/ })).not.toBeInTheDocument();

    // Clicking the active segment again clears the filter (back to all)
    const genreGroupAfter = screen.getByRole('group', { name: 'Genre' });
    fireEvent.click(within(genreGroupAfter).getAllByRole('button')[1]);
    expect(screen.getByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pack Two/ })).toBeInTheDocument();
  });

  it('clears a stale genre filter when refresh removes that genre', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockImplementation((id: string) =>
      Promise.resolve(id === 'pack-two' ? mockPackDetailTwo : mockPackDetailOne),
    );
    // Refresh returns only the historical pack — the previously selected 'society' genre disappears
    refreshLocalPacksMock.mockResolvedValue({
      packs: [mockPacksSummaryList[1]],
      count: 1,
      diagnostics: [],
      diagnostic_count: 0,
    });

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    });

    // Select the society segment → only Pack One remains
    const genreGroup = screen.getByRole('group', { name: 'Genre' });
    fireEvent.click(within(genreGroup).getAllByRole('button')[1]);
    expect(screen.queryByRole('button', { name: /Pack Two/ })).not.toBeInTheDocument();

    // Refresh to a pack set that no longer contains 'society'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Packs' }));

    // The stale genre filter must clear so the remaining pack shows instead of an empty state
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pack Two/ })).toBeInTheDocument();
    });
    expect(screen.queryByText('No matching packs found.')).not.toBeInTheDocument();
  });

  it('selects and previews a pack, showing templates, suggested settings, metadata, and handles fallbacks', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    });

    // Click on Pack One to preview
    const packOneBtn = screen.getByRole('button', { name: /Pack One/ });
    fireEvent.click(packOneBtn);

    await waitFor(() => {
      expect(getLocalPackMock).toHaveBeenCalledWith('pack-one');
      expect(screen.getAllByText('What did Zheng He discover?').length).toBeGreaterThan(0);
    });

    // Verify settings, metadata and optional agent casts / demo snapshots
    expect(screen.getByText('Curator:')).toBeInTheDocument();
    expect(screen.getByText('DeepMind')).toBeInTheDocument();
    expect(screen.getByText('Zheng He')).toBeInTheDocument();
    expect(screen.getByText(/Navigator/)).toBeInTheDocument();
    expect(screen.getByText('demo_one.json')).toBeInTheDocument();
  });

  it('materializes an explicit zh template even when the current UI language is en', async () => {
    await i18n.changeLanguage('en');
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);

    const onImportMock = vi.fn();
    render(<LocalPackPicker onImport={onImportMock} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Pack One/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Use This Template' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use This Template' }));

    expect(onImportMock).toHaveBeenCalledTimes(1);
    expect(onImportMock).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'pack-one',
      templateId: 'template-a',
      question: '郑和下西洋发现了什么？',
      suggestedSettings: {
        numAgents: 5,
        rounds: 10,
        simulationMode: 'balanced',
        language: 'zh',
      },
      worldContext: {
        title: '郑和下西洋发现了什么？',
        summary: '历史背景描述',
        key_entities: [
          {
            name: '郑和',
            role: '航海家',
            traits: [],
            perspective: '探索未知',
          },
        ],
        constraints: ['利益相关者一'],
        evidence_snippets: [`${LOCAL_PACK_PROMPT_EVIDENCE_PREFIX_ZH}提示词一`],
        source_metadata: expect.objectContaining({
          filename: 'pack-one-template-a.json',
          content_type: 'application/json',
          suffix: '.json',
          extraction_method: 'text',
        }),
        warnings: [LOCAL_PACK_PROMPT_WARNING_ZH],
      },
      agentsPreview: [
        { name: '郑和', role: '航海家', persona: '探索未知' },
      ],
    }));
  });

  it('materializes an explicit en template even when the current UI language is zh', async () => {
    await i18n.changeLanguage('zh');
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });
    const englishDetail: LocalPack = {
      ...mockPackDetailOne,
      suggested_settings: {
        ...mockPackDetailOne.suggested_settings,
        language: 'en',
      },
    };
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(englishDetail);

    const onImportMock = vi.fn();
    render(<LocalPackPicker onImport={onImportMock} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /主题包一/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /主题包一/ }));
    const importButton = await screen.findByRole('button', { name: '使用此模板' });
    fireEvent.click(importButton);

    expect(onImportMock).toHaveBeenCalledTimes(1);
    expect(onImportMock).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'pack-one',
      templateId: 'template-a',
      question: 'What did Zheng He discover?',
      suggestedSettings: expect.objectContaining({ language: 'en' }),
      worldContext: expect.objectContaining({
        summary: 'Historical context description',
        constraints: ['Stakeholder one'],
        evidence_snippets: [`${LOCAL_PACK_PROMPT_EVIDENCE_PREFIX}Prompt one`],
        warnings: [LOCAL_PACK_PROMPT_WARNING],
      }),
      agentsPreview: [
        { name: 'Zheng He', role: 'Navigator', persona: 'Explore the unknown' },
      ],
    }));
  });

  it.each([
    ['zh', 'zh', '假设郑和发现了美洲', '背景二', '提示二', '使用此模板'],
    ['en', 'en', 'What if Zheng He reached America first?', 'Context two', 'Prompt two', 'Use This Template'],
  ] as const)(
    'keeps the current %s UI language when the pack setting is bilingual',
    async (uiLanguage, expectedLanguage, expectedQuestion, expectedContext, expectedPrompt, importLabel) => {
      await i18n.changeLanguage(uiLanguage);
      useCapabilityCheckMock.mockReturnValue({
        loading: false,
        enabled: true,
        capabilities: null,
        error: null,
        reload: vi.fn(),
      });
      listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[1]], count: 1 });
      getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
      getLocalPackMock.mockResolvedValue(mockPackDetailTwo);

      const onImportMock = vi.fn();
      render(<LocalPackPicker onImport={onImportMock} onDemoImported={vi.fn()} />);

      const importButton = await screen.findByRole('button', { name: importLabel });
      fireEvent.click(importButton);

      expect(onImportMock).toHaveBeenCalledTimes(1);
      expect(onImportMock).toHaveBeenCalledWith(expect.objectContaining({
        packId: 'pack-two',
        templateId: 'template-b',
        question: expectedQuestion,
        suggestedSettings: {
          numAgents: 3,
          rounds: 5,
          simulationMode: 'conservative',
          language: expectedLanguage,
        },
        worldContext: expect.objectContaining({
          summary: expectedContext,
          constraints: [],
          evidence_snippets: [
            `${expectedLanguage === 'zh'
              ? LOCAL_PACK_PROMPT_EVIDENCE_PREFIX_ZH
              : LOCAL_PACK_PROMPT_EVIDENCE_PREFIX}${expectedPrompt}`,
          ],
          key_entities: [],
        }),
        agentsPreview: [],
      }));
    },
  );

  it('supports copies to clipboard for prompt and JSON payload', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pack One/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Pack One/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copy Prompt' })).toBeInTheDocument();
    });

    // Copy Prompt
    fireEvent.click(screen.getByRole('button', { name: 'Copy Prompt' }));
    expect(writeTextMock).toHaveBeenCalledWith('Prompt one');

    // Copy JSON
    fireEvent.click(screen.getByRole('button', { name: 'Copy JSON' }));
    expect(writeTextMock).toHaveBeenCalledWith(JSON.stringify(mockPackDetailOne, null, 2));
  });

  it('calls refresh packs and surfaces diagnostics with correct mapping', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);
    refreshLocalPacksMock.mockResolvedValue({
      packs: mockPacksSummaryList,
      count: 2,
      diagnostics: mockDiagnosticsResponse,
      diagnostic_count: 2,
    });

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Refresh Packs' })).toBeInTheDocument();
    });

    // Click Refresh
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Packs' }));

    await waitFor(() => {
      expect(refreshLocalPacksMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Pack Diagnostics/)).toBeInTheDocument();
    });

    // Expand details
    const summary = screen.getByText(/Pack Diagnostics/);
    fireEvent.click(summary);

    // Verify diagnostics mapping
    expect(screen.getByText('invalid-pack.json')).toBeInTheDocument();
    expect(screen.getByText('MALFORMED_JSON')).toBeInTheDocument();
    // Known error code mapped message
    expect(screen.getByText('Pack file is not a valid JSON structure')).toBeInTheDocument();

    // Verify fallback for unknown diagnostics code (showing raw message)
    expect(screen.getByText('bad-metadata.json')).toBeInTheDocument();
    expect(screen.getByText('UNKNOWN_DIAGNOSTIC_CODE_TEST')).toBeInTheDocument();
    expect(screen.getByText('Unknown issue occurred in server metadata')).toBeInTheDocument();
  });

  it('reloads the selected pack detail when refresh returns the same pack id', async () => {
    await i18n.changeLanguage('en');
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });
    const refreshedDetail: LocalPack = {
      ...mockPackDetailOne,
      description: { zh: '刷新后的详情 v2', en: 'Refreshed pack detail v2' },
      scenario_templates: [
        {
          ...mockPackDetailOne.scenario_templates[0],
          prompt: { zh: '刷新后的提示词 v2', en: 'Refreshed prompt v2' },
        },
      ],
    };
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[0]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock
      .mockResolvedValueOnce(mockPackDetailOne)
      .mockResolvedValueOnce(refreshedDetail);
    refreshLocalPacksMock.mockResolvedValue({
      packs: [mockPacksSummaryList[0]],
      count: 1,
      diagnostics: [],
      diagnostic_count: 0,
    });

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    expect(await screen.findByText('Prompt one')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Packs' }));

    expect(await screen.findByText('Refreshed pack detail v2')).toBeInTheDocument();
    expect(screen.getByText('Refreshed prompt v2')).toBeInTheDocument();
    expect(screen.queryByText('Prompt one')).not.toBeInTheDocument();
    expect(getLocalPackMock).toHaveBeenCalledTimes(2);
    expect(getLocalPackMock).toHaveBeenLastCalledWith('pack-one');
  });

  it('clears pack A detail and actions when loading pack B detail fails', async () => {
    await i18n.changeLanguage('en');
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });
    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockImplementation((id: string) =>
      id === 'pack-one'
        ? Promise.resolve(mockPackDetailOne)
        : Promise.reject(new Error('pack two detail failed')),
    );

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    expect(await screen.findByText('Prompt one')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Pack Two/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load pack details.');
    expect(screen.queryByText('Prompt one')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy JSON' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Prompt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use This Template' })).not.toBeInTheDocument();
  });

  it('does not let a late pack A response overwrite the newly selected pack B', async () => {
    await i18n.changeLanguage('en');
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });
    const packADetail = createDeferred<LocalPack>();
    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockImplementation((id: string) =>
      id === 'pack-one' ? packADetail.promise : Promise.resolve(mockPackDetailTwo),
    );

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    await waitFor(() => expect(getLocalPackMock).toHaveBeenCalledWith('pack-one'));
    fireEvent.click(screen.getByRole('button', { name: /Pack Two/ }));
    expect(
      (await screen.findAllByText('What if Zheng He reached America first?')).length,
    ).toBeGreaterThan(0);

    await act(async () => {
      packADetail.resolve(mockPackDetailOne);
      await packADetail.promise;
    });

    expect(
      screen.getAllByText('What if Zheng He reached America first?').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText('Prompt one')).not.toBeInTheDocument();
  });

  it('tolerates malformed packs gracefully without throwing', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    // Return pack-two (malformed)
    listLocalPacksMock.mockResolvedValue({ packs: [mockPacksSummaryList[1]], count: 1 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailTwo);

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Pack Two/ })).toBeInTheDocument();
    });

    // Click on Pack Two
    fireEvent.click(screen.getByRole('button', { name: /Pack Two/ }));

    await waitFor(() => {
      expect(screen.getAllByText('What if Zheng He reached America first?').length).toBeGreaterThan(0);
    });

    // Confirm that the component rendered without crashing even with missing casts/snapshots/stakes
    expect(screen.queryByText('Agent Casts')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo Snapshots')).not.toBeInTheDocument();
  });

  it('switches preview to a newly clicked pack after the first is auto-selected (P0-3)', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockImplementation((id: string) =>
      Promise.resolve(id === 'pack-two' ? mockPackDetailTwo : mockPackDetailOne),
    );

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    // pack-one is auto-selected on mount (P0-3) and its detail loads first
    await waitFor(() => {
      expect(getLocalPackMock).toHaveBeenCalledWith('pack-one');
    });

    // Clicking the not-yet-selected pack-two must switch the preview to it (proves the click path, not auto-select)
    fireEvent.click(screen.getByRole('button', { name: /Pack Two/ }));

    await waitFor(() => {
      expect(getLocalPackMock).toHaveBeenCalledWith('pack-two');
      expect(screen.getAllByText('What if Zheng He reached America first?').length).toBeGreaterThan(0);
    });
  });

  it('collapses unknown genres into a single "Other" segment and filters by it', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    const packsWithUnknown: LocalPackSummary[] = [
      { ...mockPacksSummaryList[0], id: 'p-society', genre: 'society', title: { zh: '', en: 'Society Pack' } },
      { ...mockPacksSummaryList[0], id: 'p-sports', genre: 'sports', title: { zh: '', en: 'Sports Pack' } },
      { ...mockPacksSummaryList[0], id: 'p-esports', genre: 'esports', title: { zh: '', en: 'Esports Pack' } },
      { ...mockPacksSummaryList[0], id: 'p-empty', genre: '', title: { zh: '', en: 'Empty Genre Pack' } },
    ];
    listLocalPacksMock.mockResolvedValue({ packs: packsWithUnknown, count: 4 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });
    getLocalPackMock.mockResolvedValue(mockPackDetailOne);

    render(<LocalPackPicker onImport={vi.fn()} onDemoImported={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Society Pack/ })).toBeInTheDocument();
    });

    // Unknown and empty genres collapse to ONE "Other" segment → All + society + Other = 3
    const genreGroup = screen.getByRole('group', { name: 'Genre' });
    const segs = within(genreGroup).getAllByRole('button');
    expect(segs).toHaveLength(3);

    // Clicking the "Other" segment (last) keeps unknown and empty-genre packs
    fireEvent.click(segs[segs.length - 1]);
    expect(screen.getByRole('button', { name: /Sports Pack/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Esports Pack/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Empty Genre Pack/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Society Pack/ })).not.toBeInTheDocument();
  });
});
