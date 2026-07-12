import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import {
  parseAgentPackBytes,
  parseAgentPackText,
  validateAgentPackPayload,
} from '../lib/agentPackImportUtils';
import { KNOWLEDGE_DOMAINS } from '../contracts/agentIdentity';
import { AgentLibrary } from './AgentLibrary';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string; name?: string }) => {
      if (fallback && typeof fallback === 'object') {
        return (fallback.defaultValue ?? key).replace('{{name}}', String(fallback.name ?? ''));
      }
      return ({
        'agents.library_title': 'Agent 资料库',
        'agents.create_btn': '创建 Agent',
        'agents.empty_state': '还没有自定义 Agent。',
        'agents.empty_hint': '创建你的第一个自定义 Agent 并在推演中使用。',
        'agent_library.backup_hint': '要备份现有 Agent，请在对应卡片上点击“导出备份”。',
        'persona_export.export': '导出备份',
        'persona_export.import': '从备份创建 Agent',
      }[key] ?? fallback ?? key);
    },
    i18n: { changeLanguage: vi.fn(), language: 'zh' },
  }),
}));

const mockCapability = vi.hoisted(() => ({
  loading: false,
  enabled: true,
  error: null as Error | null,
  reload: vi.fn(),
}));

const mockPersonaCapability = vi.hoisted(() => ({
  loading: false,
  enabled: true,
  error: null as Error | null,
  reload: vi.fn(),
}));

const mockApi = vi.hoisted(() => ({
  deleteAgent: vi.fn(),
  exportAgentPack: vi.fn(),
  exportPersona: vi.fn(),
  getAgentFavorites: vi.fn(),
  getIdentityGrowthEvents: vi.fn(),
  getIdentityMemory: vi.fn(),
  getSessionBoundUserId: vi.fn(() => 'test_user'),
  importAgentPack: vi.fn(),
  importPersona: vi.fn(),
  isApiError: vi.fn(() => false),
  listAgentIdentities: vi.fn(),
  markAgentFavorite: vi.fn(),
  unmarkAgentFavorite: vi.fn(),
}));

vi.mock('../api/client', () => ({
  deleteAgent: mockApi.deleteAgent,
  exportAgentPack: mockApi.exportAgentPack,
  exportPersona: mockApi.exportPersona,
  getAgentFavorites: mockApi.getAgentFavorites,
  getIdentityGrowthEvents: mockApi.getIdentityGrowthEvents,
  getIdentityMemory: mockApi.getIdentityMemory,
  getSessionBoundUserId: mockApi.getSessionBoundUserId,
  importAgentPack: mockApi.importAgentPack,
  importPersona: mockApi.importPersona,
  isApiError: mockApi.isApiError,
  listAgentIdentities: mockApi.listAgentIdentities,
  markAgentFavorite: mockApi.markAgentFavorite,
  unmarkAgentFavorite: mockApi.unmarkAgentFavorite,
}));

const mockDownloads = vi.hoisted(() => ({
  triggerJsonDownload: vi.fn(),
}));

vi.mock('../components/personaExportImportUtils', async () => {
  const actual = await vi.importActual<typeof import('../components/personaExportImportUtils')>(
    '../components/personaExportImportUtils',
  );
  return {
    ...actual,
    triggerJsonDownload: mockDownloads.triggerJsonDownload,
  };
});

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: (key: string) => {
    const capability = key === 'persona_export' ? mockPersonaCapability : mockCapability;
    return {
    loading: capability.loading,
    enabled: capability.enabled,
    capabilities: null,
    error: capability.error,
    reload: capability.reload,
    };
  },
}));

const mockAgentStore = vi.hoisted(() => ({
  identities: [] as Array<{
    id: string;
    user_id: string;
    kind: 'generated' | 'custom';
    display_name: string;
    role: string;
    persona: string | null;
    decision_bias: Record<string, unknown> | null;
    decision_bias_json: string | null;
    preferred_tier: 'IMPORTANT' | 'CROWD' | null;
    continuity_key: string;
    created_at: string;
    updated_at: string;
  }>,
  fetchIdentities: vi.fn(),
  setIdentities: vi.fn(),
}));

vi.mock('../stores/agentStore', () => ({
  useAgentStore: () => ({
    identities: mockAgentStore.identities,
    loading: false,
    error: null,
    fetchIdentities: mockAgentStore.fetchIdentities,
    setIdentities: mockAgentStore.setIdentities,
  }),
}));

function validAgentPackInput() {
  return {
    format: 'swarmoracle.agent_pack',
    schema_version: 1,
    exported_at: '2026-07-12T01:02:03Z',
    title: ' Research team ',
    agents: [{
      name: ' Ada ',
      role: ' Forecaster ',
      persona_text: 'Careful and concise.',
      decision_bias: { caution: 0.8 },
      tags: ['science'],
    }],
  };
}

function twoAgentPackInput() {
  const pack = validAgentPackInput();
  pack.agents.push({
    name: 'Grace',
    role: 'Risk analyst',
    persona_text: 'Challenges assumptions and names failure modes.',
    decision_bias: { caution: 0.7 },
    tags: ['technology', 'law'],
  });
  return pack;
}

function renderAgentLibrary() {
  return render(
    <MemoryRouter initialEntries={['/agents']}>
      <AgentLibrary />
    </MemoryRouter>,
  );
}

function libraryAgent(
  id: string,
  name: string,
  role = 'Forecaster',
  kind: 'custom' | 'generated' = 'custom',
) {
  return {
    id,
    user_id: 'test_user',
    kind,
    display_name: name,
    role,
    persona: `${name} persona`,
    decision_bias: null,
    decision_bias_json: null,
    preferred_tier: 'IMPORTANT' as const,
    continuity_key: `${id}-continuity`,
    created_at: '2026-05-11T00:00:00Z',
    updated_at: '2026-05-11T00:00:00Z',
  };
}

function openAgentPackPastePreview(pack = twoAgentPackInput()) {
  fireEvent.click(screen.getByRole('button', { name: 'Import Agent Pack' }));
  const dialog = screen.getByRole('dialog', { name: 'Review Agent Pack' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Paste Agent Pack JSON' }));
  fireEvent.change(within(dialog).getByLabelText('Agent Pack JSON'), {
    target: { value: JSON.stringify(pack) },
  });
  return dialog;
}

describe('Agent Pack v1 local validator', () => {
  it('normalizes bounded text and fills missing known decision-bias keys', () => {
    const result = validateAgentPackPayload(validAgentPackInput());

    expect(result).toEqual({
      ok: true,
      pack: {
        format: 'swarmoracle.agent_pack',
        schema_version: 1,
        exported_at: '2026-07-12T01:02:03Z',
        title: 'Research team',
        agents: [{
          name: 'Ada',
          role: 'Forecaster',
          persona_text: 'Careful and concise.',
          decision_bias: {
            caution: 0.8,
            optimism: 0.5,
            conservatism: 0.5,
            risk_tolerance: 0.5,
            creativity: 0.5,
          },
          tags: ['science'],
        }],
      },
    });
  });

  it.each([
    ['root secret field', { ...validAgentPackInput(), api_key: 'sk-secret' }],
    ['agent owner field', {
      ...validAgentPackInput(),
      agents: [{ ...validAgentPackInput().agents[0], user_id: 'secret-owner' }],
    }],
    ['bias credential field', {
      ...validAgentPackInput(),
      agents: [{
        ...validAgentPackInput().agents[0],
        decision_bias: { caution: 0.8, credential: 0.5 },
      }],
    }],
  ])('rejects extra-forbid violations including %s', (_label, input) => {
    expect(validateAgentPackPayload(input)).toEqual({ ok: false, error: 'invalid_schema' });
  });

  it.each([
    ['wrong format', { ...validAgentPackInput(), format: 'swarmoracle.persona' }],
    ['wrong version', { ...validAgentPackInput(), schema_version: 2 }],
    ['timestamp without timezone', {
      ...validAgentPackInput(),
      exported_at: '2026-07-12T01:02:03',
    }],
    ['invalid RFC3339 calendar date', {
      ...validAgentPackInput(),
      exported_at: '2026-02-30T01:02:03Z',
    }],
    ['unsupported RFC3339 year zero', {
      ...validAgentPackInput(),
      exported_at: '0000-01-01T01:02:03Z',
    }],
    ['empty agents', { ...validAgentPackInput(), agents: [] }],
    ['more than 20 agents', {
      ...validAgentPackInput(),
      agents: Array.from({ length: 21 }, (_, index) => ({
        ...validAgentPackInput().agents[0],
        name: `Agent ${index}`,
      })),
    }],
  ])('rejects %s', (_label, input) => {
    expect(validateAgentPackPayload(input)).toEqual({ ok: false, error: 'invalid_schema' });
  });

  it('accepts exact text and collection boundaries', () => {
    const input = validAgentPackInput();
    input.title = 't'.repeat(100);
    input.agents = Array.from({ length: 20 }, (_, index) => ({
      ...input.agents[0],
      name: `${index}`.padEnd(100, 'n'),
      role: 'r'.repeat(200),
      persona_text: 'p'.repeat(2000),
      tags: [...KNOWLEDGE_DOMAINS],
    }));

    const result = validateAgentPackPayload(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pack.agents).toHaveLength(20);
      expect(result.pack.agents[0].tags).toHaveLength(15);
    }
  });

  it.each([
    ['blank title', (input: ReturnType<typeof validAgentPackInput>) => { input.title = '   '; }],
    ['long title', (input: ReturnType<typeof validAgentPackInput>) => { input.title = 't'.repeat(101); }],
    ['blank name', (input: ReturnType<typeof validAgentPackInput>) => { input.agents[0].name = ' '; }],
    ['long name', (input: ReturnType<typeof validAgentPackInput>) => { input.agents[0].name = 'n'.repeat(101); }],
    ['blank role', (input: ReturnType<typeof validAgentPackInput>) => { input.agents[0].role = ' '; }],
    ['long role', (input: ReturnType<typeof validAgentPackInput>) => { input.agents[0].role = 'r'.repeat(201); }],
    ['long persona', (input: ReturnType<typeof validAgentPackInput>) => { input.agents[0].persona_text = 'p'.repeat(2001); }],
  ])('rejects %s', (_label, mutate) => {
    const input = validAgentPackInput();
    mutate(input);
    expect(validateAgentPackPayload(input)).toEqual({ ok: false, error: 'invalid_schema' });
  });

  it.each([
    ['boolean', true],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['below zero', -0.01],
    ['above one', 1.01],
  ])('rejects %s decision-bias values', (_label, value) => {
    const input = validAgentPackInput();
    input.agents[0].decision_bias = { caution: value as number };
    expect(validateAgentPackPayload(input)).toEqual({ ok: false, error: 'invalid_schema' });
  });

  it.each([
    ['duplicate tags', ['science', 'science']],
    ['unknown tags', ['science', 'astrology']],
  ])('rejects %s', (_label, tags) => {
    const input = validAgentPackInput();
    input.agents[0].tags = tags;
    expect(validateAgentPackPayload(input)).toEqual({ ok: false, error: 'invalid_schema' });
  });

  it('enforces the 256 KiB UTF-8 limit before JSON parsing', () => {
    const oversized = '界'.repeat(90_000);
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(262_144);
    expect(parseAgentPackText(oversized)).toEqual({ ok: false, error: 'too_large' });
  });

  it('rejects malformed JSON and non-UTF-8 file bytes without exposing raw input', () => {
    expect(parseAgentPackText('{"api_key":"sk-secret"')).toEqual({
      ok: false,
      error: 'invalid_json',
    });
    expect(parseAgentPackBytes(Uint8Array.from([0xc3, 0x28]))).toEqual({
      ok: false,
      error: 'invalid_utf8',
    });
  });
});

describe('AgentLibrary', () => {
  beforeEach(() => {
    mockCapability.loading = false;
    mockCapability.enabled = true;
    mockCapability.error = null;
    mockCapability.reload.mockClear();
    mockPersonaCapability.loading = false;
    mockPersonaCapability.enabled = true;
    mockPersonaCapability.error = null;
    mockPersonaCapability.reload.mockClear();
    mockAgentStore.identities = [];
    mockAgentStore.fetchIdentities.mockClear();
    mockAgentStore.fetchIdentities.mockResolvedValue(undefined);
    mockAgentStore.setIdentities.mockClear();
    mockApi.deleteAgent.mockClear();
    mockApi.exportAgentPack.mockReset();
    mockDownloads.triggerJsonDownload.mockReset();
    mockApi.getAgentFavorites.mockClear();
    mockApi.getAgentFavorites.mockReturnValue(new Promise(() => {}));
    mockApi.getIdentityGrowthEvents.mockClear();
    mockApi.getIdentityGrowthEvents.mockResolvedValue({ events: [] });
    mockApi.getIdentityMemory.mockClear();
    mockApi.getIdentityMemory.mockResolvedValue({ memories: [] });
    mockApi.getSessionBoundUserId.mockClear();
    mockApi.importAgentPack.mockReset();
    mockApi.listAgentIdentities.mockReset();
    mockApi.listAgentIdentities.mockResolvedValue([]);
    mockApi.isApiError.mockClear();
    mockApi.isApiError.mockReturnValue(false);
    mockApi.markAgentFavorite.mockClear();
    mockApi.unmarkAgentFavorite.mockClear();
    Object.defineProperty(window, 'localStorage', {
      value: { getItem: vi.fn().mockReturnValue('test_user'), setItem: vi.fn(), removeItem: vi.fn() },
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/agents');
    vi.restoreAllMocks();
  });
  it('renders localized empty state copy', () => {
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: 'Agent 资料库' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '从备份创建 Agent' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /\+ 创建 Agent/ })).toBeInTheDocument();
    expect(screen.getByText('还没有自定义 Agent。')).toBeInTheDocument();
    expect(screen.getByText('创建你的第一个自定义 Agent 并在推演中使用。')).toBeInTheDocument();
  });

  it('does not fetch identities when capability is disabled', () => {
    mockCapability.enabled = false;
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );
    expect(mockAgentStore.fetchIdentities).not.toHaveBeenCalled();
    expect(screen.getByText('Custom agents feature is not enabled.')).toBeInTheDocument();
  });

  it('shows retryable capability probe errors instead of disabled copy', () => {
    mockCapability.enabled = false;
    mockCapability.error = new Error('capabilities failed');
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    expect(mockAgentStore.fetchIdentities).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not check custom agent availability. Please retry.',
    );
    expect(screen.queryByText('Custom agents feature is not enabled.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mockCapability.reload).toHaveBeenCalledTimes(1);
  });

  it('does not expose raw favorites load errors', async () => {
    mockApi.getAgentFavorites.mockRejectedValueOnce(new Error('raw favorites failure'));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to load favorites. Please retry.',
    );
    expect(screen.queryByText(/raw favorites failure/i)).not.toBeInTheDocument();
    debugSpy.mockRestore();
  });

  it('labels custom agent delete buttons with the target agent name', () => {
    mockAgentStore.identities = [{
      id: 'custom-1',
      user_id: 'test_user',
      kind: 'custom',
      display_name: 'Ada',
      role: 'Forecaster',
      persona: 'Careful and concise.',
      decision_bias: null,
      decision_bias_json: null,
      preferred_tier: 'IMPORTANT',
      continuity_key: 'ada',
      created_at: '2026-05-11T00:00:00Z',
      updated_at: '2026-05-11T00:00:00Z',
    }];

    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: 'Delete Ada' })).toBeInTheDocument();
  });

  it('opens an Agent profile from an agent_profile hash deep-link', () => {
    mockAgentStore.identities = [{
      id: 'custom-1',
      user_id: 'test_user',
      kind: 'custom',
      display_name: 'Ada',
      role: 'Forecaster',
      persona: 'Careful and concise.',
      decision_bias: null,
      decision_bias_json: null,
      preferred_tier: 'IMPORTANT',
      continuity_key: 'ada',
      created_at: '2026-05-11T00:00:00Z',
      updated_at: '2026-05-11T00:00:00Z',
    }];
    window.history.replaceState(null, '', '/agents#agent_profile=custom-1&tab=memory');

    render(
      <MemoryRouter initialEntries={['/agents#agent_profile=custom-1&tab=memory']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Agent Profile' });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Ada' })).toBeInTheDocument();
  });

  it('makes the Agent backup export entry visible on existing Agent cards', () => {
    mockAgentStore.identities = [{
      id: 'custom-1',
      user_id: 'test_user',
      kind: 'custom',
      display_name: 'Ada',
      role: 'Forecaster',
      persona: 'Careful and concise.',
      decision_bias: null,
      decision_bias_json: null,
      preferred_tier: 'IMPORTANT',
      continuity_key: 'ada',
      created_at: '2026-05-11T00:00:00Z',
      updated_at: '2026-05-11T00:00:00Z',
    }];

    render(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );

    expect(screen.getByText('要备份现有 Agent，请在对应卡片上点击“导出备份”。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export backup for Ada' })).toHaveTextContent('导出备份');
  });

  it('exports selected Agents in stable library order as one named Agent Pack download', async () => {
    mockAgentStore.identities = [
      libraryAgent('custom-1', 'Ada'),
      libraryAgent('custom-2', 'Grace', 'Risk analyst'),
    ];
    const validated = validateAgentPackPayload(twoAgentPackInput());
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error('test fixture must be valid');
    const exportedPack = validated.pack;
    mockApi.exportAgentPack.mockResolvedValueOnce(exportedPack);
    renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    fireEvent.change(within(dialog).getByLabelText('Pack title'), {
      target: { value: '  Research team  ' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Include Grace,/ }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Include Ada,/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export 2 Agents' }));

    await waitFor(() => {
      expect(mockApi.exportAgentPack).toHaveBeenCalledWith(
        {
          title: 'Research team',
          identity_ids: ['custom-1', 'custom-2'],
        },
        { signal: expect.any(AbortSignal) },
      );
    });
    expect(mockDownloads.triggerJsonDownload).toHaveBeenCalledWith(
      exportedPack,
      'Research-team-agent-pack.json',
    );
    expect(within(dialog).getByRole('status')).toHaveTextContent('Agent Pack downloaded locally.');
  });

  it('enforces the 20-Agent export cap and keeps title/selection validation local', () => {
    mockAgentStore.identities = Array.from({ length: 21 }, (_, index) => (
      libraryAgent(`custom-${index + 1}`, `Agent ${index + 1}`)
    ));
    renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    const submit = within(dialog).getByRole('button', { name: 'Export 0 Agents' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Pack title'), {
      target: { value: 'A'.repeat(101) },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Select first 20' }));

    expect(within(dialog).getByRole('checkbox', { name: /^Include Agent 20,/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /^Include Agent 21,/ })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Export 20 Agents' })).toBeDisabled();
    expect(mockApi.exportAgentPack).not.toHaveBeenCalled();
  });

  it('counts Unicode code points for the 100-character title boundary', () => {
    mockAgentStore.identities = [libraryAgent('custom-1', 'Ada')];
    renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Include Ada,/ }));
    const titleInput = within(dialog).getByLabelText('Pack title');
    fireEvent.change(titleInput, { target: { value: '🧭'.repeat(100) } });
    expect(within(dialog).getByRole('button', { name: 'Export 1 Agent' })).toBeEnabled();

    fireEvent.change(titleInput, { target: { value: '🧭'.repeat(101) } });
    expect(within(dialog).getByRole('button', { name: 'Export 1 Agent' })).toBeDisabled();
    expect(mockApi.exportAgentPack).not.toHaveBeenCalled();
  });

  it('distinguishes duplicate custom and generated members and gives an honest privacy warning', () => {
    mockAgentStore.identities = [
      libraryAgent('custom-1', 'Echo', 'Analyst', 'custom'),
      libraryAgent('generated-1', 'Echo', 'Strategist', 'generated'),
    ];
    renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    expect(within(dialog).getByRole('checkbox', {
      name: 'Include Echo, Analyst, Custom',
    })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', {
      name: 'Include Echo, Strategist, Generated',
    })).toBeInTheDocument();
    expect(within(dialog).getByText('Custom')).toBeInTheDocument();
    expect(within(dialog).getByText('Generated')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/common credential patterns are redacted/i);
    expect(dialog).toHaveTextContent('review it for any other sensitive text');
  });

  it('deduplicates export requests and aborts safely when the dialog closes', async () => {
    mockAgentStore.identities = [libraryAgent('custom-1', 'Ada')];
    let resolveExport!: (value: ReturnType<typeof validAgentPackInput>) => void;
    mockApi.exportAgentPack.mockImplementationOnce((_payload, options) => new Promise((resolve) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      resolveExport = resolve;
    }));
    renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    fireEvent.change(within(dialog).getByLabelText('Pack title'), {
      target: { value: 'Solo' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Include Ada,/ }));
    const submit = within(dialog).getByRole('button', { name: 'Export 1 Agent' });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(mockApi.exportAgentPack).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    const signal = mockApi.exportAgentPack.mock.calls[0][1].signal as AbortSignal;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Agent Pack export' }));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Export Agent Pack' })).not.toBeInTheDocument();

    await act(async () => {
      resolveExport(validAgentPackInput());
    });
    expect(mockDownloads.triggerJsonDownload).not.toHaveBeenCalled();
  });

  it('aborts and discards an export when the available identity list changes', async () => {
    mockAgentStore.identities = [libraryAgent('custom-1', 'Ada')];
    let resolveExport!: (value: ReturnType<typeof validAgentPackInput>) => void;
    mockApi.exportAgentPack.mockImplementationOnce(() => new Promise((resolve) => {
      resolveExport = resolve;
    }));
    const view = renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    fireEvent.change(within(dialog).getByLabelText('Pack title'), {
      target: { value: 'Solo' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Include Ada,/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export 1 Agent' }));
    const signal = mockApi.exportAgentPack.mock.calls[0][1].signal as AbortSignal;

    mockAgentStore.identities = [libraryAgent('custom-2', 'Grace')];
    view.rerender(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );
    expect(signal.aborted).toBe(true);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'One or more selected Agents are no longer available. Refresh the library and try again.',
    );

    await act(async () => {
      resolveExport(validAgentPackInput());
    });
    expect(mockDownloads.triggerJsonDownload).not.toHaveBeenCalled();
  });

  it('aborts a hidden export when the capability gate turns off', async () => {
    mockAgentStore.identities = [libraryAgent('custom-1', 'Ada')];
    let resolveExport!: (value: ReturnType<typeof validAgentPackInput>) => void;
    mockApi.exportAgentPack.mockImplementationOnce(() => new Promise((resolve) => {
      resolveExport = resolve;
    }));
    const view = renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    fireEvent.change(within(dialog).getByLabelText('Pack title'), {
      target: { value: 'Solo' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Include Ada,/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export 1 Agent' }));
    const signal = mockApi.exportAgentPack.mock.calls[0][1].signal as AbortSignal;

    mockPersonaCapability.enabled = false;
    view.rerender(
      <MemoryRouter initialEntries={['/agents']}>
        <AgentLibrary />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog', { name: 'Export Agent Pack' })).not.toBeInTheDocument();
    expect(signal.aborted).toBe(true);

    await act(async () => {
      resolveExport(validAgentPackInput());
    });
    expect(mockDownloads.triggerJsonDownload).not.toHaveBeenCalled();
  });

  it('maps stale-member export errors without exposing server details', async () => {
    mockAgentStore.identities = [libraryAgent('custom-1', 'Ada')];
    mockApi.isApiError.mockReturnValue(true);
    mockApi.exportAgentPack.mockRejectedValueOnce({
      status: 404,
      code: 'AGENT_PACK_MEMBER_NOT_FOUND',
      message: 'raw owner and identity details',
    });
    renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    fireEvent.change(within(dialog).getByLabelText('Pack title'), {
      target: { value: 'Solo' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Include Ada,/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export 1 Agent' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'One or more selected Agents are no longer available. Refresh the library and try again.',
    );
    expect(dialog).not.toHaveTextContent('raw owner and identity details');
    expect(mockDownloads.triggerJsonDownload).not.toHaveBeenCalled();
  });

  it('rejects a malformed success response before creating a download', async () => {
    mockAgentStore.identities = [libraryAgent('custom-1', 'Ada')];
    mockApi.exportAgentPack.mockResolvedValueOnce({
      format: 'swarmoracle.agent_pack',
      schema_version: 1,
      exported_at: '2026-07-12T01:02:03Z',
      title: 'Solo',
      agents: [],
      api_key: 'must-not-reach-download',
    });
    renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    fireEvent.change(within(dialog).getByLabelText('Pack title'), {
      target: { value: 'Solo' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Include Ada,/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export 1 Agent' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The server returned an invalid Agent Pack. Nothing was downloaded.',
    );
    expect(mockDownloads.triggerJsonDownload).not.toHaveBeenCalled();
  });

  it('rejects an oversized success response before creating a download', async () => {
    mockAgentStore.identities = [libraryAgent('custom-1', 'Ada')];
    const oversized = validAgentPackInput();
    oversized.agents[0].persona_text = '界'.repeat(90_000);
    mockApi.exportAgentPack.mockResolvedValueOnce(oversized);
    renderAgentLibrary();

    fireEvent.click(screen.getByRole('button', { name: 'Export Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Export Agent Pack' });
    fireEvent.change(within(dialog).getByLabelText('Pack title'), {
      target: { value: 'Solo' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /^Include Ada,/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export 1 Agent' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The server returned an invalid Agent Pack. Nothing was downloaded.',
    );
    expect(mockDownloads.triggerJsonDownload).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', { enabled: false, loading: false, error: null }],
    ['loading', { enabled: true, loading: true, error: null }],
    ['probe error', { enabled: true, loading: false, error: new Error('legacy capability') }],
  ])('hides Agent Pack import when persona_export is %s', (_label, state) => {
    Object.assign(mockPersonaCapability, state);
    renderAgentLibrary();

    expect(screen.queryByRole('button', { name: 'Import Agent Pack' })).not.toBeInTheDocument();
  });

  it('previews pasted agents in pack order without sending an import request', () => {
    renderAgentLibrary();
    const dialog = openAgentPackPastePreview();

    const preview = within(dialog).getByRole('list', { name: 'Agents in import order' });
    const rows = within(preview).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ada');
    expect(rows[0]).toHaveTextContent('Forecaster');
    expect(rows[0]).toHaveTextContent('science');
    expect(rows[0]).toHaveTextContent('Careful and concise.');
    expect(rows[1]).toHaveTextContent('Grace');
    expect(rows[1]).toHaveTextContent('Risk analyst');
    expect(dialog).toHaveTextContent(
      'The complete persona text for every listed agent will be imported.',
    );
    expect(mockApi.importAgentPack).not.toHaveBeenCalled();
  });

  it('previews a selected JSON file locally without sending an import request', async () => {
    renderAgentLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Import Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Review Agent Pack' });
    const file = new File([JSON.stringify(twoAgentPackInput())], 'team.json', {
      type: 'application/json',
    });

    fireEvent.change(within(dialog).getByTestId('agent-pack-file-input'), {
      target: { files: [file] },
    });

    expect(await within(dialog).findByRole('list', { name: 'Agents in import order' }))
      .toBeInTheDocument();
    expect(mockApi.importAgentPack).not.toHaveBeenCalled();
  });

  it('deduplicates confirm and locks every close path while import is in flight', async () => {
    let resolveImport!: (value: {
      success: true;
      title: string;
      imported_count: number;
      identities: never[];
    }) => void;
    mockApi.importAgentPack.mockImplementationOnce(() => new Promise((resolve) => {
      resolveImport = resolve;
    }));
    renderAgentLibrary();
    const dialog = openAgentPackPastePreview();
    mockAgentStore.fetchIdentities.mockClear();
    mockAgentStore.setIdentities.mockClear();
    mockApi.listAgentIdentities.mockClear();

    const confirmButton = within(dialog).getByRole('button', { name: 'Import 2 Agents' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(mockApi.importAgentPack).toHaveBeenCalledTimes(1);
    expect(confirmButton).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Close Agent Pack dialog' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('agent-pack-backdrop'));
    expect(screen.getByRole('dialog', { name: 'Review Agent Pack' })).toBeInTheDocument();

    await act(async () => {
      resolveImport({
        success: true,
        title: 'Research team',
        imported_count: 2,
        identities: [],
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Review Agent Pack' })).not.toBeInTheDocument();
    });
    expect(mockApi.listAgentIdentities).toHaveBeenCalledTimes(1);
    expect(mockApi.listAgentIdentities).toHaveBeenCalledWith('test_user');
    expect(mockAgentStore.setIdentities).toHaveBeenCalledTimes(1);
    expect(mockAgentStore.setIdentities).toHaveBeenCalledWith([]);
    expect(mockAgentStore.fetchIdentities).not.toHaveBeenCalled();
  });

  it('ignores a stale file read after a newer pasted pack starts importing', async () => {
    let resolveFile!: (value: ArrayBuffer) => void;
    let resolveImport!: (value: {
      success: true;
      title: string;
      imported_count: number;
      identities: never[];
    }) => void;
    const latePack = validAgentPackInput();
    latePack.agents[0].name = 'Late file agent';
    const lateBytes = new TextEncoder().encode(JSON.stringify(latePack));
    const pendingFile = {
      name: 'late.json',
      type: 'application/json',
      arrayBuffer: vi.fn(() => new Promise<ArrayBuffer>((resolve) => {
        resolveFile = resolve;
      })),
    };
    mockApi.importAgentPack.mockImplementationOnce(() => new Promise((resolve) => {
      resolveImport = resolve;
    }));
    renderAgentLibrary();
    fireEvent.click(screen.getByRole('button', { name: 'Import Agent Pack' }));
    const dialog = screen.getByRole('dialog', { name: 'Review Agent Pack' });
    fireEvent.change(within(dialog).getByTestId('agent-pack-file-input'), {
      target: { files: [pendingFile] },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Paste Agent Pack JSON' }));
    fireEvent.change(within(dialog).getByLabelText('Agent Pack JSON'), {
      target: { value: JSON.stringify(twoAgentPackInput()) },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 2 Agents' }));

    await act(async () => {
      resolveFile(lateBytes.buffer as ArrayBuffer);
    });

    expect(dialog).toHaveTextContent('Ada');
    expect(dialog).not.toHaveTextContent('Late file agent');
    expect(mockApi.importAgentPack).toHaveBeenCalledWith(expect.objectContaining({
      agents: expect.arrayContaining([expect.objectContaining({ name: 'Ada' })]),
    }));

    await act(async () => {
      resolveImport({
        success: true,
        title: 'Research team',
        imported_count: 2,
        identities: [],
      });
    });
  });

  it('keeps a confirmed import committed when the library refresh fails', async () => {
    mockApi.importAgentPack.mockResolvedValueOnce({
      success: true,
      title: 'Research team',
      imported_count: 2,
      identities: [],
    });
    mockApi.listAgentIdentities.mockRejectedValueOnce(new Error('raw refresh failure'));
    renderAgentLibrary();
    const dialog = openAgentPackPastePreview();

    const confirmButton = within(dialog).getByRole('button', { name: 'Import 2 Agents' });
    fireEvent.click(confirmButton);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Agents were imported, but the library could not refresh. Reload the library or page to see them.',
    );
    expect(dialog).not.toHaveTextContent('No agents were imported');
    expect(dialog).not.toHaveTextContent('Try again');
    expect(confirmButton).toBeDisabled();
    fireEvent.click(confirmButton);
    expect(mockApi.importAgentPack).toHaveBeenCalledTimes(1);

    const closeButton = within(dialog).getByRole('button', { name: 'Close Agent Pack dialog' });
    expect(closeButton).toBeEnabled();
    fireEvent.click(closeButton);
    expect(screen.queryByRole('dialog', { name: 'Review Agent Pack' })).not.toBeInTheDocument();
  });

  it.each([
    [
      'whole-pack conflict',
      { status: 409, code: 'AGENT_PACK_CONFLICT', message: 'raw conflict details' },
      true,
      'No agents were imported because this pack conflicts with your library.',
    ],
    [
      'retryable service outage',
      { status: 503, code: 'AGENT_PACK_IMPORT_UNAVAILABLE', message: 'raw outage details' },
      true,
      'Import is temporarily unavailable. Try again.',
    ],
    [
      'unknown network outcome',
      new Error('raw socket reset after upload'),
      false,
      'The import result is unknown. Refresh Agent Library before trying again.',
    ],
  ])('maps %s safely and never retries automatically', async (_label, error, isApi, expected) => {
    mockApi.isApiError.mockReturnValue(isApi);
    mockApi.importAgentPack.mockRejectedValueOnce(error);
    renderAgentLibrary();
    const dialog = openAgentPackPastePreview();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Import 2 Agents' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(expected);
    expect(dialog).not.toHaveTextContent(error.message);
    expect(mockApi.importAgentPack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog', { name: 'Review Agent Pack' })).toBeInTheDocument();
  });
});
