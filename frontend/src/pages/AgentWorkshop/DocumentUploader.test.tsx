import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentUploader } from './DocumentUploader';

const uploadDocumentForAgentsMock = vi.hoisted(() => vi.fn());

vi.mock('../../api/client', () => ({
  uploadDocumentForAgents: uploadDocumentForAgentsMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

afterEach(() => {
  cleanup();
  uploadDocumentForAgentsMock.mockReset();
});

describe('DocumentUploader', () => {
  it('does not report success when the backend creates zero agents', async () => {
    uploadDocumentForAgentsMock.mockResolvedValue({
      agents_created: 0,
      agents_failed: 1,
      entities_extracted: 1,
      identities: [],
    });
    const onAgentsCreated = vi.fn();

    const { container } = render(<DocumentUploader onAgentsCreated={onAgentsCreated} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, {
      target: {
        files: [new File(['%PDF-stub'], 'agents.pdf', { type: 'application/pdf' })],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Upload and Extract' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No agents could be created from this PDF.',
    );
    expect(onAgentsCreated).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Create Agents' })).not.toBeInTheDocument();
  });
});
