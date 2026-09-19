import type { TFunction } from 'i18next';
import { normalizeLanguage } from '../i18n/language';

type ValueLabels = Readonly<Record<'zh' | 'en', string>>;

const STANCE_LABELS: ReadonlyMap<string, ValueLabels> = new Map([
  ['支持', { zh: '支持', en: 'Supportive' }],
  ['support', { zh: '支持', en: 'Supportive' }],
  ['supportive', { zh: '支持', en: 'Supportive' }],
  ['反对', { zh: '反对', en: 'Opposed' }],
  ['oppose', { zh: '反对', en: 'Opposed' }],
  ['opposed', { zh: '反对', en: 'Opposed' }],
  ['中立', { zh: '中立', en: 'Neutral' }],
  ['neutral', { zh: '中立', en: 'Neutral' }],
]);

const EMOTION_LABELS: ReadonlyMap<string, ValueLabels> = new Map([
  ['neutral', { zh: '中性', en: 'Neutral' }],
  ['happy', { zh: '愉快', en: 'Happy' }],
  ['excited', { zh: '兴奋', en: 'Excited' }],
  ['angry', { zh: '生气', en: 'Angry' }],
  ['sad', { zh: '难过', en: 'Sad' }],
  ['thoughtful', { zh: '思考中', en: 'Thoughtful' }],
  ['anxious', { zh: '焦虑', en: 'Anxious' }],
  ['calm', { zh: '平静', en: 'Calm' }],
  ['surprised', { zh: '惊讶', en: 'Surprised' }],
]);

function valueLabel(
  labels: ReadonlyMap<string, ValueLabels>,
  value: string,
  language: string | undefined,
): string {
  // Only exact known values are labels; authored sentences remain untouched.
  return labels.get(value.trim().toLowerCase())?.[normalizeLanguage(language)] ?? value;
}

export function getAgentStanceLabel(stance: string, language: string | undefined): string {
  return valueLabel(STANCE_LABELS, stance, language);
}

export function getAgentEmotionLabel(emotion: string, language: string | undefined): string {
  return valueLabel(EMOTION_LABELS, emotion, language);
}

export function getAgentTierLabel(t: TFunction, tier: string): string {
  switch (tier) {
    case 'CORE': return t('sim.panel.tier_core');
    case 'IMPORTANT': return t('sim.panel.tier_important');
    case 'CROWD': return t('sim.panel.tier_crowd');
    default: return tier;
  }
}
