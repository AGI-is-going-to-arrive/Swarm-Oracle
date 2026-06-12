import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentSeedPanel } from './DocumentSeedPanel';
import type { WorldContext, DocumentSeedResponse } from '../types';

const useCapabilityCheckMock = vi.hoisted(() => vi.fn());
const uploadDocumentSeedMock = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useCapabilityCheck', () => ({
  useCapabilityCheck: useCapabilityCheckMock,
}));

vi.mock('../api/client', () => ({
  uploadDocumentSeed: uploadDocumentSeedMock,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

afterEach(() => {
  cleanup();
  useCapabilityCheckMock.mockReset();
  uploadDocumentSeedMock.mockReset();
});

const mockWorldContext: WorldContext = {
  title: ' Zheng He Discovered America First ',
  summary: ' Zheng He sailed to the Americas in 1421. ',
  key_entities: [
    {
      name: ' Zheng He ',
      role: ' Admiral ',
      traits: [' Brave ', ' Navigator '],
      perspective: ' Confident in exploration ',
    },
  ],
  constraints: [' Must keep history intact '],
  evidence_snippets: [' Snippet 1: Chinese maps '],
  source_metadata: {
    filename: 'zhenghe.pdf',
    content_type: 'application/pdf',
    suffix: 'pdf',
    byte_count: 1024,
    char_count: 500,
    extraction_method: 'pdf',
  },
  warnings: [' Warning: Length exceeds context window '],
};

const mockSeedResponse: DocumentSeedResponse = {
  world_context: mockWorldContext,
  agents_preview: [
    {
      name: ' Emperor Zhu Di ',
      role: ' Ruler ',
      persona: ' Royal persona details ',
    },
  ],
  entities_extracted: 1,
  agents_failed: 0,
  source: mockWorldContext.source_metadata,
  warnings: [' Top-level warning '],
};

describe('DocumentSeedPanel', () => {
  it('renders disabled state message when capability is disabled', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: false,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    render(
      <DocumentSeedPanel
        worldContext={null}
        setWorldContext={vi.fn()}
        agentsPreview={null}
        setAgentsPreview={vi.fn()}
      />
    );

    expect(
      screen.getByText('Document seeding is disabled. Check capability settings.')
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Choose a document to seed world context')
    ).not.toBeInTheDocument();
  });

  it('renders dropzone when capability is enabled and no worldContext is seeded', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    render(
      <DocumentSeedPanel
        worldContext={null}
        setWorldContext={vi.fn()}
        agentsPreview={null}
        setAgentsPreview={vi.fn()}
      />
    );

    expect(
      screen.getByLabelText('Choose a document to seed world context')
    ).toBeInTheDocument();
  });

  it('handles successful upload and triggers processFile correctly', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    uploadDocumentSeedMock.mockResolvedValue(mockSeedResponse);

    const setWorldContext = vi.fn();
    const setAgentsPreview = vi.fn();

    const { container } = render(
      <DocumentSeedPanel
        worldContext={null}
        setWorldContext={setWorldContext}
        agentsPreview={null}
        setAgentsPreview={setAgentsPreview}
      />
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['dummy-text'], 'history.txt', { type: 'text/plain' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(uploadDocumentSeedMock).toHaveBeenCalledWith(file, expect.any(AbortSignal));
    });

    expect(setWorldContext).toHaveBeenCalledWith(mockWorldContext);
    expect(setAgentsPreview).toHaveBeenCalledWith(mockSeedResponse.agents_preview);
  });

  it('displays generic error message on upload failure and does not leak raw details', async () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    uploadDocumentSeedMock.mockRejectedValue(new Error('Internal Database Error Stack Trace'));

    const { container } = render(
      <DocumentSeedPanel
        worldContext={null}
        setWorldContext={vi.fn()}
        agentsPreview={null}
        setAgentsPreview={vi.fn()}
      />
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['dummy-text'], 'history.txt', { type: 'text/plain' });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Document parsing failed, please try a different file.'
      );
    });

    expect(screen.queryByText('Internal Database Error Stack Trace')).not.toBeInTheDocument();
  });

  it('renders seeded worldContext summary and agent previews correctly', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    render(
      <DocumentSeedPanel
        worldContext={mockWorldContext}
        setWorldContext={vi.fn()}
        agentsPreview={mockSeedResponse.agents_preview}
        setAgentsPreview={vi.fn()}
      />
    );

    // Metadata & Summary Text
    expect(screen.getByText('zhenghe.pdf')).toBeInTheDocument();
    expect(screen.getByText('1.0 KB')).toBeInTheDocument();
    expect(screen.getByText('pdf')).toBeInTheDocument();
    expect(screen.getByText('Zheng He Discovered America First')).toBeInTheDocument();
    expect(screen.getByText('Zheng He sailed to the Americas in 1421.')).toBeInTheDocument();

    // Constraints & Snippets
    expect(screen.getByText('Must keep history intact')).toBeInTheDocument();
    expect(screen.getByText('Snippet 1: Chinese maps')).toBeInTheDocument();

    // Key Entity Card
    expect(screen.getByText('Zheng He')).toBeInTheDocument();
    expect(screen.getByText('Admiral')).toBeInTheDocument();
    expect(screen.getByText('Brave')).toBeInTheDocument();
    expect(screen.getByText('Navigator')).toBeInTheDocument();
    expect(screen.getByText('Confident in exploration')).toBeInTheDocument();

    // Agents Swarm Preview
    expect(screen.getByText('Emperor Zhu Di')).toBeInTheDocument();
    expect(screen.getByText('Ruler')).toBeInTheDocument();
    expect(screen.getByText('Royal persona details')).toBeInTheDocument();

    // Budget warnings
    expect(screen.getByText('Warning: Length exceeds context window')).toBeInTheDocument();
  });

  it('triggers setWorldContext(null) on clicking Remove', () => {
    useCapabilityCheckMock.mockReturnValue({
      loading: false,
      enabled: true,
      capabilities: null,
      error: null,
      reload: vi.fn(),
    });

    const setWorldContext = vi.fn();
    const setAgentsPreview = vi.fn();

    render(
      <DocumentSeedPanel
        worldContext={mockWorldContext}
        setWorldContext={setWorldContext}
        agentsPreview={mockSeedResponse.agents_preview}
        setAgentsPreview={setAgentsPreview}
      />
    );

    const removeBtn = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(removeBtn);

    expect(setWorldContext).toHaveBeenCalledWith(null);
    expect(setAgentsPreview).toHaveBeenCalledWith(null);
  });
});
