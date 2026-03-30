import type { EndingRoomPhase, EndingRoomRoleSlot, EndingRoomStatus, EndingRoomType } from '../types';

type Translator = (key: string) => string;

export function getEndingRoomStatusLabel(
  status: EndingRoomStatus | 'idle' | 'loading',
  t: Translator,
): string {
  switch (status) {
    case 'draft':
      return t('ending_room.status_draft');
    case 'live':
      return t('ending_room.status_live');
    case 'done':
      return t('ending_room.status_done');
    case 'error':
      return t('ending_room.status_error');
    case 'loading':
      return t('ending_room.loading');
    default:
      return t('common.loading');
  }
}

export function getEndingRoomModeLabel(roomType: EndingRoomType, t: Translator): string {
  if (roomType === 'one_move_only') {
    return t('ending_room.mode_one_move_only');
  }
  if (roomType === 'crossline_gallery') {
    return t('roundtable.gallery_title');
  }
  return t('ending_room.mode_debrief');
}

export function getEndingRoomPhaseLabel(phase: EndingRoomPhase, t: Translator): string {
  return t(`roundtable.phase_${phase}`);
}

export function getEndingRoomRoleLabel(role: EndingRoomRoleSlot, t: Translator, isZh: boolean): string {
  switch (role) {
    case 'archivist':
      return t('roundtable.role_archivist');
    case 'representative':
      return t('roundtable.role_representative');
    case 'agent':
      return t('ending_room.current_branch_badge');
    case 'observer':
      return t('roundtable.gallery_title');
    case 'critic':
      return isZh ? '评论者' : 'Critic';
    default:
      return role;
  }
}
