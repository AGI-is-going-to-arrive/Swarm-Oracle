/**
 * PersonaExportImport — ExportButton + ImportDialog test suite.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
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

    triggerJsonDownload(validPayload, 'aria-persona.json');
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
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument();
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
      expect(screen.getByText(/persona exported/i)).toBeInTheDocument();
    });
  });
});

describe('PersonaExportImport — ImportDialog', () => {
  beforeEach(() => {
    mockCapEnabled = true;
    mockExport.mockReset();
    mockImport.mockReset();
  });
  afterEach(() => { cleanup(); });

  it('opens and shows drop zone + paste field', () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('persona-drop-zone')).toBeInTheDocument();
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
    const textarea = screen.getByTestId('persona-paste-textarea');
    const bad = JSON.stringify({ ...validPayload, schema_version: 2 });
    fireEvent.change(textarea, { target: { value: bad } });

    const submit = screen.getByRole('button', { name: /^import$/i });
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/schema_version must be 1/i);
    });
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('shows missing_fields error when required fields absent', async () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    const textarea = screen.getByTestId('persona-paste-textarea');
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          schema_version: 1,
          persona: { name: '', role: '', persona_text: '' },
        }),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Missing required fields/i);
    });
    expect(mockImport).not.toHaveBeenCalled();
  });

  it('accepts valid JSON via textarea and calls importPersona', async () => {
    mockImport.mockResolvedValueOnce({ success: true, identity_id: 'identity-99' });
    const onImported = vi.fn();
    const onClose = vi.fn();
    render(<ImportDialog open={true} onClose={onClose} onImported={onImported} />);

    const textarea = screen.getByTestId('persona-paste-textarea');
    fireEvent.change(textarea, { target: { value: JSON.stringify(validPayload) } });
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => expect(mockImport).toHaveBeenCalledTimes(1));
    expect(mockImport).toHaveBeenCalledWith(expect.objectContaining({ schema_version: 1 }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('identity-99'));
    expect(onClose).toHaveBeenCalled();
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
    const textarea = screen.getByTestId('persona-paste-textarea');
    fireEvent.change(textarea, { target: { value: '{not-json' } });
    fireEvent.click(screen.getByRole('button', { name: /^import$/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Invalid JSON/i);
    });
  });

  it('disables submit button when textarea empty', () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    const submit = screen.getByRole('button', { name: /^import$/i });
    expect(submit).toBeDisabled();
  });

  it('has accessible dialog role + aria-labelledby', () => {
    render(<ImportDialog open={true} onClose={vi.fn()} onImported={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    if (labelId) {
      expect(document.getElementById(labelId)).toHaveTextContent(/Import Agent Persona/i);
    }
  });
});
