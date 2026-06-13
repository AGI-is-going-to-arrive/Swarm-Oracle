import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ModelProfilesView from './ModelProfilesView';

// Mock react-router-dom
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, className, ...props }: { children?: React.ReactNode; to: string; className?: string }) => (
    <a href={to} className={className} {...props}>
      {children}
    </a>
  ),
}));

// Mock translation
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue || key,
    i18n: { language: 'en' },
  }),
}));

const useCapabilityCheckMock = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
}));

// Mock ModelProfileManager to avoid deeply testing it here
vi.mock('../components/ModelProfileManager', () => ({
  ModelProfileManager: () => <div data-testid="mock-profile-manager">Mock Model Profile Manager</div>,
}));

afterEach(() => {
  cleanup();
  useCapabilityCheckMock.mockReset();
});

describe('ModelProfilesView', () => {
  it('renders loading state when capability check is loading', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: true,
      enabled: false,
      error: null,
      reload: vi.fn(),
    });

    render(<ModelProfilesView />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-profile-manager')).not.toBeInTheDocument();
  });

  it('renders error state when capability check fails', () => {
    const reloadMock = vi.fn();
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: false,
      error: new Error('Capability check failed'),
      reload: reloadMock,
    });

    render(<ModelProfilesView />);
    expect(screen.getByText('Could not check model profile availability. Please retry.')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-profile-manager')).not.toBeInTheDocument();
  });

  it('renders disabled placeholder when capability is disabled', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: false,
      error: null,
      reload: vi.fn(),
    });

    render(<ModelProfilesView />);
    expect(screen.getByText('Model profiles capability is disabled.')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-profile-manager')).not.toBeInTheDocument();
  });

  it('renders ModelProfileManager when capability is enabled', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      error: null,
      reload: vi.fn(),
    });

    render(<ModelProfilesView />);
    expect(screen.getByText('Model Profiles')).toBeInTheDocument();
    expect(screen.getByTestId('mock-profile-manager')).toBeInTheDocument();
  });
});
