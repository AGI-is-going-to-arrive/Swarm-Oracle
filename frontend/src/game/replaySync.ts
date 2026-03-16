export interface ReplaySyncState {
  visualizationEnabled: boolean;
  isSimulationComplete: boolean;
  messages: unknown[];
}

export interface ReplaySyncGameLike {
  scene: {
    isActive: (key: string) => boolean;
    stop: (key: string) => void;
    start: (key: string) => void;
  };
}

export function shouldSkipTitleScene(state: ReplaySyncState): boolean {
  if (!state.visualizationEnabled) return false;
  if (!state.isSimulationComplete) return true;
  // Completed theater replays should not depend on message hydration timing.
  return true;
}

export function ensureReplayStartsInWorldScene(
  game: ReplaySyncGameLike | null,
  state: ReplaySyncState,
): boolean {
  if (!game || !shouldSkipTitleScene(state)) return false;
  if (!game.scene.isActive('TitleScene')) return false;

  game.scene.stop('TitleScene');
  game.scene.start('WorldScene');
  return true;
}
