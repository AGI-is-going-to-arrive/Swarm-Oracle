function normalizeOrigin(origin: string): string {
  return origin.replace(/\/$/, '');
}

export function buildScenarioPermalink(origin: string, scenarioId: string): string {
  return `${normalizeOrigin(origin)}/result/${scenarioId}`;
}

export function buildDebatePermalink(origin: string, debateId: string): string {
  return `${normalizeOrigin(origin)}/debate/${debateId}/result`;
}
