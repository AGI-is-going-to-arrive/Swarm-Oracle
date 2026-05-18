import { describe, expect, it } from 'vitest';

import type { AgentInfo, BranchInfo } from '../types';
import { buildSharedChallengeSearch, readSharedChallengePayload } from '../lib/challengeShare';
import { GAMEPLAY_CONTRACT } from '../lib/gameplayContract';
import {
  getGameplayProfileLabel as getGameplayProfileSummaryLabel,
  getGameplayProfileSignatureHooks as getGameplayProfileSummaryHooks,
  resolveGameplayProfileId,
} from '../lib/gameplayProfileSummary';
import { GAMEPLAY_PROFILE_FRAME_ASSETS } from '../lib/themeRegistry';
import {
  buildAgentsById,
  buildGameplayAutoDirective,
  buildGameplayCardPrompt,
  getGameplayBadgeSrc,
  getGameplayCardDisplayModel,
  getGameplayProfileFrameSrc,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
  getScenarioSystemTrackState,
  getRecommendedGameplayCards,
  getSuggestedGameplayAgents,
  getSuggestedSourceBranchId,
  getDefaultGameplayTargetBranch,
  getGameplayCardDirectivePreview,
  getGameplayProfileTacticalState,
  inferGameplayProfile,
  isCounterplayCard,
  type GameplayCardId,
  type GameplayProfileId,
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

  it('builds backchannel pact prompt with two agents and a secret bargain', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'backchannel_pact',
      question: '如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？',
      sceneTheme: 'trade_harbor',
      profileId: 'trade',
      targetBranchTitle: '港口密议',
      agentsById: buildAgentsById(agents),
      primaryAgentId: 'a1',
      secondaryAgentId: 'a2',
      customDirective: '以通行税减免换取关键港区在 48 小时内配合静默封锁。',
      isZh: true,
    });

    expect(prompt).toContain('密约交易');
    expect(prompt).toContain('顾星河');
    expect(prompt).toContain('周凌云');
    expect(prompt).toContain('通行税减免');
    expect(prompt).toContain('私下达成一份暂不曝光的密约');
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

  it('builds evacuation order prompt as a branch-wide emergency order', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'evacuation_order',
      question: '如果跨大陆淡水供应在十年内枯竭，会发生什么？',
      sceneTheme: 'ecology_wasteland',
      profileId: 'ecology',
      targetBranchTitle: '阈值撤离',
      agentsById: buildAgentsById(agents),
      primaryAgentId: 'a1',
      customDirective: '优先撤离饮水断供区与儿童病患，并封锁即将失守的净化站。',
      isZh: true,
    });

    expect(prompt).toContain('撤离令');
    expect(prompt).toContain('顾星河');
    expect(prompt).toContain('阈值撤离');
    expect(prompt).toContain('优先撤离饮水断供区与儿童病患');
    expect(prompt).toContain('谁先撤');
  });

  it('builds public hearing prompt as an evidence-forcing event', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'public_hearing',
      question: '如果港口议会要求立刻冻结关税，会发生什么？',
      sceneTheme: 'trade_harbor',
      profileId: 'trade',
      targetBranchTitle: '港口僵局',
      agentsById: buildAgentsById(agents),
      customDirective: '要求商团、工会与税务方各自公开一条账本或补贴证据。',
      isZh: true,
    });

    expect(prompt).toContain('公开听证');
    expect(prompt).toContain('港口僵局');
    expect(prompt).toContain('账本或补贴证据');
    expect(prompt).toContain('至少让三个不同立场');
  });

  it('builds resource triage prompt as a survival-pressure event', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'resource_triage',
      question: '如果跨大陆淡水供应在十年内枯竭，会发生什么？',
      sceneTheme: 'ecology_wasteland',
      profileId: 'ecology',
      targetBranchTitle: '干旱阈值',
      agentsById: buildAgentsById(agents),
      customDirective: '优先保住淡水、迁徙走廊与防疫配给，其余工业扩张全部后撤。',
      isZh: true,
    });

    expect(prompt).toContain('资源分诊');
    expect(prompt).toContain('干旱阈值');
    expect(prompt).toContain('淡水、迁徙走廊与防疫配给');
    expect(prompt).toContain('谁先获得水、粮、药品');
  });

  it('builds forbidden ritual prompt as a high-cost mythic pivot', () => {
    const prompt = buildGameplayCardPrompt({
      cardId: 'forbidden_ritual',
      question: '如果一群法师在秘法圣所中试图改写巨龙契约，会发生什么？',
      sceneTheme: 'arcane_sanctum',
      profileId: 'mythic',
      targetBranchTitle: '龙契裂解',
      agentsById: buildAgentsById(agents),
      customDirective: '以禁术仪式重写龙契约，但必须公开献祭代价与王权后果。',
      isZh: true,
    });

    expect(prompt).toContain('禁术仪式');
    expect(prompt).toContain('龙契裂解');
    expect(prompt).toContain('献祭代价与王权后果');
    expect(prompt).toContain('可能不可逆');
  });

  it('uses contract directives for newly added counterplay cards', () => {
    const preview = getGameplayCardDirectivePreview('governance', 'audit_reckoning', true);
    expect(preview).toContain('责任账本');
    expect(preview).toContain('误判');
  });

  it('recommends counterplay cards when risk is high or resources are low', () => {
    const recommended = getRecommendedGameplayCards(
      'governance',
      [
        { cardId: 'forbidden_ritual', profileId: 'governance', round: 1 },
        { cardId: 'mandate_surge', profileId: 'governance', round: 2 },
      ],
      { active: true },
    );

    expect(recommended[0]).toBe('audit_reckoning');
    expect(isCounterplayCard(recommended[0])).toBe(true);
  });

  it('surfaces a profile-specific tactical note for law pressure states', () => {
    const tacticalState = getGameplayProfileTacticalState(
      'law',
      [
        { cardId: 'forbidden_ritual', profileId: 'law', round: 1 },
        { cardId: 'mandate_surge', profileId: 'law', round: 2 },
      ],
      { active: false },
      true,
    );

    expect(tacticalState.mode).toBe('pressure');
    expect(tacticalState.label).toBe('程序冻结');
    expect(tacticalState.focusCards).toContain('audit_reckoning');
    expect(tacticalState.note).toContain('例外条款');
  });

  it('computes scenario-level system tracks with commitment pressure', () => {
    const tracks = getScenarioSystemTrackState(
      'governance',
      [
        { cardId: 'public_hearing', profileId: 'governance', round: 1 },
        { cardId: 'resource_triage', profileId: 'governance', round: 2 },
      ],
      { active: true },
      true,
    );

    expect(tracks.riskValue).toBeGreaterThanOrEqual(0);
    expect(tracks.resourceValue).toBeGreaterThanOrEqual(0);
    expect(tracks.pressure).toBeTruthy();
  });

  it('ignores stale unknown card ids when computing derived track state', () => {
    const staleUsage = {
      cardId: 'missing_card',
      profileId: 'governance',
      round: 1,
    } as never;

    expect(() => getScenarioSystemTrackState('governance', [staleUsage], null, true)).not.toThrow();
    const tracks = getScenarioSystemTrackState('governance', [staleUsage], null, true);
    expect(tracks.riskValue).toBe(0);
    expect(tracks.resourceValue).toBe(3);
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
      inferGameplayProfile('如果所有大型组织都必须每周随机交换一次负责人，会发生什么？', 'modern_city').id,
    ).toBe('generic');
    expect(
      inferGameplayProfile('如果所有关键城市都必须每三十天由抽签产生的临时委员会接管，会发生什么？', 'modern_city').id,
    ).toBe('generic');
    expect(
      inferGameplayProfile('What if every high-stakes decision had to be re-approved by a rotating external review board?', 'modern_city').id,
    ).toBe('generic');
    expect(inferGameplayProfile('', 'switchboard_forum').id).toBe('generic');
    expect(
      inferGameplayProfile('如果一支远征舰队在荒芜边疆建立流动自治城邦，会发生什么？', 'space_station').id,
    ).toBe('frontier');
    expect(inferGameplayProfile('central bank liquidity run after credit default', 'modern_city').id).toBe('finance');
    expect(inferGameplayProfile('hospital triage after vaccine shortage and ICU overload', 'modern_city').id).toBe('medical');
    expect(inferGameplayProfile('chip platform cybersecurity incident in an open source stack', 'scifi_base').id).toBe('technology');
  });

  it('provides recommended cards and profile label', () => {
    expect(getRecommendedGameplayCards('governance')[0]).toBe('public_hearing');
    expect(getRecommendedGameplayCards('governance')).toContain('backchannel_pact');
    expect(getRecommendedGameplayCards('law')).toContain('mandate_surge');
    expect(getRecommendedGameplayCards('law')).toContain('public_hearing');
    expect(getRecommendedGameplayCards('trade')).toContain('backchannel_pact');
    expect(getRecommendedGameplayCards('ecology')[0]).toBe('resource_triage');
    expect(getRecommendedGameplayCards('ecology')).toContain('evacuation_order');
    expect(getRecommendedGameplayCards('survival')[0]).toBe('resource_triage');
    expect(getRecommendedGameplayCards('survival')).toContain('evacuation_order');
    expect(getRecommendedGameplayCards('faith')[0]).toBe('forbidden_ritual');
    expect(getRecommendedGameplayCards('mythic')[0]).toBe('forbidden_ritual');
    expect(getGameplayProfileLabel('war', true)).toBe('战争冲突');
    expect(getGameplayProfileFrameSrc('empire')).toContain('gameplay_card_frame_empire');
    expect(getGameplayProfileFrameSrc('trade')).toContain('gameplay_card_frame_trade');
    expect(getGameplayProfileFrameSrc('law')).toContain('gameplay_card_frame_law');
    expect(getGameplayProfileFrameSrc('faith')).toContain('gameplay_card_frame_faith');
    expect(getGameplayProfileFrameSrc('ecology')).toContain('gameplay_card_frame_ecology');
    expect(getGameplayProfileFrameSrc('generic')).toContain('gameplay_card_frame_generic');
    expect(getGameplayBadgeSrc('recommended')).toContain('badge_recommended');
    expect(getGameplayProfileSignatureHooks('trade', true)).toContain('关税杠杆');
    expect(getGameplayCardDirectivePreview('law', 'human_takeover', true)).toContain('暂停执行');
    expect(getGameplayCardDirectivePreview('trade', 'mandate_surge', true)).toContain('抵制浪潮');
    expect(getGameplayCardDirectivePreview('trade', 'backchannel_pact', true)).toContain('密约');
    expect(getGameplayCardDirectivePreview('ecology', 'evacuation_order', true)).toContain('撤离');
  });

  it('differentiates opening recommendations between trade and ecology', () => {
    expect(getRecommendedGameplayCards('trade').slice(0, 3)).toEqual([
      'backchannel_pact',
      'spy_infiltrate',
      'intel_blowback',
    ]);
    expect(getRecommendedGameplayCards('ecology').slice(0, 3)).toEqual([
      'resource_triage',
      'evacuation_order',
      'public_hearing',
    ]);
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

  it('suggests different agents for backchannel pact', () => {
    const { primaryAgentId, secondaryAgentId } = getSuggestedGameplayAgents('backchannel_pact', agents, 'trade');
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
    expect(getRecommendedGameplayCards('trade')).toContain('public_hearing');
    expect(getRecommendedGameplayCards('frontier')).toContain('resource_triage');
    expect(getRecommendedGameplayCards('faith')).toContain('forbidden_ritual');
    expect(getRecommendedGameplayCards('frontier')).toContain('evacuation_order');
    expect(getRecommendedGameplayCards('law')).toContain('backchannel_pact');
  });

  it('falls back to generic for unknown profile ids', () => {
    const unknownProfileId = 'unknown_profile' as GameplayProfileId;

    expect(getGameplayProfileLabel(unknownProfileId, false)).toBe('General Topics');
    expect(getGameplayProfileSignatureHooks(unknownProfileId, true)).toEqual(
      getGameplayProfileSignatureHooks('generic', true),
    );
    expect(getGameplayProfileFrameSrc(unknownProfileId)).toContain('gameplay_card_frame_generic');
    expect(getGameplayCardDirectivePreview(unknownProfileId, 'audit_reckoning', true)).toContain('公开责任');
    expect(getRecommendedGameplayCards(unknownProfileId).slice(0, 3)).toEqual(
      getRecommendedGameplayCards('generic').slice(0, 3),
    );
    expect(getGameplayProfileTacticalState(unknownProfileId, [], null, false).label).toBe('Center Probe');
    expect(getScenarioSystemTrackState(unknownProfileId, [], null, false).riskLabel).toBe('Tension Clock');
    expect(resolveGameplayProfileId('unknown_profile')).toBe('generic');
    expect(resolveGameplayProfileId('')).toBe('generic');
    expect(getGameplayProfileSummaryLabel('unknown_profile', false)).toBe('General Topics');
    expect(getGameplayProfileSummaryHooks('  ', true)).toEqual(
      getGameplayProfileSummaryHooks('generic', true),
    );

    const sharedPayload = readSharedChallengePayload(new URLSearchParams(
      '?sharedChallenge=1&question=What+if%3F&rounds=4&agents=5&mode=blackboard&viz=1&profile=unknown_profile',
    ));
    expect(sharedPayload?.profileId).toBe('generic');
    const emptyProfilePayload = readSharedChallengePayload(new URLSearchParams(
      '?sharedChallenge=1&question=What+if%3F&rounds=4&agents=5&mode=blackboard&viz=1&profile=',
    ));
    expect(emptyProfilePayload?.profileId).toBe('generic');

    const sharedSearch = buildSharedChallengeSearch({
      question: 'What if?',
      rounds: 4,
      numAgents: 5,
      mode: 'blackboard',
      visualizationEnabled: true,
      profileId: unknownProfileId,
    });
    expect(new URLSearchParams(sharedSearch).get('profile')).toBe('generic');
  });

  it('keeps shared gameplay contract synchronized with frontend profile and card ids', () => {
    const contractCardIds = new Set(GAMEPLAY_CONTRACT.cards.map((card) => card.id));
    const contractProfileIds = new Set(GAMEPLAY_CONTRACT.profiles.map((profile) => profile.id));
    const frontendProfileIds = Object.keys(GAMEPLAY_PROFILE_FRAME_ASSETS).filter((profileId) => profileId !== 'generic');

    expect([...contractProfileIds]).toEqual(expect.arrayContaining(frontendProfileIds));

    for (const profile of GAMEPLAY_CONTRACT.profiles) {
      expect(new Set(Object.keys(profile.default_directives))).toEqual(contractCardIds);
      expect(profile.recommended_cards.every((cardId) => contractCardIds.has(cardId))).toBe(true);
    }
  });

  it('keeps homepage profile labels and hooks synchronized with the shared contract', () => {
    for (const profile of GAMEPLAY_CONTRACT.profiles) {
      const profileId = profile.id as GameplayProfileId;
      expect(getGameplayProfileSummaryLabel(profileId, true)).toBe(profile.labels.zh);
      expect(getGameplayProfileSummaryLabel(profileId, false)).toBe(profile.labels.en);
      expect(getGameplayProfileSummaryHooks(profileId, true)).toEqual(profile.signature_hooks.zh);
      expect(getGameplayProfileSummaryHooks(profileId, false)).toEqual(profile.signature_hooks.en);
    }
  });

  it('returns at most 3 recommended cards in the display model', () => {
    const model = getGameplayCardDisplayModel('governance');
    expect(model.recommended.length).toBeLessThanOrEqual(3);
    expect(model.recommended.length).toBeGreaterThan(0);
  });

  it('partitions cards into four named groups without recommended overlap', () => {
    const model = getGameplayCardDisplayModel('governance');
    expect(model.groups.map((group) => group.id)).toEqual([
      'role_play',
      'worldline_distort',
      'crisis_dispatch',
      'counter_cool',
    ]);
    const allGrouped: GameplayCardId[] = model.groups.flatMap((group) => group.cardIds);
    for (const cardId of allGrouped) {
      expect(model.recommended).not.toContain(cardId);
    }
  });

  it('places counter cards under counter_cool group', () => {
    const model = getGameplayCardDisplayModel('generic');
    const counterCool = model.groups.find((group) => group.id === 'counter_cool');
    expect(counterCool?.cardIds).toEqual(
      expect.arrayContaining(['audit_reckoning', 'intel_blowback', 'mandate_snapback', 'ceasefire_committee']),
    );
  });

  it('uses scenarioContext to bias recommended cards', () => {
    const baseline = getGameplayCardDisplayModel('governance');
    const pressured = getGameplayCardDisplayModel('governance', {
      usages: [
        { cardId: 'forbidden_ritual', profileId: 'governance', round: 1 },
        { cardId: 'mandate_surge', profileId: 'governance', round: 2 },
      ],
      commitment: { active: true },
    });
    expect(pressured.recommended[0]).toBe('audit_reckoning');
    expect(baseline.recommended).not.toEqual(pressured.recommended);
  });

  it('falls back to generic profile for unknown ids in display model', () => {
    const model = getGameplayCardDisplayModel('unknown_profile');
    expect(model.recommended.length).toBeGreaterThan(0);
    expect(model.groups).toHaveLength(4);
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
