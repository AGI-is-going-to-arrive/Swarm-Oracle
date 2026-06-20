import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalPackPicker } from './LocalPackPicker';
import type {
  LocalPackSummary,
  LocalPack,
  PackDiagnostic,
} from '../types';

const useCapabilityCheckMock = vi.hoisted(() => vi.fn());
const listLocalPacksMock = vi.hoisted(() => vi.fn());
const getLocalPackMock = vi.hoisted(() => vi.fn());
const refreshLocalPacksMock = vi.hoisted(() => vi.fn());
const getLocalPackDiagnosticsMock = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
}));

vi.mock('../api/client', () => ({
  listLocalPacks: listLocalPacksMock,
  getLocalPack: getLocalPackMock,
  refreshLocalPacks: refreshLocalPacksMock,
  getLocalPackDiagnostics: getLocalPackDiagnosticsMock,
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
  writeTextMock.mockClear();
});

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

describe('LocalPackPicker', () => {
  it('renders loading state when capability is loading', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: true,
      enabled: false,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    render(<LocalPackPicker onImport={vi.fn()} />);

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

    render(<LocalPackPicker onImport={vi.fn()} />);

    expect(
      screen.getByText('Local packs feature is disabled. Check capability settings.')
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

    render(<LocalPackPicker onImport={vi.fn()} />);

    expect(screen.getByText('Capability error')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('loads packs and renders pack list, tags, and filters packs correctly', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    listLocalPacksMock.mockResolvedValue({ packs: mockPacksSummaryList, count: 2 });
    getLocalPackDiagnosticsMock.mockResolvedValue({ diagnostics: [], count: 0 });

    render(<LocalPackPicker onImport={vi.fn()} />);

    await waitFor(() => {
      expect(listLocalPacksMock).toHaveBeenCalledTimes(1);
      expect(getLocalPackDiagnosticsMock).toHaveBeenCalledTimes(1);
    });

    // Verify pack list render
    expect(await screen.findByText('Pack One')).toBeInTheDocument();
    expect(screen.getByText('Pack Two')).toBeInTheDocument();
    expect(screen.getByText('society')).toBeInTheDocument();
    expect(screen.getByText('historical what-if')).toBeInTheDocument();

    // Verify tag chips render
    expect(screen.getByRole('button', { name: 'Society' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tech' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'History' })).toBeInTheDocument();

    // Test text search
    const searchInput = screen.getByPlaceholderText('Search title, description, or genre...');
    fireEvent.change(searchInput, { target: { value: 'One' } });
    expect(screen.getByText('Pack One')).toBeInTheDocument();
    expect(screen.queryByText('Pack Two')).not.toBeInTheDocument();

    // Reset search
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.getByText('Pack Two')).toBeInTheDocument();

    // Test tag filter
    const societyTagBtn = screen.getByRole('button', { name: 'Society' });
    fireEvent.click(societyTagBtn);
    expect(screen.getByText('Pack One')).toBeInTheDocument();
    expect(screen.queryByText('Pack Two')).not.toBeInTheDocument();
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

    render(<LocalPackPicker onImport={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Pack One')).toBeInTheDocument();
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

  it('fires onImport callback with correct payload when templates are imported', async () => {
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
    render(<LocalPackPicker onImport={onImportMock} />);

    await waitFor(() => {
      expect(screen.getByText('Pack One')).toBeInTheDocument();
    });

    // Click on Pack One
    fireEvent.click(screen.getByRole('button', { name: /Pack One/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Use This Template' })).toBeInTheDocument();
    });

    // Click Use This Template
    fireEvent.click(screen.getByRole('button', { name: 'Use This Template' }));

    expect(onImportMock).toHaveBeenCalledTimes(1);
    expect(onImportMock).toHaveBeenCalledWith({
      question: 'What did Zheng He discover?',
      suggested_settings: mockPackDetailOne.suggested_settings,
    });
  });

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

    render(<LocalPackPicker onImport={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Pack One')).toBeInTheDocument();
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
    refreshLocalPacksMock.mockResolvedValue({
      packs: mockPacksSummaryList,
      count: 2,
      diagnostics: mockDiagnosticsResponse,
      diagnostic_count: 2,
    });

    render(<LocalPackPicker onImport={vi.fn()} />);

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

    render(<LocalPackPicker onImport={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Pack Two')).toBeInTheDocument();
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
});
