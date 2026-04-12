import { useTranslation } from "react-i18next";

export interface SimWarmupNarrativeProps {
  /** Current warmup phase: 1 = loading theater, 2 = summoning agents, 3 = building worldlines */
  phase: 1 | 2 | 3;
}

export function SimWarmupNarrative({ phase }: SimWarmupNarrativeProps) {
  const { t } = useTranslation();

  const messages = [
    t("sim.warmup_narrative_phase_1"),
    t("sim.warmup_narrative_phase_2"),
    t("sim.warmup_narrative_phase_3"),
  ];

  return (
    <div className="sim-warmup-narrative" aria-live="polite">
      <div className="sim-warmup-narrative__steps">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`sim-warmup-narrative__step${i < phase ? " is-done" : ""}${i === phase - 1 ? " is-active" : ""}`}
          >
            <span className="sim-warmup-narrative__dot" />
            <span className="sim-warmup-narrative__text">{msg}</span>
          </div>
        ))}
      </div>
      <p className="sim-warmup-narrative__hint">{t("sim.warmup_narrative_hint")}</p>
    </div>
  );
}
