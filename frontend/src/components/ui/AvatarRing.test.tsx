import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AvatarRing } from "./AvatarRing";

describe("AvatarRing", () => {
  it("renders an image with correct src and alt", () => {
    render(<AvatarRing src="/sprites/agent1.png" alt="Agent Alpha" />);
    const img = screen.getByAltText("Agent Alpha");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/sprites/agent1.png");
  });

  it("renders at default size (42px)", () => {
    const { container } = render(<AvatarRing src="/a.png" alt="A" />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("42px");
  });

  it("renders at 32px size", () => {
    const { container } = render(<AvatarRing src="/a.png" alt="A" size={32} />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("h-8");
  });

  it("renders at 56px size", () => {
    const { container } = render(<AvatarRing src="/a.png" alt="A" size={56} />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("h-14");
  });

  it("applies speaking class when isSpeaking is true", () => {
    const { container } = render(
      <AvatarRing src="/a.png" alt="A" isSpeaking />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("avatar-ring-speaking");
  });

  it("does not apply speaking class when isSpeaking is false", () => {
    const { container } = render(
      <AvatarRing src="/a.png" alt="A" isSpeaking={false} />,
    );
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).not.toContain("avatar-ring-speaking");
  });

  it("applies custom ring color via CSS variable", () => {
    const { container } = render(
      <AvatarRing src="/a.png" alt="A" ringColor="oklch(65% 0.18 220)" />,
    );
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.getPropertyValue("--avatar-ring-color")).toBe(
      "oklch(65% 0.18 220)",
    );
  });

  it("has avatar-ring base class", () => {
    const { container } = render(<AvatarRing src="/a.png" alt="A" />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.className).toContain("avatar-ring");
  });

  it("image is not draggable", () => {
    render(<AvatarRing src="/a.png" alt="A" />);
    const img = screen.getByAltText("A");
    expect(img).toHaveAttribute("draggable", "false");
  });

  it("image has rounded-full class for circular shape", () => {
    render(<AvatarRing src="/a.png" alt="A" />);
    const img = screen.getByAltText("A");
    expect(img.className).toContain("rounded-full");
  });
});
