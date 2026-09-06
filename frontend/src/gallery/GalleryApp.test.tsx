import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GalleryApp } from './GalleryApp';
import { parsePublicArtifact } from './parseArtifact';
import { buildPublicArtifactLink } from './artifactLink';
import type { PublicArtifact } from '../types';
import galleryI18n from './galleryI18n';
import { LANGUAGE_STORAGE_KEY, resolveInitialLanguage } from '../i18n/language';

const realTranslations = vi.hoisted(() => ({ enabled: false }));

const changeLanguageMock = vi.fn();

function setWindowHash(hash: string) {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
}

class DeferredTestFileReader {
  static instances: DeferredTestFileReader[] = [];
  result: string | ArrayBuffer | null = null;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

  constructor() {
    DeferredTestFileReader.instances.push(this);
  }

  readAsText() {}

  succeed(value: string) {
    this.result = value;
    this.onload?.({ target: this } as unknown as ProgressEvent<FileReader>);
  }

  fail() {
    this.onerror?.({ target: this } as unknown as ProgressEvent<FileReader>);
  }
}

function installDeferredFileReader() {
  DeferredTestFileReader.instances = [];
  vi.stubGlobal('FileReader', DeferredTestFileReader as unknown as typeof FileReader);
  return DeferredTestFileReader.instances;
}

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => {
      const translation = actual.useTranslation();
      return realTranslations.enabled ? translation : ({
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
      });
    },
  };
});

vi.mock('./parseArtifact', () => ({
  parsePublicArtifact: vi.fn(),
  MAX_ARTIFACT_BYTES: 1024,
}));

describe('GalleryApp shell', () => {
  const artifact: PublicArtifact = {
    schema_version: 'public_artifact.v1',
    question: 'Unicode 世界线 🌏',
    language: 'zh',
    display_agent_names: ['Agent Alpha'],
    branch_verdicts: [],
    probability_bars: [],
    transcript_excerpts: [],
    source_summary: { domains: [] },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(parsePublicArtifact).mockReset();
    realTranslations.enabled = false;
    setWindowHash('');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
    const limit = 1024;
    const oversizedJson = JSON.stringify({ value: 'x'.repeat(limit) });
    setWindowHash(`#data=${encodeURIComponent(oversizedJson)}`);

    render(<GalleryApp />);

    await waitFor(() => {
      expect(screen.getByText('Artifact size exceeds the maximum limit of {{max}} MB.')).toBeInTheDocument();
    });

    expect(parsePublicArtifact).not.toHaveBeenCalled();
  });

  it('loads a new UTF-8 base64url artifact from the hash on mount', async () => {
    const link = buildPublicArtifactLink(artifact, {
      baseUrl: '/',
      currentUrl: 'https://example.test/result/scenario-1',
    });
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    setWindowHash(new URL(link.url).hash);
    vi.mocked(parsePublicArtifact).mockReturnValue({ ok: true, artifact });

    render(<GalleryApp />);

    expect(await screen.findByText('Unicode 世界线 🌏')).toBeInTheDocument();
    expect(parsePublicArtifact).toHaveBeenCalledWith(JSON.stringify(artifact));
    expect(changeLanguageMock).not.toHaveBeenCalled();
  });

  it('does not re-apply the artifact language after a manual language switch rerenders the viewer', async () => {
    setWindowHash(`#data=${encodeURIComponent(JSON.stringify(artifact))}`);
    vi.mocked(parsePublicArtifact).mockReturnValue({ ok: true, artifact });

    const { rerender } = render(<GalleryApp />);
    expect(await screen.findByText('Unicode 世界线 🌏')).toBeInTheDocument();

    changeLanguageMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'EN' }));
    expect(changeLanguageMock).toHaveBeenCalledTimes(1);
    expect(changeLanguageMock).toHaveBeenLastCalledWith('en');

    rerender(<GalleryApp />);

    expect(changeLanguageMock).toHaveBeenCalledTimes(1);
    expect(changeLanguageMock).toHaveBeenLastCalledWith('en');
  });

  it('keeps a persisted interface choice when loading opposite-language artifacts and reloading', async () => {
    realTranslations.enabled = true;
    await galleryI18n.changeLanguage('zh');
    const source = { ...artifact, language: 'en', question: 'Original English question' };
    setWindowHash(`#data=${encodeURIComponent(JSON.stringify(source))}`);
    vi.mocked(parsePublicArtifact).mockReturnValue({ ok: true, artifact: source });
    const first = render(<GalleryApp />);
    expect(await screen.findByText('Original English question')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '中文' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.lang).toBe('zh');
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh');

    fireEvent.click(screen.getByRole('button', { name: 'EN' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    first.unmount();
    await galleryI18n.changeLanguage(resolveInitialLanguage());
    render(<GalleryApp />);
    expect(screen.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Original English question')).toBeInTheDocument();
  });

  it('translates an existing import error when the interface language changes', async () => {
    realTranslations.enabled = true;
    await galleryI18n.changeLanguage('en');
    setWindowHash('#data=%%%');
    render(<GalleryApp />);
    const english = screen.getByRole('alert').textContent;
    fireEvent.click(screen.getByRole('button', { name: '中文' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).not.toBe(english));
    expect(document.documentElement.lang).toBe('zh');
    expect(parsePublicArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ['percent-encoded JSON', (json: string) => encodeURIComponent(json)],
    ['plain base64', (json: string) => btoa(json)],
  ])('keeps backward compatibility with %s hashes', async (_label, encodeLegacy) => {
    const legacyArtifact = { ...artifact, question: 'Legacy artifact', language: 'en' };
    setWindowHash(`#data=${encodeLegacy(JSON.stringify(legacyArtifact))}`);
    vi.mocked(parsePublicArtifact).mockReturnValue({ ok: true, artifact: legacyArtifact });

    render(<GalleryApp />);

    expect(await screen.findByText('Legacy artifact')).toBeInTheDocument();
    expect(parsePublicArtifact).toHaveBeenCalledWith(JSON.stringify(legacyArtifact));
  });

  it('reloads on hashchange and clears stale content when a later hash is malformed', async () => {
    const firstArtifact = { ...artifact, question: 'First artifact' };
    const secondArtifact = { ...artifact, question: 'Second artifact' };
    vi.mocked(parsePublicArtifact).mockImplementation((raw) => {
      const parsed = JSON.parse(String(raw)) as PublicArtifact;
      return {
        ok: true,
        artifact: parsed.question === firstArtifact.question ? firstArtifact : secondArtifact,
      };
    });
    setWindowHash(`#data=${encodeURIComponent(JSON.stringify(firstArtifact))}`);

    render(<GalleryApp />);
    expect(await screen.findByText('First artifact')).toBeInTheDocument();

    await act(async () => {
      setWindowHash(`#data=${encodeURIComponent(JSON.stringify(secondArtifact))}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByText('Second artifact')).toBeInTheDocument();
    expect(screen.queryByText('First artifact')).toBeNull();

    await act(async () => {
      setWindowHash('#data=%%%');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByText('Malformed JSON file.')).toBeInTheDocument();
    expect(screen.queryByText('Second artifact')).toBeNull();
  });

  it('clears the current artifact when the hash no longer contains artifact data', async () => {
    setWindowHash(`#data=${encodeURIComponent(JSON.stringify(artifact))}`);
    vi.mocked(parsePublicArtifact).mockReturnValue({ ok: true, artifact });

    render(<GalleryApp />);
    expect(await screen.findByText('Unicode 世界线 🌏')).toBeInTheDocument();

    await act(async () => {
      setWindowHash('#details');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(await screen.findByText('No artifact loaded.')).toBeInTheDocument();
    expect(screen.queryByText('Unicode 世界线 🌏')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps a newer hash artifact when an older file read completes late', async () => {
    const readers = installDeferredFileReader();

    const fileArtifact = { ...artifact, question: 'Late file artifact', language: 'en' };
    const hashArtifact = { ...artifact, question: 'New hash artifact' };
    vi.mocked(parsePublicArtifact).mockImplementation((raw) => {
      const parsed = JSON.parse(String(raw)) as PublicArtifact;
      return {
        ok: true,
        artifact: parsed.question === fileArtifact.question ? fileArtifact : hashArtifact,
      };
    });

    render(<GalleryApp />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File([JSON.stringify(fileArtifact)], 'late.json', { type: 'application/json' })] },
    });
    expect(readers).toHaveLength(1);

    await act(async () => {
      setWindowHash(`#data=${encodeURIComponent(JSON.stringify(hashArtifact))}`);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByText('New hash artifact')).toBeInTheDocument();

    act(() => {
      readers[0].succeed(JSON.stringify(fileArtifact));
    });

    expect(screen.getByText('New hash artifact')).toBeInTheDocument();
    expect(screen.queryByText('Late file artifact')).toBeNull();
    expect(parsePublicArtifact).not.toHaveBeenCalledWith(JSON.stringify(fileArtifact));
  });

  it('shows a bounded error and clears stale content when FileReader fails', async () => {
    const readers = installDeferredFileReader();
    setWindowHash(`#data=${encodeURIComponent(JSON.stringify(artifact))}`);
    vi.mocked(parsePublicArtifact).mockReturnValue({ ok: true, artifact });

    render(<GalleryApp />);
    expect(await screen.findByText('Unicode 世界线 🌏')).toBeInTheDocument();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['{}'], 'unreadable.json', { type: 'application/json' })] },
    });
    expect(readers).toHaveLength(1);

    act(() => {
      readers[0].fail();
    });

    expect(await screen.findByText('Malformed JSON file.')).toBeInTheDocument();
    expect(screen.queryByText('Unicode 世界线 🌏')).toBeNull();
  });

  it('resets the file input so the same file can be selected again', () => {
    installDeferredFileReader();
    render(<GalleryApp />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, 'value', {
      configurable: true,
      writable: true,
      value: 'C:\\fakepath\\artifact.json',
    });

    fireEvent.change(fileInput, {
      target: {
        files: [new File(['{}'], 'artifact.json', { type: 'application/json' })],
      },
    });

    expect(fileInput.value).toBe('');
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
