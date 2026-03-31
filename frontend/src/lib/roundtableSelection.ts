import type { StoryData } from '../types';
import type { EndingRoomCandidate } from './endingRoomCandidates';

export type CandidateVoiceVariant =
  | 'imperial'
  | 'field'
  | 'finance'
  | 'market'
  | 'faith'
  | 'industry'
  | 'frontier'
  | 'survival'
  | 'scholar'
  | 'civic'
  | 'plain';

export function detectCandidateVoiceVariant(candidate: Pick<EndingRoomCandidate, 'name' | 'role' | 'persona'>): CandidateVoiceVariant {
  const normalized = `${candidate.name} ${candidate.role} ${candidate.persona ?? ''}`.trim().toLowerCase();
  if (/(皇|king|queen|emperor|crown|court)/u.test(normalized)) return 'imperial';
  if (/(将|统帅|指挥官|舰队|commander|captain|marshal|fleet|guard)/u.test(normalized)) return 'field';
  if (/(银行|行长|财政|金融|清算|流动性|bank|banker|finance|treasury|settlement|liquidity)/u.test(normalized)) return 'finance';
  if (/(摊主|商户|商贩|市场|港口|贸易|货运|vendor|merchant|market|port|trade|freight)/u.test(normalized)) return 'market';
  if (/(祭司|祭坛|神官|神谕|priest|cleric|oracle|temple|faith|ritual|covenant)/u.test(normalized)) return 'faith';
  if (/(工程|工厂|电网|产能|后勤|调度|engineer|factory|industrial|grid|throughput|logistics|plant)/u.test(normalized)) return 'industry';
  if (/(边疆|拓荒|殖民|轨道|补给舱|生命维持|pilot|orbital|frontier|colony|expedition|convoy|airlock|life support)/u.test(normalized)) return 'frontier';
  if (/(避难|药品|口粮|撤离|医疗|scout|medic|refuge|ration|evacuation|shelter|survival)/u.test(normalized)) return 'survival';
  if (/(史官|书记官|学者|档案|证人|scribe|scholar|historian|witness|record|ledger|clerk)/u.test(normalized)) return 'scholar';
  if (/(议长|书记|委员|minister|speaker|council|administrator|governor|civic)/u.test(normalized)) return 'civic';
  return 'plain';
}

export function chooseRepresentativeDefaults(
  branchOrder: string[],
  branchCandidates: Record<string, EndingRoomCandidate[]>,
  current: Record<string, string>,
): { next: Record<string, string>; changed: boolean } {
  const next: Record<string, string> = {};
  const reservedAgentIds = new Set<string>();
  let changed = false;

  for (const branchId of branchOrder) {
    const candidates = branchCandidates[branchId] ?? [];
    const currentAgentId = current[branchId];
    const currentStillValid = currentAgentId && candidates.some((candidate) => candidate.id === currentAgentId);

    if (currentStillValid) {
      next[branchId] = currentAgentId;
      reservedAgentIds.add(currentAgentId);
      continue;
    }

    const fallbackCandidate = candidates[0];
    const diversifiedCandidate = candidates.find((candidate) => !reservedAgentIds.has(candidate.id));
    const chosenAgentId = diversifiedCandidate?.id ?? fallbackCandidate?.id;
    if (chosenAgentId) {
      next[branchId] = chosenAgentId;
      reservedAgentIds.add(chosenAgentId);
    }
    if (currentAgentId !== chosenAgentId) {
      changed = true;
    }
  }

  return { next, changed };
}

export function chooseTraitMixRepresentatives(
  branchOrder: string[],
  branchCandidates: Record<string, EndingRoomCandidate[]>,
  current: Record<string, string>,
): { next: Record<string, string>; changed: boolean } {
  // Trait-mix should be stable relative to the neutral default roster, not
  // relative to the already-mixed current selection.
  const defaultRepresentatives = chooseRepresentativeDefaults(branchOrder, branchCandidates, {}).next;
  const next = { ...defaultRepresentatives };
  const usedVariants = new Map<CandidateVoiceVariant, number>();

  branchOrder.forEach((branchId, branchIndex) => {
    const candidates = branchCandidates[branchId] ?? [];
    if (candidates.length === 0) return;
    const rotationIndex = branchIndex % candidates.length;
    const rotated = [
      ...candidates.slice(rotationIndex),
      ...candidates.slice(0, rotationIndex),
    ];
    const ranked = rotated.sort((left, right) => {
      const leftVariant = detectCandidateVoiceVariant(left);
      const rightVariant = detectCandidateVoiceVariant(right);
      const leftScore = Math.round(left.impactScore * 100)
        + left.keyMomentHits * 14
        + left.contributionCount * 5
        + left.lastRound
        + ((usedVariants.get(leftVariant) ?? 0) === 0 ? 38 : 0)
        - (usedVariants.get(leftVariant) ?? 0) * 28
        - (leftVariant === 'plain' ? 10 : 0)
        - (left.fallbackCast ? 6 : 0)
        + (defaultRepresentatives[branchId] === left.id ? 2 : 0);
      const rightScore = Math.round(right.impactScore * 100)
        + right.keyMomentHits * 14
        + right.contributionCount * 5
        + right.lastRound
        + ((usedVariants.get(rightVariant) ?? 0) === 0 ? 38 : 0)
        - (usedVariants.get(rightVariant) ?? 0) * 28
        - (rightVariant === 'plain' ? 10 : 0)
        - (right.fallbackCast ? 6 : 0)
        + (defaultRepresentatives[branchId] === right.id ? 2 : 0);
      return rightScore - leftScore || right.name.localeCompare(left.name);
    });
    const chosen = ranked[0];
    if (!chosen) return;
    next[branchId] = chosen.id;
    const chosenVariant = detectCandidateVoiceVariant(chosen);
    usedVariants.set(chosenVariant, (usedVariants.get(chosenVariant) ?? 0) + 1);
  });

  const stayedDefault = branchOrder.every((branchId) => (
    next[branchId] != null && next[branchId] === defaultRepresentatives[branchId]
  ));
  if (stayedDefault) {
    for (const [branchIndex, branchId] of branchOrder.entries()) {
      const candidates = branchCandidates[branchId] ?? [];
      const alternative = candidates[(branchIndex + 1) % candidates.length];
      if (!alternative) continue;
      next[branchId] = alternative.id;
      break;
    }
  }

  const changed = branchOrder.some((branchId) => next[branchId] !== current[branchId]);
  return { next, changed };
}

export function extractBranchLexicon(branch: { title: string; insight: string; key_moments?: StoryData['branches'][number]['key_moments'] }): Set<string> {
  const joined = `${branch.title} ${branch.insight} ${(branch.key_moments ?? []).join(' ')}`.toLowerCase();
  return new Set(joined.match(/[\p{L}\p{N}_-]+/gu) ?? []);
}
