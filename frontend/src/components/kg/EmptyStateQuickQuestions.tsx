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
}

export function EmptyStateQuickQuestions(props: EmptyStateQuickQuestionsProps) {
  const { onSelect, className } = props;
  const { t } = useTranslation();

  const pills = [
    t('conversation.empty_state.quick_q_1'),
    t('conversation.empty_state.quick_q_2'),
    t('conversation.empty_state.quick_q_3'),
  ];

  return (
    <div
      className={cn('flex flex-col items-start gap-3 text-left', className)}
      data-testid="conversation-empty-state"
    >
      <h2 className="text-base font-semibold text-text-primary">
        {t('conversation.empty_state.title')}
      </h2>
      <p className="text-sm text-text-muted">{t('conversation.empty_state.subtitle')}</p>
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
