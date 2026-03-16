/* ═══════════════════════════════════════════════════════════
   SwarmOracle — QuickStartCards
   ═══════════════════════════════════════════════════════════ */

import { useTranslation } from 'react-i18next';
import './QuickStartCards.css';

const PRESETS_EN = [
  { emoji: '⚔️', question: 'What if Zhuge Liang lived 10 more years?', subtitle: 'History / Three Kingdoms' },
  { emoji: '🚀', question: 'What if humanity landed on Mars in 2000?', subtitle: 'Tech / Parallel Universe' },
  { emoji: '🌍', question: 'What if the internet was never invented?', subtitle: 'Society / Evolution' },
  { emoji: '🎵', question: 'What if Beethoven was born today?', subtitle: 'Culture / Arts' },
  { emoji: '💡', question: 'What if Einstein chose engineering instead of physics?', subtitle: 'Science / Butterfly Effect' },
  { emoji: '🏰', question: 'What if the Roman Empire never fell?', subtitle: 'History / Civilization' },
];

const PRESETS_ZH = [
  { emoji: '⚔️', question: '如果诸葛亮多活10年？', subtitle: '三国演义 · 历史推演' },
  { emoji: '🚀', question: '如果人类在2000年就登陆了火星？', subtitle: '科技 · 平行宇宙' },
  { emoji: '🌍', question: '如果互联网从未被发明？', subtitle: '社会 · 文明走向' },
  { emoji: '🎵', question: '如果贝多芬出生在现代？', subtitle: '文化 · 艺术演变' },
  { emoji: '💡', question: '如果爱因斯坦选择了工程而不是物理？', subtitle: '科学 · 蝴蝶效应' },
  { emoji: '🏰', question: '如果罗马帝国从未衰落？', subtitle: '历史 · 文明推演' },
];

interface Props {
  onSelect: (question: string) => void;
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
          onClick={() => onSelect(preset.question)}
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
