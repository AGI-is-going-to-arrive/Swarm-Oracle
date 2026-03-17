export interface WorldSceneBootstrapGuardInput {
  synthDone: boolean;
  worldSceneActive: boolean;
  agentCount: number;
}

export function shouldBootstrapWorldScene(input: WorldSceneBootstrapGuardInput): boolean {
  if (input.synthDone) return false;
  if (!input.worldSceneActive) return false;
  return input.agentCount > 0;
}
