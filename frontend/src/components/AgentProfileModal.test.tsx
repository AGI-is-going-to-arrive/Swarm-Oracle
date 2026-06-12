/**
 * P1-1 — AgentProfileModal tests
 */
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Link: ({ children, to, ...props }: any) => <a href={to} {...props}>{children}</a>,
}));

// Stable function reference — avoids infinite re-render loop when `t` is
// used as a dependency in useCallback (AgentProfileModal.fetchData depends on [t]).
const stableT = (key: string, fallback?: string) => fallback ?? key;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: stableT,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const mockGetIdentityMemory = vi.fn();
const mockGetIdentityGrowthEvents = vi.fn();

vi.mock('../api/client', () => ({
  getIdentityMemory: (...args: unknown[]) => mockGetIdentityMemory(...args),
  getIdentityGrowthEvents: (...args: unknown[]) => mockGetIdentityGrowthEvents(...args),
}));

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({ loading: false, enabled: true }),
}));

import type { AgentIdentityInfo } from '../types';
import { AgentProfileModal } from './AgentProfileModal';

// HTMLDialogElement stubs for jsdom
beforeEach(() => {
  mockGetIdentityMemory.mockResolvedValue({ identity_id: '1', memories: [] });
  mockGetIdentityGrowthEvents.mockResolvedValue({ identity_id: '1', events: [] });

  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const baseIdentity: AgentIdentityInfo = {
  id: 'id-001',
  user_id: 'user-1',
  kind: 'generated',
  display_name: 'Oracle Alpha',
  role: 'Economist',
  persona: 'A seasoned macroeconomist with contrarian views.',
  decision_bias_json: null,
  knowledge_domain_json: JSON.stringify(['economics', 'politics']),
  continuity_key: 'abc123def456',
  created_at: '2026-04-01T00:00:00Z',
  updated_at: '2026-04-01T00:00:00Z',
};

describe('AgentProfileModal', () => {
  it('renders empty dialog when identity is null', () => {
    const { container } = render(
      <AgentProfileModal identity={null} open={false} onClose={vi.fn()} />,
    );
    const dialog = container.querySelector('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog?.children.length).toBe(0);
  });

  it('opens dialog when open=true and identity is provided', async () => {
    render(<AgentProfileModal identity={baseIdentity} open={true} onClose={vi.fn()} />);
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText('Oracle Alpha')).toBeInTheDocument();
    });
  });

  it('falls back to the open attribute when showModal is unavailable', async () => {
    // @ts-expect-error test-only legacy browser fallback
    HTMLDialogElement.prototype.showModal = undefined;

    const { container } = render(<AgentProfileModal identity={baseIdentity} open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Oracle Alpha')).toBeInTheDocument();
    });
    expect(container.querySelector('dialog')).toHaveAttribute('open');
  });

  it('displays identity info (name, role, kind, persona, domains)', async () => {
    render(<AgentProfileModal identity={baseIdentity} open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Oracle Alpha')).toBeInTheDocument();
      expect(screen.getByText('Economist')).toBeInTheDocument();
      expect(screen.getByText('Generated')).toBeInTheDocument();
      expect(screen.getByText('A seasoned macroeconomist with contrarian views.')).toBeInTheDocument();
      expect(screen.getByText('economics')).toBeInTheDocument();
      expect(screen.getByText('politics')).toBeInTheDocument();
    });
  });

  it('shows continuity key and creation date', async () => {
    render(<AgentProfileModal identity={baseIdentity} open={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/abc123def456/)).toBeInTheDocument();
    });
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    render(<AgentProfileModal identity={baseIdentity} open={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('Oracle Alpha')).toBeInTheDocument();
    });

    const closeBtn = screen.getByLabelText('Close');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows loading state while fetching data', async () => {
    mockGetIdentityMemory.mockReturnValueOnce(
      new Promise(() => { /* intentionally never resolves */ }),
    );
    mockGetIdentityGrowthEvents.mockReturnValueOnce(
      new Promise(() => { /* intentionally never resolves */ }),
    );

    render(<AgentProfileModal identity={baseIdentity} open={true} onClose={vi.fn()} />);

    expect(await screen.findByText('Loading...')).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    mockGetIdentityMemory.mockRejectedValueOnce(new Error('Network error'));
    mockGetIdentityGrowthEvents.mockRejectedValueOnce(new Error('Network error'));

    render(<AgentProfileModal identity={baseIdentity} open={true} onClose={vi.fn()} />);

    const errorMsg = await screen.findByRole('alert');
    expect(errorMsg).toBeInTheDocument();
    expect(errorMsg.textContent).toContain('Failed to load agent data.');
  });

  it('renders MemoryTimeline with fetched data', async () => {
    mockGetIdentityMemory.mockResolvedValueOnce({
      identity_id: 'id-001',
      memories: [
        { summary: 'Remembers the great crash', scenario_id: 'sc1', created_at: '2026-04-01T10:00:00Z' },
      ],
    });
    mockGetIdentityGrowthEvents.mockResolvedValueOnce({
      identity_id: 'id-001',
      events: [
        {
          id: 'ev1', scenario_id: 'sc1', branch_id: 'b1',
          round_number: 2, event_type: 'stance_shift',
          summary: 'Shifted stance on monetary policy',
          metrics_json: null, created_at: '2026-04-01T11:00:00Z',
        },
      ],
    });

    render(<AgentProfileModal identity={baseIdentity} open={true} onClose={vi.fn()} />);

    expect(await screen.findByText('Remembers the great crash')).toBeInTheDocument();
    expect(screen.getByText('Shifted stance on monetary policy')).toBeInTheDocument();
  });

  it('renders custom kind badge for custom agents', async () => {
    const customIdentity: AgentIdentityInfo = {
      ...baseIdentity,
      kind: 'custom',
      display_name: 'User Agent',
    };
    render(<AgentProfileModal identity={customIdentity} open={true} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Custom')).toBeInTheDocument();
    });
  });

  it('handles missing persona gracefully', async () => {
    const noPersIdentity: AgentIdentityInfo = {
      ...baseIdentity,
      persona: null,
    };
    render(<AgentProfileModal identity={noPersIdentity} open={true} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Oracle Alpha')).toBeInTheDocument();
    });
    expect(screen.queryByText('Persona')).not.toBeInTheDocument();
  });

  it('handles invalid knowledge_domain_json gracefully', async () => {
    const badDomainIdentity: AgentIdentityInfo = {
      ...baseIdentity,
      knowledge_domain_json: 'not-valid-json',
    };
    render(<AgentProfileModal identity={badDomainIdentity} open={true} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Oracle Alpha')).toBeInTheDocument();
    });
    expect(screen.queryByText('Knowledge Domains')).not.toBeInTheDocument();
  });

  it('ignores stale memory responses after switching identities', async () => {
    let resolveFirstMemory!: (value: unknown) => void;
    let resolveFirstEvents!: (value: unknown) => void;
    const secondIdentity: AgentIdentityInfo = {
      ...baseIdentity,
      id: 'id-002',
      display_name: 'Oracle Beta',
    };

    mockGetIdentityMemory.mockImplementation((id: string) => {
      if (id === 'id-001') {
        return new Promise((resolve) => {
          resolveFirstMemory = resolve;
        });
      }
      return Promise.resolve({
        identity_id: 'id-002',
        memories: [
          { summary: 'Beta memory', scenario_id: 'sc2', created_at: '2026-04-02T10:00:00Z' },
        ],
      });
    });
    mockGetIdentityGrowthEvents.mockImplementation((id: string) => {
      if (id === 'id-001') {
        return new Promise((resolve) => {
          resolveFirstEvents = resolve;
        });
      }
      return Promise.resolve({ identity_id: 'id-002', events: [] });
    });

    const { rerender } = render(
      <AgentProfileModal identity={baseIdentity} open={true} onClose={vi.fn()} />,
    );
    await waitFor(() => {
      expect(mockGetIdentityMemory).toHaveBeenCalledWith('id-001');
    });
    rerender(<AgentProfileModal identity={secondIdentity} open={true} onClose={vi.fn()} />);

    expect(await screen.findByText('Oracle Beta')).toBeInTheDocument();
    expect(await screen.findByText('Beta memory')).toBeInTheDocument();

    resolveFirstMemory({
      identity_id: 'id-001',
      memories: [
        { summary: 'Stale Alpha memory', scenario_id: 'sc1', created_at: '2026-04-01T10:00:00Z' },
      ],
    });
    resolveFirstEvents({ identity_id: 'id-001', events: [] });

    await waitFor(() => {
      expect(screen.queryByText('Stale Alpha memory')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Beta memory')).toBeInTheDocument();
  });

  it('ignores non-array and non-string knowledge domain entries', async () => {
    const objectDomainIdentity: AgentIdentityInfo = {
      ...baseIdentity,
      knowledge_domain_json: JSON.stringify({ primary: 'economics' }),
    };
    const { rerender } = render(
      <AgentProfileModal identity={objectDomainIdentity} open={true} onClose={vi.fn()} />,
    );
    await waitFor(() => {
      expect(screen.getByText('Oracle Alpha')).toBeInTheDocument();
    });
    expect(screen.queryByText('Knowledge Domains')).not.toBeInTheDocument();

    rerender(
      <AgentProfileModal
        identity={{
          ...baseIdentity,
          knowledge_domain_json: JSON.stringify(['economics', null, { name: 'politics' }]),
        }}
        open={true}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText('economics')).toBeInTheDocument();
    expect(screen.queryByText('[object Object]')).not.toBeInTheDocument();
  });

  it('renders View memory inspector link when identity id is present', async () => {
    render(
      <AgentProfileModal identity={baseIdentity} open={true} onClose={vi.fn()} />
    );

    await waitFor(() => {
      const link = screen.getByTestId('agent-profile-modal-inspector');
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', '/agents/identities/id-001/memories');
      expect(link.textContent).toBe('View memory inspector');
    });
  });
});
