function anchorIdsEqual(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

export function isRoundtableReplayUrl(url, { kind = 'either' } = {}) {
  if (typeof url !== 'string' || url.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(url, 'http://127.0.0.1');
  } catch {
    return false;
  }
  if (parsed.pathname !== '/roundtable/replay') return false;
  const hasShare = parsed.searchParams.has('roomShare');
  const hasLocal = parsed.searchParams.has('roomLocal');
  if (kind === 'share') return hasShare;
  if (kind === 'local') return hasLocal;
  return hasShare || hasLocal;
}

export function isLiveRoundtableAutomationPayload(
  payload,
  {
    expectedRoomId = null,
    expectedActiveThreadId = null,
    expectedQuestionAnchorIds = null,
    expectedAnchorKind = null,
    expectedInteractionMode = null,
  } = {},
) {
  const controls = payload?.page?.controls;
  if (payload?.page?.kind !== 'worldline_roundtable') return false;
  if (!controls) return false;
  if (expectedRoomId && payload?.scene?.room_id !== expectedRoomId) return false;
  if (controls.is_read_only === true) return false;
  if (controls.showing_picker === true) return false;
  if (controls.can_send !== true) return false;
  if (expectedInteractionMode && controls.interaction_mode !== expectedInteractionMode) return false;
  if (expectedActiveThreadId && controls.active_thread_id !== expectedActiveThreadId) return false;
  if (expectedQuestionAnchorIds && !anchorIdsEqual(controls.question_anchor_ids, expectedQuestionAnchorIds)) return false;
  if (expectedAnchorKind && controls.anchor_kind !== expectedAnchorKind) return false;
  return true;
}

export function isReadonlyRoundtableAutomationPayload(
  payload,
  {
    replayUrl = null,
    replayKind = 'either',
    expectedActiveThreadId = null,
    expectedQuestionAnchorIds = null,
    expectedAnchorKind = null,
    expectedInteractionMode = null,
  } = {},
) {
  const controls = payload?.page?.controls;
  if (payload?.page?.kind !== 'worldline_roundtable') return false;
  if (!controls) return false;
  if (replayUrl && !isRoundtableReplayUrl(replayUrl, { kind: replayKind })) return false;
  if (controls.is_read_only !== true) return false;
  if (controls.can_send !== false) return false;
  if (expectedInteractionMode && controls.interaction_mode !== expectedInteractionMode) return false;
  if (expectedActiveThreadId && controls.active_thread_id !== expectedActiveThreadId) return false;
  if (expectedQuestionAnchorIds && !anchorIdsEqual(controls.question_anchor_ids, expectedQuestionAnchorIds)) return false;
  if (expectedAnchorKind && controls.anchor_kind !== expectedAnchorKind) return false;
  return true;
}
