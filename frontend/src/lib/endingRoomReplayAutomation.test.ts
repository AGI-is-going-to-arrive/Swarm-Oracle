import { describe, expect, it } from 'vitest';

import {
  ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN,
  ENDING_ROOM_SAVE_READONLY_COPY_PATTERN,
  isReplayCoverageUrl,
  isLiveEndingRoomModalState,
  isReadonlyReplayUiReady,
  isReadonlyEndingRoomModalState,
} from './endingRoomReplayAutomation.js';

describe('endingRoomReplayAutomation', () => {
  it('matches both legacy and current save-readonly button copy', () => {
    expect(ENDING_ROOM_SAVE_READONLY_COPY_PATTERN.test('Save local read-only copy')).toBe(true);
    expect(ENDING_ROOM_SAVE_READONLY_COPY_PATTERN.test('Save read-only copy')).toBe(true);
    expect(ENDING_ROOM_SAVE_READONLY_COPY_PATTERN.test('Save copy')).toBe(true);
    expect(ENDING_ROOM_SAVE_READONLY_COPY_PATTERN.test('保存本地只读副本')).toBe(true);
    expect(ENDING_ROOM_SAVE_READONLY_COPY_PATTERN.test('保存只读副本')).toBe(true);
    expect(ENDING_ROOM_SAVE_READONLY_COPY_PATTERN.test('保存副本')).toBe(true);
  });

  it('recognizes import-local-run action copy variants', () => {
    expect(ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN.test('Import as Local Run')).toBe(true);
    expect(ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN.test('Import local run')).toBe(true);
    expect(ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN.test('Import run')).toBe(true);
    expect(ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN.test('导入为本地运行')).toBe(true);
    expect(ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN.test('导入本地运行')).toBe(true);
    expect(ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN.test('导入运行')).toBe(true);
  });

  it('accepts only matching live ending-room modal state', () => {
    expect(isLiveEndingRoomModalState(
      {
        room_id: 'room-1',
        room_type: 'ending_chamber',
        status: 'done',
        has_result: true,
        can_send: true,
        read_only: false,
      },
      { expectedRoomId: 'room-1', expectedRoomType: 'ending_chamber' },
    )).toBe(true);

    expect(isLiveEndingRoomModalState(
      {
        room_id: 'room-2',
        room_type: 'ending_chamber',
        status: 'done',
        has_result: true,
        can_send: true,
        read_only: false,
      },
      { expectedRoomId: 'room-1', expectedRoomType: 'ending_chamber' },
    )).toBe(false);

    expect(isLiveEndingRoomModalState(
      {
        room_id: 'room-1',
        room_type: 'ending_chamber',
        status: 'done',
        has_result: true,
        can_send: false,
        read_only: true,
      },
      { expectedRoomId: 'room-1', expectedRoomType: 'ending_chamber' },
    )).toBe(false);
  });

  it('treats readonly replay UI fallback as valid only on replay URLs with import and without composer', () => {
    expect(isReadonlyReplayUiReady({
      url: 'http://127.0.0.1:18928/result/replay?roomLocal=abc',
      hasImportAction: true,
      hasComposerSendButton: false,
    })).toBe(true);

    expect(isReadonlyReplayUiReady({
      url: 'http://127.0.0.1:18928/result/scenario-1',
      hasImportAction: true,
      hasComposerSendButton: false,
    })).toBe(false);

    expect(isReadonlyReplayUiReady({
      url: 'http://127.0.0.1:18928/result/replay?roomShare=abc',
      hasImportAction: false,
      hasComposerSendButton: false,
    })).toBe(false);

    expect(isReadonlyReplayUiReady({
      url: 'http://127.0.0.1:18928/result/replay?roomLocal=abc',
      hasImportAction: true,
      hasComposerSendButton: true,
    })).toBe(false);
  });

  it('recognizes valid ending-room replay URL variants across replay, share, and local copies', () => {
    expect(isReplayCoverageUrl('http://127.0.0.1:18928/result/replay?roomReplay=token')).toBe(true);
    expect(isReplayCoverageUrl('http://127.0.0.1:18928/result/replay?roomShare=artifact')).toBe(true);
    expect(isReplayCoverageUrl('http://127.0.0.1:18928/result/replay?roomLocal=local-copy')).toBe(true);
    expect(isReplayCoverageUrl('http://127.0.0.1:18928/result/scenario-1')).toBe(false);
  });

  it('accepts readonly replay UI fallback on full replay URLs, not only share/local copies', () => {
    expect(isReadonlyReplayUiReady({
      url: 'http://127.0.0.1:18928/result/replay?roomReplay=token',
      hasImportAction: true,
      hasComposerSendButton: false,
    })).toBe(true);
  });

  it('recognizes readonly modal state only when sending is disabled', () => {
    expect(isReadonlyEndingRoomModalState({ read_only: true, can_send: false })).toBe(true);
    expect(isReadonlyEndingRoomModalState({ read_only: true, can_send: true })).toBe(false);
    expect(isReadonlyEndingRoomModalState({ read_only: false, can_send: false })).toBe(false);
  });
});
