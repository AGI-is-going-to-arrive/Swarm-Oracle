export async function openEndingRoomModalFromPicker(
  page,
  {
    buttonSelector = ".ending-room-picker__footer .btn",
    modalSelector = ".ending-chat-modal",
    initialTimeout = 5000,
    retryTimeout = 15000,
  } = {},
) {
  const confirmButton = page.locator(buttonSelector).last();
  await confirmButton.scrollIntoViewIfNeeded().catch(() => {});
  await confirmButton.click({ force: true });
  try {
    await page.waitForSelector(modalSelector, { timeout: initialTimeout });
  } catch {
    await confirmButton.click({ force: true });
    await page.waitForSelector(modalSelector, { timeout: retryTimeout });
  }
}

export function isEndingRoomModalUiReady({
  text = "",
  hasComposer = false,
  hasModePill = false,
  hasCloseButton = false,
} = {}) {
  return text.includes("结局会客厅")
    || text.includes("Ending Chamber")
    || text.includes("只改一步")
    || text.includes("One Move Only")
    || text.includes("当前参与者")
    || text.includes("Current participants")
    || hasComposer
    || hasModePill
    || hasCloseButton;
}
