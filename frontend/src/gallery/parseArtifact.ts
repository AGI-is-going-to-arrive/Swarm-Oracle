import {
  PUBLIC_ARTIFACT_SCHEMA_VERSION,
  type PublicArtifact,
  type PublicArtifactConfidence,
  type PublicArtifactBranchVerdict,
  type PublicArtifactProbabilityBar,
  type PublicArtifactTranscriptExcerpt,
  type PublicArtifactSourceDomain,
} from '../types';

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Runtime type guard and validator for the PublicArtifact JSON contract.
 * Ensures the object has exactly the expected fields, clamps values, truncates arrays,
 * and narrows types safely without escaping via 'as any' or 'as unknown'.
 */
export function parsePublicArtifact(
  rawInput: unknown,
): { ok: true; artifact: PublicArtifact } | { ok: false; reason: 'malformed' | 'unknown_version' } {
  let json: unknown;
  if (typeof rawInput === 'string') {
    try {
      json = JSON.parse(rawInput);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  } else {
    json = rawInput;
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, reason: 'malformed' };
  }

  const obj = json as Record<string, unknown>;

  // Check schema version
  if (obj.schema_version !== PUBLIC_ARTIFACT_SCHEMA_VERSION) {
    return { ok: false, reason: 'unknown_version' };
  }

  // Question: string, max 320
  if (typeof obj.question !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const question = obj.question.slice(0, 320);

  // Language: string, max 8
  if (typeof obj.language !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const language = obj.language.slice(0, 8);

  // display_agent_names: array of strings, max 12, each max 80
  if (!Array.isArray(obj.display_agent_names)) {
    return { ok: false, reason: 'malformed' };
  }
  const rawAgentNames = obj.display_agent_names;
  const display_agent_names: string[] = [];
  const maxAgents = Math.min(rawAgentNames.length, 12);
  for (let i = 0; i < maxAgents; i++) {
    const item = rawAgentNames[i];
    if (typeof item !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    display_agent_names.push(item.slice(0, 80));
  }

  // branch_verdicts: array of objects, max 8
  if (!Array.isArray(obj.branch_verdicts)) {
    return { ok: false, reason: 'malformed' };
  }
  const rawBranchVerdicts = obj.branch_verdicts;
  const branch_verdicts: PublicArtifactBranchVerdict[] = [];
  const maxVerdicts = Math.min(rawBranchVerdicts.length, 8);
  for (let i = 0; i < maxVerdicts; i++) {
    const item = rawBranchVerdicts[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'malformed' };
    }
    const itemObj = item as Record<string, unknown>;
    const branchIndex = itemObj.branch_index;
    const title = itemObj.title;
    const verdict = itemObj.verdict;
    const confidence = itemObj.confidence;

    if (typeof branchIndex !== 'number' || typeof title !== 'string' || typeof verdict !== 'string') {
      return { ok: false, reason: 'malformed' };
    }

    let parsedConfidence: PublicArtifactConfidence = 'low';
    if (confidence === 'high' || confidence === 'medium' || confidence === 'low') {
      parsedConfidence = confidence;
    }

    branch_verdicts.push({
      branch_index: branchIndex,
      title: title.slice(0, 120),
      verdict: verdict.slice(0, 240),
      confidence: parsedConfidence,
    });
  }

  // probability_bars: array of objects, max 8
  if (!Array.isArray(obj.probability_bars)) {
    return { ok: false, reason: 'malformed' };
  }
  const rawProbBars = obj.probability_bars;
  const probability_bars: PublicArtifactProbabilityBar[] = [];
  const maxProbBars = Math.min(rawProbBars.length, 8);
  for (let i = 0; i < maxProbBars; i++) {
    const item = rawProbBars[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'malformed' };
    }
    const itemObj = item as Record<string, unknown>;
    const branchIndex = itemObj.branch_index;
    const label = itemObj.label;
    const probability = itemObj.probability;

    if (typeof branchIndex !== 'number' || typeof label !== 'string' || typeof probability !== 'number') {
      return { ok: false, reason: 'malformed' };
    }

    const clampedProb = Math.max(0, Math.min(1, probability));

    probability_bars.push({
      branch_index: branchIndex,
      label: label.slice(0, 120),
      probability: clampedProb,
    });
  }

  // transcript_excerpts: array of objects, max 12
  if (!Array.isArray(obj.transcript_excerpts)) {
    return { ok: false, reason: 'malformed' };
  }
  const rawExcerpts = obj.transcript_excerpts;
  const transcript_excerpts: PublicArtifactTranscriptExcerpt[] = [];
  const maxExcerpts = Math.min(rawExcerpts.length, 12);
  for (let i = 0; i < maxExcerpts; i++) {
    const item = rawExcerpts[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'malformed' };
    }
    const itemObj = item as Record<string, unknown>;
    const branchIndex = itemObj.branch_index;
    const agentName = itemObj.agent_name;
    const excerpt = itemObj.excerpt;
    const round = itemObj.round;

    if (typeof branchIndex !== 'number' || typeof agentName !== 'string' || typeof excerpt !== 'string') {
      return { ok: false, reason: 'malformed' };
    }

    const hasRound = typeof round === 'number';

    transcript_excerpts.push({
      branch_index: branchIndex,
      ...(hasRound ? { round } : {}),
      agent_name: agentName.slice(0, 80),
      excerpt: excerpt.slice(0, 280),
    });
  }

  // source_summary: object, containing domains array of objects (max 12)
  const sourceSummary = obj.source_summary;
  if (!sourceSummary || typeof sourceSummary !== 'object' || Array.isArray(sourceSummary)) {
    return { ok: false, reason: 'malformed' };
  }
  const sourceSummaryObj = sourceSummary as Record<string, unknown>;
  if (!Array.isArray(sourceSummaryObj.domains)) {
    return { ok: false, reason: 'malformed' };
  }
  const rawDomains = sourceSummaryObj.domains;
  const domains: PublicArtifactSourceDomain[] = [];
  const maxDomains = Math.min(rawDomains.length, 12);
  for (let i = 0; i < maxDomains; i++) {
    const item = rawDomains[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: 'malformed' };
    }
    const itemObj = item as Record<string, unknown>;
    const domainName = itemObj.domain;
    const sourceCount = itemObj.source_count;

    if (typeof domainName !== 'string' || typeof sourceCount !== 'number') {
      return { ok: false, reason: 'malformed' };
    }

    domains.push({
      domain: domainName,
      source_count: sourceCount,
    });
  }

  return {
    ok: true,
    artifact: {
      schema_version: PUBLIC_ARTIFACT_SCHEMA_VERSION,
      question,
      language,
      display_agent_names,
      branch_verdicts,
      probability_bars,
      transcript_excerpts,
      source_summary: {
        domains,
      },
    },
  };
}
