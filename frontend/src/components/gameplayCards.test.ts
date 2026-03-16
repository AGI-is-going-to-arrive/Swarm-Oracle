import { describe, expect, it } from 'vitest';

import type { AgentInfo, BranchInfo } from '../types';
import {
  buildAgentsById,
  buildGameplayAutoDirective,
  buildGameplayCardPrompt,
  getGameplayBadgeSrc,
  getGameplayProfileFrameSrc,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
  getRecommendedGameplayCards,
  getSuggestedGameplayAgents,
  getSuggestedSourceBranchId,
  getDefaultGameplayTargetBranch,
  getGameplayCardDirectivePreview,
  inferGameplayProfile,
} from './gameplayCards';

const agents: AgentInfo[] = [
  { id: 'a1', name: '顾星河', role: '算法治理理事会主席', tier: 'CORE', emotion: 'neutral' },
  { id: 'a2', name: '周凌云', role: '基层联盟代表', tier: 'CORE', emotion: 'neutral' },
  { id: 'a3', name: 'Milan', role: 'council chair', tier: 'IMPORTANT', emotion: 'neutral' },
];

const branches: BranchInfo[] = [
  {
    id: 'b1',
    parent_branch_id: null,
    fork_round: 0,
    fork_reason: '',
    title: '算法登基',
    summary: '',
    story: '',
    insight: '',
    key_moments: [],
    probability: 1,
    status: 'ACTIVE',
  },
  {
    id: 'b2',
    parent_branch_id: 'b1',
    fork_round: 2,
    fork_reason: '',
    title: '人机共治',
    summary: '',
    story: '',
    insight: '',
    key_moments: [],
    probability: 0.45,
    status: 'COMPLETED',
  },
];

describe('gameplayCards helpers', () => {
  it('picks the first active branch as default target', () => {
    expect(getDefaultGameplayTargetBranch(branches)).toBe('b1');
  });

  it('builds civilization debate prompt with both agents', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'civilization_debate',
      question: '如果人工智能统治世界？',
      sceneTheme: 'scifi_base',
      profileId: 'governance',
      targetBranchTitle: '算法登基',
      agentsById: buildAgentsById(agents),
      primaryAgentId: 'a1',
      secondaryAgentId: 'a2',
      customDirective: '算法是否应该压过民意',
      isZh: true,
    });

    expect(prompt).toContain('顾星河');
    expect(prompt).toContain('周凌云');
    expect(prompt).toContain('算法是否应该压过民意');
    expect(prompt).toContain('高优先级玩法卡事件');
    expect(prompt).toContain('持续生效');
  });

  it('builds spy infiltration prompt in english', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'spy_infiltrate',
      question: 'What if AI ruled the world?',
      sceneTheme: 'scifi_base',
      profileId: 'governance',
      targetBranchTitle: 'Human Oversight',
      agentsById: buildAgentsById(agents),
      primaryAgentId: 'a3',
      customDirective: 'Quietly redirect security policy toward central control.',
      isZh: false,
    });

    expect(prompt).toContain('Milan');
    expect(prompt).toContain('Quietly redirect security policy toward central control.');
    expect(prompt).toContain('covert infiltrator');
    expect(prompt).toContain('HIGH-PRIORITY GAMEPLAY EVENT');
    expect(prompt).toContain('Persistent effect');
  });

  it('builds spacetime rift prompt with source branch', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'spacetime_rift',
      question: '如果人工智能统治世界？',
      sceneTheme: 'scifi_base',
      profileId: 'governance',
      targetBranchTitle: '算法登基',
      sourceBranchTitle: '人机共治',
      agentsById: buildAgentsById(agents),
      customDirective: '另一条时间线显示算法治理最终被地方议会限制。',
      isZh: true,
    });

    expect(prompt).toContain('人机共治');
    expect(prompt).toContain('地方议会限制');
  });

  it('builds mandate surge prompt without agent bindings', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'mandate_surge',
      question: '如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？',
      sceneTheme: 'modern_city',
      profileId: 'law',
      targetBranchTitle: '法律急刹',
      agentsById: buildAgentsById(agents),
      customDirective: '街头与法律社群要求公开证据并冻结争议政策。',
      isZh: true,
    });

    expect(prompt).toContain('民意浪潮');
    expect(prompt).toContain('法律急刹');
    expect(prompt).toContain('公开证据并冻结争议政策');
    expect(prompt).toContain('所有 agent 都必须明确表态');
  });

  it('infers gameplay profiles from theme and question', () => {
    expect(inferGameplayProfile('如果人工智能统治世界？', 'scifi_base').id).toBe('governance');
    expect(inferGameplayProfile('citizens assembly after election crisis', 'civic_chamber').id).toBe('governance');
    expect(inferGameplayProfile('platform state with social credit checkpoints', 'surveillance_megacity').id).toBe('governance');
    expect(inferGameplayProfile('如果世界大战全面爆发？', 'war_battlefield').id).toBe('war');
    expect(inferGameplayProfile('如果世界大战在高度自动化军备时代再次爆发？', 'war_command').id).toBe('war');
    expect(inferGameplayProfile('supply line collapse at a fortified logistics hub', 'logistics_hub').id).toBe('war');
    expect(inferGameplayProfile('如果罗马帝国从未衰落？', 'ancient_empire').id).toBe('empire');
    expect(inferGameplayProfile('roman senate power struggle', 'imperial_forum').id).toBe('empire');
    expect(inferGameplayProfile('succession crisis inside a dynastic palace', 'dynastic_palace').id).toBe('empire');
    expect(inferGameplayProfile('resource bottleneck in a massive foundry complex', 'factory_foundry').id).toBe('industry');
    expect(inferGameplayProfile('blackout cascade inside a continental power grid nexus', 'power_grid_nexus').id).toBe('industry');
    expect(inferGameplayProfile('如果港口关税联盟突然瓦解？', 'modern_city').id).toBe('trade');
    expect(inferGameplayProfile('如果最高法院否决算法宪章？', 'scifi_base').id).toBe('law');
    expect(inferGameplayProfile('如果神谕教会统治王国？', 'fantasy_kingdom').id).toBe('faith');
    expect(inferGameplayProfile('如果水源枯竭引发边境迁徙？', 'desert_outpost').id).toBe('ecology');
    expect(
      inferGameplayProfile('如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？', 'law_court').id,
    ).toBe('law');
    expect(
      inferGameplayProfile('如果一则神谕成为整个王国唯一合法的统治依据，会发生什么？', 'faith_temple').id,
    ).toBe('faith');
    expect(
      inferGameplayProfile('如果跨大陆淡水供应在十年内枯竭，会发生什么？', 'ecology_wasteland').id,
    ).toBe('ecology');
    expect(inferGameplayProfile('如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？', 'trade_harbor').id).toBe('trade');
    expect(inferGameplayProfile('autonomous city-state on a frontier colony', 'frontier_colony').id).toBe('frontier');
    expect(inferGameplayProfile('arcane wizard conclave in a rune sanctuary', 'arcane_sanctum').id).toBe('mythic');
    expect(inferGameplayProfile('如果一群法师在秘法圣所中试图改写巨龙契约，会发生什么？', 'arcane_sanctum').id).toBe('mythic');
    expect(inferGameplayProfile('fortified quarantine refuge after famine', 'refuge_compound').id).toBe('survival');
    expect(
      inferGameplayProfile('如果一支远征舰队在荒芜边疆建立流动自治城邦，会发生什么？', 'space_station').id,
    ).toBe('frontier');
  });

  it('provides recommended cards and profile label', () => {
    expect(getRecommendedGameplayCards('governance')[0]).toBe('civilization_debate');
    expect(getRecommendedGameplayCards('law')).toContain('mandate_surge');
    expect(getGameplayProfileLabel('war', true)).toBe('战争抉择');
    expect(getGameplayProfileFrameSrc('empire')).toContain('gameplay_card_frame_empire');
    expect(getGameplayProfileFrameSrc('trade')).toContain('gameplay_card_frame_trade');
    expect(getGameplayProfileFrameSrc('law')).toContain('gameplay_card_frame_law');
    expect(getGameplayProfileFrameSrc('faith')).toContain('gameplay_card_frame_faith');
    expect(getGameplayProfileFrameSrc('ecology')).toContain('gameplay_card_frame_ecology');
    expect(getGameplayBadgeSrc('recommended')).toContain('badge_recommended');
    expect(getGameplayProfileSignatureHooks('trade', true)).toContain('关税杠杆');
    expect(getGameplayCardDirectivePreview('law', 'human_takeover', true)).toContain('暂停执行');
    expect(getGameplayCardDirectivePreview('trade', 'mandate_surge', true)).toContain('抵制浪潮');
  });

  it('suggests agents based on stance for debate', () => {
    const { primaryAgentId, secondaryAgentId } = getSuggestedGameplayAgents('civilization_debate', [
      ...agents,
      { id: 'a4', name: '反对派', role: '反对派', tier: 'CORE', emotion: 'neutral', stance: '反对' },
      { id: 'a5', name: '支持派', role: '支持派', tier: 'CORE', emotion: 'neutral', stance: '支持' },
    ]);

    expect(primaryAgentId).toBeTruthy();
    expect(secondaryAgentId).toBeTruthy();
    expect(primaryAgentId).not.toBe(secondaryAgentId);
  });

  it('chooses a contrasting source branch when possible', () => {
    expect(getSuggestedSourceBranchId(branches, 'b1')).toBe('b2');
  });

  it('builds themed auto directives', () => {
    const directive = buildGameplayAutoDirective({
      cardId: 'human_takeover',
      question: '如果人工智能统治世界？',
      sceneTheme: 'scifi_base',
      profileId: 'governance',
      isZh: true,
    });

    expect(directive).toContain('如果人工智能统治世界');
    expect(directive).toContain('scifi_base');
  });

  it('keeps mandate surge in the recommended rotation for thematic profiles', () => {
    expect(getRecommendedGameplayCards('governance')).toContain('mandate_surge');
    expect(getRecommendedGameplayCards('frontier')).toContain('mandate_surge');
  });

  it('builds mandate surge prompts as branch-wide legitimacy shocks', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'mandate_surge',
      question: '如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？',
      sceneTheme: 'desert_outpost',
      profileId: 'trade',
      targetBranchTitle: '商团锁闸',
      agentsById: buildAgentsById(agents),
      customDirective: '港口工会与沿岸城市同时要求公开通行费账本并暂停封锁。',
      isZh: true,
    });

    expect(prompt).toContain('Mandate Surge');
    expect(prompt).toContain('商团锁闸');
    expect(prompt).toContain('港口工会与沿岸城市同时要求公开通行费账本并暂停封锁');
    expect(prompt).toContain('所有 agent 都必须明确表态');
  });
});
