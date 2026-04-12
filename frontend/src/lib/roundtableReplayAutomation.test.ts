import { describe, expect, it } from 'vitest';

import {
  isLiveRoundtableAutomationPayload,
  isReadonlyRoundtableAutomationPayload,
  isRoundtableReplayUrl,
} from './roundtableReplayAutomation.js';

describe('roundtableReplayAutomation', () => {
  it('recognizes share and local roundtable replay URLs', () => {
    expect(isRoundtableReplayUrl('http://127.0.0.1:18928/roundtable/replay?roomShare=abc')).toBe(true);
    expect(isRoundtableReplayUrl('http://127.0.0.1:18928/roundtable/replay?roomLocal=abc')).toBe(true);
    expect(isRoundtableReplayUrl('http://127.0.0.1:18928/roundtable/replay?roomShare=abc', { kind: 'share' })).toBe(true);
    expect(isRoundtableReplayUrl('http://127.0.0.1:18928/roundtable/replay?roomLocal=abc', { kind: 'local' })).toBe(true);
    expect(isRoundtableReplayUrl('http://127.0.0.1:18928/roundtable/replay?roomLocal=abc', { kind: 'share' })).toBe(false);
    expect(isRoundtableReplayUrl('http://127.0.0.1:18928/result/scenario-1')).toBe(false);
  });

  it('accepts only matching live roundtable state', () => {
    const payload = {
      page: {
        kind: 'worldline_roundtable',
        controls: {
          is_read_only: false,
          can_send: true,
          showing_picker: false,
          active_thread_id: 'thread-1',
          question_anchor_ids: ['quote:1'],
          anchor_kind: 'quote',
          interaction_mode: 'thread_followup',
        },
      },
      scene: {
        room_id: 'room-1',
      },
    };

    expect(isLiveRoundtableAutomationPayload(payload, {
      expectedRoomId: 'room-1',
      expectedActiveThreadId: 'thread-1',
      expectedQuestionAnchorIds: ['quote:1'],
      expectedAnchorKind: 'quote',
      expectedInteractionMode: 'thread_followup',
    })).toBe(true);

    expect(isLiveRoundtableAutomationPayload(payload, {
      expectedRoomId: 'room-2',
    })).toBe(false);

    expect(isLiveRoundtableAutomationPayload({
      ...payload,
      page: {
        ...payload.page,
        controls: {
          ...payload.page.controls,
          is_read_only: true,
        },
      },
    })).toBe(false);
  });

  it('accepts only matching readonly roundtable replay state', () => {
    const payload = {
      page: {
        kind: 'worldline_roundtable',
        controls: {
          is_read_only: true,
          can_send: false,
          active_thread_id: 'thread-1',
          question_anchor_ids: ['quote:1'],
          anchor_kind: 'quote',
          interaction_mode: 'thread_followup',
        },
      },
    };

    expect(isReadonlyRoundtableAutomationPayload(payload, {
      replayUrl: 'http://127.0.0.1:18928/roundtable/replay?roomLocal=abc',
      replayKind: 'local',
      expectedActiveThreadId: 'thread-1',
      expectedQuestionAnchorIds: ['quote:1'],
      expectedAnchorKind: 'quote',
      expectedInteractionMode: 'thread_followup',
    })).toBe(true);

    expect(isReadonlyRoundtableAutomationPayload(payload, {
      replayUrl: 'http://127.0.0.1:18928/roundtable/replay?roomShare=abc',
      replayKind: 'local',
    })).toBe(false);

    expect(isReadonlyRoundtableAutomationPayload({
      ...payload,
      page: {
        ...payload.page,
        controls: {
          ...payload.page.controls,
          can_send: true,
        },
      },
    }, {
      replayUrl: 'http://127.0.0.1:18928/roundtable/replay?roomLocal=abc',
      replayKind: 'local',
    })).toBe(false);
  });
});
