import type { AgentInfo, BranchInfo } from '../types';

export type GameplayCardId =
  | 'civilization_debate'
  | 'spy_infiltrate'
  | 'human_takeover'
  | 'spacetime_rift'
  | 'mandate_surge';

export interface GameplayCardDefinition {
  id: GameplayCardId;
  icon: string;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  animation: string;
}

export interface GameplayCardPromptInput {
  cardId: GameplayCardId;
  question: string;
  sceneTheme?: string | null;
  profileId: GameplayProfileId;
  targetBranchTitle: string;
  agentsById: Record<string, AgentInfo>;
  primaryAgentId?: string;
  secondaryAgentId?: string;
  sourceBranchTitle?: string;
  customDirective?: string;
  isZh: boolean;
}

export type GameplayProfileId =
  | 'governance'
  | 'war'
  | 'empire'
  | 'industry'
  | 'trade'
  | 'law'
  | 'faith'
  | 'ecology'
  | 'frontier'
  | 'mythic'
  | 'survival'
  | 'generic';

export const GAMEPLAY_PROFILE_FRAME_ASSETS: Record<GameplayProfileId, string> = {
  governance: '/assets/ui/generated/gameplay_card_frame_governance.png',
  war: '/assets/ui/generated/gameplay_card_frame_war.png',
  empire: '/assets/ui/generated/gameplay_card_frame_empire.png',
  industry: '/assets/ui/generated/gameplay_card_frame_industry.png',
  trade: '/assets/ui/generated/gameplay_card_frame_trade.png',
  law: '/assets/ui/generated/gameplay_card_frame_law.png',
  faith: '/assets/ui/generated/gameplay_card_frame_faith.png',
  ecology: '/assets/ui/generated/gameplay_card_frame_ecology.png',
  frontier: '/assets/ui/generated/gameplay_card_frame_frontier.png',
  mythic: '/assets/ui/generated/gameplay_card_frame_mythic.png',
  survival: '/assets/ui/generated/gameplay_card_frame_survival.png',
  generic: '/assets/ui/generated/gameplay_panel.png',
};

export const GAMEPLAY_BADGE_ASSETS = {
  recommended: '/assets/ui/generated/badge_recommended.png',
  dailyChallenge: '/assets/ui/generated/badge_daily_challenge.png',
  archiveRecord: '/assets/ui/generated/badge_archive_record.png',
  betWinner: '/assets/ui/generated/badge_bet_winner.png',
} as const;

export type GameplayBadgeId =
  | 'recommended'
  | 'daily_challenge'
  | 'archive_record'
  | 'bet_winner';

interface GameplayProfileDefinition {
  id: GameplayProfileId;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  signatureHooksZh: string[];
  signatureHooksEn: string[];
  recommendedCards: GameplayCardId[];
  defaultDirectives: Record<GameplayCardId, { zh: string; en: string }>;
}

interface GameplayProfileHeuristics {
  primaryRoleKeywords?: string[];
  secondaryRoleKeywords?: string[];
  sourceBranchKeywords?: string[];
}

export const GAMEPLAY_CARD_DEFS: GameplayCardDefinition[] = [
  {
    id: 'civilization_debate',
    icon: '🗣️',
    labelZh: '文明辩论',
    labelEn: 'Civilization Debate',
    descriptionZh: '强制两名角色公开交锋，其他人必须回应这场辩论。',
    descriptionEn: 'Force two agents into a public debate and make others react to it.',
    animation: 'debate_spotlight',
  },
  {
    id: 'spy_infiltrate',
    icon: '🕵️',
    labelZh: '间谍渗透',
    labelEn: 'Spy Infiltration',
    descriptionZh: '让一名角色带着隐藏议程发言，扰动局势。',
    descriptionEn: 'Give one agent a hidden agenda that disturbs the simulation.',
    animation: 'shadow_reveal',
  },
  {
    id: 'human_takeover',
    icon: '🧑',
    labelZh: '人类潜入',
    labelEn: 'Human Takeover',
    descriptionZh: '由用户接管一名角色一轮发言，把输入直接注入世界线。',
    descriptionEn: 'Let the user take over one agent for a round and inject direct intent.',
    animation: 'player_swap',
  },
  {
    id: 'spacetime_rift',
    icon: '🌀',
    labelZh: '时空裂缝',
    labelEn: 'Space-Time Rift',
    descriptionZh: '把另一条世界线的一条信息泄漏到当前分支，制造外源扰动。',
    descriptionEn: 'Leak one signal from another branch into the current branch.',
    animation: 'portal_open',
  },
  {
    id: 'mandate_surge',
    icon: '📣',
    labelZh: '民意浪潮',
    labelEn: 'Mandate Surge',
    descriptionZh: '注入一波突发民意或合法性冲击，迫使整条世界线立刻重新站位。',
    descriptionEn: 'Inject a sudden legitimacy shock that forces the whole branch to reposition.',
    animation: 'mandate_surge',
  },
];

const GAMEPLAY_PROFILES: Record<GameplayProfileId, GameplayProfileDefinition> = {
  governance: {
    id: 'governance',
    labelZh: '治理博弈',
    labelEn: 'Governance Conflict',
    descriptionZh: '适合 AI 治理、民主、制度与权力分配类问题。',
    descriptionEn: 'Fits AI governance, democracy, institutions, and power allocation.',
    signatureHooksZh: ['主权边界', '算法否决', '地方复核'],
    signatureHooksEn: ['Sovereignty lines', 'Algorithmic vetoes', 'Local review'],
    recommendedCards: ['civilization_debate', 'mandate_surge', 'human_takeover', 'spy_infiltrate', 'spacetime_rift'],
    defaultDirectives: {
      civilization_debate: {
        zh: '算法是否应拥有最终否决权，还是必须接受地方人类审议。',
        en: 'Should the algorithm hold final veto power, or remain subject to local human review?',
      },
      spy_infiltrate: {
        zh: '暗中推动中央权力扩张，同时伪装成温和改革派。',
        en: 'Quietly expand central control while sounding like a moderate reformer.',
      },
      human_takeover: {
        zh: '暂停自动裁决，先恢复人工复核与地方问责。',
        en: 'Pause automatic rule and restore human review plus local accountability.',
      },
      spacetime_rift: {
        zh: '另一条时间线显示，算法统治最终因基层反叛而被迫让权。',
        en: 'Another timeline shows algorithmic rule being forced to cede power after a grassroots revolt.',
      },
      mandate_surge: {
        zh: '各地城市同步爆发要求人工复核与地方问责的民意浪潮。',
        en: 'Cities erupt in a synchronized mandate demanding human review and local accountability.',
      },
    },
  },
  war: {
    id: 'war',
    labelZh: '战争抉择',
    labelEn: 'War Doctrine',
    descriptionZh: '适合战争、入侵、边疆冲突和军事扩张类问题。',
    descriptionEn: 'Fits war, invasion, border conflict, and military escalation.',
    signatureHooksZh: ['停火窗口', '后勤断点', '误判升级'],
    signatureHooksEn: ['Ceasefire windows', 'Logistics breaks', 'Escalation by mistake'],
    recommendedCards: ['civilization_debate', 'mandate_surge', 'spy_infiltrate', 'spacetime_rift', 'human_takeover'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应当继续全面进攻，还是转向补给稳固与防线收缩。',
        en: 'Should the branch keep pushing a full offensive or pivot toward logistics and defense?',
      },
      spy_infiltrate: {
        zh: '暗中破坏后勤协同，把注意力引向一次冒险突击。',
        en: 'Quietly sabotage logistics coordination and redirect attention toward a reckless strike.',
      },
      human_takeover: {
        zh: '立刻宣布停火窗口，用人类谈判压制升级冲动。',
        en: 'Announce an immediate ceasefire window and force a human-led negotiation pause.',
      },
      spacetime_rift: {
        zh: '另一条战线泄漏的情报显示，继续强攻会导致补给线崩溃。',
        en: 'Leaked intel from another front shows that continued assault will collapse the supply line.',
      },
      mandate_surge: {
        zh: '后方城镇与退役军团突然要求停火、清算误判并公开补给真相。',
        en: 'Home-front cities and veteran legions surge with demands for ceasefire, accountability, and supply transparency.',
      },
    },
  },
  empire: {
    id: 'empire',
    labelZh: '帝国统合',
    labelEn: 'Imperial Balance',
    descriptionZh: '适合帝国、王朝、君主制、历史秩序维持类问题。',
    descriptionEn: 'Fits empires, dynasties, monarchies, and historical order maintenance.',
    signatureHooksZh: ['中央与行省', '宫廷裂缝', '军团忠诚'],
    signatureHooksEn: ['Center vs provinces', 'Court fractures', 'Legion loyalty'],
    recommendedCards: ['civilization_debate', 'mandate_surge', 'spacetime_rift', 'spy_infiltrate', 'human_takeover'],
    defaultDirectives: {
      civilization_debate: {
        zh: '帝国应继续中央集权，还是把更多空间让给地方自治与商贸网络。',
        en: 'Should the empire keep centralizing power or yield more room to provincial autonomy and trade networks?',
      },
      spy_infiltrate: {
        zh: '以忠诚官员身份渗透朝堂，暗中挑动贵族与军团之间的不信任。',
        en: 'Infiltrate the court as a loyal official while quietly amplifying distrust between nobles and the military.',
      },
      human_takeover: {
        zh: '以统治者口吻发布一项亲自裁决的诏令，重写权力平衡。',
        en: 'Issue a ruler-level decree that personally resets the balance of power.',
      },
      spacetime_rift: {
        zh: '另一条时间线传来的密信显示，地方总督最终会借商路自立。',
        en: 'A leaked dispatch from another timeline shows provincial governors eventually breaking away through trade power.',
      },
      mandate_surge: {
        zh: '都城与行省同时掀起要求减税、分权与重审军团忠诚的民意浪潮。',
        en: 'The capital and provinces surge with demands for tax relief, shared authority, and a review of legion loyalty.',
      },
    },
  },
  industry: {
    id: 'industry',
    labelZh: '工业与资源',
    labelEn: 'Industry and Resources',
    descriptionZh: '适合工业革命、能源、资源调配、市场与生产线类问题。',
    descriptionEn: 'Fits industrialization, energy, resource allocation, markets, and production.',
    signatureHooksZh: ['产能瓶颈', '关键资源', '调度委员会'],
    signatureHooksEn: ['Throughput bottlenecks', 'Strategic resources', 'Dispatch committees'],
    recommendedCards: ['human_takeover', 'mandate_surge', 'civilization_debate', 'spy_infiltrate', 'spacetime_rift'],
    defaultDirectives: {
      civilization_debate: {
        zh: '资源应优先用于产能扩张，还是用于社会缓冲与安全冗余。',
        en: 'Should resources prioritize production growth or social buffering and safety redundancy?',
      },
      spy_infiltrate: {
        zh: '暗中操纵价格与供给预期，迫使各方过度依赖单一基础设施。',
        en: 'Quietly manipulate prices and supply expectations so the branch over-relies on one infrastructure path.',
      },
      human_takeover: {
        zh: '立刻冻结关键资源外流，把调度权从自动系统拉回人工委员会。',
        en: 'Freeze key resource outflows and pull dispatch authority back to a human committee.',
      },
      spacetime_rift: {
        zh: '另一条时间线证明，当前这条高效率路线最终会引发资源挤兑。',
        en: 'Another timeline proves that the current high-efficiency route ends in a resource squeeze.',
      },
      mandate_surge: {
        zh: '工人城市与配给社区突然要求停机审计、公开库存并保留安全冗余。',
        en: 'Worker cities and rationing districts demand a stop-work audit, public inventories, and safety redundancy.',
      },
    },
  },
  trade: {
    id: 'trade',
    labelZh: '贸易绞盘',
    labelEn: 'Trade Leverage',
    descriptionZh: '适合港口、关税、商路、供应链与商团博弈类问题。',
    descriptionEn: 'Fits ports, tariffs, trade routes, supply chains, and merchant coalitions.',
    signatureHooksZh: ['关税杠杆', '港口封锁', '商团倒戈'],
    signatureHooksEn: ['Tariff leverage', 'Port choke points', 'Merchant defections'],
    recommendedCards: ['spy_infiltrate', 'mandate_surge', 'spacetime_rift', 'civilization_debate', 'human_takeover'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应优先保住关税与商路控制，还是用让利来换取更大的同盟网络。',
        en: 'Should the branch protect tariffs and route control, or trade margin for a wider alliance network?',
      },
      spy_infiltrate: {
        zh: '暗中操控码头配额与船队保险，逼关键商团临阵倒向另一侧。',
        en: 'Quietly manipulate dock quotas and convoy insurance to force a key merchant bloc to defect.',
      },
      human_takeover: {
        zh: '由玩家亲自宣布临时降税或封港，把谈判桌节奏硬拉回自己手里。',
        en: 'Let the player impose an emergency tariff cut or port closure to seize the tempo of the negotiation.',
      },
      spacetime_rift: {
        zh: '另一条世界线泄漏的账本显示，当前最赚钱的商路最终会成为致命依赖。',
        en: 'A leaked ledger from another timeline shows the most profitable route becoming a fatal dependency.',
      },
      mandate_surge: {
        zh: '港口工人与商团客户同时发起抵制浪潮，要求立刻重谈关税与封锁规则。',
        en: 'Port workers and merchant clients launch a boycott wave demanding an immediate rewrite of tariffs and blockade rules.',
      },
    },
  },
  law: {
    id: 'law',
    labelZh: '法律红线',
    labelEn: 'Legal Red Lines',
    descriptionZh: '适合宪法、法院、程序正义、合规与否决权类问题。',
    descriptionEn: 'Fits constitutions, courts, due process, compliance, and veto powers.',
    signatureHooksZh: ['紧急否决', '审计证据', '程序补丁'],
    signatureHooksEn: ['Emergency vetoes', 'Audit evidence', 'Procedural patches'],
    recommendedCards: ['human_takeover', 'mandate_surge', 'civilization_debate', 'spacetime_rift', 'spy_infiltrate'],
    defaultDirectives: {
      civilization_debate: {
        zh: '是否应把最终否决权交给法院式复核机制，而不是继续依赖单一执行中心。',
        en: 'Should final veto power move to a court-like review layer instead of staying with one executive core?',
      },
      spy_infiltrate: {
        zh: '暗中修改例外条款的适用门槛，让看似合法的程序变成特权通道。',
        en: 'Quietly alter the exception thresholds so a seemingly lawful process becomes a privilege tunnel.',
      },
      human_takeover: {
        zh: '由玩家直接发起“暂停执行 + 公开证据包 + 48小时复核”的法律急刹方案。',
        en: 'Let the player trigger a legal emergency brake: pause execution, publish the evidence pack, and mandate a 48-hour review.',
      },
      spacetime_rift: {
        zh: '另一条时间线的裁决书显示，当前这条程序路径最终会被判定违宪。',
        en: 'A ruling leaked from another timeline shows the current procedural path being struck down as unconstitutional.',
      },
      mandate_surge: {
        zh: '街头、公民团体与法律社群同时要求公开证据并立即冻结争议政策。',
        en: 'Streets, civic groups, and legal networks surge with demands to publish the evidence and freeze the disputed policy.',
      },
    },
  },
  faith: {
    id: 'faith',
    labelZh: '神权号角',
    labelEn: 'Sacred Order',
    descriptionZh: '适合宗教、教会、神谕、异端与象征合法性类问题。',
    descriptionEn: 'Fits religion, churches, prophecies, heresy, and symbolic legitimacy.',
    signatureHooksZh: ['异端审判', '圣谕改写', '祭司联盟'],
    signatureHooksEn: ['Heresy trials', 'Rewritten prophecy', 'Clerical alliances'],
    recommendedCards: ['civilization_debate', 'mandate_surge', 'spy_infiltrate', 'human_takeover', 'spacetime_rift'],
    defaultDirectives: {
      civilization_debate: {
        zh: '神权秩序应继续垄断解释权，还是允许世俗共同体重新定义神谕。',
        en: 'Should sacred authority keep a monopoly on interpretation, or let secular communities redefine the prophecy?',
      },
      spy_infiltrate: {
        zh: '伪装成虔诚代言人渗透议会，暗中重写圣谕的政治含义。',
        en: 'Infiltrate the council as a devout advocate while quietly rewriting the prophecy’s political meaning.',
      },
      human_takeover: {
        zh: '由玩家公开宣布一条打破旧神谕的新诏令，逼全体角色重新站队。',
        en: 'Let the player issue a decree that breaks the old prophecy and forces everyone to realign.',
      },
      spacetime_rift: {
        zh: '另一条世界线传来的圣谕残片揭示，当前祭司联盟最终会亲手毁掉秩序。',
        en: 'A prophetic fragment from another timeline reveals the current clerical alliance eventually destroying the order it protects.',
      },
      mandate_surge: {
        zh: '信众与地方神殿突然要求重审圣谕、公开祭司联盟的真实代价。',
        en: 'Believers and local temples surge with demands to reopen the prophecy and expose the clerical alliance’s true cost.',
      },
    },
  },
  ecology: {
    id: 'ecology',
    labelZh: '生态阈值',
    labelEn: 'Ecology Thresholds',
    descriptionZh: '适合气候、水源、瘟疫、环境承载与长期韧性类问题。',
    descriptionEn: 'Fits climate, water, plague, environmental carrying capacity, and long-run resilience.',
    signatureHooksZh: ['生态红线', '迁徙窗口', '系统韧性'],
    signatureHooksEn: ['Ecological red lines', 'Migration windows', 'System resilience'],
    recommendedCards: ['human_takeover', 'mandate_surge', 'spacetime_rift', 'civilization_debate', 'spy_infiltrate'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应优先守住生态红线与撤离窗口，还是继续押注短期增长与征服速度。',
        en: 'Should the branch protect ecological red lines and evacuation windows, or keep chasing short-term growth and conquest speed?',
      },
      spy_infiltrate: {
        zh: '暗中压低环境风险预警，把群体引向一条表面高效、实际透支生态的路线。',
        en: 'Quietly suppress environmental warnings and steer the branch toward a path that looks efficient while burning ecological slack.',
      },
      human_takeover: {
        zh: '由玩家下令进入保守韧性模式，暂停扩张并重排水粮与防疫优先级。',
        en: 'Let the player switch the branch into resilience mode, pausing expansion and reprioritizing water, food, and outbreak control.',
      },
      spacetime_rift: {
        zh: '另一条时间线的灾害日志证明，当前这条路线会在下一个季节突破生态阈值。',
        en: 'A disaster log from another timeline proves the current route crosses the ecological threshold next season.',
      },
      mandate_surge: {
        zh: '受灾社区突然要求立刻限水、公开迁徙路线，并暂停一切高消耗扩张。',
        en: 'Affected communities surge with demands for water limits, open migration corridors, and an immediate halt to high-consumption expansion.',
      },
    },
  },
  frontier: {
    id: 'frontier',
    labelZh: '边疆探索',
    labelEn: 'Frontier Expansion',
    descriptionZh: '适合太空、海洋、边疆探索与新殖民地治理类问题。',
    descriptionEn: 'Fits space, oceanic, frontier exploration, and colony governance.',
    signatureHooksZh: ['远征风险', '生命维持', '撤离路线'],
    signatureHooksEn: ['Expedition risk', 'Life support', 'Evac routes'],
    recommendedCards: ['spacetime_rift', 'mandate_surge', 'human_takeover', 'civilization_debate', 'spy_infiltrate'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应当继续激进拓展边疆，还是先建立更稳固的生命维持与治理规则。',
        en: 'Should the branch keep expanding aggressively, or secure life-support and governance first?',
      },
      spy_infiltrate: {
        zh: '以技术顾问身份隐藏真实目的，推动一次高风险远征来争夺资源优势。',
        en: 'Hide behind a technical role and push a high-risk expedition to seize strategic advantage.',
      },
      human_takeover: {
        zh: '以人为主导下令暂停扩张，先重新审查环境风险与撤离路线。',
        en: 'Take human command, pause expansion, and re-audit environmental risk plus evacuation routes.',
      },
      spacetime_rift: {
        zh: '另一条时间线传来的信号显示，前方殖民地最终因补给断裂而失守。',
        en: 'A signal from another timeline shows the frontier colony eventually collapsing after a logistics break.',
      },
      mandate_surge: {
        zh: '前线殖民地居民突然要求暂停外扩，优先保障生命维持、返航权与家属名额。',
        en: 'Frontier settlers surge with demands to pause expansion and prioritize life support, return rights, and family slots.',
      },
    },
  },
  mythic: {
    id: 'mythic',
    labelZh: '神话秩序',
    labelEn: 'Mythic Order',
    descriptionZh: '适合奇幻、魔法、神权与传说秩序类问题。',
    descriptionEn: 'Fits fantasy, magic, sacred order, and legendary politics.',
    signatureHooksZh: ['神谕偏转', '禁术代价', '王权传说'],
    signatureHooksEn: ['Bent prophecy', 'Forbidden arts', 'Royal myth'],
    recommendedCards: ['civilization_debate', 'mandate_surge', 'spacetime_rift', 'human_takeover', 'spy_infiltrate'],
    defaultDirectives: {
      civilization_debate: {
        zh: '魔法秩序应继续由少数守护者垄断，还是向更多人开放。',
        en: 'Should magical order remain under a few guardians, or open to broader participation?',
      },
      spy_infiltrate: {
        zh: '伪装成预言者渗透议会，暗中引导神谕向自己倾斜。',
        en: 'Infiltrate the council as a prophet and quietly bend the prophecy toward your own faction.',
      },
      human_takeover: {
        zh: '以玩家视角颁布一条违背旧神谕的新命令。',
        en: 'As the player, issue a command that openly contradicts the old prophecy.',
      },
      spacetime_rift: {
        zh: '另一条世界线传来预言残片，显示守旧路线会毁掉整个王国。',
        en: 'A prophecy fragment from another timeline reveals that the conservative path destroys the whole kingdom.',
      },
      mandate_surge: {
        zh: '王国民众与边境守望者突然要求公开禁术代价，并重写旧神谕的解释权。',
        en: 'The kingdom’s crowds and frontier wardens surge with demands to expose forbidden costs and rewrite who interprets prophecy.',
      },
    },
  },
  survival: {
    id: 'survival',
    labelZh: '生存极限',
    labelEn: 'Survival Pressure',
    descriptionZh: '适合末日、崩塌、灾难、资源短缺与社会存亡类问题。',
    descriptionEn: 'Fits apocalypse, collapse, disaster, scarcity, and survival crises.',
    signatureHooksZh: ['最后冗余', '撤退路线', '极限配给'],
    signatureHooksEn: ['Last reserves', 'Retreat routes', 'Scarcity rationing'],
    recommendedCards: ['human_takeover', 'mandate_surge', 'spacetime_rift', 'spy_infiltrate', 'civilization_debate'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应该集中最后资源赌一次豪赌，还是保留冗余来换取更长生存时间。',
        en: 'Should the branch spend its last reserves on a high-risk gamble or preserve redundancy for longer survival?',
      },
      spy_infiltrate: {
        zh: '暗中囤积关键资源，引导群体走向错误避难路线。',
        en: 'Secretly hoard key resources and steer the group toward the wrong refuge route.',
      },
      human_takeover: {
        zh: '立刻发布一条保守生存命令，把人群从高风险路线撤回。',
        en: 'Issue an immediate conservative survival order and pull the population off the high-risk route.',
      },
      spacetime_rift: {
        zh: '另一条时间线的残缺求救信号证明，当前路线最终会导致集体灭失。',
        en: 'A fragmented distress signal from another timeline proves the current route ends in collective failure.',
      },
      mandate_surge: {
        zh: '避难居民突然要求公开余粮库存、改写配给顺序，并优先保护撤离路线。',
        en: 'Shelter residents surge with demands to publish food reserves, rewrite rationing order, and secure evacuation routes first.',
      },
    },
  },
  generic: {
    id: 'generic',
    labelZh: '通用博弈',
    labelEn: 'General Tension',
    descriptionZh: '适合暂时无法归类的问题，用通用冲突机制增强推演。',
    descriptionEn: 'Use general conflict tools when the scenario does not map cleanly to a domain.',
    signatureHooksZh: ['关键分歧', '隐藏议程', '世界线证据'],
    signatureHooksEn: ['Core tensions', 'Hidden agendas', 'Branch evidence'],
    recommendedCards: ['civilization_debate', 'mandate_surge', 'human_takeover', 'spy_infiltrate', 'spacetime_rift'],
    defaultDirectives: {
      civilization_debate: {
        zh: '让两名角色围绕当前世界线最核心的分歧展开公开辩论。',
        en: 'Make two agents publicly debate the branch’s central disagreement.',
      },
      spy_infiltrate: {
        zh: '让一名角色带着隐藏议程发言，悄悄把局势推向更极端的方向。',
        en: 'Give one agent a hidden agenda that quietly pushes the branch toward a sharper outcome.',
      },
      human_takeover: {
        zh: '让用户直接接管一名角色，强行改变当前讨论的重心。',
        en: 'Let the user take over one agent and force a pivot in the branch conversation.',
      },
      spacetime_rift: {
        zh: '让另一条世界线的一条关键信号泄漏到当前分支，制造新的冲突与证据。',
        en: 'Leak a critical signal from another branch into the current one to create a fresh conflict.',
      },
      mandate_surge: {
        zh: '让一股突发的群众压力席卷当前世界线，逼所有角色重新表态与站队。',
        en: 'Trigger a sudden wave of public pressure that forces every actor in the branch to restate their position.',
      },
    },
  },
};

const GAMEPLAY_PROFILE_FRAME_SRC: Record<GameplayProfileId, string> = {
  governance: '/assets/ui/generated/gameplay_card_frame_governance.png',
  war: '/assets/ui/generated/gameplay_card_frame_war.png',
  empire: '/assets/ui/generated/gameplay_card_frame_empire.png',
  industry: '/assets/ui/generated/gameplay_card_frame_industry.png',
  trade: '/assets/ui/generated/gameplay_card_frame_trade.png',
  law: '/assets/ui/generated/gameplay_card_frame_law.png',
  faith: '/assets/ui/generated/gameplay_card_frame_faith.png',
  ecology: '/assets/ui/generated/gameplay_card_frame_ecology.png',
  frontier: '/assets/ui/generated/gameplay_card_frame_frontier.png',
  mythic: '/assets/ui/generated/gameplay_card_frame_mythic.png',
  survival: '/assets/ui/generated/gameplay_card_frame_survival.png',
  generic: '/assets/ui/generated/gameplay_panel.png',
};

const GAMEPLAY_BADGE_SRC: Record<GameplayBadgeId, string> = {
  recommended: '/assets/ui/generated/badge_recommended.png',
  daily_challenge: '/assets/ui/generated/badge_daily_challenge.png',
  archive_record: '/assets/ui/generated/badge_archive_record.png',
  bet_winner: '/assets/ui/generated/badge_bet_winner.png',
};

const PROFILE_HEURISTICS: Partial<Record<GameplayProfileId, GameplayProfileHeuristics>> = {
  governance: {
    primaryRoleKeywords: ['治理', '议会', '委员', 'govern', 'council', 'minister', 'oversight'],
    secondaryRoleKeywords: ['人权', '地方', '公民', 'rights', 'local', 'activist', 'audit'],
    sourceBranchKeywords: ['审议', '否决', '主权', '治理', 'veto', 'review'],
  },
  war: {
    primaryRoleKeywords: ['将军', '海军', '司令', 'war', 'general', 'admiral', 'security', 'commander'],
    secondaryRoleKeywords: ['医生', '外交', '和平', 'doctor', 'diplomat', 'ceasefire', 'humanitarian'],
    sourceBranchKeywords: ['停火', '补给', '突击', '前线', 'ceasefire', 'supply', 'strike'],
  },
  empire: {
    primaryRoleKeywords: ['皇', '王', '总督', '帝', 'emperor', 'governor', 'royal', 'court'],
    secondaryRoleKeywords: ['贵族', '军团', '商团', 'noble', 'legion', 'merchant'],
    sourceBranchKeywords: ['自治', '叛乱', '王朝', '行省', 'dynasty', 'provinc', 'rebel'],
  },
  industry: {
    primaryRoleKeywords: ['工厂', '能源', '工程', 'industrial', 'engineer', 'resource', 'market'],
    secondaryRoleKeywords: ['工人', '社区', 'safety', 'worker', 'union', 'planner'],
    sourceBranchKeywords: ['产能', '能源', '市场', 'factory', 'energy', 'market'],
  },
  trade: {
    primaryRoleKeywords: ['商', '港', '税', 'merchant', 'port', 'finance', 'treasury', 'trade'],
    secondaryRoleKeywords: ['使节', '外交', '保险', 'envoy', 'diplomat', 'broker', 'convoy'],
    sourceBranchKeywords: ['关税', '商路', '港', '封锁', 'tariff', 'port', 'route', 'blockade'],
  },
  law: {
    primaryRoleKeywords: ['法院', '法官', '法律', '审计', 'court', 'judge', 'legal', 'audit'],
    secondaryRoleKeywords: ['议会', '顾问', '律师', 'parliament', 'counsel', 'rights'],
    sourceBranchKeywords: ['判例', '裁决', '合规', '违宪', 'ruling', 'legal', 'compliance'],
  },
  faith: {
    primaryRoleKeywords: ['祭司', '神', '教', 'prophet', 'priest', 'faith', 'oracle', 'temple'],
    secondaryRoleKeywords: ['君主', '异端', 'royal', 'heretic', 'cleric'],
    sourceBranchKeywords: ['圣', '神谕', '教派', '异端', 'sacred', 'prophecy', 'heresy'],
  },
  ecology: {
    primaryRoleKeywords: ['环境', '生态', '气候', 'water', 'climate', 'ecology', 'scientist'],
    secondaryRoleKeywords: ['总督', '社区', '农', 'governor', 'community', 'doctor', 'farmer'],
    sourceBranchKeywords: ['污染', '瘟疫', '干旱', '水', 'plague', 'drought', 'water', 'forest'],
  },
  frontier: {
    primaryRoleKeywords: ['太空', '舰', '边疆', '远征', 'explorer', 'space', 'orbital', 'colon', 'pilot', 'fleet', 'expedition'],
    secondaryRoleKeywords: ['生命维持', '医', '自治', 'support', 'doctor', 'survival', 'charter'],
    sourceBranchKeywords: ['殖民', '撤离', '轨道', '边疆', '风暴', '自治', 'colony', 'evac', 'orbital', 'frontier', 'storm', 'autonomy'],
  },
  mythic: {
    primaryRoleKeywords: ['法师', '巫', 'dragon', 'magic', 'wizard', 'sacred'],
    secondaryRoleKeywords: ['国王', '祭司', 'royal', 'priest', 'prophet'],
    sourceBranchKeywords: ['预言', '魔法', '王国', 'prophecy', 'magic', 'kingdom'],
  },
  survival: {
    primaryRoleKeywords: ['避难', 'survival', 'doctor', 'security', 'scout', 'commander'],
    secondaryRoleKeywords: ['社区', '粮', 'worker', 'medic', 'mayor'],
    sourceBranchKeywords: ['饥荒', '瘟疫', '撤离', 'famine', 'plague', 'retreat', 'collapse'],
  },
};

const THEME_TO_PROFILE: Partial<Record<string, GameplayProfileId>> = {
  scifi_base: 'governance',
  surveillance_megacity: 'governance',
  civic_chamber: 'governance',
  modern_city: 'governance',
  law_court: 'law',
  war_battlefield: 'war',
  logistics_hub: 'war',
  war_command: 'war',
  imperial_forum: 'empire',
  dynastic_palace: 'empire',
  ancient_empire: 'empire',
  medieval_village: 'empire',
  power_grid_nexus: 'industry',
  factory_foundry: 'industry',
  industrial_city: 'industry',
  trade_harbor: 'trade',
  desert_outpost: 'trade',
  frontier_colony: 'frontier',
  space_station: 'frontier',
  ecology_wasteland: 'ecology',
  underwater_kingdom: 'ecology',
  arcane_sanctum: 'mythic',
  faith_temple: 'faith',
  fantasy_kingdom: 'mythic',
  refuge_compound: 'survival',
  post_apocalypse: 'survival',
};

const KEYWORD_TO_PROFILE: Array<[GameplayProfileId, string[]]> = [
  ['law', ['法院', '法庭', '法律', '合规', '宪法', '宪章', '司法', '审计', '否决', 'court', 'legal', 'constitutional', 'judicial', 'compliance', 'audit', 'veto']],
  ['trade', ['贸易', '商路', '港口', '关税', '商团', '供应链', '海峡', 'trade', 'tariff', 'port', 'merchant', 'supply chain', 'logistics', 'harbor']],
  ['faith', ['宗教', '教会', '神谕', '异端', '神权', '圣', 'religion', 'church', 'faith', 'prophecy', 'heresy', 'sacred', 'temple']],
  ['ecology', ['生态', '气候', '森林', '水源', '淡水', '枯竭', '干旱', '迁徙', '瘟疫', '洪水', '环境', 'climate', 'ecology', 'forest', 'migration', 'plague', 'drought', 'water', 'freshwater', 'environment']],
  ['governance', ['人工智能', '算法', '民主', '治理', '选举', 'ai', 'algorithm', 'govern', 'democracy', 'internet']],
  ['war', ['战争', '战场', '围攻', '军', '补给线', '后勤', '车队', '运输枢纽', 'war', 'battle', 'invasion', 'siege', 'supply line', 'convoy', 'logistics hub']],
  ['empire', ['帝国', '王朝', '王国', '古罗马', '三国', 'empire', 'dynasty', 'kingdom', 'roman']],
  ['industry', ['工业', '工厂', '资源', '能源', '市场', '蒸汽', 'industrial', 'factory', 'resource', 'market', 'energy']],
  ['frontier', ['边疆', '远征', '舰队', '自治城邦', '流动城邦', '殖民地', '轨道', '太空', '火星', '空间站', '海洋', '深海', '星域', 'frontier', 'expedition', 'fleet', 'autonomous city-state', 'orbital', 'space', 'mars', 'colony', 'ocean', 'underwater', 'starfield']],
  ['mythic', ['奇幻', '魔法', '龙', '巫师', '法师', '秘法', '奥术', '符文', '巨龙', 'fantasy', 'magic', 'dragon', 'wizard', 'arcane', 'rune', 'sorcerer']],
  ['survival', ['末日', '崩塌', '灾难', '灭绝', 'survival', 'collapse', 'apocalypse', 'disaster', 'extinction']],
];

export function getGameplayCardDefinition(cardId: GameplayCardId): GameplayCardDefinition {
  return GAMEPLAY_CARD_DEFS.find((card) => card.id === cardId) ?? GAMEPLAY_CARD_DEFS[0];
}

export function getGameplayCardLabel(cardId: GameplayCardId, isZh: boolean): string {
  const card = getGameplayCardDefinition(cardId);
  return isZh ? card.labelZh : card.labelEn;
}

export function inferGameplayProfile(
  question: string,
  sceneTheme?: string | null,
): GameplayProfileDefinition {
  const scores = new Map<GameplayProfileId, number>();
  const addScore = (profileId: GameplayProfileId, amount: number) => {
    scores.set(profileId, (scores.get(profileId) ?? 0) + amount);
  };

  const lower = question.toLowerCase();
  for (const [profileId, keywords] of KEYWORD_TO_PROFILE) {
    const matches = keywords.filter((keyword) => lower.includes(keyword.toLowerCase())).length;
    if (matches > 0) addScore(profileId, matches);
  }

  // Question keywords should define the gameplay profile. Scene theme is only
  // a fallback when the question itself does not clearly map to a profile.
  if (scores.size === 0 && sceneTheme && THEME_TO_PROFILE[sceneTheme]) {
    addScore(THEME_TO_PROFILE[sceneTheme] as GameplayProfileId, 1);
  }

  let bestProfileId: GameplayProfileId | null = null;
  let bestScore = 0;
  for (const [profileId, score] of scores.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestProfileId = profileId;
    }
  }

  return bestProfileId ? GAMEPLAY_PROFILES[bestProfileId] : GAMEPLAY_PROFILES.generic;
}

export function getGameplayProfileLabel(profileId: GameplayProfileId, isZh: boolean): string {
  const profile = GAMEPLAY_PROFILES[profileId];
  return isZh ? profile.labelZh : profile.labelEn;
}

export function getGameplayProfileDescription(profileId: GameplayProfileId, isZh: boolean): string {
  const profile = GAMEPLAY_PROFILES[profileId];
  return isZh ? profile.descriptionZh : profile.descriptionEn;
}

export function getGameplayProfileSignatureHooks(profileId: GameplayProfileId, isZh: boolean): string[] {
  const profile = GAMEPLAY_PROFILES[profileId];
  return isZh ? profile.signatureHooksZh : profile.signatureHooksEn;
}

export function getGameplayCardDirectivePreview(
  profileId: GameplayProfileId,
  cardId: GameplayCardId,
  isZh: boolean,
): string {
  const directive = GAMEPLAY_PROFILES[profileId].defaultDirectives[cardId];
  return isZh ? directive.zh : directive.en;
}

export function getGameplayProfileFrameSrc(profileId: GameplayProfileId): string {
  return GAMEPLAY_PROFILE_FRAME_SRC[profileId];
}

export function getGameplayBadgeSrc(badgeId: GameplayBadgeId): string {
  return GAMEPLAY_BADGE_SRC[badgeId];
}

export function getRecommendedGameplayCards(profileId: GameplayProfileId): GameplayCardId[] {
  return GAMEPLAY_PROFILES[profileId].recommendedCards;
}

function unreachableGameplayCard(cardId: never): never {
  throw new Error(`Unhandled gameplay card: ${cardId}`);
}

function resolveAgentName(agentsById: Record<string, AgentInfo>, agentId?: string): string {
  if (!agentId) return '';
  return agentsById[agentId]?.name ?? '';
}

function fallbackDirective(customDirective: string | undefined, fallback: string): string {
  const trimmed = customDirective?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function buildDirectorOverridePrefix(isZh: boolean): string[] {
  if (isZh) {
    return [
      '[DIRECTOR OVERRIDE / 高优先级玩法卡事件]',
      '这不是普通补充说明，而是当前世界线中所有角色都已知晓的导演级事件。',
      '你必须把它当成已经发生且持续生效的状态变化：相关角色要立刻执行，其余角色必须明确回应，并让影响延续到后续轮次，直到被新的事件或证据推翻。',
    ];
  }

  return [
    '[DIRECTOR OVERRIDE / HIGH-PRIORITY GAMEPLAY EVENT]',
    'This is not flavor text. It is a director-level event that every actor in the branch already knows.',
    'Treat it as an immediate and persistent state change: the named actors must act on it now, everyone else must explicitly react, and the consequences should continue shaping later rounds until superseded.',
  ];
}

function normalizeStance(stance: string | undefined): number {
  if (!stance) return 0;
  const lower = stance.toLowerCase();
  if (lower.includes('支持') || lower.includes('support')) return 1;
  if (lower.includes('反对') || lower.includes('oppose') || lower.includes('against')) return -1;
  if (lower.includes('观望') || lower.includes('wait')) return 0.25;
  return 0;
}

function tierPriority(tier: AgentInfo['tier']): number {
  if (tier === 'CORE') return 3;
  if (tier === 'IMPORTANT') return 2;
  return 1;
}

function roleKeywordScore(agent: AgentInfo, keywords: string[] = []): number {
  if (keywords.length === 0) return 0;
  const haystack = `${agent.name} ${agent.role} ${agent.persona ?? ''}`.toLowerCase();
  return keywords.reduce((score, keyword) => (
    haystack.includes(keyword.toLowerCase()) ? score + 1 : score
  ), 0);
}

export function getSuggestedGameplayAgents(
  cardId: GameplayCardId,
  agents: AgentInfo[],
  profileId: GameplayProfileId = 'generic',
): { primaryAgentId: string; secondaryAgentId?: string } {
  const heuristics = PROFILE_HEURISTICS[profileId];
  const sorted = [...agents].sort((a, b) => {
    const keywordDiff = roleKeywordScore(b, heuristics?.primaryRoleKeywords) - roleKeywordScore(a, heuristics?.primaryRoleKeywords);
    if (keywordDiff !== 0) return keywordDiff;
    const tierDiff = tierPriority(b.tier) - tierPriority(a.tier);
    if (tierDiff !== 0) return tierDiff;
    return normalizeStance(b.stance) - normalizeStance(a.stance);
  });

  const defaultPrimary = sorted[0]?.id ?? '';
  const supporters = sorted.filter((agent) => normalizeStance(agent.stance) > 0.5);
  const opponents = sorted.filter((agent) => normalizeStance(agent.stance) < -0.5);
  const neutrals = sorted.filter((agent) => Math.abs(normalizeStance(agent.stance)) < 0.4);
  const roleSortedPrimary = [...sorted].sort((a, b) => roleKeywordScore(b, heuristics?.primaryRoleKeywords) - roleKeywordScore(a, heuristics?.primaryRoleKeywords));
  const roleSortedSecondary = [...sorted].sort((a, b) => roleKeywordScore(b, heuristics?.secondaryRoleKeywords) - roleKeywordScore(a, heuristics?.secondaryRoleKeywords));

  if (cardId === 'civilization_debate') {
    const primary = roleSortedPrimary[0]?.id ?? supporters[0]?.id ?? defaultPrimary;
    const secondary =
      roleSortedSecondary.find((agent) => agent.id !== primary)?.id
      ?? opponents.find((agent) => agent.id !== primary)?.id
      ?? neutrals.find((agent) => agent.id !== primary)?.id
      ?? sorted.find((agent) => agent.id !== primary)?.id
      ?? primary;
    return {
      primaryAgentId: primary,
      secondaryAgentId: secondary,
    };
  }

  if (cardId === 'spy_infiltrate') {
    return {
      primaryAgentId:
        roleSortedPrimary[0]?.id
        ?? neutrals[0]?.id
        ?? supporters[0]?.id
        ?? defaultPrimary,
    };
  }

  if (cardId === 'human_takeover') {
    return {
      primaryAgentId: roleSortedPrimary[0]?.id ?? sorted[0]?.id ?? '',
    };
  }

  if (cardId === 'mandate_surge') {
    return {
      primaryAgentId:
        roleSortedPrimary[0]?.id
        ?? supporters[0]?.id
        ?? neutrals[0]?.id
        ?? defaultPrimary,
    };
  }

  return {
    primaryAgentId: roleSortedPrimary[0]?.id ?? defaultPrimary,
  };
}

export function getSuggestedSourceBranchId(
  branches: BranchInfo[],
  targetBranchId: string | null | undefined,
  profileId: GameplayProfileId = 'generic',
): string {
  const candidates = branches.filter((branch) => branch.id !== targetBranchId);
  const keywords = PROFILE_HEURISTICS[profileId]?.sourceBranchKeywords ?? [];
  const scoreBranch = (branch: BranchInfo) => {
    const haystack = `${branch.title} ${branch.summary} ${branch.fork_reason}`.toLowerCase();
    return keywords.reduce((score, keyword) => (
      haystack.includes(keyword.toLowerCase()) ? score + 1 : score
    ), 0);
  };
  const rankedCandidates = [...candidates].sort((a, b) => {
    const statusRank = (branch: BranchInfo) => (branch.status === 'COMPLETED' ? 2 : branch.status === 'ACTIVE' ? 1 : 0);
    const statusDiff = statusRank(b) - statusRank(a);
    if (statusDiff !== 0) return statusDiff;
    const scoreDiff = scoreBranch(b) - scoreBranch(a);
    if (scoreDiff !== 0) return scoreDiff;
    return b.probability - a.probability;
  });
  return (
    rankedCandidates[0]?.id
    ?? ''
  );
}

export function buildGameplayAutoDirective(params: {
  cardId: GameplayCardId;
  question: string;
  sceneTheme?: string | null;
  profileId: GameplayProfileId;
  isZh: boolean;
}): string {
  const { cardId, question, sceneTheme, profileId, isZh } = params;
  const profile = GAMEPLAY_PROFILES[profileId];
  const base = isZh ? profile.defaultDirectives[cardId].zh : profile.defaultDirectives[cardId].en;

  if (isZh) {
    return `围绕题目「${question}」在${sceneTheme ? `${sceneTheme}场景` : '当前场景'}中推进：${base}`;
  }

  return `For the question "${question}"${sceneTheme ? ` in the ${sceneTheme} scene` : ''}: ${base}`;
}

export function buildGameplayCardPrompt(input: GameplayCardPromptInput): string {
  const {
    cardId,
    question,
    sceneTheme,
    profileId,
    targetBranchTitle,
    agentsById,
    primaryAgentId,
    secondaryAgentId,
    sourceBranchTitle,
    customDirective,
    isZh,
  } = input;

  const primaryAgent = resolveAgentName(agentsById, primaryAgentId);
  const secondaryAgent = resolveAgentName(agentsById, secondaryAgentId);
  const directive = buildGameplayAutoDirective({
    cardId,
    question,
    sceneTheme,
    profileId,
    isZh,
  });

  if (isZh) {
    switch (cardId) {
      case 'civilization_debate':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Civilization Debate / 文明辩论]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          `请在下一轮强制安排 ${primaryAgent} 与 ${secondaryAgent} 进行一场公开辩论，其余 agent 必须引用、反驳或放大这场辩论的观点。`,
          `辩题：${fallbackDirective(customDirective, directive)}`,
          '要求：让这场辩论改变后续讨论重心，并显式体现不同阵营的张力。',
          '持续效果：后续轮次要继续围绕这场辩论产生结盟、裂痕、站队变化或新政策提案。',
        ].join('\n');
      case 'spy_infiltrate':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Spy Infiltration / 间谍渗透]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          `请让 ${primaryAgent} 在下一轮成为隐藏议程的间谍角色，但不要直接公开其身份。`,
          `隐藏任务：${fallbackDirective(customDirective, directive)}`,
          '要求：其他 agent 只能从措辞、立场偏移和策略建议里逐渐察觉异常。',
          '持续效果：这次渗透必须改变信任结构、联盟判断或关键资源/情报流向，而不是只说一句可有可无的话。',
        ].join('\n');
      case 'human_takeover':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Human Takeover / 人类潜入]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          `请在下一轮把 ${primaryAgent} 的发言改为由用户直接接管，并把下面这段内容视为该角色的真实表态。`,
          `用户输入：${fallbackDirective(customDirective, directive)}`,
          '要求：其他 agent 必须把这段输入当作真实政治动作继续推演。',
          '持续效果：这段接管发言要引发后续轮次中的再回应、策略修正、联盟变化或风险升级/缓和。',
        ].join('\n');
      case 'spacetime_rift':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Space-Time Rift / 时空裂缝]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          `信息来源分支：${sourceBranchTitle || '另一条世界线'}`,
          `请让来自另一条世界线的一条关键信息泄漏到当前分支：${fallbackDirective(customDirective, directive)}`,
          '要求：把它写成一个突然出现的证据、传闻或被截获的信号，并让当前讨论因此转向。',
          '持续效果：该信息必须改变当前世界线的判断、优先级或风险感知，并在后续轮次持续产生余波。',
        ].join('\n');
      case 'mandate_surge':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Mandate Surge / 民意浪潮]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          `请让当前世界线突然遭遇一波公开且无法忽视的民意/合法性冲击：${fallbackDirective(customDirective, directive)}`,
          '要求：把它写成街头浪潮、请愿、罢工、神殿号召、殖民地集体请命或其他群众性信号，让所有 agent 都必须明确表态。',
          '持续效果：后续轮次要继续体现这波冲击对联盟关系、政策优先级、执行正当性或风险感知的持续影响。',
        ].join('\n');
      default:
        return unreachableGameplayCard(cardId);
    }
  }

  switch (cardId) {
    case 'civilization_debate':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Civilization Debate]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        `Force ${primaryAgent} and ${secondaryAgent} into a public debate in the next round.`,
        `Debate topic: ${fallbackDirective(customDirective, directive)}`,
        'Other agents must quote, oppose, or amplify that debate and let it reshape the branch momentum.',
        'Persistent effect: later rounds should keep reflecting the alliances, fractures, or policy shifts created by this debate.',
      ].join('\n');
    case 'spy_infiltrate':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Spy Infiltration]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        `Turn ${primaryAgent} into a covert infiltrator in the next round without openly revealing the identity.`,
        `Hidden mission: ${fallbackDirective(customDirective, directive)}`,
        'Other agents should only detect the anomaly through rhetoric, stance drift, and suspicious strategy proposals.',
        'Persistent effect: the infiltration must alter trust, coalitions, or resource/intel flows beyond a single line of dialogue.',
      ].join('\n');
    case 'human_takeover':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Human Takeover]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        `Let the user directly take over ${primaryAgent}'s next-round statement and treat the following as their authentic position.`,
        `User input: ${fallbackDirective(customDirective, directive)}`,
        'All other agents must respond as if this was a real move by that character.',
        'Persistent effect: the branch should continue reacting to this move in later rounds through strategy changes, alliances, or escalating tension.',
      ].join('\n');
    case 'spacetime_rift':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Space-Time Rift]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        `Source branch: ${sourceBranchTitle || 'another timeline'}`,
        `Leak this signal from the other timeline into the current branch: ${fallbackDirective(customDirective, directive)}`,
        'Present it as intercepted evidence, rumor, or a temporal anomaly that forces the branch discussion to pivot.',
        'Persistent effect: the leak must keep reshaping the branch’s priorities or risk model in the rounds that follow.',
      ].join('\n');
    case 'mandate_surge':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Mandate Surge]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        `Hit the branch with a public legitimacy shock that no actor can ignore: ${fallbackDirective(customDirective, directive)}`,
        'Frame it as a strike wave, petition, sacred uprising, colony-wide demand, or any mass signal that forces every agent to answer in public.',
        'Persistent effect: later rounds should keep reflecting how this mandate reshapes alliances, priorities, and perceived legitimacy.',
      ].join('\n');
    default:
      return unreachableGameplayCard(cardId);
  }
}

export function buildAgentsById(agents: AgentInfo[]): Record<string, AgentInfo> {
  return Object.fromEntries(agents.map((agent) => [agent.id, agent]));
}

export function getDefaultGameplayTargetBranch(branches: BranchInfo[]): string | null {
  return branches.find((branch) => branch.status === 'ACTIVE')?.id ?? null;
}
