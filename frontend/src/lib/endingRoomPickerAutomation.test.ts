import { describe, expect, it, vi } from "vitest";

import {
  isEndingRoomModalUiReady,
  openEndingRoomModalFromPicker,
} from "./endingRoomPickerAutomation.js";

function createFakePage({ failFirstWait = false } = {}) {
  const confirmButton = {
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
  };

  let waitCount = 0;
  const waitForSelector = vi.fn(async () => {
    waitCount += 1;
    if (failFirstWait && waitCount === 1) {
      throw new Error("first wait timed out");
    }
  });

  return {
    page: {
      locator: vi.fn(() => ({
        last: vi.fn(() => confirmButton),
      })),
      waitForSelector,
    },
    confirmButton,
    waitForSelector,
  };
}

describe("openEndingRoomModalFromPicker", () => {
  it("clicks confirm and waits for the modal DOM to appear", async () => {
    const { page, confirmButton, waitForSelector } = createFakePage();

    await openEndingRoomModalFromPicker(page);

    expect(confirmButton.scrollIntoViewIfNeeded).toHaveBeenCalledTimes(1);
    expect(confirmButton.click).toHaveBeenCalledTimes(1);
    expect(confirmButton.click).toHaveBeenCalledWith({ force: true });
    expect(waitForSelector).toHaveBeenCalledTimes(1);
    expect(waitForSelector).toHaveBeenCalledWith(".ending-chat-modal", { timeout: 5000 });
  });

  it("retries the confirm click once when the first modal wait times out", async () => {
    const { page, confirmButton, waitForSelector } = createFakePage({ failFirstWait: true });

    await openEndingRoomModalFromPicker(page);

    expect(confirmButton.click).toHaveBeenCalledTimes(2);
    expect(waitForSelector).toHaveBeenNthCalledWith(1, ".ending-chat-modal", { timeout: 5000 });
    expect(waitForSelector).toHaveBeenNthCalledWith(2, ".ending-chat-modal", { timeout: 15000 });
  });
});

describe("isEndingRoomModalUiReady", () => {
  it("returns true when the chamber title text is already visible", () => {
    expect(isEndingRoomModalUiReady({
      text: "结局会客厅 · 主厅",
      hasComposer: false,
      hasModePill: false,
      hasCloseButton: false,
    })).toBe(true);
  });

  it("returns true when the modal chrome is present even before automation settles", () => {
    expect(isEndingRoomModalUiReady({
      text: "",
      hasComposer: true,
      hasModePill: true,
      hasCloseButton: true,
    })).toBe(true);
  });

  it("returns false when no modal affordance is visible yet", () => {
    expect(isEndingRoomModalUiReady({
      text: "",
      hasComposer: false,
      hasModePill: false,
      hasCloseButton: false,
    })).toBe(false);
  });
});
