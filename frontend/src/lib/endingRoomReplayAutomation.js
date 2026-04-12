export const ENDING_ROOM_COPY_REPLAY_PATTERN = /Copy replay|复制回放/i;

export const ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN = /Import(?: as)? Local Run|导入为本地运行|导入本地运行/i;

export const ENDING_ROOM_SAVE_READONLY_COPY_PATTERN = /Save(?: local)? read-only copy|保存本地只读副本|保存只读副本/i;

export function isReplayCoverageUrl(url) {
  return typeof url === 'string'
    && (url.includes('roomReplay=') || url.includes('roomShare=') || url.includes('roomLocal='));
}

export function isReadonlyEndingRoomModalState(modalState) {
  return modalState?.read_only === true && modalState?.can_send === false;
}

export function isLiveEndingRoomModalState(
  modalState,
  {
    expectedRoomId = null,
    expectedRoomType = null,
  } = {},
) {
  if (!modalState?.room_id) return false;
  if (expectedRoomId && modalState.room_id !== expectedRoomId) return false;
  if (expectedRoomType && modalState.room_type !== expectedRoomType) return false;
  if (modalState.read_only === true) return false;
  if (modalState.status === 'loading') return false;
  return Boolean(modalState.has_result || modalState.can_send);
}

export function isReadonlyReplayUiReady({
  url,
  hasImportAction,
  hasComposerSendButton,
}) {
  return isReplayCoverageUrl(url) && hasImportAction === true && hasComposerSendButton === false;
}
