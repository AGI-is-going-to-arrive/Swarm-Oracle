import { describe, expect, it } from 'vitest';
import { parsePublicArtifact } from './parseArtifact';
import {
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  PUBLIC_ARTIFACT_SCHEMA_VERSION_V1,
} from '../types';
import * as fs from 'fs';
import * as path from 'path';

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
    const badVersion = { ...validArtifact, schema_version: 'public_artifact.v3' };
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

  it('accepts a strict v1 artifact and preserves its version', () => {
    const result = parsePublicArtifact({
      ...validArtifact,
      schema_version: PUBLIC_ARTIFACT_SCHEMA_VERSION_V1,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.schema_version).toBe(PUBLIC_ARTIFACT_SCHEMA_VERSION_V1);
      expect(result.artifact.branch_verdicts[0].confidence).toBe('high');
    }
  });

  it.each([
    [PUBLIC_ARTIFACT_SCHEMA_VERSION_V1, 'missing', undefined, true],
    [PUBLIC_ARTIFACT_SCHEMA_VERSION_V1, 'explicit null', null, false],
    [PUBLIC_ARTIFACT_SCHEMA_VERSION_V1, 'invalid string', 'extreme-high', false],
    [PUBLIC_ARTIFACT_SCHEMA_VERSION, 'missing', undefined, true],
    [PUBLIC_ARTIFACT_SCHEMA_VERSION, 'invalid string', 'extreme-high', false],
  ] as const)('rejects %s with %s confidence', (schemaVersion, _label, confidence, omitConfidence) => {
    const verdict: Record<string, unknown> = {
      branch_index: 1,
      title: 'Shu Han Consolidates Power',
      verdict: 'Shu forces occupy Chang\'an and stabilize the northern front.',
      confidence,
    };
    if (omitConfidence) delete verdict.confidence;

    const result = parsePublicArtifact({
      ...validArtifact,
      schema_version: schemaVersion,
      branch_verdicts: [verdict],
    });

    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts explicit null confidence in v2 without inventing a tier', () => {
    const result = parsePublicArtifact({
      ...validArtifact,
      branch_verdicts: [{ ...validArtifact.branch_verdicts[0], confidence: null }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.schema_version).toBe(PUBLIC_ARTIFACT_SCHEMA_VERSION);
      expect(result.artifact.branch_verdicts[0].confidence).toBeNull();
    }
  });

  it.each([
    [PUBLIC_ARTIFACT_SCHEMA_VERSION_V1, 'high'],
    [PUBLIC_ARTIFACT_SCHEMA_VERSION_V1, 'medium'],
    [PUBLIC_ARTIFACT_SCHEMA_VERSION_V1, 'low'],
    [PUBLIC_ARTIFACT_SCHEMA_VERSION, 'high'],
    [PUBLIC_ARTIFACT_SCHEMA_VERSION, 'medium'],
    [PUBLIC_ARTIFACT_SCHEMA_VERSION, 'low'],
  ] as const)(
    'preserves the valid confidence tier for %s (%s)',
    (schemaVersion, confidence) => {
      const result = parsePublicArtifact({
        ...validArtifact,
        schema_version: schemaVersion,
        branch_verdicts: [{ ...validArtifact.branch_verdicts[0], confidence }],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.artifact.branch_verdicts[0].confidence).toBe(confidence);
      }
    },
  );

  it('consumes the backend golden fixture successfully', () => {
    const goldenPath = path.resolve(__dirname, '../../../samples/public-artifacts/golden.v1.json');
    const goldenContent = fs.readFileSync(goldenPath, 'utf8');
    const golden = JSON.parse(goldenContent);

    const result = parsePublicArtifact(golden);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.schema_version).toBe(PUBLIC_ARTIFACT_SCHEMA_VERSION_V1);
      expect(result.artifact.transcript_excerpts).toHaveLength(2);
      result.artifact.transcript_excerpts.forEach((item) => {
        expect(typeof item.excerpt).toBe('string');
        expect(typeof item.round).toBe('number');
        expect('text' in item).toBe(false);
      });
    }
  });

  it('accepts a v2 equivalent of the v1 golden with explicit null confidence', () => {
    const goldenPath = path.resolve(__dirname, '../../../samples/public-artifacts/golden.v1.json');
    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8')) as Record<string, unknown>;
    const branchVerdicts = (golden.branch_verdicts as Record<string, unknown>[]).map((verdict) => ({
      ...verdict,
      confidence: null,
    }));

    const result = parsePublicArtifact({
      ...golden,
      schema_version: PUBLIC_ARTIFACT_SCHEMA_VERSION,
      branch_verdicts: branchVerdicts,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.schema_version).toBe(PUBLIC_ARTIFACT_SCHEMA_VERSION);
      expect(result.artifact.branch_verdicts.every((verdict) => verdict.confidence === null)).toBe(true);
    }
  });

  it('rejects transcript excerpts carrying text but no excerpt', () => {
    const malformedArtifact = {
      ...validArtifact,
      transcript_excerpts: [
        {
          branch_index: 1,
          agent_name: 'Zhuge Liang',
          text: 'The Han dynasty shall rise again.',
        },
      ],
    };
    const result = parsePublicArtifact(malformedArtifact);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('malformed');
    }
  });
});
