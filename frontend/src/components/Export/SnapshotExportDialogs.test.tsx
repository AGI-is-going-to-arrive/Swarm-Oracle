import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SnapshotExportWizard from './SnapshotExportWizard';
import SnapshotImportDialog from './SnapshotImportDialog';

const {
  exportScenarioSnapshotMock,
  getOfficialSamplesMock,
  importOfficialSampleMock,
  importScenarioSnapshotMock,
} = vi.hoisted(() => ({
  exportScenarioSnapshotMock: vi.fn(),
  getOfficialSamplesMock: vi.fn(),
  importOfficialSampleMock: vi.fn(),
  importScenarioSnapshotMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../api/client', () => ({
  exportScenarioSnapshot: exportScenarioSnapshotMock,
  getOfficialSamples: getOfficialSamplesMock,
  importOfficialSample: importOfficialSampleMock,
  importScenarioSnapshot: importScenarioSnapshotMock,
}));

describe('Snapshot export/import dialogs', () => {
  beforeEach(() => {
    exportScenarioSnapshotMock.mockReset();
    getOfficialSamplesMock.mockReset();
    getOfficialSamplesMock.mockResolvedValue({ catalog_version: '1.0', count: 0, samples: [] });
    importOfficialSampleMock.mockReset();
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

  it('aborts an in-flight built-in sample import when the dialog unmounts', async () => {
    let requestSignal: AbortSignal | undefined;
    getOfficialSamplesMock.mockResolvedValueOnce({
      catalog_version: '1.0',
      count: 1,
      samples: [{
        id: 'sample-1',
        question: 'Question',
        scene_theme: null,
        title: { zh: '样例', en: 'Sample' },
        summary: { zh: '摘要', en: 'Summary' },
        agent_count: 3,
        outcome_count: 3,
      }],
    });
    importOfficialSampleMock.mockImplementation(
      (_sampleId: string, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        return new Promise<{ scenario_id: string }>(() => undefined);
      },
    );
    const view = render(
      <SnapshotImportDialog isOpen onClose={() => {}} onImported={() => {}} />,
    );

    await screen.findByText('Sample');
    await userEvent.click(screen.getByRole('button', { name: 'snapshot.sample_use_aria' }));
    await waitFor(() => expect(requestSignal).toBeDefined());
    view.unmount();

    expect(requestSignal?.aborted).toBe(true);
  });
});
