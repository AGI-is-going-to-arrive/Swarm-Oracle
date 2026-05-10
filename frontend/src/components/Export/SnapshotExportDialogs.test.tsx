import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SnapshotExportWizard from './SnapshotExportWizard';
import SnapshotImportDialog from './SnapshotImportDialog';

const { exportScenarioSnapshotMock, importScenarioSnapshotMock } = vi.hoisted(() => ({
  exportScenarioSnapshotMock: vi.fn(),
  importScenarioSnapshotMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../api/client', () => ({
  exportScenarioSnapshot: exportScenarioSnapshotMock,
  importScenarioSnapshot: importScenarioSnapshotMock,
}));

describe('Snapshot export/import dialogs', () => {
  beforeEach(() => {
    exportScenarioSnapshotMock.mockReset();
    importScenarioSnapshotMock.mockReset();
  });

  it('aborts an in-flight export request when the wizard unmounts', async () => {
    let requestSignal: AbortSignal | undefined;
    exportScenarioSnapshotMock.mockImplementation(
      (_scenarioId: string, _includePrivate: boolean, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        return new Promise<Blob>(() => undefined);
      },
    );
    const view = render(
      <SnapshotExportWizard
        scenarioId="scenario-export"
        isOpen
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByTestId('snapshot-export-start'));

    await waitFor(() => {
      expect(requestSignal).toBeDefined();
    });
    view.unmount();

    expect(requestSignal?.aborted).toBe(true);
  });

  it('keeps the hidden import input out of tab order behind a visible button', () => {
    const { container } = render(
      <SnapshotImportDialog
        isOpen
        onClose={() => {}}
        onImported={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'snapshot.import_pick_file' })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toHaveAttribute('tabindex', '-1');
  });

  it('rejects files above the backend import cap before calling the API', async () => {
    const { container } = render(
      <SnapshotImportDialog
        isOpen
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const file = new File(['zip'], 'large.zip', { type: 'application/zip' });
    Object.defineProperty(file, 'size', {
      configurable: true,
      value: 50 * 1024 * 1024 + 1,
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [file] } });

    expect(await screen.findByText(/snapshot\.import_file_too_large/)).toBeInTheDocument();
    expect(importScenarioSnapshotMock).not.toHaveBeenCalled();
  });

  it('aborts an in-flight import request when the dialog unmounts', async () => {
    let requestSignal: AbortSignal | undefined;
    importScenarioSnapshotMock.mockImplementation(
      (_file: File, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        return new Promise<{ scenario_id: string }>(() => undefined);
      },
    );
    const { container, unmount } = render(
      <SnapshotImportDialog
        isOpen
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    fireEvent.change(input!, {
      target: {
        files: [new File(['zip'], 'snapshot.zip', { type: 'application/zip' })],
      },
    });

    await userEvent.click(screen.getByTestId('snapshot-import-confirm'));

    await waitFor(() => {
      expect(requestSignal).toBeDefined();
    });
    unmount();

    expect(requestSignal?.aborted).toBe(true);
  });
});
