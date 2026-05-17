import GameplayCardsModal from '../components/GameplayCardsModal';
import InterventionReceiptCard from '../components/InterventionReceiptCard';
import PredictionModal from '../components/PredictionModal';
import type { AgentInfo, BranchInfo } from '../types';

const PREVIEW_QUESTION = 'What if a council of agents must vote on a long-tail risk?';

const PREVIEW_AGENTS: AgentInfo[] = [
  {
    id: 'a1',
    name: 'Quorum Speaker',
    role: 'facilitator',
    tier: 'CORE',
    emotion: 'calm',
    stance: 'support',
  },
  {
    id: 'a2',
    name: 'Civic Auditor',
    role: 'scrutiny',
    tier: 'CORE',
    emotion: 'neutral',
    stance: 'oppose',
  },
];

const PREVIEW_BRANCHES: BranchInfo[] = [
  {
    id: 'branch-1',
    parent_branch_id: null,
    fork_round: 0,
    fork_reason: '',
    title: 'Mainline worldline',
    summary: 'The council holds together under public scrutiny.',
    story: 'A transparent review process keeps the coalition intact.',
    insight: 'Accountability stabilizes the branch.',
    key_moments: [],
    probability: 1,
    status: 'ACTIVE',
  },
  {
    id: 'branch-2',
    parent_branch_id: null,
    fork_round: 0,
    fork_reason: '',
    title: 'Dissenting worldline',
    summary: 'A minority bloc pushes back against the vote.',
    story: 'The council splits over enforcement authority.',
    insight: 'Pressure creates a visible counter-path.',
    key_moments: [],
    probability: 0.4,
    status: 'ACTIVE',
  },
];

function previewScenarioId(fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return new URLSearchParams(window.location.search).get('scenario') || fallback;
}

export function GameplayCardsModalPreview() {
  return (
    <GameplayCardsModal
      scenarioId={previewScenarioId('sc-e2e-gameplay')}
      branches={PREVIEW_BRANCHES}
      agents={PREVIEW_AGENTS}
      question={PREVIEW_QUESTION}
      sceneTheme="civic_council"
      currentRound={2}
      onClose={() => {}}
      onApplied={() => {}}
    />
  );
}

export function PredictionModalPreview() {
  return (
    <PredictionModal
      scenarioId={previewScenarioId('sc-e2e-prediction')}
      branches={PREVIEW_BRANCHES}
      question={PREVIEW_QUESTION}
      sceneTheme="civic_council"
      currentRound={2}
      onClose={() => {}}
      onPlacedBet={() => {}}
    />
  );
}

export function InterventionReceiptPreview() {
  return (
    <main style={{ padding: 24, maxWidth: 720 }}>
      <InterventionReceiptCard
        scenarioId={previewScenarioId('sc-e2e-receipt')}
        enabled
      />
    </main>
  );
}
