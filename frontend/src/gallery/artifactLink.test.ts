import { describe, expect, it } from 'vitest';

import type { PublicArtifact } from '../types';
import { MAX_ARTIFACT_BYTES } from './parseArtifact';
import {
  MAX_GALLERY_URL_CHARS,
  buildPublicArtifactLink,
  decodePublicArtifactHash,
} from './artifactLink';

function makeArtifact(overrides: Partial<PublicArtifact> = {}): PublicArtifact {
  return {
    schema_version: 'public_artifact.v1',
    question: '如果港口关闭三天，会发生什么？ 🌊',
    language: 'zh',
    display_agent_names: ['分析员 α'],
    branch_verdicts: [],
    probability_bars: [],
    transcript_excerpts: [],
    source_summary: { domains: [] },
    ...overrides,
  };
}

describe('public artifact gallery links', () => {
  it('encodes UTF-8 JSON as base64url and resolves gallery.html under Vite BASE_URL', () => {
    const artifact = makeArtifact();

    const result = buildPublicArtifactLink(artifact, {
      baseUrl: '/swarmoracle/app/',
      currentUrl: 'https://example.test/results/scenario-1?private=query',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(url.origin).toBe('https://example.test');
    expect(url.pathname).toBe('/swarmoracle/app/gallery.html');
    expect(url.search).toBe('');
    expect(url.hash).toMatch(/^#data=[A-Za-z0-9_-]+$/);
    expect(url.hash.slice('#data='.length)).not.toContain('=');

    const decoded = decodePublicArtifactHash(url.hash);
    expect(decoded).toEqual({ ok: true, json: JSON.stringify(artifact) });
  });

  it('uses the deployment root without leaking the fragment into the server URL', () => {
    const result = buildPublicArtifactLink(makeArtifact(), {
      baseUrl: '/',
      currentUrl: 'https://example.test/result/scenario-2',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.url);
    expect(`${url.origin}${url.pathname}${url.search}`).toBe('https://example.test/gallery.html');
    expect(url.hash.startsWith('#data=')).toBe(true);
    expect(result.url.length).toBeLessThanOrEqual(MAX_GALLERY_URL_CHARS);
  });

  it('returns too_large when raw UTF-8 JSON exceeds MAX_ARTIFACT_BYTES', () => {
    const artifact = makeArtifact({
      question: '界'.repeat(Math.ceil(MAX_ARTIFACT_BYTES / 3) + 1),
    });

    const result = buildPublicArtifactLink(artifact, {
      baseUrl: '/',
      currentUrl: 'https://example.test/result/scenario-3',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_large');
    expect(result.json).toBe(JSON.stringify(artifact));
  });

  it('returns too_large when the exported URL exceeds its conservative character cap', () => {
    const result = buildPublicArtifactLink(makeArtifact(), {
      baseUrl: '/nested/',
      currentUrl: 'https://example.test/result/scenario-4',
      maxUrlChars: 80,
    });

    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('round-trips near-limit raw JSON even when its base64url text exceeds the raw byte cap', () => {
    const artifact = makeArtifact({
      question: 'x'.repeat(Math.floor(MAX_ARTIFACT_BYTES * 0.8)),
    });
    const result = buildPublicArtifactLink(artifact, {
      baseUrl: '/',
      currentUrl: 'https://example.test/result/large',
      maxUrlChars: MAX_ARTIFACT_BYTES * 2,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new URL(result.url).hash.length).toBeGreaterThan(MAX_ARTIFACT_BYTES);
    const decoded = decodePublicArtifactHash(new URL(result.url).hash);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.json.length).toBe(JSON.stringify(artifact).length);
    expect((JSON.parse(decoded.json) as PublicArtifact).question).toBe(artifact.question);
  }, 15_000);

  it('returns malformed instead of throwing when serialization fails', () => {
    const artifact = makeArtifact() as PublicArtifact & { self?: unknown };
    artifact.self = artifact;

    expect(() => buildPublicArtifactLink(artifact)).not.toThrow();
    expect(buildPublicArtifactLink(artifact)).toEqual({ ok: false, reason: 'malformed' });
    expect(buildPublicArtifactLink(undefined as unknown as PublicArtifact)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects malformed and decoded-oversize hash payloads without throwing', () => {
    expect(decodePublicArtifactHash('#data=%%%')).toEqual({ ok: false, reason: 'malformed' });

    const oversizedJson = JSON.stringify({ value: 'x'.repeat(MAX_ARTIFACT_BYTES) });
    const legacyHash = `#data=${encodeURIComponent(oversizedJson)}`;
    expect(decodePublicArtifactHash(legacyHash)).toEqual({ ok: false, reason: 'too_large' });
  });
});
