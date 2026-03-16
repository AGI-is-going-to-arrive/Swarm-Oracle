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

const PRESETS_EN = [
  { emoji: '⚔️', question: 'What if Zhuge Liang lived 10 more years?', subtitle: 'History / Three Kingdoms' },
  { emoji: '🚀', question: 'What if humanity landed on Mars in 2000?', subtitle: 'Tech / Parallel Universe' },
  { emoji: '🌍', question: 'What if the internet was never invented?', subtitle: 'Society / Evolution' },
  { emoji: '🎵', question: 'What if Beethoven was born today?', subtitle: 'Culture / Arts' },
  { emoji: '💡', question: 'What if Einstein chose engineering instead of physics?', subtitle: 'Science / Butterfly Effect' },
  { emoji: '🏰', question: 'What if the Roman Empire never fell?', subtitle: 'History / Civilization' },
  { emoji: '🐉', question: 'What if the dragon pact guarding a kingdom collapsed overnight?', subtitle: 'Mythic / Forbidden Order' },
  { emoji: '🛡️', question: 'What if the last refuge city only had thirty days of power left?', subtitle: 'Survival / Last Reserves' },
  {
    emoji: '🎲',
    question: 'What if every major institution had to swap leaders at random every week?',
    subtitle: 'General / Hidden Agendas',
    rounds: 4,
    numAgents: 4,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    emoji: '🗳️',
    question: 'What if every critical city had to be governed by a lottery-picked emergency committee every thirty days?',
    subtitle: 'General / Lottery Committees',
    rounds: 4,
    numAgents: 4,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    emoji: '🧾',
    question: 'What if every high-stakes decision had to be re-approved by a rotating external review board?',
    subtitle: 'General / Rotating Oversight',
    rounds: 4,
    numAgents: 4,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
] satisfies QuickStartPreset[];

const PRESETS_ZH = [
  { emoji: '⚔️', question: '如果诸葛亮多活10年？', subtitle: '三国演义 · 历史推演' },
  { emoji: '🚀', question: '如果人类在2000年就登陆了火星？', subtitle: '科技 · 平行宇宙' },
  { emoji: '🌍', question: '如果互联网从未被发明？', subtitle: '社会 · 文明走向' },
  { emoji: '🎵', question: '如果贝多芬出生在现代？', subtitle: '文化 · 艺术演变' },
  { emoji: '💡', question: '如果爱因斯坦选择了工程而不是物理？', subtitle: '科学 · 蝴蝶效应' },
  { emoji: '🏰', question: '如果罗马帝国从未衰落？', subtitle: '历史 · 文明推演' },
  { emoji: '🐉', question: '如果王国与巨龙订立的守护契约在一夜之间失效，会发生什么？', subtitle: '神话秩序 · 龙契约与禁术代价' },
  { emoji: '🛡️', question: '如果最后一座避难城只能再维持三十天供电，会发生什么？', subtitle: '生存极限 · 最后冗余' },
  {
    emoji: '🎲',
    question: '如果所有大型组织都必须每周随机交换一次负责人，会发生什么？',
    subtitle: '通用博弈 · 关键分歧',
    rounds: 4,
    numAgents: 4,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    emoji: '🗳️',
    question: '如果所有关键城市都必须每三十天由抽签产生的临时委员会接管，会发生什么？',
    subtitle: '通用博弈 · 抽签委员会与临时授权',
    rounds: 4,
    numAgents: 4,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
  {
    emoji: '🧾',
    question: '如果每一项重大决策都必须交给轮值外部评审团重新裁决，会发生什么？',
    subtitle: '通用博弈 · 轮值评审与再裁决',
    rounds: 4,
    numAgents: 4,
    mode: 'blackboard',
    visualizationEnabled: true,
  },
] satisfies QuickStartPreset[];

interface Props {
  onSelect: (preset: QuickStartPreset) => void;
}

export function QuickStartCards({ onSelect }: Props) {
  const { i18n } = useTranslation();
  const presets = i18n.language === 'en' ? PRESETS_EN : PRESETS_ZH;

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
