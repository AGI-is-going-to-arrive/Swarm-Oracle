import * as React from "react";
import { cn } from "../../lib/utils";

export interface AvatarRingProps {
  /** Image source URL for the avatar */
  src: string;
  /** Alt text for accessibility */
  alt: string;
  /** Size variant in pixels */
  size?: 32 | 42 | 56;
  /** Whether the speaker is currently active/speaking */
  isSpeaking?: boolean;
  /** Accent color override for the ring (CSS value) */
  ringColor?: string;
  /** Additional class names */
  className?: string;
  /** Pass-through data-testid */
  "data-testid"?: string;
}

/**
 * Avatar with animated speaking ring using ::after pseudo-element pulse.
 * Uses transform: scale(1.12) + opacity animation instead of box-shadow
 * to stay on the GPU composite layer (CONSTRAINT from design spec).
 */
const AvatarRing = React.forwardRef<HTMLDivElement, AvatarRingProps>(
  (
    {
      src,
      alt,
      size = 42,
      isSpeaking = false,
      ringColor,
      className,
      "data-testid": testId,
    },
    ref,
  ) => {
    const sizeClass = {
      32: "h-8 w-8",
      42: "h-[42px] w-[42px]",
      56: "h-14 w-14",
    }[size];

    return (
      <div
        ref={ref}
        data-testid={testId}
        className={cn(
          "avatar-ring relative inline-flex shrink-0 items-center justify-center rounded-full",
          sizeClass,
          isSpeaking && "avatar-ring-speaking",
          className,
        )}
        style={ringColor ? { "--avatar-ring-color": ringColor } as React.CSSProperties : undefined}
      >
        <img
          src={src}
          alt={alt}
          className="h-full w-full rounded-full object-cover"
          draggable={false}
        />
      </div>
    );
  },
);
AvatarRing.displayName = "AvatarRing";

export { AvatarRing };
