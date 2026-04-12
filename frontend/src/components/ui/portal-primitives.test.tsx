import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./accordion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: () => {},
  },
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "common.close": "关闭",
      })[key] ?? key,
    i18n: {
      language: "zh",
    },
  }),
}));

type ContainerProp = {
  container?: HTMLElement | null;
};

const DialogContentWithContainer =
  DialogContent as React.ComponentType<React.ComponentProps<typeof DialogContent> & ContainerProp>;
const DropdownMenuContentWithContainer =
  DropdownMenuContent as React.ComponentType<
    React.ComponentProps<typeof DropdownMenuContent> & ContainerProp
  >;
const SheetContentWithContainer =
  SheetContent as React.ComponentType<React.ComponentProps<typeof SheetContent> & ContainerProp>;
const TooltipContentWithContainer =
  TooltipContent as React.ComponentType<React.ComponentProps<typeof TooltipContent> & ContainerProp>;

function createPortalContainer(testId: string) {
  const container = document.createElement("div");
  container.dataset.testid = testId;
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("portal UI primitives", () => {
  it("render into the caller-provided portal container", () => {
    const dialogContainer = createPortalContainer("dialog-container");
    const dropdownContainer = createPortalContainer("dropdown-container");
    const sheetContainer = createPortalContainer("sheet-container");
    const tooltipContainer = createPortalContainer("tooltip-container");

    render(
      <>
        <Dialog open>
          <DialogContentWithContainer container={dialogContainer}>
            <DialogTitle>Dialog title</DialogTitle>
            <DialogDescription>Dialog description</DialogDescription>
            <div>Dialog body</div>
          </DialogContentWithContainer>
        </Dialog>

        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
          <DropdownMenuContentWithContainer container={dropdownContainer}>
            Menu body
          </DropdownMenuContentWithContainer>
        </DropdownMenu>

        <Sheet open>
          <SheetContentWithContainer container={sheetContainer}>
            <SheetTitle>Sheet title</SheetTitle>
            <SheetDescription>Sheet description</SheetDescription>
            <div>Sheet body</div>
          </SheetContentWithContainer>
        </Sheet>

        <TooltipProvider delayDuration={0}>
          <Tooltip open>
            <TooltipTrigger asChild>
              <button type="button">Tooltip trigger</button>
            </TooltipTrigger>
            <TooltipContentWithContainer container={tooltipContainer}>
              Tooltip body
            </TooltipContentWithContainer>
          </Tooltip>
        </TooltipProvider>
      </>,
    );

    expect(within(dialogContainer).getByText("Dialog body")).toBeInTheDocument();
    expect(within(dropdownContainer).getByText("Menu body")).toBeInTheDocument();
    expect(within(sheetContainer).getByText("Sheet body")).toBeInTheDocument();
    expect(
      within(tooltipContainer).getByRole("tooltip", { hidden: true }),
    ).toHaveTextContent("Tooltip body");
  });

  it("uses the shared translated close label instead of a hard-coded english string", () => {
    render(
      <>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Dialog title</DialogTitle>
            <DialogDescription>Dialog description</DialogDescription>
          </DialogContent>
        </Dialog>
        <Sheet open>
          <SheetContent>
            <SheetTitle>Sheet title</SheetTitle>
            <SheetDescription>Sheet description</SheetDescription>
          </SheetContent>
        </Sheet>
      </>,
    );

    const closeLabels = document.querySelectorAll(".sr-only");

    expect(closeLabels).toHaveLength(2);
    expect(Array.from(closeLabels).map((node) => node.textContent)).toEqual([
      "关闭",
      "关闭",
    ]);
  });

  it("wires animation duration through animate utilities instead of transition duration classes", () => {
    const dialogContainer = createPortalContainer("dialog-container");
    const sheetContainer = createPortalContainer("sheet-container");

    render(
      <>
        <Dialog open>
          <DialogContentWithContainer container={dialogContainer}>
            <DialogTitle>Dialog title</DialogTitle>
            <DialogDescription>Dialog description</DialogDescription>
            <div>Dialog body</div>
          </DialogContentWithContainer>
        </Dialog>
        <Sheet open>
          <SheetContentWithContainer container={sheetContainer}>
            <SheetTitle>Sheet title</SheetTitle>
            <SheetDescription>Sheet description</SheetDescription>
            <div>Sheet body</div>
          </SheetContentWithContainer>
        </Sheet>
      </>,
    );

    const dialog = within(dialogContainer).getByRole("dialog", { hidden: true });
    const sheet = within(sheetContainer).getByRole("dialog", { hidden: true });
    const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
    const dialogTokens = dialog.className.split(/\s+/);
    const sheetTokens = sheet.className.split(/\s+/);

    expect(dialogTokens).toContain("animate-duration-200");
    expect(dialogTokens).not.toContain("duration-200");
    expect(sheetTokens).toContain("data-[state=closed]:animate-duration-300");
    expect(sheetTokens).toContain("data-[state=open]:animate-duration-500");
    expect(sheetTokens).not.toContain("data-[state=closed]:duration-300");
    expect(sheetTokens).not.toContain("data-[state=open]:duration-500");

    expect(css).toContain("@utility animate-duration-200");
    expect(css).toContain("@utility animate-duration-300");
    expect(css).toContain("@utility animate-duration-500");
    expect(css).toContain("--tw-animate-duration");
  });

  it("adds reduced-motion guards to shared accordion and sheet transitions", () => {
    const sheetContainer = createPortalContainer("sheet-container");

    render(
      <>
        <Accordion type="single" collapsible defaultValue="strategy">
          <AccordionItem value="strategy">
            <AccordionTrigger>Strategy panel</AccordionTrigger>
            <AccordionContent>Strategy details</AccordionContent>
          </AccordionItem>
        </Accordion>

        <Sheet open>
          <SheetContentWithContainer container={sheetContainer}>
            <SheetTitle>Sheet title</SheetTitle>
            <SheetDescription>Sheet description</SheetDescription>
            <div>Sheet body</div>
          </SheetContentWithContainer>
        </Sheet>
      </>,
    );

    const trigger = within(document.body).getByRole("button", {
      name: "Strategy panel",
      hidden: true,
    });
    const chevron = trigger.querySelector("svg");

    if (!chevron) {
      throw new Error("Expected accordion trigger chevron");
    }

    const sheet = within(sheetContainer).getByRole("dialog", { hidden: true });
    const closeButton = within(sheet).getByRole("button", { name: "关闭" });
    const triggerTokens = trigger.className.split(/\s+/);
    const chevronTokens = (chevron.getAttribute("class") ?? "").split(/\s+/);
    const sheetTokens = (sheet.getAttribute("class") ?? "").split(/\s+/);
    const closeButtonTokens = (closeButton.getAttribute("class") ?? "").split(/\s+/);

    expect(triggerTokens).toContain("motion-safe:transition-all");
    expect(triggerTokens).toContain("motion-reduce:transition-none");
    expect(triggerTokens).not.toContain("transition-all");

    expect(chevronTokens).toContain("motion-safe:transition-transform");
    expect(chevronTokens).toContain("motion-safe:duration-200");
    expect(chevronTokens).toContain("motion-reduce:transition-none");
    expect(chevronTokens).not.toContain("transition-transform");
    expect(chevronTokens).not.toContain("duration-200");

    expect(sheetTokens).toContain("motion-safe:transition");
    expect(sheetTokens).toContain("motion-safe:ease-in-out");
    expect(sheetTokens).toContain("motion-reduce:transition-none");
    expect(sheetTokens).not.toContain("transition");
    expect(sheetTokens).not.toContain("ease-in-out");

    expect(closeButtonTokens).toContain("motion-safe:transition-opacity");
    expect(closeButtonTokens).toContain("motion-reduce:transition-none");
    expect(closeButtonTokens).not.toContain("transition-opacity");
  });

  it("preserves oracle sheet semantics inside a themed portal container", () => {
    const oracleContainer = createPortalContainer("oracle-container");
    oracleContainer.className = "ending-chat-modal oracle-skin oracle-skin--law";
    oracleContainer.style.setProperty("--oracle-accent", "rgb(12 34 56)");

    render(
      <Sheet open>
        <SheetContentWithContainer side="bottom" container={oracleContainer}>
          <SheetTitle>Chamber sidebar</SheetTitle>
          <SheetDescription>Review the live Oracle room.</SheetDescription>
          <div>Sheet body</div>
        </SheetContentWithContainer>
      </Sheet>,
    );

    const sheet = within(oracleContainer).getByRole("dialog", {
      name: "Chamber sidebar",
      hidden: true,
    });
    const labelledBy = sheet.getAttribute("aria-labelledby");
    const describedBy = sheet.getAttribute("aria-describedby");

    expect(sheet.closest(".oracle-skin")).toBe(oracleContainer);
    expect(sheet.getAttribute("class")).toContain("bottom-0");
    expect(sheet.getAttribute("class")).toContain("data-[state=open]:slide-in-from-bottom");
    expect(sheet.getAttribute("class")).toContain("data-[state=closed]:slide-out-to-bottom");
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(labelledBy ? document.getElementById(labelledBy) : null).toHaveTextContent(
      "Chamber sidebar",
    );
    expect(describedBy ? document.getElementById(describedBy) : null).toHaveTextContent(
      "Review the live Oracle room.",
    );
  });
});
