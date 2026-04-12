import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { FoldableTurn } from "./FoldableTurn";

const showFullName = /show full turn|shared\.foldable\.show_full/i;
const collapseName = /collapse turn|shared\.foldable\.collapse/i;

describe("FoldableTurn", () => {
  it("renders speaker name and content", () => {
    render(<FoldableTurn speaker="Oracle" content="The verdict is clear." isCollapsed={false} />);
    expect(screen.getByText("Oracle")).toBeInTheDocument();
    expect(screen.getByText("The verdict is clear.")).toBeInTheDocument();
  });

  it("renders as article element", () => {
    render(
      <FoldableTurn speaker="Agent" content="content" isCollapsed={false} data-testid="turn" />,
    );
    expect(screen.getByTestId("turn").tagName).toBe("ARTICLE");
  });

  it("content is always in DOM even when collapsed", () => {
    render(
      <FoldableTurn speaker="Agent" content="Hidden but present" isCollapsed={true} />,
    );
    // Content must be in DOM (CONSTRAINT: folded content always in DOM)
    expect(screen.getByText("Hidden but present")).toBeInTheDocument();
  });

  it("applies collapsed max-height from CSS variable", () => {
    render(
      <FoldableTurn
        speaker="Agent"
        content="content"
        isCollapsed={true}
        data-testid="turn"
      />,
    );
    const turn = screen.getByTestId("turn");
    expect(turn.style.maxHeight).toContain("foldable-collapsed-height");
    expect(turn.style.overflow).toBe("hidden");
  });

  it("applies expanded max-height when not collapsed", () => {
    render(
      <FoldableTurn
        speaker="Agent"
        content="content"
        isCollapsed={false}
        data-testid="turn"
      />,
    );
    const turn = screen.getByTestId("turn");
    expect(turn.style.maxHeight).toContain("foldable-expanded-max");
  });

  it("calls onToggle when toggle button is clicked", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <FoldableTurn
        speaker="Agent"
        content="content"
        isCollapsed={true}
        onToggle={onToggle}
      />,
    );
    const btn = screen.getByRole("button", { name: showFullName });
    await user.click(btn);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("toggle button has correct aria-expanded state", () => {
    const { rerender } = render(
      <FoldableTurn speaker="Agent" content="content" isCollapsed={true} onToggle={() => {}} />,
    );
    const collapsedToggle = screen.getByRole("button");
    const collapsedRegion = screen.getByRole("region", { hidden: true });
    expect(collapsedToggle).toHaveAttribute("aria-expanded", "false");
    expect(collapsedToggle).toHaveAttribute("aria-controls", collapsedRegion.id);
    expect(collapsedRegion).toHaveAttribute("aria-hidden", "true");
    expect(collapsedRegion).toHaveAttribute("aria-labelledby");
    expect(screen.getByText("content")).toBeInTheDocument();

    rerender(
      <FoldableTurn speaker="Agent" content="content" isCollapsed={false} onToggle={() => {}} />,
    );
    const expandedToggle = screen.getByRole("button");
    const expandedRegion = screen.getByRole("region", { name: "Agent" });
    expect(expandedToggle).toHaveAttribute("aria-expanded", "true");
    expect(expandedToggle).toHaveAttribute("aria-controls", expandedRegion.id);
    expect(expandedRegion).toHaveAttribute("aria-hidden", "false");
  });

  it("does not render toggle button when onToggle is not provided", () => {
    render(<FoldableTurn speaker="Agent" content="content" isCollapsed={false} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("sets data-speaker attribute for color hue", () => {
    render(
      <FoldableTurn
        speaker="Agent"
        content="content"
        isCollapsed={false}
        speakerIndex={3}
        data-testid="turn"
      />,
    );
    expect(screen.getByTestId("turn")).toHaveAttribute("data-speaker", "3");
  });

  it("renders badge when provided", () => {
    render(
      <FoldableTurn
        speaker="Agent"
        content="content"
        isCollapsed={false}
        badge={<span data-testid="faction-badge">Ally</span>}
      />,
    );
    expect(screen.getByTestId("faction-badge")).toBeInTheDocument();
  });

  it("keeps actions visible and keyboard reachable without hover", async () => {
    const user = userEvent.setup();
    render(
      <FoldableTurn
        speaker="Agent"
        content="content"
        isCollapsed={false}
        onToggle={() => {}}
        actions={<button>Follow</button>}
      />,
    );
    const toggle = screen.getByRole("button", { name: collapseName });
    const action = screen.getByRole("button", { name: "Follow" });
    const actionsContainer = action.parentElement;

    expect(action).toBeVisible();
    expect(actionsContainer).not.toHaveClass("opacity-0");

    await user.tab();
    expect(toggle).toHaveFocus();

    await user.tab();
    expect(action).toHaveFocus();
    expect(action).toBeVisible();
  });
});
