import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n/config";
import {
  SpotlightTurnCard,
  type SpotlightTurnCardProps,
} from "./SpotlightTurnCard";

const originalMatchMedia = window.matchMedia;

function renderSpotlightTurnCard(props: SpotlightTurnCardProps) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SpotlightTurnCard {...props} />
    </I18nextProvider>,
  );
}

function setReducedMotionPreference(matches: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" ? matches : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("SpotlightTurnCard", () => {
  it("renders speaker name and content", () => {
    renderSpotlightTurnCard({
      speaker: "Agent Alpha",
      content: "The economy will shift dramatically.",
    });

    expect(screen.getByText("Agent Alpha")).toBeInTheDocument();
    expect(
      screen.getByText("The economy will shift dramatically."),
    ).toBeInTheDocument();
  });

  it("renders as article element", () => {
    renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
      "data-testid": "test-card",
    });

    const article = screen.getByTestId("test-card");
    expect(article.tagName).toBe("ARTICLE");
  });

  it("passes data-testid through", () => {
    renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
      "data-testid": "debate-live-turn",
    });

    expect(screen.getByTestId("debate-live-turn")).toBeInTheDocument();
  });

  it("renders badge when provided", () => {
    renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
      badge: <span data-testid="badge">HOT</span>,
    });

    expect(screen.getByTestId("badge")).toBeInTheDocument();
  });

  it("applies highlighted styles when isHighlighted is true", () => {
    renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
      isHighlighted: true,
      "data-testid": "card",
    });

    const card = screen.getByTestId("card");
    expect(card.className).toContain("spotlight");
  });

  it("uses debate max-width variant", () => {
    renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
      variant: "debate",
      "data-testid": "card",
    });

    const card = screen.getByTestId("card");
    expect(card.style.maxWidth).toContain("spotlight-max-ch-debate");
  });

  it("uses default max-width variant", () => {
    renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
      "data-testid": "card",
    });

    const card = screen.getByTestId("card");
    expect(card.style.maxWidth).toContain("spotlight-max-ch");
    expect(card.style.maxWidth).not.toContain("debate");
  });

  it("applies custom accent color", () => {
    renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
      accentColor: "red",
      "data-testid": "card",
    });

    const card = screen.getByTestId("card");
    expect(card.style.borderLeftColor).toBe("red");
  });

  it("does not line-clamp long content by default", () => {
    const longContent = "Long transcript segment ".repeat(40).trim();

    renderSpotlightTurnCard({
      speaker: "Agent",
      content: longContent,
    });

    const paragraph = screen.getByText(longContent);
    expect(paragraph.className).not.toMatch(/\bline-clamp-/);
  });

  it("wraps in motion.div when layoutId is provided and reduced motion is off", () => {
    setReducedMotionPreference(false);

    const { container } = renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
      layoutId: "turn-1",
    });

    const article = container.querySelector("article");
    expect(article).toBeInTheDocument();
    expect(article?.parentElement?.tagName).toBe("DIV");
  });

  it("renders without motion wrapper when prefers reduced motion is enabled", () => {
    setReducedMotionPreference(true);

    const { container } = renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
      layoutId: "turn-1",
    });

    const article = container.querySelector("article");
    expect(article).toBeInTheDocument();
    expect(article?.parentElement).toBe(container);
  });

  it("renders without motion wrapper when no layoutId", () => {
    const { container } = renderSpotlightTurnCard({
      speaker: "Agent",
      content: "content",
    });

    const article = container.querySelector("article");
    expect(article).toBeInTheDocument();
    expect(article?.parentElement).toBe(container);
  });
});
