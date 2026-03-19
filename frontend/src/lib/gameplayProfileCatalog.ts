import { CONTRACT_GAMEPLAY_PROFILES } from './gameplayContract';
import type { GameplayProfileId } from './themeRegistry';

export type GameplayBadgeId =
  | 'recommended'
  | 'daily_challenge'
  | 'archive_record'
  | 'bet_winner';

export interface GameplayProfileCatalogEntry {
  id: GameplayProfileId;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  signatureHooksZh: string[];
  signatureHooksEn: string[];
  recommendedCards: string[];
  defaultDirectives: Record<string, { zh: string; en: string }>;
}

export const GAMEPLAY_PROFILE_CATALOG = (
  CONTRACT_GAMEPLAY_PROFILES as Record<GameplayProfileId, GameplayProfileCatalogEntry>
);

const GAMEPLAY_BADGE_ASSET_PATHS = {
  recommended: '/assets/ui/generated/badge_recommended.png',
  dailyChallenge: '/assets/ui/generated/badge_daily_challenge.png',
  archiveRecord: '/assets/ui/generated/badge_archive_record.png',
  betWinner: '/assets/ui/generated/badge_bet_winner.png',
} as const;

export function getGameplayProfileLabel(profileId: GameplayProfileId, isZh: boolean): string {
  const profile = GAMEPLAY_PROFILE_CATALOG[profileId];
  return isZh ? profile.labelZh : profile.labelEn;
}

export function getGameplayProfileSignatureHooks(
  profileId: GameplayProfileId,
  isZh: boolean,
): string[] {
  const profile = GAMEPLAY_PROFILE_CATALOG[profileId];
  return isZh ? profile.signatureHooksZh : profile.signatureHooksEn;
}

export function getGameplayBadgeSrc(badgeId: GameplayBadgeId): string {
  if (badgeId === 'recommended') return GAMEPLAY_BADGE_ASSET_PATHS.recommended;
  if (badgeId === 'daily_challenge') return GAMEPLAY_BADGE_ASSET_PATHS.dailyChallenge;
  if (badgeId === 'archive_record') return GAMEPLAY_BADGE_ASSET_PATHS.archiveRecord;
  return GAMEPLAY_BADGE_ASSET_PATHS.betWinner;
}
