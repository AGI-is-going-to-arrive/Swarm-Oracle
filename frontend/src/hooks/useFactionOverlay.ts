/* ═══════════════════════════════════════════════════════════
   P1-8 — Faction Overlay Hook
   Maps participantId → faction info for transcript badge rendering.
   Fetches faction timeline per branch and merges results so each
   participant is mapped through their own source_branch_id.
   ═══════════════════════════════════════════════════════════ */

import { useEffect, useMemo, useState } from 'react';
import type { EndingRoomParticipant } from '../types';
import { getFactionTimeline } from '../api/client';

interface FactionInfo {
  key: string;
  label: string | null;
  members: string[];
}

interface RoundFactionData {
  round: number;
  factions: FactionInfo[];
}

export interface ParticipantFaction {
  factionKey: string;
  factionLabel: string;
  color: string;
}

const FACTION_COLORS = [
  '#4a90d9', '#e74c3c', '#2ecc71', '#9b59b6',
  '#e67e22', '#1abc9c', '#f1c40f', '#e91e63',
];

/**
 * Given a scenarioId and participants map, fetches faction timelines
 * for each unique source_branch_id and builds a per-participant lookup.
 *
 * For single-branch use (EndingChatModal), pass branchId directly and
 * only one fetch is made. For multi-branch (roundtable), branchId
 * can be omitted — the hook discovers branches from participants.
 */
export function useFactionOverlay(
  scenarioId: string | undefined,
  branchId: string | undefined,
  participantsById: Map<string, EndingRoomParticipant>,
): Map<string, ParticipantFaction> {
  const [factionMap, setFactionMap] = useState<Map<string, ParticipantFaction>>(new Map());

  // Collect unique branch IDs from participants, or use the single branchId
  const branchIds = useMemo(() => {
    if (branchId) return [branchId];
    const ids = new Set<string>();
    for (const p of participantsById.values()) {
      if (p.source_branch_id) ids.add(p.source_branch_id);
    }
    return [...ids];
  }, [branchId, participantsById]);

  useEffect(() => {
    if (!scenarioId || branchIds.length === 0 || participantsById.size === 0) {
      setFactionMap(new Map());
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // Fetch faction timelines for all branches in parallel
        const results = await Promise.all(
          branchIds.map(bid =>
            getFactionTimeline(scenarioId, bid)
              .then(data => ({ branchId: bid, data: data as RoundFactionData[] }))
              .catch(() => ({ branchId: bid, data: [] as RoundFactionData[] }))
          ),
        );
        if (cancelled) return;

        // Build agent_id → faction from last round of each branch
        // Collect all faction keys across all branches for consistent coloring
        const allFactionKeys = new Set<string>();
        const branchAgentFactions = new Map<string, Map<string, { key: string; label: string }>>();

        for (const { branchId: bid, data } of results) {
          if (data.length === 0) continue;
          const lastRound = data[data.length - 1];
          const agentMap = new Map<string, { key: string; label: string }>();
          for (const faction of lastRound.factions) {
            allFactionKeys.add(faction.key);
            for (const agentId of faction.members) {
              agentMap.set(agentId, {
                key: faction.key,
                label: faction.label ?? faction.key,
              });
            }
          }
          branchAgentFactions.set(bid, agentMap);
        }

        // Stable color assignment across all branches
        const factionKeyArr = [...allFactionKeys];
        const colorMap = Object.fromEntries(
          factionKeyArr.map((k, i) => [k, FACTION_COLORS[i % FACTION_COLORS.length]])
        );

        // Map each participant through their own branch's faction data
        const result = new Map<string, ParticipantFaction>();
        for (const [pid, participant] of participantsById) {
          const agentId = participant.source_agent_id;
          const pBranch = participant.source_branch_id;
          if (!agentId || !pBranch) continue;

          const agentMap = branchAgentFactions.get(pBranch);
          if (!agentMap) continue;

          const faction = agentMap.get(agentId);
          if (faction) {
            result.set(pid, {
              factionKey: faction.key,
              factionLabel: faction.label,
              color: colorMap[faction.key] ?? '#888',
            });
          }
        }

        setFactionMap(result);
      } catch {
        // Non-critical — faction overlay is decorative
      }
    })();

    return () => { cancelled = true; };
  }, [scenarioId, branchIds, participantsById]);

  return factionMap;
}
