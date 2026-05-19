/* eslint-disable react-refresh/only-export-components */
/* ═══════════════════════════════════════════════════════════
   SwarmOracle — ResultView shared context
   ═══════════════════════════════════════════════════════════ */

import {
  createContext,
  useContext,
  type Dispatch,
  type ReactNode,
  type FocusEvent,
  type SetStateAction,
} from 'react';
import type { TFunction } from 'i18next';
import type { NavigateFunction } from 'react-router-dom';
import type {
  AgentInfo,
  CampaignFinalizeResult,
  CampaignScenarioSummary,
  PredictionInfo,
  Scenario,
  StoryData,
} from '../../types';
import type { ScenarioMeta } from '../../lib/scenarioMeta';
import type { ResultViewMode } from '../../stores/uiPreferencesStore';
import type { CapabilitiesResponse } from '../../api/client';
import type { GameplayProfileId } from '../../lib/themeRegistry';

/**
 * Shared values consumed by ResultView sub-components. Hook orchestration and
 * setters remain inside `ResultView.tsx`; this object only exposes the
 * derived values + handlers actually needed by extracted sections.
 */
export interface ResultViewContextValue {
  // identifiers + locale + navigation
  id: string | undefined;
  activeScenarioId: string | null;
  navigate: NavigateFunction;
  t: TFunction;
  isZh: boolean;

  // display mode
  resultViewMode: ResultViewMode;
  setResultViewMode: (mode: ResultViewMode) => void;
  isWorkbenchMode: boolean;
  isReplayMode: boolean;

  // capability registry
  capabilities: CapabilitiesResponse | null;
  capLoading: boolean;

  // top-level data
  scenario: Scenario | null;
  storyData: StoryData | null;
  agents: AgentInfo[];
  predictions: PredictionInfo[];
  branches: StoryData['branches'];
  analysisBranch: StoryData['branches'][number] | null;
  primaryAgentIdentityId: string | null;

  // notebook + web sources collapsibles
  notebookOpen: boolean;
  setNotebookOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  debriefOpen: boolean;
  setDebriefOpen: Dispatch<SetStateAction<boolean>>;
  webSourcesOpen: boolean;
  setWebSourcesOpen: (next: boolean | ((prev: boolean) => boolean)) => void;
  blurCollapsedPanelFocus: (event: FocusEvent<HTMLDivElement>) => void;

  // expand state for ending cards
  expandedBranch: string | null;
  setExpandedBranch: (next: string | null) => void;

  // export controls
  exporting: boolean;
  exportError: string;
  importError: string;
  importingReplay: boolean;
  showResultReplayImportAction: boolean;
  handleExport: () => void;
  handleImportReplay: () => void;

  // permalink + share
  replayUrl: string | null;
  permalinkCopied: boolean;
  handleCopyPermalink: () => void;
  challengeLinkCopied: boolean;
  handleShareChallenge: () => void;
  showShare: boolean;
  setShowShare: (next: boolean) => void;
  showSnapshotExport: boolean;
  setShowSnapshotExport: (next: boolean) => void;

  // ending room handlers (Ending cards grid + modals)
  handleOpenEndingRoom: (
    branchId: string,
    roomType: 'ending_chamber' | 'one_move_only' | 'crossline_gallery',
  ) => void;
  handleOpenRoundtable: () => void;

  // scoring (Predictions section)
  scoring: boolean;
  scoreError: string;
  hasUnscored: boolean;
  handleScore: () => void;

  // runtime preset
  activeRuntimePresetLabel: string;

  // counterfactual + faction (workbench)
  cfBranchId: string | null;
  setCfBranchId: (next: string | null) => void;
  cfInitialRound: number | undefined;
  setCfInitialRound: (next: number | undefined) => void;

  // archive / scenarioMeta + campaign
  scenarioMeta: ScenarioMeta | null;
  campaignSummary: CampaignFinalizeResult | null;
  campaignScenarioSummary: CampaignScenarioSummary | null;
  campaignError: string;
  campaignNotice: string;
  isDailyChallenge: boolean;
  resolvedProfileId: GameplayProfileId | null | undefined;
  gameplayProfileLabel: string | null;
  gameplayProfileHooks: string[];

  // share envelope sources
  shareSourceFamilies: string[] | undefined;

  // in-context agent follow-up (opens NodeConversationSheet from ExploreDeeperBridge)
  agentFollowupTarget: AgentInfo | null;
  setAgentFollowupTarget: (agent: AgentInfo | null) => void;
}

const ResultViewContext = createContext<ResultViewContextValue | null>(null);

export function ResultContextProvider({
  value,
  children,
}: {
  value: ResultViewContextValue;
  children: ReactNode;
}) {
  return (
    <ResultViewContext.Provider value={value}>
      {children}
    </ResultViewContext.Provider>
  );
}

export function useResultContext(): ResultViewContextValue {
  const ctx = useContext(ResultViewContext);
  if (!ctx) {
    throw new Error('useResultContext must be used within a ResultContextProvider');
  }
  return ctx;
}
