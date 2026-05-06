import * as React from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

export interface FoldableTurnProps {
  /** Speaker display name */
  speaker: string;
  /** Turn content (full text, always in DOM) */
  content: string;
  /** Whether this turn is collapsed */
  isCollapsed: boolean;
  /** Callback when expand/collapse is toggled */
  onToggle?: () => void;
  /** Speaker index for color hue (maps to data-speaker) */
  speakerIndex?: number;
  /** Whether this is the current speaker (highlighted) */
  isCurrentSpeaker?: boolean;
  /** Whether this is an archivist turn */
  isArchivist?: boolean;
  /** Optional badge element (e.g., FactionBadge) */
  badge?: React.ReactNode;
  /** Optional action buttons (hover-reveal) */
  actions?: React.ReactNode;
  /** Additional class names */
  className?: string;
  /** Pass-through data-testid */
  "data-testid"?: string;
}

const FoldableTurn = React.forwardRef<HTMLElement, FoldableTurnProps>(
  (
    {
      speaker,
      content,
      isCollapsed,
      onToggle,
      speakerIndex,
      isCurrentSpeaker = false,
      isArchivist = false,
      badge,
      actions,
      className,
      "data-testid": testId,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const regionId = React.useId();
    const speakerId = `${regionId}-speaker`;
    const contentId = `${regionId}-content`;

    return (
      <article
        ref={ref as React.Ref<HTMLElement>}
        data-testid={testId}
        data-speaker={speakerIndex}
        className={cn(
          "group relative rounded-md border-l-2 px-3 py-2 transition-[max-height]",
          "border-l-border-default bg-surface",
          isCurrentSpeaker && "border-l-primary bg-[var(--spotlight-bg)]",
          isArchivist && "border-l-warning",
          className,
        )}
        style={{
          maxHeight: isCollapsed
            ? "var(--foldable-collapsed-height)"
            : "var(--foldable-expanded-max)",
          overflow: "hidden",
          transition: "var(--foldable-transition)",
        }}
      >
        <div className="flex items-center gap-2">
          <strong id={speakerId} className="text-sm font-medium text-text-primary">
            {speaker}
          </strong>
          {badge}
          {onToggle && (
            <button
              type="button"
              onClick={onToggle}
              className="ml-auto text-xs text-text-muted hover:text-text-secondary"
              aria-expanded={!isCollapsed}
              aria-controls={contentId}
              aria-label={isCollapsed ? t("shared.foldable.show_full") : t("shared.foldable.collapse")}
            >
              {isCollapsed ? "▼" : "▲"}
            </button>
          )}
        </div>
        <div
          id={contentId}
          role="region"
          aria-labelledby={speakerId}
          aria-hidden={isCollapsed}
        >
          <p
            className={cn(
              "mt-1 text-sm leading-relaxed text-text-secondary",
              isCollapsed && "overflow-hidden text-ellipsis whitespace-nowrap",
              !isCollapsed && "whitespace-pre-wrap break-words",
            )}
          >
            {content}
          </p>
        </div>
        {actions && (
          <div className="mt-2 flex gap-1">
            {actions}
          </div>
        )}
      </article>
    );
  },
);
FoldableTurn.displayName = "FoldableTurn";

export { FoldableTurn };
