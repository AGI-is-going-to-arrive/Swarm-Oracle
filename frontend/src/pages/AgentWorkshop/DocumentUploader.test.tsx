import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentUploader } from './DocumentUploader';
import i18n from '../../i18n/config';

const uploadDocumentForAgentsMock = vi.hoisted(() => vi.fn());

vi.mock('../../api/client', () => ({
  uploadDocumentForAgents: uploadDocumentForAgentsMock,
}));

afterEach(() => {
  cleanup();
  uploadDocumentForAgentsMock.mockReset();
});

describe('DocumentUploader', () => {
  function selectFile(container: HTMLElement, name = '原始报告.pdf'): void {
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['%PDF-stub'], name, { type: 'application/pdf' })] },
    });
  }

  it('translates an existing backend error without resubmitting or changing the file name', async () => {
    uploadDocumentForAgentsMock.mockRejectedValueOnce({ status: 504, code: 'DOCUMENT_PDF_TIMEOUT', message: 'private provider details' });
    const view = render(<DocumentUploader />);
    selectFile(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Upload and Extract' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Document processing timed out.');
    await act(async () => { await i18n.changeLanguage('zh'); });
    expect(screen.getByRole('alert')).toHaveTextContent('文档处理超时');
    expect(screen.getByText('原始报告.pdf')).toBeInTheDocument();
    expect(screen.queryByText(/private provider details/)).not.toBeInTheDocument();
    expect(uploadDocumentForAgentsMock).toHaveBeenCalledOnce();
  });

  it('translates file validation errors and their size parameter after a language switch', async () => {
    const view = render(<DocumentUploader />);
    const file = new File(['%PDF'], 'oversized.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 26 * 1024 * 1024 });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(screen.getByRole('alert')).toHaveTextContent('25 MB');
    await act(async () => { await i18n.changeLanguage('zh'); });
    expect(screen.getByRole('alert')).toHaveTextContent('25 MB');
    expect(screen.getByRole('alert')).not.toHaveTextContent('File is larger');
    expect(uploadDocumentForAgentsMock).not.toHaveBeenCalled();
  });

  it('does not expose unknown provider error text in the primary message or diagnostics', async () => {
    uploadDocumentForAgentsMock.mockRejectedValueOnce(new Error('secret API key sk-private credential failure'));
    const view = render(<DocumentUploader />);
    selectFile(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Upload and Extract' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed. Please try again.');
    expect(screen.queryByText(/sk-private/)).not.toBeInTheDocument();
  });

  it('ignores an upload result that arrives after cancellation', async () => {
    let resolveUpload!: (result: { agents_created: number; entities_extracted: number; identities: Array<{ id: string; name: string; role: string }> }) => void;
    uploadDocumentForAgentsMock.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    const onAgentsCreated = vi.fn();
    const view = render(<DocumentUploader onAgentsCreated={onAgentsCreated} />);
    selectFile(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'Upload and Extract' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => { resolveUpload({ agents_created: 1, entities_extracted: 1, identities: [{ id: 'old', name: 'Late', role: 'Analyst' }] }); });
    await waitFor(() => expect(screen.getByRole('button', { name: /Click or press Enter to choose a PDF/ })).toBeInTheDocument());
    expect(onAgentsCreated).not.toHaveBeenCalled();
  });
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
