import { ArrowRight, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

export interface EmptyStateQuickQuestionsProps {
  onSelect: (text: string) => void;
  className?: string;
  variant?: 'node' | 'result';
  agentName?: string;
}

export function EmptyStateQuickQuestions(props: EmptyStateQuickQuestionsProps) {
  const { onSelect, className, variant = 'node' } = props;
  const { t } = useTranslation();
  const keyFor = (suffix: string) => (
    variant === 'result'
      ? `conversation.empty_state.result_${suffix}`
      : `conversation.empty_state.${suffix}`
  );
  const fallback = variant === 'result'
    ? {
        title: 'Ask about this result',
        subtitle: 'Explore why this ending landed and what could change next.',
        quick_q_1: 'What drove this ending?',
        quick_q_2: 'Which branch was most fragile?',
        quick_q_3: 'What should I inspect next?',
      }
    : {
        title: 'Start a conversation',
        subtitle: 'Ask the agent a question to explore this node.',
        quick_q_1: 'Why did this happen?',
        quick_q_2: 'What would change if I intervened?',
        quick_q_3: 'Who else was affected?',
      };

  const questions = [
    t(keyFor('quick_q_1'), { defaultValue: fallback.quick_q_1 }),
    t(keyFor('quick_q_2'), { defaultValue: fallback.quick_q_2 }),
    t(keyFor('quick_q_3'), { defaultValue: fallback.quick_q_3 }),
  ];

  return (
    <div
      className={cn('conv-empty-state', className)}
      data-testid="conversation-empty-state"
    >
      <div className="conv-empty-state__header">
        <Sparkles className="conv-empty-state__sparkle" size={18} aria-hidden="true" />
        <h2 className="conv-empty-state__title">
          {t(keyFor('title'), { defaultValue: fallback.title })}
        </h2>
      </div>
      <p className="conv-empty-state__subtitle">
        {t(keyFor('subtitle'), { defaultValue: fallback.subtitle })}
      </p>
      <div className="conv-empty-state__questions">
        {questions.map((text, i) => (
          <button
            key={i}
            type="button"
            data-testid={`conversation-quick-q-${i + 1}`}
            onClick={() => onSelect(text)}
            className="quick-question-card conv-quick-q"
          >
            <span>{text}</span>
            <ArrowRight className="conv-quick-q__arrow" size={16} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
