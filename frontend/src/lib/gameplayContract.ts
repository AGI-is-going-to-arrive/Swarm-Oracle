import contractData from '../../../shared/gameplay_contract.v1.json';

interface LocalizedText {
  zh: string;
  en: string;
}

interface ContractCard {
  id: string;
  icon: string;
  labels: LocalizedText;
  descriptions: LocalizedText;
  animation_key: string;
  cost: number;
  cooldown_rounds: number;
  auto_cooldown_rounds: number;
  trigger_type: 'auto' | 'manual';
  manual_enabled: boolean;
  auto_enabled: boolean;
  min_round: number;
}

interface ContractProfile {
  id: string;
  labels: LocalizedText;
  descriptions: LocalizedText;
  signature_hooks: {
    zh: string[];
    en: string[];
  };
  recommended_cards: string[];
  default_directives: Record<string, LocalizedText>;
  signature_arc: {
    labels: LocalizedText;
    sequence: string[];
    risk_track_labels: LocalizedText;
    resource_track_labels: LocalizedText;
  };
}

interface GameplayContract {
  version: number;
  cards: ContractCard[];
  profiles: ContractProfile[];
  card_system_effects: Record<string, { risk: number; resource: number }>;
}

const gameplayContract = contractData as GameplayContract;

export const GAMEPLAY_CONTRACT = gameplayContract;

export const CONTRACT_GAMEPLAY_CARD_DEFS = gameplayContract.cards.map((card) => ({
  id: card.id,
  icon: card.icon,
  labelZh: card.labels.zh,
  labelEn: card.labels.en,
  descriptionZh: card.descriptions.zh,
  descriptionEn: card.descriptions.en,
  animation: card.animation_key,
}));

export const CONTRACT_GAMEPLAY_PROFILES = Object.fromEntries(
  gameplayContract.profiles.map((profile) => [profile.id, {
    id: profile.id,
    labelZh: profile.labels.zh,
    labelEn: profile.labels.en,
    descriptionZh: profile.descriptions.zh,
    descriptionEn: profile.descriptions.en,
    signatureHooksZh: profile.signature_hooks.zh,
    signatureHooksEn: profile.signature_hooks.en,
    recommendedCards: profile.recommended_cards,
    defaultDirectives: profile.default_directives,
  }]),
);

export const CONTRACT_SIGNATURE_ARCS = Object.fromEntries(
  gameplayContract.profiles.map((profile) => [profile.id, {
    labelZh: profile.signature_arc.labels.zh,
    labelEn: profile.signature_arc.labels.en,
    sequence: profile.signature_arc.sequence,
    riskLabelZh: profile.signature_arc.risk_track_labels.zh,
    riskLabelEn: profile.signature_arc.risk_track_labels.en,
    resourceLabelZh: profile.signature_arc.resource_track_labels.zh,
    resourceLabelEn: profile.signature_arc.resource_track_labels.en,
  }]),
);

export const CONTRACT_CARD_SYSTEM_EFFECTS = gameplayContract.card_system_effects;

export const CONTRACT_CARD_RULES = Object.fromEntries(
  gameplayContract.cards.map((card) => [card.id, {
    cost: card.cost,
    cooldownRounds: card.cooldown_rounds,
  }]),
);
