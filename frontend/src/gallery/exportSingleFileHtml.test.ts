import { describe, expect, it } from 'vitest';
import { buildSingleFileGalleryHtml } from './exportSingleFileHtml';
import { PUBLIC_ARTIFACT_SCHEMA_VERSION, type PublicArtifact } from '../types';

describe('buildSingleFileGalleryHtml exporter', () => {
  const artifact: PublicArtifact = {
    schema_version: PUBLIC_ARTIFACT_SCHEMA_VERSION,
    question: 'What if Zhuge Liang lived 10 more years? </script><script>alert("XSS")</script>',
    language: 'en',
    display_agent_names: ['Zhuge Liang'],
    branch_verdicts: [
      {
        branch_index: 1,
        title: 'Shu Victory',
        verdict: 'Shu triumphs over Wei.',
        confidence: 'high',
      },
    ],
    probability_bars: [
      {
        branch_index: 1,
        label: 'Victory',
        probability: 0.8,
      },
    ],
    transcript_excerpts: [],
    source_summary: { domains: [] },
  };

  it('produces a self-contained HTML containing the inlined artifact script tag and styles', () => {
    const html = buildSingleFileGalleryHtml(artifact, 'en');

    // 1. Must contain the JSON inside a script tag
    expect(html).toContain('<script id="swarm-artifact" type="application/json">');

    // 2. Must contain inlined style block
    expect(html).toContain('<style>');

    // 3. Must escape </script> to prevent script breakout
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('<\\/script><script>');
  });

  it('does not contain any external script or stylesheet references', () => {
    const html = buildSingleFileGalleryHtml(artifact, 'en');

    // Match any script tag that uses src attribute
    const scriptSrcRegex = /<script\s+[^>]*src=["'][^"']+["']/i;
    expect(scriptSrcRegex.test(html)).toBe(false);

    // Match any link tag that references stylesheet href
    const stylesheetHrefRegex = /<link\s+[^>]*rel=["']stylesheet["']\s+[^>]*href=["'][^"']+["']/i;
    expect(stylesheetHrefRegex.test(html)).toBe(false);
  });
});
