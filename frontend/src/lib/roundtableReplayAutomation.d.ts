export interface RoundtableAutomationControls {
  active_thread_id?: string | null;
  anchor_kind?: string | null;
  can_send?: boolean | null;
  cast_mode?: string | null;
  discussion_format?: string | null;
  interaction_mode?: string | null;
  is_read_only?: boolean | null;
  question_anchor_ids?: string[] | null;
  showing_picker?: boolean | null;
}

export interface RoundtableAutomationPayload {
  page?: {
    kind?: string | null;
    controls?: RoundtableAutomationControls | null;
  } | null;
}

export interface RoundtableAutomationExpectation {
  expectedRoomId?: string | null;
  expectedActiveThreadId?: string | null;
  expectedQuestionAnchorIds?: string[] | null;
  expectedAnchorKind?: string | null;
  expectedInteractionMode?: string | null;
  expectedDiscussionFormat?: string | null;
  expectedCastMode?: string | null;
  replayUrl?: string | null;
  replayKind?: 'share' | 'local' | 'either';
}

export function isRoundtableReplayUrl(
  url: string | null | undefined,
  options?: { kind?: 'share' | 'local' | 'either' },
): boolean;

export function isLiveRoundtableAutomationPayload(
  payload: RoundtableAutomationPayload | null | undefined,
  expectation?: RoundtableAutomationExpectation,
): boolean;

export function isReadonlyRoundtableAutomationPayload(
  payload: RoundtableAutomationPayload | null | undefined,
  expectation?: RoundtableAutomationExpectation,
): boolean;
