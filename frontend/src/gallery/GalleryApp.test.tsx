import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GalleryApp } from './GalleryApp';
import { parsePublicArtifact } from './parseArtifact';

const changeLanguageMock = vi.fn();
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => {
        const map: Record<string, string> = {
          'gallery.title': 'Public Artifact Gallery',
          'gallery.load_prompt': 'Select or drag a public artifact JSON file to load',
          'gallery.load_file': 'Choose File',
          'gallery.error_malformed': 'Malformed JSON file.',
          'gallery.error_unknown_version': 'Unknown schema version.',
          'gallery.error_too_large': 'Artifact size exceeds the maximum limit of {{max}} MB.',
          'gallery.empty': 'No artifact loaded.',
        };
        return map[key] ?? key;
      },
      i18n: { language: 'en', changeLanguage: changeLanguageMock },
    }),
  };
});

vi.mock('./parseArtifact', () => ({
  parsePublicArtifact: vi.fn(),
  MAX_ARTIFACT_BYTES: 2 * 1024 * 1024,
}));

describe('GalleryApp shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('renders header instructions and empty state initially', () => {
    render(<GalleryApp />);
    expect(screen.getByText('Public Artifact Gallery')).toBeInTheDocument();
    expect(screen.getByText('No artifact loaded.')).toBeInTheDocument();
  });

  it('displays malformed error banner when parse fails', async () => {
    vi.mocked(parsePublicArtifact).mockReturnValue({ ok: false, reason: 'malformed' });

    render(<GalleryApp />);
    const file = new File(['invalid json'], 'artifact.json', { type: 'application/json' });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeInTheDocument();

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Malformed JSON file.')).toBeInTheDocument();
    });
  });

  it('displays unknown version error when schema version is invalid', async () => {
    vi.mocked(parsePublicArtifact).mockReturnValue({ ok: false, reason: 'unknown_version' });

    render(<GalleryApp />);
    const file = new File(['{"schema_version": "v2"}'], 'artifact.json', { type: 'application/json' });
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Unknown schema version.')).toBeInTheDocument();
    });
  });

  it('triggers i18n changeLanguage when clicking EN/中文 buttons', () => {
    render(<GalleryApp />);
    const enButton = screen.getByRole('button', { name: 'EN' });
    const zhButton = screen.getByRole('button', { name: '中文' });

    fireEvent.click(enButton);
    expect(changeLanguageMock).toHaveBeenCalledWith('en');

    fireEvent.click(zhButton);
    expect(changeLanguageMock).toHaveBeenCalledWith('zh');
  });

  it('displays error banner when hash payload exceeds size limit and bails', async () => {
    const limit = 2 * 1024 * 1024;
    window.location.hash = '#data=' + 'x'.repeat(limit + 10);

    render(<GalleryApp />);

    await waitFor(() => {
      expect(screen.getByText('Artifact size exceeds the maximum limit of {{max}} MB.')).toBeInTheDocument();
    });

    expect(parsePublicArtifact).not.toHaveBeenCalled();
  });

  it('displays error banner when uploaded file exceeds size limit and bails', async () => {
    const limit = 2 * 1024 * 1024;
    render(<GalleryApp />);

    // Create an oversized file using Object.defineProperty to set size
    const file = new File([], 'too_large.json');
    Object.defineProperty(file, 'size', { value: limit + 10 });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText('Artifact size exceeds the maximum limit of {{max}} MB.')).toBeInTheDocument();
    });

    expect(parsePublicArtifact).not.toHaveBeenCalled();
  });
});
