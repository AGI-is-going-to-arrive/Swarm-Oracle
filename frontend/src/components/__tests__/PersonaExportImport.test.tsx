/**
 * PersonaExportImport — ExportButton + ImportDialog test suite.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string; name?: string }) => {
      if (fallback && typeof fallback === 'object') {
        return (fallback.defaultValue ?? key).replace('{{name}}', String(fallback.name ?? ''));
      }
      return fallback ?? key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const mockExport = vi.fn();
const mockImport = vi.fn();

vi.mock('../../api/client', () => ({
  exportPersona: (...args: unknown[]) => mockExport(...args),
  importPersona: (...args: unknown[]) => mockImport(...args),
  isApiError: () => false,
}));

let mockCapEnabled = true;
vi.mock('../../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: () => ({ loading: false, enabled: mockCapEnabled, capabilities: null }),
}));

import {
  ExportButton,
  ImportDialog,
} from '../PersonaExportImport';
import { triggerJsonDownload, validatePersonaPayload } from '../personaExportImportUtils';
import type { PersonaExportPayload } from '../../api/client';

const validPayload: PersonaExportPayload = {
  schema_version: 1,
  exported_at: '2026-05-11T00:00:00Z',
  persona: {
    name: 'Aria',
    role: 'Strategist',
    persona_text: 'A quiet planner who reads three steps ahead.',
    decision_bias: { caution: 0.3, optimism: -0.1 },
    tags: ['analyst', 'calm'],
  },
};

function openPastePanel(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: /advanced: paste json content/i }));
  return screen.getByTestId('persona-paste-textarea');
}

describe('PersonaExportImport — validatePersonaPayload', () => {
  it('accepts a well-formed payload', () => {
    const result = validatePersonaPayload(validPayload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.persona.name).toBe('Aria');
      expect(result.payload.persona.tags).toEqual(['analyst', 'calm']);
    }
  });

  it('rejects payloads with schema_version != 1', () => {
    const result = validatePersonaPayload({ ...validPayload, schema_version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKey).toBe('persona_export.invalid_schema');
  });

  it('rejects payloads missing required fields', () => {
    const result = validatePersonaPayload({
      schema_version: 1,
      persona: { name: '', role: 'X', persona_text: '' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKey).toBe('persona_export.missing_fields');
  });

  it('soft-fills missing decision_bias and tags', () => {
    const result = validatePersonaPayload({
      schema_version: 1,
      persona: { name: 'A', role: 'B', persona_text: 'C' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.persona.decision_bias).toEqual({});
      expect(result.payload.persona.tags).toEqual([]);
    }
  });

  it('accepts an exported persona with empty persona_text', () => {
    const result = validatePersonaPayload({
      schema_version: 1,
      persona: { name: 'A', role: 'B', persona_text: '' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.persona.persona_text).toBe('');
    }
  });
});

describe('PersonaExportImport — triggerJsonDownload', () => {
  it('creates an anchor and clicks it for download', () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    triggerJsonDownload(validPayload, 'aria-agent-backup.json');
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });
});

describe('PersonaExportImport — ExportButton', () => {
  beforeEach(() => {
    mockCapEnabled = true;
    mockExport.mockReset();
    mockImport.mockReset();
  });
  afterEach(() => { cleanup(); });

  it('renders when capability enabled', () => {
    render(<ExportButton identityId={42} name="Aria" />);
    expect(screen.getByRole('button', { name: 'Export backup for Aria' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export backup for Aria' })).toHaveTextContent(
      'Export Backup',
    );
  });

  it('hidden when capability disabled', () => {
    mockCapEnabled = false;
    const { container } = render(<ExportButton identityId={42} name="Aria" />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('triggers download on click', async () => {
    mockExport.mockResolvedValueOnce(validPayload);
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<ExportButton identityId={42} name="Aria" />);
    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    await waitFor(() => expect(mockExport).toHaveBeenCalledWith(42));
    await waitFor(() => expect(clickSpy).toHaveBeenCalled());

    clickSpy.mockRestore();
  });

  it('shows success status after export', async () => {
    mockExport.mockResolvedValueOnce(validPayload);
    URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    render(<ExportButton identityId={1} name="Aria" />);
    fireEvent.click(screen.getByRole('button', { name: /export/i }));

    await waitFor(() => {
      expect(screen.getByText(/Agent backup exported/i)).toBeInTheDocument();
    });
  });

  it('does not expose raw export errors to the user', async () => {
    mockExport.mockRejectedValueOnce(new Error('raw upstream export failure'));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    render(<ExportButton identityId={1} name="Aria" />);
    fireEvent.click(screen.getByRole('button', { name: 'Export backup for Aria' }));

    await waitFor(() => {
      expect(screen.getByText(/Could not export Agent backup/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/raw upstream export failure/i)).not.toBeInTheDocument();

    debugSpy.mockRestore();
  });
});

describe('PersonaExportImport — ImportDialog', () => {
  beforeEach(() => {
    mockCapEnabled = true;
    mockExport.mockReset();
    mockImport.mockReset();
  });
  afterEach(() => { cleanup(); });

  it('opens as a backup creation dialog with advanced JSON paste collapsed', () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: /Create Agent from Backup/i })).toBeInTheDocument();
    expect(screen.getByText(/creates a new Agent/i)).toBeInTheDocument();
    expect(screen.getByText(/Upload a JSON backup exported from Agent Library/i)).toBeInTheDocument();
    expect(screen.getByTestId('persona-drop-zone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /advanced: paste json content/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByTestId('persona-paste-textarea')).not.toBeInTheDocument();
    openPastePanel();
    expect(screen.getByTestId('persona-paste-textarea')).toBeInTheDocument();
  });

  it('does not render when open is false', () => {
    const { container } = render(
      <ImportDialog open={false} onClose={vi.fn()} onImported={vi.fn()} />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows invalid_schema error when schema_version != 1', async () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    const textarea = openPastePanel();
    const bad = JSON.stringify({ ...validPayload, schema_version: 2 });
    fireEvent.change(textarea, { target: { value: bad } });

    const submit = screen.getByRole('button', { name: /create as new agent/i });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/backup file is not supported/i);
    });
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('shows missing_fields error when required fields absent', async () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    const textarea = openPastePanel();
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          schema_version: 1,
          persona: { name: '', role: '', persona_text: '' },
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /create as new agent/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/missing the Agent name/i);
    });
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('accepts valid JSON via textarea and calls importPersona', async () => {
    mockImport.mockResolvedValueOnce({ success: true, identity_id: 'identity-99' });
    const onImported = vi.fn();
    const onClose = vi.fn();
    render(<ImportDialog open={true} onClose={onClose} onImported={onImported} />);

    const textarea = openPastePanel();
    fireEvent.change(textarea, { target: { value: JSON.stringify(validPayload) } });
    fireEvent.click(screen.getByRole('button', { name: /create as new agent/i }));

    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    expect(mockImport).toHaveBeenCalledWith(expect.objectContaining({ schema_version: 1 }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('identity-99'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does not expose raw import errors to the user', async () => {
    mockImport.mockRejectedValueOnce(new Error('raw database import failure'));
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);

    fireEvent.change(openPastePanel(), {
      target: { value: JSON.stringify(validPayload) },
    });
    fireEvent.click(screen.getByRole('button', { name: /create as new agent/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Could not create Agent from backup/i);
    });
    expect(screen.queryByText(/raw database import failure/i)).not.toBeInTheDocument();

    debugSpy.mockRestore();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<ImportDialog open={true} onClose={onClose} onImported={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    render(<ImportDialog open={true} onClose={onClose} onImported={vi.fn()} />);
    const backdrop = screen.getByTestId('persona-import-backdrop');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('drop zone shows highlight on dragover', () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    const dropZone = screen.getByTestId('persona-drop-zone');
    fireEvent.dragOver(dropZone);
    expect(dropZone).toHaveAttribute('data-drag-active', 'true');
    fireEvent.dragLeave(dropZone);
    expect(dropZone).toHaveAttribute('data-drag-active', 'false');
  });

  it('detects invalid JSON in textarea', async () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    const textarea = openPastePanel();
    fireEvent.change(textarea, { target: { value: '{not-json' } });
    fireEvent.click(screen.getByRole('button', { name: /create as new agent/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Invalid JSON/i);
    });
  });

  it('disables submit button when textarea empty', () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    const submit = screen.getByRole('button', { name: /create as new agent/i });
    expect(submit).toBeDisabled();
  });

  it('has accessible dialog role + aria-labelledby', () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    if (labelId) {
      expect(document.getElementById(labelId)).toHaveTextContent(/Create Agent from Backup/i);
    }
  });
});
