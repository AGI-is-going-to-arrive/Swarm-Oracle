/* ═══════════════════════════════════════════════════════════
   SwarmOracle — App Entry (Router)
   ═══════════════════════════════════════════════════════════ */

import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { AppErrorBoundary } from './components/AppErrorBoundary';
import { LanguageSwitcher } from './components/LanguageSwitcher';
import { PipelineStepper } from './components/PipelineStepper';
import { GlobalOfflineBanner } from './components/shared/GlobalOfflineBanner';

const InputView = lazy(() =>
  import('./pages/InputView').then((mod) => ({ default: mod.InputView }))
);
const SimulationView = lazy(() =>
  import('./pages/SimulationView').then((mod) => ({ default: mod.SimulationView }))
);
const DebateArenaView = lazy(() =>
  import('./pages/DebateArenaView').then((mod) => ({ default: mod.DebateArenaView }))
);
const DebateResultView = lazy(() =>
  import('./pages/DebateResultView').then((mod) => ({ default: mod.DebateResultView }))
);
const ResultView = lazy(() => import('./pages/ResultView'));
const ResultReportView = lazy(() => import('./pages/ResultReportView'));
const WorldlineRoundtableView = lazy(() => import('./pages/WorldlineRoundtableView'));
const HistoryView = lazy(() => import('./pages/HistoryView'));
const LeaderboardView = lazy(() => import('./pages/LeaderboardView'));
// Phase 3: new pages
const AgentLibrary = lazy(() => import('./pages/AgentLibrary'));
const AgentWorkshopView = lazy(() => import('./pages/AgentWorkshopView'));
const CausalReviewView = lazy(() => import('./pages/CausalReviewView'));
const CompareDigestView = lazy(() => import('./pages/CompareDigestView'));
const IdentityInspectorView = lazy(() => import('./pages/IdentityInspectorView'));
// Graph playability upgrade (FE-2 / FE-4): G6 pages + replay view
// - KGExplorerView + TimelineGalaxy share capability 'kg_explorer'
// - ReplayView will be authored by FE-4; its chunk resolves lazily when
//   the feature flag 'replay_trace' is enabled server-side
const WorkbenchView = lazy(() => import('./pages/WorkbenchView'));
const KGExplorerView = lazy(() => import('./pages/KGExplorerView'));
const TimelineGalaxy = lazy(() => import('./pages/TimelineGalaxy'));
const ReplayView = lazy(() => import('./pages/ReplayView'));
// S0-1: 3-step setup wizard at /admin/setup
const SetupWizardView = lazy(() => import('./pages/SetupWizardView'));
// Personal Prediction Journal at /me/journal
const PersonalJournalView = lazy(() => import('./pages/PersonalJournalView'));
const GameplayCardsModalPreview = lazy(() =>
  import('./pages/E2EPreviewSurfaces').then((mod) => ({ default: mod.GameplayCardsModalPreview }))
);
const PredictionModalPreview = lazy(() =>
  import('./pages/E2EPreviewSurfaces').then((mod) => ({ default: mod.PredictionModalPreview }))
);
const InterventionReceiptPreview = lazy(() =>
  import('./pages/E2EPreviewSurfaces').then((mod) => ({ default: mod.InterventionReceiptPreview }))
);

function RouteFallback() {
  const { t } = useTranslation();
  return <div className="game-skeleton">{t('common.loading')}</div>;
}

export default function App() {
  return (
    <AppErrorBoundary>
      <GlobalOfflineBanner />
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<InputView />} />
            {/* Phase 3: agent routes */}
            <Route path="/agents" element={<AgentLibrary />} />
            <Route path="/agents/new" element={<AgentWorkshopView />} />
            <Route path="/agents/edit/:id" element={<AgentWorkshopView />} />
            <Route path="/agents/identities/:id/memories" element={<IdentityInspectorView />} />
            <Route path="/sim/replay" element={<SimulationView />} />
            {/* Phase 3: causal-map BEFORE :id catch-all (Gemini review) */}
            <Route path="/sim/:id/causal-map" element={<CausalReviewView />} />
            <Route path="/sim/:id" element={<SimulationView />} />
            <Route path="/debate/:id" element={<DebateArenaView />} />
            <Route path="/debate/:id/result" element={<DebateResultView />} />
            <Route path="/debate/replay/result" element={<DebateResultView />} />
            {/* Phase 3: compare BEFORE :id catch-all */}
            <Route path="/result/:id/compare" element={<CompareDigestView />} />
            <Route path="/result/:id/report" element={<ResultReportView />} />
            <Route path="/result/:id" element={<ResultView />} />
            <Route path="/result/replay" element={<ResultView />} />
            <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
            <Route path="/roundtable/replay" element={<WorldlineRoundtableView />} />
            <Route path="/history" element={<HistoryView />} />
            <Route path="/leaderboard" element={<LeaderboardView />} />
            {/* P2-1: Graph Workbench (split causal + KG view) */}
            <Route path="/workbench/:id" element={<WorkbenchView />} />
            {/* FE-2: KG Explorer + Timeline Galaxy (share kg_explorer capability) */}
            <Route path="/kg-explorer/:id" element={<KGExplorerView />} />
            <Route path="/timeline-galaxy/:id" element={<TimelineGalaxy />} />
            {/* FE-4: Replay View (gated by replay_trace capability server-side) */}
            <Route path="/replay/:id" element={<ReplayView />} />
            {/* S0-1: Setup Wizard (admin onboarding) */}
            <Route path="/admin/setup" element={<SetupWizardView />} />
            {/* Personal Prediction Journal */}
            <Route path="/me/journal" element={<PersonalJournalView />} />
            <Route path="/__gameplay_cards_modal_preview" element={<GameplayCardsModalPreview />} />
            <Route path="/__prediction_modal_preview" element={<PredictionModalPreview />} />
            <Route path="/__intervention_receipt_preview" element={<InterventionReceiptPreview />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <LanguageSwitcher />
        <PipelineStepper />
      </BrowserRouter>
    </AppErrorBoundary>
  );
}
