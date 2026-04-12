export const ENDING_ROOM_COPY_REPLAY_PATTERN: RegExp;
export const ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN: RegExp;
export const ENDING_ROOM_SAVE_READONLY_COPY_PATTERN: RegExp;

export interface LiveEndingRoomModalState {
  room_id?: string | null;
  room_type?: string | null;
  status?: string | null;
  has_result?: boolean | null;
  can_send?: boolean | null;
  read_only?: boolean | null;
}

export interface LiveEndingRoomStateExpectation {
  expectedRoomId?: string | null;
  expectedRoomType?: string | null;
}

export interface ReadonlyReplayUiState {
  url?: string | null;
  hasImportAction?: boolean | null;
  hasComposerSendButton?: boolean | null;
}

export function isReplayCoverageUrl(url: string | null | undefined): boolean;
export function isReadonlyEndingRoomModalState(modalState: LiveEndingRoomModalState | null | undefined): boolean;
export function isLiveEndingRoomModalState(
  modalState: LiveEndingRoomModalState | null | undefined,
  expectation?: LiveEndingRoomStateExpectation,
): boolean;
export function isReadonlyReplayUiReady(state: ReadonlyReplayUiState): boolean;
