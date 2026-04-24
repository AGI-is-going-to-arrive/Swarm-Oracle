/**
 * FE-3 — Empty state quick-questions (ui-prompts §4).
 *
 * Three pill-shaped quick questions the user can click to seed the
 * conversation input. Caller provides `onSelect(text)` to hydrate the
 * textarea.
 */

import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

export interface EmptyStateQuickQuestionsProps {
  onSelect: (text: string) => void;
  className?: string;
  variant?: 'node' | 'result';
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

  const pills = [
    t(keyFor('quick_q_1'), { defaultValue: fallback.quick_q_1 }),
    t(keyFor('quick_q_2'), { defaultValue: fallback.quick_q_2 }),
    t(keyFor('quick_q_3'), { defaultValue: fallback.quick_q_3 }),
  ];

  return (
    <div
      className={cn('flex flex-col items-start gap-3 text-left', className)}
      data-testid="conversation-empty-state"
    >
      <h2 className="text-base font-semibold text-text-primary">
        {t(keyFor('title'), { defaultValue: fallback.title })}
      </h2>
      <p className="text-sm text-text-muted">
        {t(keyFor('subtitle'), { defaultValue: fallback.subtitle })}
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        {pills.map((text, i) => (
          <button
            key={i}
            type="button"
            data-testid={`conversation-quick-q-${i + 1}`}
            onClick={() => onSelect(text)}
            className="min-h-[44px] rounded-full border border-border-default px-4 py-2 text-xs text-text-primary hover:bg-surface-muted"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
