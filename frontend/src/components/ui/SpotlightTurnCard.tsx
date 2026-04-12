import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "../../lib/utils";

export interface SpotlightTurnCardProps {
  /** Unique key for Motion layoutId animation */
  layoutId?: string;
  /** Speaker display name */
  speaker: string;
  /** Turn content text */
  content: string;
  /** Left border accent color override (CSS value) */
  accentColor?: string;
  /** Variant controls max-width: oracle/roundtable = 58ch, debate = 64ch */
  variant?: "default" | "debate";
  /** Whether this is the latest / highlighted turn */
  isHighlighted?: boolean;
  /** Optional badge element rendered beside the speaker name */
  badge?: React.ReactNode;
  /** Additional class names */
  className?: string;
  /** Pass-through data-testid */
  "data-testid"?: string;
}

const SpotlightTurnCard = React.forwardRef<HTMLElement, SpotlightTurnCardProps>(
  (
    {
      layoutId,
      speaker,
      content,
      accentColor,
      variant = "default",
      isHighlighted = false,
      badge,
      className,
      "data-testid": testId,
    },
    ref,
  ) => {
    const shouldReduceMotion = useReducedMotion();
    const maxWidth = variant === "debate"
      ? "var(--spotlight-max-ch-debate)"
      : "var(--spotlight-max-ch)";

    const cardContent = (
      <article
        ref={ref as React.Ref<HTMLElement>}
        data-testid={testId}
        className={cn(
          "relative rounded-lg border-l-4 px-4 py-3 transition-shadow",
          isHighlighted
            ? "bg-[var(--spotlight-bg)] shadow-[var(--spotlight-shadow)]"
            : "bg-surface",
          className,
        )}
        style={{
          borderLeftColor: accentColor ?? "var(--spotlight-border)",
          maxWidth,
        }}
      >
        <div className="mb-1 flex items-center gap-2">
          <strong className="text-sm font-semibold text-text-primary">
            {speaker}
          </strong>
          {badge}
        </div>
        <p className="text-sm leading-relaxed text-text-secondary">
          {content}
        </p>
      </article>
    );

    if (layoutId && !shouldReduceMotion) {
      return (
        <motion.div layoutId={layoutId}>
          {cardContent}
        </motion.div>
      );
    }

    return cardContent;
  },
);
SpotlightTurnCard.displayName = "SpotlightTurnCard";

export { SpotlightTurnCard };
