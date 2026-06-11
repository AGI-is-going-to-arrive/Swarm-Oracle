import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import SnapshotImportDialog from './SnapshotImportDialog';

const { importScenarioSnapshotMock } = vi.hoisted(() => ({
  importScenarioSnapshotMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../api/client', () => ({
  importScenarioSnapshot: importScenarioSnapshotMock,
}));

describe('SnapshotImportDialog validation behavior', () => {
  beforeEach(() => {
    importScenarioSnapshotMock.mockReset();
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
