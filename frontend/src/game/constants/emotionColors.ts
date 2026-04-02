/** Emotion-to-halo color mapping shared between PhaserGame and VizSynthesizer. */
export const EMOTION_HALO_COLORS: Record<string, string> = {
  aggressive: '#ff0000',
  angry: '#ff3300',
  anxious: '#ff9900',
  fearful: '#ff6600',
  cautious: '#ffcc00',
  calm: '#66ccff',
  hopeful: '#00cc66',
  cooperative: '#33cc33',
  confident: '#6699ff',
  neutral: '#999999',
};

export const EMOTION_HALO_FALLBACK = '#999999';

/** Look up the halo color for a given emotion string. */
export function emotionToHaloColor(emotion: string): string {
  return EMOTION_HALO_COLORS[emotion] || EMOTION_HALO_FALLBACK;
}
