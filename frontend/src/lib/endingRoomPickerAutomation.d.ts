export interface OpenEndingRoomModalFromPickerOptions {
  buttonSelector?: string;
  modalSelector?: string;
  initialTimeout?: number;
  retryTimeout?: number;
}

export interface EndingRoomModalUiReadySnapshot {
  text?: string;
  hasComposer?: boolean;
  hasModePill?: boolean;
  hasCloseButton?: boolean;
}

export function openEndingRoomModalFromPicker(
  page: {
    locator: (selector: string) => {
      last: () => {
        scrollIntoViewIfNeeded: () => Promise<unknown>;
        click: (options: { force: true }) => Promise<unknown>;
      };
    };
    waitForSelector: (selector: string, options: { timeout: number }) => Promise<unknown>;
  },
  options?: OpenEndingRoomModalFromPickerOptions,
): Promise<void>;

export function isEndingRoomModalUiReady(
  snapshot?: EndingRoomModalUiReadySnapshot,
): boolean;
