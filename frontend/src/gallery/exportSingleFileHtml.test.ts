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

  function renderExportedArtifact(exportArtifact: PublicArtifact): Document {
    const html = buildSingleFileGalleryHtml(exportArtifact, 'en');
    const documentNode = new DOMParser().parseFromString(html, 'text/html');
    const renderer = [...documentNode.querySelectorAll('script')]
      .find((script) => script.id !== 'swarm-artifact');
    expect(renderer?.textContent).toBeTruthy();
    new Function('document', renderer?.textContent ?? '')(documentNode);
    return documentNode;
  }

  it('produces a self-contained HTML containing the inlined artifact script tag and styles', () => {
    const html = buildSingleFileGalleryHtml(artifact, 'en');

    // 1. Must contain the JSON inside a script tag
    expect(html).toContain('<script id="swarm-artifact" type="application/json">');

    // 2. Must contain inlined style block
    expect(html).toContain('<style>');

    // 3. Must escape </script> to prevent script breakout
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('\\u003c/script>\\u003cscript>');
  });

  it('prevents script breakout with custom vectors and maintains round-trip lossless parsing', () => {
    const xssArtifact: PublicArtifact = {
      schema_version: PUBLIC_ARTIFACT_SCHEMA_VERSION,
      question: 'Test </script >alert(1) </script\t> </ScRiPt> <!--',
      language: 'en',
      display_agent_names: ['Zhuge Liang'],
      branch_verdicts: [],
      probability_bars: [],
      transcript_excerpts: [
        {
          branch_index: 1,
          round: 1,
          agent_name: 'Zhuge Liang',
          excerpt: 'Vector: </script >alert(1) <!--',
        },
      ],
      source_summary: { domains: [] },
    };

    const html = buildSingleFileGalleryHtml(xssArtifact, 'en');

    // Extract JSON data block inside <script id="swarm-artifact" type="application/json">...</script>
    const startTag = '<script id="swarm-artifact" type="application/json">';
    const endTag = '</script>';
    const startIndex = html.indexOf(startTag);
    expect(startIndex).not.toBe(-1);
    const jsonStart = startIndex + startTag.length;
    const jsonEnd = html.indexOf(endTag, jsonStart);
    expect(jsonEnd).not.toBe(-1);

    const jsonSub = html.substring(jsonStart, jsonEnd);

    // Assert: (a) /<\/script/i has ZERO matches inside that data block
    expect(/<\/script/i.test(jsonSub)).toBe(false);

    // Assert: (b) there is NO bare < inside that data block
    expect(jsonSub.includes('<')).toBe(false);

    // Assert: (c) JSON.parse of the unescaped block yields question byte-equal to original
    const parsed = JSON.parse(jsonSub) as PublicArtifact;
    expect(parsed.question).toBe(xssArtifact.question);
    expect(parsed.transcript_excerpts[0].excerpt).toBe(xssArtifact.transcript_excerpts[0].excerpt);
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

  it('keeps the verdict visible but omits confidence copy when confidence is null', () => {
    const documentNode = renderExportedArtifact({
      ...artifact,
      branch_verdicts: [{
        ...artifact.branch_verdicts[0],
        verdict: 'The exported verdict remains visible without a model rating.',
        confidence: null,
      }],
    });

    expect(documentNode.querySelector('.verdict-box')?.textContent).toBe(
      'The exported verdict remains visible without a model rating.',
    );
    expect(documentNode.querySelector('.confidence-badge')).toBeNull();
  });

  it.each([
    ['high', 'High Confidence'],
    ['medium', 'Medium Confidence'],
    ['low', 'Low Confidence'],
  ] as const)('renders the existing %s confidence tier in exported HTML', (confidence, label) => {
    const documentNode = renderExportedArtifact({
      ...artifact,
      branch_verdicts: [{ ...artifact.branch_verdicts[0], confidence }],
    });

    expect(documentNode.querySelector('.confidence-badge')?.textContent).toBe(label);
  });

  it('renders a strict v1 artifact as well as the current v2 contract', () => {
    const documentNode = renderExportedArtifact({
      ...artifact,
      schema_version: 'public_artifact.v1',
      branch_verdicts: [{ ...artifact.branch_verdicts[0], confidence: 'high' }],
    });

    expect(documentNode.querySelector('.confidence-badge')?.textContent).toBe('High Confidence');
    expect(documentNode.querySelector('.verdict-box')?.textContent).toBe(
      artifact.branch_verdicts[0].verdict,
    );
  });
});
