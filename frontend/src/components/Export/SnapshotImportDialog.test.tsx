import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import SnapshotImportDialog from './SnapshotImportDialog';

const {
  getOfficialSamplesMock,
  importOfficialSampleMock,
  importScenarioSnapshotMock,
} = vi.hoisted(() => ({
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
  getOfficialSamples: getOfficialSamplesMock,
  importOfficialSample: importOfficialSampleMock,
  importScenarioSnapshot: importScenarioSnapshotMock,
}));

const catalog = {
  catalog_version: '1.0',
  count: 1,
  samples: [{
    id: 'sample-river-city-pact',
    question: 'What if a river city governed water through a public pact?',
    scene_theme: 'river_delta',
    title: { zh: '河城公约', en: 'The River City Pact' },
    summary: { zh: '三方水权推演', en: 'Three parties test water governance.' },
    agent_count: 3,
    outcome_count: 3,
  }],
};

describe('SnapshotImportDialog validation behavior', () => {
  beforeEach(() => {
    getOfficialSamplesMock.mockReset();
    getOfficialSamplesMock.mockResolvedValue(catalog);
    importOfficialSampleMock.mockReset();
    importScenarioSnapshotMock.mockReset();
  });

  it('imports a built-in sample with one click and navigates immediately', async () => {
    const onImported = vi.fn();
    importOfficialSampleMock.mockResolvedValue({
      scenario_id: 'imported-sample-1',
      sample_id: 'sample-river-city-pact',
      status: 'imported',
    });
    render(
      <SnapshotImportDialog
        isOpen
        onClose={() => {}}
        onImported={onImported}
      />,
    );

    expect(await screen.findByText('The River City Pact')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'snapshot.sample_use_aria' }));

    await waitFor(() => {
      expect(importOfficialSampleMock).toHaveBeenCalledWith(
        'sample-river-city-pact',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(onImported).toHaveBeenCalledWith('imported-sample-1');
    });
    expect(screen.queryByTestId('snapshot-import-view-scenario')).not.toBeInTheDocument();
  });

  it('keeps local file upload available when the built-in catalog fails and retries', async () => {
    getOfficialSamplesMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(catalog);
    render(
      <SnapshotImportDialog isOpen onClose={() => {}} onImported={() => {}} />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('snapshot.sample_catalog_failed');
    expect(screen.getByRole('button', { name: 'snapshot.import_pick_file' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'snapshot.sample_catalog_retry' }));

    expect(await screen.findByText('The River City Pact')).toBeInTheDocument();
    expect(getOfficialSamplesMock).toHaveBeenCalledTimes(2);
  });

  it('deduplicates rapid clicks while a built-in sample import is in flight', async () => {
    importOfficialSampleMock.mockImplementation(
      () => new Promise<{ scenario_id: string }>(() => undefined),
    );
    render(
      <SnapshotImportDialog isOpen onClose={() => {}} onImported={() => {}} />,
    );

    await screen.findByText('The River City Pact');
    const action = screen.getByRole('button', { name: 'snapshot.sample_use_aria' });
    fireEvent.click(action);
    fireEvent.click(action);

    expect(importOfficialSampleMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a .swarm file with empty MIME type', async () => {
    const { container } = render(
      <SnapshotImportDialog
        isOpen
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const file = new File(['fake-swarm-bytes'], 'zheng-he-americas.swarm', { type: '' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [file] } });

    expect(screen.queryByText('snapshot.import_invalid_format')).not.toBeInTheDocument();
    expect(screen.getByTestId('snapshot-import-confirm')).toBeInTheDocument();
  });

  it('accepts a .zip file with empty MIME type', async () => {
    const { container } = render(
      <SnapshotImportDialog
        isOpen
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const file = new File(['fake-zip-bytes'], 'snapshot.zip', { type: '' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [file] } });

    expect(screen.queryByText('snapshot.import_invalid_format')).not.toBeInTheDocument();
    expect(screen.getByTestId('snapshot-import-confirm')).toBeInTheDocument();
  });

  it('accepts a .zip file with application/zip MIME type', async () => {
    const { container } = render(
      <SnapshotImportDialog
        isOpen
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const file = new File(['fake-zip-bytes'], 'snapshot.zip', { type: 'application/zip' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [file] } });

    expect(screen.queryByText('snapshot.import_invalid_format')).not.toBeInTheDocument();
    expect(screen.getByTestId('snapshot-import-confirm')).toBeInTheDocument();
  });

  it('rejects a .txt file and shows invalid-format error', async () => {
    const { container } = render(
      <SnapshotImportDialog
        isOpen
        onClose={() => {}}
        onImported={() => {}}
      />,
    );
    const file = new File(['x'], 'note.txt', { type: 'text/plain' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');

    fireEvent.change(input!, { target: { files: [file] } });

    expect(screen.getByText(/snapshot\.import_invalid_format/)).toBeInTheDocument();
    expect(screen.queryByTestId('snapshot-import-confirm')).not.toBeInTheDocument();
  });
});
