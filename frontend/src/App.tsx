/* ═══════════════════════════════════════════════════════════
   SwarmOracle — App Entry (Router)
   ═══════════════════════════════════════════════════════════ */

import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { AppErrorBoundary } from './components/AppErrorBoundary';
import { LanguageSwitcher } from './components/LanguageSwitcher';

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

function RouteFallback() {
  const { t } = useTranslation();
  return <div className="game-skeleton">{t('common.loading')}</div>;
}

export default function App() {
  return (
    <AppErrorBoundary>
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<InputView />} />
            <Route path="/sim/replay" element={<SimulationView />} />
            <Route path="/sim/:id" element={<SimulationView />} />
            <Route path="/debate/:id" element={<DebateArenaView />} />
            <Route path="/debate/:id/result" element={<DebateResultView />} />
            <Route path="/debate/replay/result" element={<DebateResultView />} />
            <Route path="/result/:id" element={<ResultView />} />
            <Route path="/result/replay" element={<ResultView />} />
            <Route path="/roundtable/:id" element={<WorldlineRoundtableView />} />
            <Route path="/roundtable/replay" element={<WorldlineRoundtableView />} />
            <Route path="/history" element={<HistoryView />} />
            <Route path="/leaderboard" element={<LeaderboardView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
        <LanguageSwitcher />
      </BrowserRouter>
    </AppErrorBoundary>
  );
}
