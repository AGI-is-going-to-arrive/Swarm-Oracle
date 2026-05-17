import { ArrowRight, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

export interface EmptyStateQuickQuestionOrigin {
  surface?: 'causal' | 'knowledge' | 'argument' | 'result';
  nodeType?: string;
  nodeLabel?: string;
  excerpt?: string;
  agentName?: string;
  targetLabel?: string;
  causeContext?: string[];
  effectContext?: string[];
  relationContext?: string[];
  relatedContext?: string[];
}

export interface EmptyStateQuickQuestionsProps {
  onSelect: (text: string) => void;
  className?: string;
  variant?: 'node' | 'result';
  agentName?: string;
  origin?: EmptyStateQuickQuestionOrigin;
}

type QuickQuestionTranslate = (key: string, options?: Record<string, unknown>) => string;

const QUESTION_TOPIC_MAX_CHARS = 34;
const QUESTION_CONTEXT_MAX_CHARS = 36;

function cleanQuestionCopy(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function clipQuestionCopy(value: string, maxChars: number): string {
  const chars = Array.from(cleanQuestionCopy(value));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('').trimEnd()}…`;
}

function stripSpeaker(value: string): string {
  const cleaned = cleanQuestionCopy(value);
  const parts = cleaned.split(/[：:]/);
  if (parts.length <= 1) return cleaned;
  const speaker = parts[0]?.trim() ?? '';
  if (Array.from(speaker).length > 16) return cleaned;
  return parts.slice(1).join(':').trim() || cleaned;
}

function firstContextLine(lines: string[] | undefined): string {
  return clipQuestionCopy((lines ?? []).map(cleanQuestionCopy).find(Boolean) ?? '', QUESTION_CONTEXT_MAX_CHARS);
}

function getQuestionTopic(origin: EmptyStateQuickQuestionOrigin | undefined, fallback: string): string {
  const raw = origin?.nodeLabel || origin?.excerpt || origin?.targetLabel || origin?.agentName || fallback;
  const subject = stripSpeaker(raw);
  return clipQuestionCopy(subject || fallback, QUESTION_TOPIC_MAX_CHARS);
}

function buildNodeQuestions(
  origin: EmptyStateQuickQuestionOrigin | undefined,
  t: QuickQuestionTranslate,
): string[] | null {
  if (!origin) return null;

  const nodeType = cleanQuestionCopy(origin.nodeType).toLowerCase();
  const surface = origin.surface;
  const topic = getQuestionTopic(
    origin,
    t('conversation.empty_state.node_topic_fallback', {
      defaultValue: 'this node',
    }),
  );
  const agent = cleanQuestionCopy(origin.agentName);
  const cause = firstContextLine(origin.causeContext);
  const effect = firstContextLine(origin.effectContext);
  const relation = firstContextLine(
    origin.relationContext && origin.relationContext.length > 0
      ? origin.relationContext
      : origin.relatedContext,
  );
  const target = cleanQuestionCopy(origin.targetLabel);

  if (surface === 'knowledge') {
    return [
      t('conversation.empty_state.knowledge_q_1', {
        topic,
        defaultValue: 'Which nodes are closest to "{{topic}}"?',
      }),
      t('conversation.empty_state.knowledge_q_2', {
        topic,
        defaultValue: 'What does "{{topic}}" actually do in this worldline?',
      }),
      t('conversation.empty_state.knowledge_q_3', {
        topic,
        defaultValue: 'If I follow "{{topic}}", what should I read next?',
      }),
    ];
  }

  if (surface === 'argument') {
    if (nodeType === 'verdict') {
      return [
        t('conversation.empty_state.argument_verdict_q_1', {
          topic,
          defaultValue: 'Why did the verdict land on "{{topic}}"?',
        }),
        t('conversation.empty_state.argument_verdict_q_2', {
          defaultValue: 'Which claim or evidence carried the most weight?',
        }),
        t('conversation.empty_state.argument_verdict_q_3', {
          defaultValue: 'If this were reviewed again, what should I question first?',
        }),
      ];
    }
    if (nodeType === 'evidence') {
      return [
        t('conversation.empty_state.argument_evidence_q_1', {
          topic,
          defaultValue: 'What does "{{topic}}" really prove?',
        }),
        t('conversation.empty_state.argument_evidence_q_2', {
          defaultValue: 'Did the other side answer this evidence, or dodge it?',
        }),
        t('conversation.empty_state.argument_evidence_q_3', {
          defaultValue: 'What missing evidence would make this point solid?',
        }),
      ];
    }
    if (nodeType === 'rebuttal' || nodeType === 'counter') {
      return [
        t('conversation.empty_state.argument_rebuttal_q_1', {
          topic,
          defaultValue: 'What weak spot does "{{topic}}" hit?',
        }),
        t('conversation.empty_state.argument_rebuttal_q_2', {
          defaultValue: 'How could the other side recover from this?',
        }),
        t('conversation.empty_state.argument_rebuttal_q_3', {
          defaultValue: 'Did this rebuttal actually move the verdict?',
        }),
      ];
    }
    return [
      t('conversation.empty_state.argument_claim_q_1', {
        topic,
        defaultValue: 'What keeps "{{topic}}" standing?',
      }),
      t('conversation.empty_state.argument_claim_q_2', {
        defaultValue: 'Who pushes back on this claim, and where?',
      }),
      t('conversation.empty_state.argument_claim_q_3', {
        defaultValue: 'Does this claim still matter by the verdict?',
      }),
    ];
  }

  if (nodeType === 'fork') {
    return [
      t('conversation.empty_state.causal_fork_q_1', {
        topic,
        defaultValue: 'What two roads split at "{{topic}}"?',
      }),
      effect
        ? t('conversation.empty_state.causal_fork_q_2_effect', {
            effect,
            defaultValue: 'How does it open the way toward "{{effect}}"?',
          })
        : t('conversation.empty_state.causal_fork_q_2', {
            defaultValue: 'Which side of this fork is the riskier bet?',
          }),
      cause
        ? t('conversation.empty_state.causal_fork_q_3_cause', {
            cause,
            defaultValue: 'What earlier move, like "{{cause}}", made this split possible?',
          })
        : t('conversation.empty_state.causal_fork_q_3', {
            defaultValue: 'If I wanted a cleaner branch, what should change before this?',
          }),
    ];
  }

  if (nodeType === 'outcome' || nodeType === 'verdict') {
    return [
      t('conversation.empty_state.causal_outcome_q_1', {
        topic,
        defaultValue: 'What pushed the branch into "{{topic}}"?',
      }),
      cause
        ? t('conversation.empty_state.causal_outcome_q_2_cause', {
            cause,
            defaultValue: 'How much did "{{cause}}" matter here?',
          })
        : t('conversation.empty_state.causal_outcome_q_2', {
            defaultValue: 'Which earlier step was hardest to undo?',
          }),
      t('conversation.empty_state.causal_outcome_q_3', {
        defaultValue: 'If I wanted to avoid this ending, where should I intervene first?',
      }),
    ];
  }

  if (nodeType === 'intervention') {
    return [
      t('conversation.empty_state.causal_intervention_q_1', {
        topic,
        defaultValue: 'What did "{{topic}}" try to change?',
      }),
      effect
        ? t('conversation.empty_state.causal_intervention_q_2_effect', {
            effect,
            defaultValue: 'Did it really move the story toward "{{effect}}"?',
          })
        : t('conversation.empty_state.causal_intervention_q_2', {
            defaultValue: 'Did this intervention work, or only add noise?',
          }),
      t('conversation.empty_state.causal_intervention_q_3', {
        defaultValue: 'What would be a cleaner intervention point?',
      }),
    ];
  }

  return [
    agent
      ? t('conversation.empty_state.causal_event_q_1_agent', {
          agent,
          topic,
          defaultValue: 'What is {{agent}} really worried about here?',
        })
      : t('conversation.empty_state.causal_event_q_1', {
          topic,
          defaultValue: 'Why is this event important?',
        }),
    cause
      ? t('conversation.empty_state.causal_event_q_2_cause', {
          cause,
          defaultValue: 'Which earlier move pushed this moment into place?',
        })
      : t('conversation.empty_state.causal_event_q_2', {
          defaultValue: 'What happened right before this card?',
        }),
    effect
      ? t('conversation.empty_state.causal_event_q_3_effect', {
          effect,
          defaultValue: 'Where does this moment push the story next?',
        })
      : relation
        ? t('conversation.empty_state.causal_event_q_3_relation', {
            relation,
            defaultValue: 'Who is this card answering or pulling against?',
          })
        : t('conversation.empty_state.causal_event_q_3', {
            target,
            defaultValue: target ? 'What should I ask {{target}} about this moment?' : 'Who changes their mind because of this?',
          }),
  ];
}

function buildResultQuestions(
  origin: EmptyStateQuickQuestionOrigin | undefined,
  t: QuickQuestionTranslate,
): string[] | null {
  if (!origin) return null;

  const topic = getQuestionTopic(
    origin,
    t('conversation.empty_state.result_topic_fallback', {
      defaultValue: 'this result',
    }),
  );
  const cause = firstContextLine(origin.causeContext);
  const relation = firstContextLine(
    origin.relatedContext && origin.relatedContext.length > 0
      ? origin.relatedContext
      : origin.relationContext,
  );

  return [
    t('conversation.empty_state.result_context_q_1', {
      topic,
      defaultValue: 'Why did "{{topic}}" become the landing point?',
    }),
    cause
      ? t('conversation.empty_state.result_context_q_2_cause', {
          cause,
          defaultValue: 'Which earlier turn pushed the story this way?',
        })
      : t('conversation.empty_state.result_context_q_2', {
          defaultValue: 'Which earlier turn pushed the story this way?',
        }),
    relation
      ? t('conversation.empty_state.result_context_q_3_compare', {
          relation,
          defaultValue: 'What really separates it from "{{relation}}"?',
        })
      : t('conversation.empty_state.result_context_q_3', {
          defaultValue: 'If this were replayed, what would you change first?',
        }),
  ];
}

export function EmptyStateQuickQuestions(props: EmptyStateQuickQuestionsProps) {
  const { onSelect, className, variant = 'node', origin } = props;
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

  const contextualQuestions = variant === 'node'
    ? buildNodeQuestions(origin, t)
    : buildResultQuestions(origin, t);
  const resultTopic = variant === 'result' && origin
    ? getQuestionTopic(origin, t('conversation.empty_state.result_topic_fallback', { defaultValue: 'this result' }))
    : null;
  const title = resultTopic
    ? t('conversation.empty_state.result_title_named', {
        topic: resultTopic,
        defaultValue: 'Ask about "{{topic}}"',
      })
    : t(keyFor('title'), { defaultValue: fallback.title });
  const subtitle = resultTopic
    ? t('conversation.empty_state.result_subtitle_named', {
        defaultValue: 'Trace why this ending held, what it diverged from, and where a replay could change it.',
      })
    : t(keyFor('subtitle'), { defaultValue: fallback.subtitle });
  const questions = contextualQuestions ?? [
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
          {title}
        </h2>
      </div>
      <p className="conv-empty-state__subtitle">
        {subtitle}
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
