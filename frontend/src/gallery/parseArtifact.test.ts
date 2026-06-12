import { describe, expect, it } from 'vitest';
import { parsePublicArtifact } from './parseArtifact';
import { PUBLIC_ARTIFACT_SCHEMA_VERSION } from '../types';

describe('parsePublicArtifact runtime validator', () => {
  const validArtifact = {
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
        text: 'The Han dynasty shall rise again.',
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

  it('validates a valid public artifact JSON and returns ok: true', () => {
    const result = parsePublicArtifact(JSON.stringify(validArtifact));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.question).toBe(validArtifact.question);
      expect(result.artifact.schema_version).toBe(PUBLIC_ARTIFACT_SCHEMA_VERSION);
      expect(result.artifact.display_agent_names).toEqual(validArtifact.display_agent_names);
      expect(result.artifact.branch_verdicts).toEqual(validArtifact.branch_verdicts);
      expect(result.artifact.probability_bars).toEqual(validArtifact.probability_bars);
      expect(result.artifact.transcript_excerpts).toEqual(validArtifact.transcript_excerpts);
      expect(result.artifact.source_summary.domains).toEqual(validArtifact.source_summary.domains);
    }
  });

  it('validates a pre-parsed valid public artifact object and returns ok: true', () => {
    const result = parsePublicArtifact(validArtifact);
    expect(result.ok).toBe(true);
  });

  it('returns ok: false for malformed JSON strings', () => {
    const result = parsePublicArtifact('{ invalid json: ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed');
    }
  });

  it('returns ok: false for non-object payloads', () => {
    expect(parsePublicArtifact(123).ok).toBe(false);
    expect(parsePublicArtifact('just string').ok).toBe(false);
    expect(parsePublicArtifact(null).ok).toBe(false);
    expect(parsePublicArtifact([]).ok).toBe(false);
  });

  it('returns ok: false and unknown_version for wrong schema versions', () => {
    const badVersion = { ...validArtifact, schema_version: 'public_artifact.v2' };
    const result = parsePublicArtifact(badVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_version');
    }
  });

  it('ignores extra fields not in the whitelist', () => {
    const extraFields = {
      ...validArtifact,
      extra_secrets: 'should_be_ignored',
      some_other_key: 12345,
    };
    const result = parsePublicArtifact(extraFields);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const artifactObj: Record<string, unknown> = { ...result.artifact };
      expect(artifactObj.extra_secrets).toBeUndefined();
      expect(artifactObj.some_other_key).toBeUndefined();
    }
  });

  it('truncates display_agent_names list exceeding 12 items', () => {
    const longAgents = Array.from({ length: 20 }, (_, i) => `Agent ${i}`);
    const input = { ...validArtifact, display_agent_names: longAgents };
    const result = parsePublicArtifact(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.display_agent_names).toHaveLength(12);
      expect(result.artifact.display_agent_names[11]).toBe('Agent 11');
    }
  });

  it('truncates branch_verdicts list exceeding 8 items', () => {
    const longVerdicts = Array.from({ length: 15 }, (_, i) => ({
      branch_index: i + 1,
      title: `Branch ${i + 1}`,
      verdict: `Verdict ${i + 1}`,
      confidence: 'medium',
    }));
    const input = { ...validArtifact, branch_verdicts: longVerdicts };
    const result = parsePublicArtifact(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.branch_verdicts).toHaveLength(8);
    }
  });

  it('clamps probability to the range [0, 1]', () => {
    const probBars = [
      { branch_index: 1, label: 'High', probability: 1.5 },
      { branch_index: 2, label: 'Low', probability: -0.2 },
    ];
    const input = { ...validArtifact, probability_bars: probBars };
    const result = parsePublicArtifact(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.probability_bars[0].probability).toBe(1.0);
      expect(result.artifact.probability_bars[1].probability).toBe(0.0);
    }
  });

  it('clamps invalid confidence to low', () => {
    const badConfidence = [
      {
        branch_index: 1,
        title: 'Shu Han Consolidates Power',
        verdict: 'Shu forces occupy Chang\'an and stabilize the northern front.',
        confidence: 'extreme-high', // invalid
      },
    ];
    const input = { ...validArtifact, branch_verdicts: badConfidence };
    const result = parsePublicArtifact(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.branch_verdicts[0].confidence).toBe('low');
    }
  });
});
