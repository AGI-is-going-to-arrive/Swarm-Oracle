/* ═══════════════════════════════════════════════════════════
   SwarmOracle — App Entry (Router)
   ═══════════════════════════════════════════════════════════ */

import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { AppErrorBoundary } from './components/AppErrorBoundary';
import { LanguageSwitcher } from './components/LanguageSwitcher';
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
const WorldlineRoundtableView = lazy(() => import('./pages/WorldlineRoundtableView'));
const HistoryView = lazy(() => import('./pages/HistoryView'));
const LeaderboardView = lazy(() => import('./pages/LeaderboardView'));
// Phase 3: new pages
const AgentLibrary = lazy(() => import('./pages/AgentLibrary'));
const AgentWorkshopView = lazy(() => import('./pages/AgentWorkshopView'));
const CausalReviewView = lazy(() => import('./pages/CausalReviewView'));
const CompareDigestView = lazy(() => import('./pages/CompareDigestView'));
// Graph playability upgrade (FE-2 / FE-4): G6 pages + replay view
// - KGExplorerView + TimelineGalaxy share capability 'kg_explorer'
// - ReplayView will be authored by FE-4; its chunk resolves lazily when
//   the feature flag 'replay_trace' is enabled server-side
const KGExplorerView = lazy(() => import('./pages/KGExplorerView'));
const TimelineGalaxy = lazy(() => import('./pages/TimelineGalaxy'));
const ReplayView = lazy(() => import('./pages/ReplayView'));

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
            <Route path="/sim/replay" element={<SimulationView />} />
            {/* Phase 3: causal-map BEFORE :id catch-all (Gemini review) */}
            <Route path="/sim/:id/causal-map" element={<CausalReviewView />} />
            <Route path="/sim/:id" element={<SimulationView />} />
            <Route path="/debate/:id" element={<DebateArenaView />} />
            <Route path="/debate/:id/result" element={<DebateResultView />} />
            <Route path="/debate/replay/result" element={<DebateResultView />} />
            {/* Phase 3: compare BEFORE :id catch-all */}
            <Route path="/result/:id/compare" element={<CompareDigestView />} />
            <Route path="/result/:id" element={<ResultView />} />
            <Route path="/result/replay" element={<ResultView />} />
            <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
            <Route path="/roundtable/replay" element={<WorldlineRoundtableView />} />
            <Route path="/history" element={<HistoryView />} />
            <Route path="/leaderboard" element={<LeaderboardView />} />
            {/* FE-2: KG Explorer + Timeline Galaxy (share kg_explorer capability) */}
            <Route path="/kg-explorer/:id" element={<KGExplorerView />} />
            <Route path="/timeline-galaxy/:id" element={<TimelineGalaxy />} />
            {/* FE-4: Replay View (gated by replay_trace capability server-side) */}
            <Route path="/replay/:id" element={<ReplayView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <LanguageSwitcher />
      </BrowserRouter>
    </AppErrorBoundary>
  );
}
