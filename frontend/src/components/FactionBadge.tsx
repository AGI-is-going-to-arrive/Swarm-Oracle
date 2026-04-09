/* ═══════════════════════════════════════════════════════════
   P1-8 — Faction Badge
   Small colored pill showing a participant's faction affiliation.
   Used in transcript bubble headers (RoundtableTranscriptList,
   EndingChatModal) when faction data is available.
   ═══════════════════════════════════════════════════════════ */

import type { ParticipantFaction } from '../hooks/useFactionOverlay';

interface Props {
  faction: ParticipantFaction | undefined;
}

export function FactionBadge({ faction }: Props) {
  if (!faction) return null;
  return (
    <span
      className="faction-badge"
      title={faction.factionLabel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        padding: '1px 6px',
        borderRadius: 9,
        fontSize: '0.65rem',
        fontWeight: 600,
        lineHeight: 1.4,
        background: `${faction.color}22`,
        color: faction.color,
        border: `1px solid ${faction.color}44`,
        verticalAlign: 'middle',
        marginLeft: 4,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: faction.color,
          flexShrink: 0,
        }}
        aria-hidden="true"
      />
      {faction.factionLabel}
    </span>
  );
}
