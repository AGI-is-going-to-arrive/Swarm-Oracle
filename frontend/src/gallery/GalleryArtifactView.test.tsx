import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GalleryArtifactView } from './GalleryArtifactView';
import { PUBLIC_ARTIFACT_SCHEMA_VERSION, type PublicArtifact } from '../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        'gallery.title': 'Public Artifact Gallery',
        'gallery.confidence_high': 'High Confidence',
        'gallery.confidence_medium': 'Medium Confidence',
        'gallery.confidence_low': 'Low Confidence',
        'gallery.probability_label': 'Probability',
        'gallery.sources_title': 'Verified Sources',
        'gallery.agents_title': 'Agent Swarm',
        'gallery.transcript_title': 'Excerpts',
        'gallery.disclaimer_public': 'Public disclaimer note.',
        'common.empty': 'None',
        'home.question_input_label': 'Simulation Question',
      };
      return map[key] ?? key;
    },
    i18n: { language: 'en', changeLanguage: vi.fn() },
  }),
}));

// Mock SafeMarkdown to keep it simple or let it render
vi.mock('../components/SafeMarkdown', () => ({
  SafeMarkdown: ({ children }: { children: string }) => <div>{children}</div>,
}));

describe('GalleryArtifactView rendering', () => {
  const artifact: PublicArtifact = {
    schema_version: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    question: 'What if Zhuge Liang lived 10 more years?',
    language: 'zh',
    display_agent_names: ['Zhuge Liang', 'Sima Yi'],
    branch_verdicts: [
      {
        branch_index: 1,
        title: 'Shu Han Consolidates Power',
        verdict: 'Shu forces occupy Chang\'an and stabilize the northern front.',
        confidence: 'high',
      },
    ],
    probability_bars: [
      {
        branch_index: 1,
        label: 'Northern Triumph',
        probability: 0.75,
      },
    ],
    transcript_excerpts: [
      {
        branch_index: 1,
        agent_name: 'Zhuge Liang',
        excerpt: 'The Han dynasty shall rise again.',
        round: 1,
      },
    ],
    source_summary: {
      domains: [
        {
          domain: 'reuters.com',
          source_count: 3,
        },
      ],
    },
  };

  it('renders the question, agents, branch outcomes, probabilities, and sources', () => {
    render(<GalleryArtifactView artifact={artifact} />);

    // Check Question
    expect(screen.getByText('What if Zhuge Liang lived 10 more years?')).toBeInTheDocument();

    // Check Agent Swarm
    expect(screen.getByText('Zhuge Liang')).toBeInTheDocument();
    expect(screen.getByText('Sima Yi')).toBeInTheDocument();

    // Check Branch Verdict & Label
    expect(screen.getByText('Northern Triumph')).toBeInTheDocument();
    expect(screen.getByText("Shu forces occupy Chang'an and stabilize the northern front.")).toBeInTheDocument();

    // Check Confidence Badge
    expect(screen.getByText('High Confidence')).toBeInTheDocument();

    // Check Sources
    expect(screen.getByText('reuters.com')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();

    // Check Excerpts
    expect(screen.getByText('The Han dynasty shall rise again.')).toBeInTheDocument();
    expect(screen.getByText('R1')).toBeInTheDocument();
  });

  it('degrades gracefully with empty arrays', () => {
    const emptyArtifact: PublicArtifact = {
      schema_version: PUBLIC_ARTIFACT_SCHEMA_VERSION,
      question: 'Empty Scenario Question?',
      language: 'en',
      display_agent_names: [],
      branch_verdicts: [],
      probability_bars: [],
      transcript_excerpts: [],
      source_summary: { domains: [] },
    };

    render(<GalleryArtifactView artifact={emptyArtifact} />);

    expect(screen.getByText('Empty Scenario Question?')).toBeInTheDocument();
    // Expecting empty placeholders to render 'None'
    const noneElements = screen.getAllByText('None');
    expect(noneElements.length).toBeGreaterThanOrEqual(1);
  });

  it('contains proper progressbar accessibility attributes', () => {
    render(<GalleryArtifactView artifact={artifact} />);

    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).toBeInTheDocument();
    expect(progressbar).toHaveAttribute('aria-valuenow', '75');
    expect(progressbar).toHaveAttribute('aria-valuemin', '0');
    expect(progressbar).toHaveAttribute('aria-valuemax', '100');
  });

  it('keeps the verdict visible but omits the confidence badge when confidence is null', () => {
    const nullConfidenceArtifact: PublicArtifact = {
      ...artifact,
      branch_verdicts: [{
        ...artifact.branch_verdicts[0],
        verdict: 'The branch verdict remains available without a model rating.',
        confidence: null,
      }],
    };

    const { container } = render(<GalleryArtifactView artifact={nullConfidenceArtifact} />);

    expect(screen.getByText('The branch verdict remains available without a model rating.')).toBeInTheDocument();
    expect(container.querySelector('.confidence-badge')).toBeNull();
    expect(screen.queryByText('Low Confidence')).not.toBeInTheDocument();
    expect(screen.queryByText('Medium Confidence')).not.toBeInTheDocument();
    expect(screen.queryByText('High Confidence')).not.toBeInTheDocument();
  });

  it.each([
    ['high', 'High Confidence'],
    ['medium', 'Medium Confidence'],
    ['low', 'Low Confidence'],
  ] as const)('renders the existing %s confidence tier', (confidence, label) => {
    render(
      <GalleryArtifactView
        artifact={{
          ...artifact,
          branch_verdicts: [{ ...artifact.branch_verdicts[0], confidence }],
        }}
      />,
    );

    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
