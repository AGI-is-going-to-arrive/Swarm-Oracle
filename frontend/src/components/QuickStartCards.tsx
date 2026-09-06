/* ═══════════════════════════════════════════════════════════
   SwarmOracle — QuickStartCards
   ═══════════════════════════════════════════════════════════ */

import { useState } from 'react';
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
  disabled?: boolean;
}

export function QuickStartCards({ onSelect, disabled = false }: Props) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);

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
    <div className="quickstart-browser">
      <div className="quickstart-cards" id="quickstart-card-list">
      {(showAll ? presets : presets.slice(0, 4)).map((preset, i) => (
        <button
          key={i}
          type="button"
          className="quickstart-card flat-card"
          onClick={() => onSelect(preset)}
          disabled={disabled}
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <span className="quickstart-card__emoji" aria-hidden="true">{preset.emoji}</span>
          <span className="quickstart-card__question">{preset.question}</span>
          <span className="quickstart-card__subtitle">{preset.subtitle}</span>
        </button>
      ))}
      </div>
      <button
        type="button"
        className="btn btn-ghost quickstart-browser__more"
        onClick={() => setShowAll((current) => !current)}
        aria-expanded={showAll}
        aria-controls="quickstart-card-list"
      >
        {t(showAll ? 'home.materials_show_less' : 'home.materials_show_more')}
      </button>
    </div>
  );
}
