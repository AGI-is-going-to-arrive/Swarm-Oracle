
import type { AutomationErrorState } from '../lib/apiErrorMessage';

export interface AutomationStoreState {
  question: string | null;
  status: string;
  currentRound: number;
  totalRounds: number | null;
  viewMode: 'classic' | 'theater';
  visualizationEnabled: boolean;
  isSimulationComplete: boolean;
  messageCount: number;
  agentCount: number;
  branchCount: number;
  thinkingAgentCount?: number;
  thinkingAgents?: Array<{
    agent: string;
    agent_id: string;
    branch: string;
    round: number;
  }>;
}

export interface AutomationSceneState {
  scene: string;
  [key: string]: unknown;
}

export interface AutomationReplayState {
  available?: boolean;
  enabled?: boolean;
  theater_ready?: boolean;
  phase?: 'idle' | 'playing' | 'settled' | 'complete';
  playback_mode: 'replay' | 'skip';
  replay_speed: number;
  selected_branch_id: string | null;
  selected_branch_title?: string | null;
  selected_round: number | null;
  available_rounds?: number[];
  filtered_message_count?: number;
  batch_count?: number;
  displayed_bubble_count?: number;
}

export interface AutomationPageState {
  route: string;
  kind: string;
  error?: AutomationErrorState | null;
  replay_state?: AutomationReplayState | null;
  [key: string]: unknown;
}

export interface AutomationPayload {
  page?: AutomationPageState;
  coordinate_system: {
    origin: 'top-left';
    x: string;
    y: string;
  };
  simulation: AutomationStoreState;
  scene: AutomationSceneState | null;
}

export interface AutomationWindow extends Window {
  render_game_to_text?: () => string;
  advanceTime?: (ms: number) => Promise<void>;
  capture_game_screenshot?: (mode?: 'canvas' | 'panel' | 'modal') => Promise<string | null>;
  __swarmGetSceneAutomation?: () => AutomationSceneState | null;
  __swarmGetReplayAutomation?: () => AutomationReplayState | null;
}

export function buildAutomationPayload(
  storeState: AutomationStoreState,
  sceneState: AutomationSceneState | null,
  pageState?: AutomationPageState,
): AutomationPayload {
  return {
    page: pageState,
    coordinate_system: {
      origin: 'top-left',
      x: 'canvas pixels in the current Phaser scene',
      y: 'canvas pixels in the current Phaser scene',
    },
    simulation: storeState,
    scene: sceneState,
  };
}

export function stringifyAutomationPayload(
  storeState: AutomationStoreState,
  sceneState: AutomationSceneState | null,
  pageState?: AutomationPageState,
): string {
  return JSON.stringify(buildAutomationPayload(storeState, sceneState, pageState));
}
