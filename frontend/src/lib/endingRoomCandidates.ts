import type { AgentInfo, AgentMessage, StoryData } from '../types';

export interface EndingRoomCandidate {
  id: string;
  name: string;
  role: string;
  persona?: string;
  contributionCount: number;
  keyMomentHits: number;
  lastRound: number;
  impactScore: number;
  fallbackCast: boolean;
  tier?: AgentInfo['tier'];
}

export function getEndingRoomCandidateVariantRank(candidate: Pick<EndingRoomCandidate, 'name' | 'role'>): number {
  const normalizedName = candidate.name.trim().toLowerCase().replace(/\s+/g, '');
  const normalizedRole = candidate.role.trim().toLowerCase().replace(/\s+/g, '');
  if (!normalizedName || !normalizedRole) return 0;

  const withoutNumericSuffix = normalizedName.replace(/\d+$/, '');
  if (normalizedName === normalizedRole || withoutNumericSuffix === normalizedRole) {
    return 1;
  }

  return 0;
}

export function buildBranchEndingRoomCandidates(params: {
  agents: AgentInfo[];
  branches: StoryData['branches'];
  messages: AgentMessage[];
  isZh: boolean;
}): Record<string, EndingRoomCandidate[]> {
  const { agents, branches, messages, isZh } = params;
  const candidatesByBranchId: Record<string, EndingRoomCandidate[]> = {};
  const messageStats = new Map<string, Map<string, { count: number; lastRound: number; keyMomentHits: number; name: string }>>();
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));

  for (const message of messages) {
    if (!message.branch || !message.agent_id) continue;
    const branchStats = messageStats.get(message.branch) ?? new Map<string, { count: number; lastRound: number; keyMomentHits: number; name: string }>();
    const current = branchStats.get(message.agent_id) ?? {
      count: 0,
      lastRound: 0,
      keyMomentHits: 0,
      name: agentById.get(message.agent_id)?.name ?? message.agent,
    };
    const branchKeyMoments = branches.find((branch) => branch.id === message.branch)?.key_moments ?? [];
    branchStats.set(message.agent_id, {
      count: current.count + 1,
      lastRound: Math.max(current.lastRound, message.round ?? 0),
      keyMomentHits: current.keyMomentHits + (
        branchKeyMoments.some((moment) => message.message.toLowerCase().includes(moment.toLowerCase())) ? 1 : 0
      ),
      name: current.name,
    });
    messageStats.set(message.branch, branchStats);
  }

  const tierRank: Record<AgentInfo['tier'], number> = {
    CORE: 0,
    IMPORTANT: 1,
    CROWD: 2,
  };

  for (const branch of branches) {
    const branchStats = messageStats.get(branch.id) ?? new Map<string, { count: number; lastRound: number; keyMomentHits: number; name: string }>();
    const sourceAgents = branchStats.size > 0
      ? [...branchStats.entries()].map(([agentId, stats]) => {
          const agent = agentById.get(agentId);
          return {
            id: agentId,
            name: agent?.name ?? stats.name,
            role: agent?.role ?? (isZh ? '当前世界线参与者' : 'Current worldline participant'),
            persona: agent?.persona ?? '',
            contributionCount: stats.count,
            keyMomentHits: stats.keyMomentHits,
            lastRound: stats.lastRound,
            tier: agent?.tier ?? 'CROWD',
            fallbackCast: !agent,
          } satisfies Omit<EndingRoomCandidate, 'impactScore'>;
        })
      : agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          persona: agent.persona,
          contributionCount: 0,
          keyMomentHits: 0,
          lastRound: 0,
          tier: agent.tier,
          fallbackCast: true,
        }));

    const maxImpactRaw = Math.max(
      1,
      ...sourceAgents.map((candidate) => (
        candidate.contributionCount * 1.1
        + candidate.keyMomentHits * 1.6
        + candidate.lastRound * 0.35
        + (candidate.tier ? (3 - tierRank[candidate.tier]) : 1) * 0.8
      )),
    );

    candidatesByBranchId[branch.id] = sourceAgents
      .map((candidate) => ({
        ...candidate,
        impactScore: Number(Math.min(
          0.99,
          (
            candidate.contributionCount * 1.1
            + candidate.keyMomentHits * 1.6
            + candidate.lastRound * 0.35
            + (candidate.tier ? (3 - tierRank[candidate.tier]) : 1) * 0.8
          ) / maxImpactRaw,
        ).toFixed(2)),
      }))
      .sort((left, right) => (
        right.impactScore - left.impactScore
        || right.keyMomentHits - left.keyMomentHits
        || right.contributionCount - left.contributionCount
        || right.lastRound - left.lastRound
        || getEndingRoomCandidateVariantRank(left) - getEndingRoomCandidateVariantRank(right)
        || tierRank[left.tier ?? 'CROWD'] - tierRank[right.tier ?? 'CROWD']
        || left.name.localeCompare(right.name, isZh ? 'zh-Hans' : 'en')
      ));
  }

  return candidatesByBranchId;
}
