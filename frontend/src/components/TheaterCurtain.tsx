export interface TheaterCurtainProps {
  /** Whether the curtain should be visible */
  isVisible: boolean;
}

/**
 * GPU-composited theater curtain overlay.
 * Renders only when isVisible is true — parent controls lifecycle.
 * Uses will-change: opacity + transform: translateZ(0) for compositing (CONSTRAINT).
 * Does NOT intercept pointer events (CONSTRAINT: e2e scripts need .theater-panel__filters).
 */
export function TheaterCurtain({ isVisible }: TheaterCurtainProps) {
  if (!isVisible) return null;

  return (
    <div
      className="theater-curtain"
      style={{
        willChange: "opacity",
        transform: "translateZ(0)",
        pointerEvents: "none",
      }}
      aria-hidden="true"
    />
  );
}
