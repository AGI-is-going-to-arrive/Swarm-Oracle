/* ═══════════════════════════════════════════════════════════
   SwarmOracle — QuickStartCards
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';
import './QuickStartCards.css';

export interface QuickStartPreset {
  emoji: string;
  question: string;
  subtitle: string;
  rounds?: number;
  numAgents?: number;
  mode?: 'raw' | 'blackboard';
  visualizationEnabled?: boolean;
}

interface QuickStartTemplate {
  emoji: string;
  key: string;
  rounds?: number;
  numAgents?: number;
  mode?: 'raw' | 'blackboard';
  visualizationEnabled?: boolean;
}

// H1: structural metadata stays in code; question/subtitle text is sourced
// from i18n so all 12 presets can be localized without forking two arrays.
const PRESETS: QuickStartTemplate[] = [
  { emoji: '⚔️', key: 'zhuge_liang' },
  { emoji: '🚀', key: 'mars_2000' },
  { emoji: '🌍', key: 'no_internet' },
  { emoji: '🎵', key: 'beethoven_today' },
  { emoji: '💡', key: 'einstein_engineer' },
  { emoji: '🏰', key: 'rome_endures' },
  { emoji: '🐉', key: 'dragon_pact' },
  { emoji: '🛡️', key: 'last_refuge' },
  {
    emoji: '🎲',
    key: 'random_leader_swap',
    rounds: 4,
    numAgents: 4,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    emoji: '🗳️',
    key: 'lottery_committee',
    rounds: 4,
    numAgents: 4,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    emoji: '🧾',
    key: 'rotating_oversight',
    rounds: 4,
    numAgents: 4,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
];

interface Props {
  onSelect: (preset: QuickStartPreset) => void;
}

export function QuickStartCards({ onSelect }: Props) {
  const { t } = useTranslation();

  const presets: QuickStartPreset[] = PRESETS.map((template) => ({
    emoji: template.emoji,
    question: t(`quickstart.${template.key}.question`),
    subtitle: t(`quickstart.${template.key}.subtitle`),
    rounds: template.rounds,
    numAgents: template.numAgents,
    mode: template.mode,
    visualizationEnabled: template.visualizationEnabled,
  }));

  return (
    <div className="quickstart-cards">
      {presets.map((preset, i) => (
        <button
          key={i}
          className="quickstart-card flat-card"
          onClick={() => onSelect(preset)}
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <span className="quickstart-card__emoji">{preset.emoji}</span>
          <span className="quickstart-card__question">{preset.question}</span>
          <span className="quickstart-card__subtitle">{preset.subtitle}</span>
        </button>
      ))}
    </div>
  );
}
