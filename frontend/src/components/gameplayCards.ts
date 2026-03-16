import type { AgentInfo, BranchInfo } from '../types';
import {
  GAMEPLAY_BADGE_ASSETS,
  GAMEPLAY_PROFILE_FRAME_ASSETS,
  getThemeProfileId,
  type GameplayProfileId,
} from '../lib/themeRegistry';

export type { GameplayProfileId } from '../lib/themeRegistry';

export type GameplayCardId =
  | 'civilization_debate'
  | 'spy_infiltrate'
  | 'backchannel_pact'
  | 'human_takeover'
  | 'spacetime_rift'
  | 'mandate_surge'
  | 'evacuation_order'
  | 'public_hearing'
  | 'resource_triage'
  | 'forbidden_ritual';

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
  signatureArcLabel?: string;
  signatureArcProgress?: string;
  systemTrackSummary?: string;
  isZh: boolean;
}

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

interface GameplayUsageLike {
  cardId: GameplayCardId;
  profileId: GameplayProfileId;
  round: number;
}

interface GameplaySignatureArcDefinition {
  labelZh: string;
  labelEn: string;
  sequence: GameplayCardId[];
  riskLabelZh: string;
  riskLabelEn: string;
  resourceLabelZh: string;
  resourceLabelEn: string;
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
    id: 'backchannel_pact',
    icon: '🤝',
    labelZh: '密约交易',
    labelEn: 'Backchannel Pact',
    descriptionZh: '让两名角色绕开公开议程私下结盟，用交易筹码改写局势。',
    descriptionEn: 'Let two agents strike a private bargain off the public agenda and rewrite the branch with traded leverage.',
    animation: 'backchannel_signal',
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
  {
    id: 'evacuation_order',
    icon: '🚨',
    labelZh: '撤离令',
    labelEn: 'Evacuation Order',
    descriptionZh: '强制当前世界线执行撤离、封锁或转运命令，立刻重排优先级。',
    descriptionEn: 'Force the branch into an evacuation, lockdown, or emergency transfer order that immediately rewrites priorities.',
    animation: 'evacuation_alarm',
  },
  {
    id: 'public_hearing',
    icon: '🏛️',
    labelZh: '公开听证',
    labelEn: 'Public Hearing',
    descriptionZh: '强制当前世界线召开公开听证，所有阵营都必须拿出证据、条款或代价。',
    descriptionEn: 'Force the branch into a public hearing where every side must surface evidence, terms, or trade-offs.',
    animation: 'hearing_bell',
  },
  {
    id: 'resource_triage',
    icon: '🧰',
    labelZh: '资源分诊',
    labelEn: 'Resource Triage',
    descriptionZh: '强制世界线进入资源分诊，公开谁先保命、谁被限供、哪些线路必须让路。',
    descriptionEn: 'Force the branch into resource triage and openly decide who gets protected, cut back, or rerouted first.',
    animation: 'generic_flash',
  },
  {
    id: 'forbidden_ritual',
    icon: '🕯️',
    labelZh: '禁术仪式',
    labelEn: 'Forbidden Ritual',
    descriptionZh: '强制世界线动用一项代价高昂的禁术、圣物或禁令，换取一次危险转向。',
    descriptionEn: 'Force the branch to invoke a costly forbidden rite, relic, or taboo exception for a dangerous pivot.',
    animation: 'generic_flash',
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
    recommendedCards: ['civilization_debate', 'public_hearing', 'backchannel_pact', 'mandate_surge', 'human_takeover', 'spy_infiltrate', 'evacuation_order', 'spacetime_rift', 'resource_triage', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '算法是否应拥有最终否决权，还是必须接受地方人类审议。',
        en: 'Should the algorithm hold final veto power, or remain subject to local human review?',
      },
      spy_infiltrate: {
        zh: '暗中推动中央权力扩张，同时伪装成温和改革派。',
        en: 'Quietly expand central control while sounding like a moderate reformer.',
      },
      backchannel_pact: {
        zh: '让中央技术集团与地方问责派私下达成一笔“离线保命换有限审计”的密约。',
        en: 'Broker a quiet deal between the central tech bloc and local accountability camp: offline resilience in exchange for limited audit oversight.',
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
      evacuation_order: {
        zh: '立刻发布关键系统撤离令，优先转移医院、电网与水务的人工接管队伍，其他城市延后处理。',
        en: 'Issue an emergency evacuation order that prioritizes human takeover crews for hospitals, power, and water, while other cities wait.',
      },
      public_hearing: {
        zh: '立刻召开公开听证，要求中央、地方与技术方各自提交一条可核验的数据、责任链或否决依据。',
        en: 'Call an immediate public hearing and force central, local, and technical actors to surface one verifiable metric, accountability chain, or veto basis.',
      },
      resource_triage: {
        zh: '立刻进入资源分诊，公开哪些城市、系统或群体先获得算力、供给与人工复核保护。',
        en: 'Enter immediate resource triage and expose which cities, systems, or groups receive compute, supplies, and human review first.',
      },
      forbidden_ritual: {
        zh: '动用一条程序外、代价高昂的黑箱紧急授权，以短期稳定换取长期信任裂缝。',
        en: 'Invoke an out-of-band emergency override with a steep cost, trading short-term stability for long-term trust damage.',
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
    recommendedCards: ['civilization_debate', 'public_hearing', 'backchannel_pact', 'mandate_surge', 'spy_infiltrate', 'evacuation_order', 'spacetime_rift', 'human_takeover', 'resource_triage', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应当继续全面进攻，还是转向补给稳固与防线收缩。',
        en: 'Should the branch keep pushing a full offensive or pivot toward logistics and defense?',
      },
      spy_infiltrate: {
        zh: '暗中破坏后勤协同，把注意力引向一次冒险突击。',
        en: 'Quietly sabotage logistics coordination and redirect attention toward a reckless strike.',
      },
      backchannel_pact: {
        zh: '让前线司令与后勤代表私下约定一条有限停火与补给换俘的密约。',
        en: 'Broker a private pact between the front-line commander and logistics faction: limited ceasefire windows in exchange for convoy access and prisoner swaps.',
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
      evacuation_order: {
        zh: '立即发布撤离与封锁令，优先疏散伤员、补给车队与侧翼居民区，暂停最冒险的推进线。',
        en: 'Issue an evacuation and lockdown order that evacuates casualties, convoy crews, and exposed civilian blocks first while freezing the riskiest advance.',
      },
      public_hearing: {
        zh: '立刻召开战时公开听证，要求前线、后勤与平民代表各自交代一条损耗、误判或补给证据。',
        en: 'Open a wartime public hearing and make the front line, logistics staff, and civilian representatives each disclose one loss, miscalculation, or supply fact.',
      },
      resource_triage: {
        zh: '立即执行战时资源分诊，明确哪些战线、伤员与补给节点必须优先保住，哪些行动必须让路。',
        en: 'Run wartime resource triage and make explicit which fronts, casualties, and supply nodes must be saved first and which operations must yield.',
      },
      forbidden_ritual: {
        zh: '动用一项危险且可能越线的焦土/禁武方案，换取短期战场逆转。',
        en: 'Invoke a dangerous scorched-earth or taboo-weapons measure to force a short-term battlefield reversal.',
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
    recommendedCards: ['civilization_debate', 'public_hearing', 'backchannel_pact', 'mandate_surge', 'spacetime_rift', 'spy_infiltrate', 'evacuation_order', 'human_takeover', 'resource_triage', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '帝国应继续中央集权，还是把更多空间让给地方自治与商贸网络。',
        en: 'Should the empire keep centralizing power or yield more room to provincial autonomy and trade networks?',
      },
      spy_infiltrate: {
        zh: '以忠诚官员身份渗透朝堂，暗中挑动贵族与军团之间的不信任。',
        en: 'Infiltrate the court as a loyal official while quietly amplifying distrust between nobles and the military.',
      },
      backchannel_pact: {
        zh: '让宫廷近臣与地方总督秘密交易税赋豁免与军团效忠，换取短期稳局。',
        en: 'Arrange a secret bargain between palace insiders and provincial governors: tax relief and legion loyalty in exchange for short-term stability.',
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
      evacuation_order: {
        zh: '立即发布撤离令，优先转移皇室档案、粮仓与边境总督家眷，并封锁最可能叛乱的关口。',
        en: 'Issue an evacuation order that first secures imperial archives, granaries, and governor families while sealing the likeliest rebel gates.',
      },
      public_hearing: {
        zh: '召集帝国公开听证，要求皇权、军团与行省各自摊开一条忠诚、税赋或调兵证据。',
        en: 'Convene an imperial hearing and force the throne, legions, and provinces to lay out one concrete loyalty, taxation, or mobilization fact each.',
      },
      resource_triage: {
        zh: '立即执行帝国资源分诊，明确粮税、军团与行省保障中哪些必须优先，哪些扩张计划必须暂停。',
        en: 'Enter imperial resource triage and decide which grain, tax, legion, and provincial guarantees stay protected while expansion plans are paused.',
      },
      forbidden_ritual: {
        zh: '启用一项血统诏令、禁军誓约或秘仪惩戒，强行改写帝国忠诚结构。',
        en: 'Invoke a bloodline decree, praetorian oath, or secret rite to forcibly rewrite the empire’s loyalty structure.',
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
    recommendedCards: ['human_takeover', 'resource_triage', 'evacuation_order', 'public_hearing', 'backchannel_pact', 'mandate_surge', 'civilization_debate', 'spy_infiltrate', 'spacetime_rift', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '资源应优先用于产能扩张，还是用于社会缓冲与安全冗余。',
        en: 'Should resources prioritize production growth or social buffering and safety redundancy?',
      },
      spy_infiltrate: {
        zh: '暗中操纵价格与供给预期，迫使各方过度依赖单一基础设施。',
        en: 'Quietly manipulate prices and supply expectations so the branch over-relies on one infrastructure path.',
      },
      backchannel_pact: {
        zh: '让工厂财团与配给委员会秘密交换库存豁免与停工顺序，换取脆弱稳态。',
        en: 'Broker a covert bargain between factory owners and rationing committees: inventory exemptions and shutdown order in exchange for a fragile calm.',
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
      evacuation_order: {
        zh: '立即发布撤离与停机令，优先疏散高危工段、化学仓储和轮班宿舍，其他产线降载运行。',
        en: 'Issue an evacuation and shutdown order that clears the most hazardous lines, chemical stores, and worker dorms first while the rest of production throttles down.',
      },
      public_hearing: {
        zh: '立即召开产能听证，要求工厂、调度委员会与社区代表各自公开一条库存、停机或安全冗余证据。',
        en: 'Launch a production hearing and require factories, dispatch committees, and community delegates to surface one stock, shutdown, or safety-redundancy fact each.',
      },
      resource_triage: {
        zh: '立即执行工业资源分诊，决定哪些产线、能源节点与社区配给先保住，哪些订单必须砍掉。',
        en: 'Run industrial resource triage and decide which lines, energy nodes, and community rations stay protected first and which orders get cut.',
      },
      forbidden_ritual: {
        zh: '启动一项高污染、高透支且不可持续的极限增产方案，换取短期产能冲刺。',
        en: 'Trigger a highly polluting, unsustainable surge-production scheme to buy a short-term throughput spike.',
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
    recommendedCards: ['spy_infiltrate', 'backchannel_pact', 'public_hearing', 'mandate_surge', 'evacuation_order', 'spacetime_rift', 'civilization_debate', 'human_takeover', 'resource_triage', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应优先保住关税与商路控制，还是用让利来换取更大的同盟网络。',
        en: 'Should the branch protect tariffs and route control, or trade margin for a wider alliance network?',
      },
      spy_infiltrate: {
        zh: '暗中操控码头配额与船队保险，逼关键商团临阵倒向另一侧。',
        en: 'Quietly manipulate dock quotas and convoy insurance to force a key merchant bloc to defect.',
      },
      backchannel_pact: {
        zh: '让两大商团私下签下一笔过路费减免换封锁配合的密约，不经公开议会备案。',
        en: 'Cut a secret side deal between rival merchant blocs: tariff relief in exchange for blockade cooperation, bypassing the public council.',
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
      evacuation_order: {
        zh: '立刻发布港区撤离令，优先转运粮船、医院补给与关键航道引航员，其余货轮暂缓离港。',
        en: 'Issue a port evacuation order that moves food convoys, medical supplies, and channel pilots first while lower-priority cargo stays delayed.',
      },
      public_hearing: {
        zh: '立刻召开港口公开听证，要求商团、工会与税务方各自拿出一条账本、运力或补贴证据。',
        en: 'Call an immediate port hearing and require merchant blocs, labor, and tax officials to reveal one ledger, throughput, or subsidy fact each.',
      },
      resource_triage: {
        zh: '立即执行港口资源分诊，明确哪些货轮、仓位与补给线优先保住，哪些贸易承诺必须延后。',
        en: 'Run port resource triage and make clear which convoys, berths, and supply routes stay protected first and which trade promises get delayed.',
      },
      forbidden_ritual: {
        zh: '强行动用一项撕毁旧约、扣押船队或祭出黑箱担保的危险交易手段，换取短期筹码。',
        en: 'Invoke a dangerous taboo trade move such as voiding old covenants, seizing fleets, or using opaque guarantees to buy leverage.',
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
    recommendedCards: ['public_hearing', 'human_takeover', 'backchannel_pact', 'mandate_surge', 'evacuation_order', 'civilization_debate', 'spacetime_rift', 'spy_infiltrate', 'resource_triage', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '是否应把最终否决权交给法院式复核机制，而不是继续依赖单一执行中心。',
        en: 'Should final veto power move to a court-like review layer instead of staying with one executive core?',
      },
      spy_infiltrate: {
        zh: '暗中修改例外条款的适用门槛，让看似合法的程序变成特权通道。',
        en: 'Quietly alter the exception thresholds so a seemingly lawful process becomes a privilege tunnel.',
      },
      backchannel_pact: {
        zh: '让法院顾问与执行中枢私下达成一笔“暂缓追责换有限放行”的密约，不公开入卷。',
        en: 'Broker an off-record compromise between court advisers and implementers: limited relief in exchange for deferred accountability.',
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
      evacuation_order: {
        zh: '立即发布撤离与保护令，优先转移关键证人、法庭档案与受影响社区，暂停最具争议的执行动作。',
        en: 'Issue an emergency protection order that evacuates key witnesses, court archives, and exposed communities first while freezing the hottest enforcement moves.',
      },
      public_hearing: {
        zh: '立刻进入公开听证，要求法院、执行方与公民团体各自提交一份证据包、程序依据或风险备忘。',
        en: 'Move straight into a public hearing and require the court, implementers, and civic groups to submit one evidence pack, procedural basis, or risk memo each.',
      },
      resource_triage: {
        zh: '立即执行程序与资源分诊，明确哪些案件、证据包与复核窗口先保住，哪些执行动作必须冻结。',
        en: 'Run legal-resource triage and decide which cases, evidence packs, and review windows stay protected first and which enforcement moves freeze.',
      },
      forbidden_ritual: {
        zh: '启用一项程序外的紧急例外或密室授权，以牺牲正当性换取一次危险裁断。',
        en: 'Invoke an extra-procedural emergency exception or closed-door mandate, sacrificing legitimacy for a dangerous ruling.',
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
    recommendedCards: ['forbidden_ritual', 'backchannel_pact', 'civilization_debate', 'public_hearing', 'mandate_surge', 'evacuation_order', 'spy_infiltrate', 'human_takeover', 'spacetime_rift', 'resource_triage'],
    defaultDirectives: {
      civilization_debate: {
        zh: '神权秩序应继续垄断解释权，还是允许世俗共同体重新定义神谕。',
        en: 'Should sacred authority keep a monopoly on interpretation, or let secular communities redefine the prophecy?',
      },
      spy_infiltrate: {
        zh: '伪装成虔诚代言人渗透议会，暗中重写圣谕的政治含义。',
        en: 'Infiltrate the council as a devout advocate while quietly rewriting the prophecy’s political meaning.',
      },
      backchannel_pact: {
        zh: '让祭司联盟与世俗王权私下交换赦免、税赋或圣物通行权，结成不公开的保命密约。',
        en: 'Arrange a hidden pact between the clerical alliance and secular throne: indulgence, taxes, or relic passage traded in a private survival deal.',
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
      evacuation_order: {
        zh: '立即发布圣殿撤离令，优先转移难民、圣物与抄经档案，并封锁最容易爆发异端冲突的街区。',
        en: 'Issue a temple evacuation order that moves refugees, relics, and sacred archives first while sealing districts most likely to ignite heresy violence.',
      },
      public_hearing: {
        zh: '立刻召开圣殿听证，要求祭司、君主与信众各自公开一条神谕解释、祭品代价或秩序风险。',
        en: 'Open a temple hearing and force clergy, rulers, and believers to surface one prophecy reading, sacrificial cost, or order-risk fact each.',
      },
      resource_triage: {
        zh: '立即执行圣殿资源分诊，明确粮仓、避难所与祭司庇护中谁先被保住，哪些仪式必须停下。',
        en: 'Enter sacred resource triage and decide which granaries, shelters, and protections get preserved first and which rituals must stop.',
      },
      forbidden_ritual: {
        zh: '立刻动用禁术、圣物或献祭仪式，以高昂神权代价换取一次神谕偏转。',
        en: 'Invoke a forbidden rite, relic, or sacrificial act to bend the prophecy at a steep sacred cost.',
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
    recommendedCards: ['resource_triage', 'evacuation_order', 'human_takeover', 'public_hearing', 'backchannel_pact', 'mandate_surge', 'spacetime_rift', 'civilization_debate', 'spy_infiltrate', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应优先守住生态红线与撤离窗口，还是继续押注短期增长与征服速度。',
        en: 'Should the branch protect ecological red lines and evacuation windows, or keep chasing short-term growth and conquest speed?',
      },
      spy_infiltrate: {
        zh: '暗中压低环境风险预警，把群体引向一条表面高效、实际透支生态的路线。',
        en: 'Quietly suppress environmental warnings and steer the branch toward a path that looks efficient while burning ecological slack.',
      },
      backchannel_pact: {
        zh: '让上游管理者与下游配给方私下交换水权、迁徙通行与余粮名额，形成一纸见不得光的救命密约。',
        en: 'Broker a hidden water-rights pact between upstream managers and downstream rationers, trading migration lanes and reserve access off the books.',
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
      evacuation_order: {
        zh: '立即发布撤离令，优先转移饮水断供区、儿童病患与防疫人员，并封锁即将突破阈值的污染带。',
        en: 'Issue an evacuation order that moves water-starved districts, children, medical cases, and outbreak crews first while sealing the zones about to cross the threshold.',
      },
      public_hearing: {
        zh: '立刻召开生态听证，要求科学家、行政方与受灾社区各自拿出一条阈值、迁徙或余粮证据。',
        en: 'Convene an ecological hearing and require scientists, administrators, and affected communities to disclose one threshold, migration, or reserve fact each.',
      },
      resource_triage: {
        zh: '立即执行生态资源分诊，决定水源、余粮、迁徙通道与防疫能力谁先保住，哪些区域必须退让。',
        en: 'Run ecological resource triage and decide which water, reserves, migration corridors, and outbreak controls stay protected first and which zones retreat.',
      },
      forbidden_ritual: {
        zh: '动用一项高代价的气候工程、抽水禁令或保育区豁免，冒险换取短期生存缓冲。',
        en: 'Invoke a costly climate intervention, emergency extraction ban, or sanctuary exemption to buy a short-lived survival buffer.',
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
    recommendedCards: ['resource_triage', 'evacuation_order', 'spacetime_rift', 'public_hearing', 'backchannel_pact', 'mandate_surge', 'human_takeover', 'civilization_debate', 'spy_infiltrate', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应当继续激进拓展边疆，还是先建立更稳固的生命维持与治理规则。',
        en: 'Should the branch keep expanding aggressively, or secure life-support and governance first?',
      },
      spy_infiltrate: {
        zh: '以技术顾问身份隐藏真实目的，推动一次高风险远征来争夺资源优势。',
        en: 'Hide behind a technical role and push a high-risk expedition to seize strategic advantage.',
      },
      backchannel_pact: {
        zh: '让舰队指挥与殖民自治派私下交换返航席位、氧气配额与资源坐标，换取暂时合作。',
        en: 'Arrange a backchannel bargain between fleet command and colonial autonomists: return seats, oxygen quotas, and resource coordinates traded for temporary alignment.',
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
      evacuation_order: {
        zh: '立即发布殖民地撤离令，优先转移氧气脆弱舱段、孩童家属与维修队，并关闭最远端的试采站。',
        en: 'Issue a colony evacuation order that clears oxygen-fragile decks, family berths, and repair crews first while abandoning the farthest extraction outpost.',
      },
      public_hearing: {
        zh: '立刻召开边疆听证，要求舰队、殖民地与生命维持团队各自公开一条风险、余量或撤离条件。',
        en: 'Open a frontier hearing and make the fleet, colony council, and life-support teams each reveal one risk, reserve, or evacuation condition.',
      },
      resource_triage: {
        zh: '立即执行边疆资源分诊，明确氧气、席位、维修窗口与返航资格谁先保住，哪些扩张计划必须让路。',
        en: 'Run frontier resource triage and decide which oxygen, seats, repair windows, and return rights stay protected first and which expansion plans yield.',
      },
      forbidden_ritual: {
        zh: '启动一项高风险生命维持实验、封存协议或返航禁令，强行换取边疆窗口。',
        en: 'Invoke a high-risk life-support experiment, sealing protocol, or return-ban to force open a frontier window.',
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
    recommendedCards: ['forbidden_ritual', 'backchannel_pact', 'civilization_debate', 'public_hearing', 'mandate_surge', 'evacuation_order', 'spacetime_rift', 'human_takeover', 'spy_infiltrate', 'resource_triage'],
    defaultDirectives: {
      civilization_debate: {
        zh: '魔法秩序应继续由少数守护者垄断，还是向更多人开放。',
        en: 'Should magical order remain under a few guardians, or open to broader participation?',
      },
      spy_infiltrate: {
        zh: '伪装成预言者渗透议会，暗中引导神谕向自己倾斜。',
        en: 'Infiltrate the council as a prophet and quietly bend the prophecy toward your own faction.',
      },
      backchannel_pact: {
        zh: '让法师议会与王权近臣私下交换龙约碎片、庇护承诺与边境封印权限，缔结密约。',
        en: 'Forge a covert pact between the mage council and royal intimates: dragon-accord fragments, sanctuary promises, and ward permissions traded in secret.',
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
      evacuation_order: {
        zh: '立即发布撤离令，优先迁出遭诅咒的村镇、龙火前线与王室学徒，并封锁即将失守的法阵节点。',
        en: 'Issue an evacuation order that clears cursed villages, dragonfire front lines, and royal apprentices first while sealing the warding nodes about to fail.',
      },
      public_hearing: {
        zh: '立刻召开王国听证，要求法师、祭司与守望者各自公开一条禁术代价、预言偏差或边境代偿。',
        en: 'Call a kingdom hearing and require mages, priests, and wardens to reveal one forbidden cost, prophecy deviation, or frontier trade-off each.',
      },
      resource_triage: {
        zh: '立即执行王国资源分诊，明确庇护、粮仓、法阵与边境守备中哪些必须优先，哪些献祭必须停下。',
        en: 'Run kingdom resource triage and decide which shelter, granaries, warding circles, and frontier defenses stay protected first and which sacrifices stop.',
      },
      forbidden_ritual: {
        zh: '立刻施放一项禁术、龙契约或王权秘仪，以巨大代价换取一次神话级转向。',
        en: 'Invoke a forbidden spell, dragon pact, or royal rite to force a mythic pivot at great cost.',
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
    recommendedCards: ['resource_triage', 'evacuation_order', 'human_takeover', 'public_hearing', 'backchannel_pact', 'mandate_surge', 'spacetime_rift', 'spy_infiltrate', 'civilization_debate', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '应该集中最后资源赌一次豪赌，还是保留冗余来换取更长生存时间。',
        en: 'Should the branch spend its last reserves on a high-risk gamble or preserve redundancy for longer survival?',
      },
      spy_infiltrate: {
        zh: '暗中囤积关键资源，引导群体走向错误避难路线。',
        en: 'Secretly hoard key resources and steer the group toward the wrong refuge route.',
      },
      backchannel_pact: {
        zh: '让避难所负责人与武装护卫私下交换药品、床位和撤离名额，换取一份不公开的生存密约。',
        en: 'Broker a secret survival pact between shelter leads and armed escorts: medicine, beds, and evacuation slots traded off the official ledger.',
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
      evacuation_order: {
        zh: '立刻发布撤离令，优先转移病患、儿童、余粮车队与最后的发电机，其他人转入限供待命。',
        en: 'Issue an evacuation order that moves patients, children, food convoys, and the last generators first while everyone else enters rationed standby.',
      },
      public_hearing: {
        zh: '立刻召开生存听证，要求避难负责人、医护与后勤方各自公开一条余粮、风险或撤离证据。',
        en: 'Open a survival hearing and require shelter leads, medics, and logistics crews to disclose one reserve, risk, or evacuation fact each.',
      },
      resource_triage: {
        zh: '立即执行生存资源分诊，明确余粮、药品、床位与撤离载具谁先使用，哪些群体必须转移或限供。',
        en: 'Run survival resource triage and decide who gets food, medicine, beds, and evacuation transport first while others are moved or rationed.',
      },
      forbidden_ritual: {
        zh: '动用最后储备、封门令或极端牺牲协议，换取一次高代价的生存喘息。',
        en: 'Invoke last-reserve burn, a hard shelter seal, or an extreme sacrifice protocol to buy one costly breath of survival.',
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
    recommendedCards: ['civilization_debate', 'public_hearing', 'backchannel_pact', 'mandate_surge', 'human_takeover', 'spy_infiltrate', 'evacuation_order', 'spacetime_rift', 'resource_triage', 'forbidden_ritual'],
    defaultDirectives: {
      civilization_debate: {
        zh: '让两名角色围绕当前世界线最核心的分歧展开公开辩论。',
        en: 'Make two agents publicly debate the branch’s central disagreement.',
      },
      spy_infiltrate: {
        zh: '让一名角色带着隐藏议程发言，悄悄把局势推向更极端的方向。',
        en: 'Give one agent a hidden agenda that quietly pushes the branch toward a sharper outcome.',
      },
      backchannel_pact: {
        zh: '让两名关键角色绕过公开流程私下交换保护、情报或让步，形成一笔见不得光的密约。',
        en: 'Force two key actors to bypass the public process and quietly trade protection, intelligence, or concessions in a hidden pact.',
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
      evacuation_order: {
        zh: '立刻发布撤离、封锁或转运命令，明确谁先离场、哪些区域暂停、哪些关键资源先走。',
        en: 'Issue an immediate evacuation, lockdown, or transfer order that spells out who exits first, which zones pause, and which resources move first.',
      },
      public_hearing: {
        zh: '立刻召开公开听证，要求当前世界线里最关键的阵营各自拿出一条事实、代价或底线。',
        en: 'Call a public hearing and force the branch’s key factions to surface one fact, trade-off, or non-negotiable line each.',
      },
      resource_triage: {
        zh: '立即执行资源分诊，明确当前世界线里哪些人、区域或系统先被保住，哪些必须降级或撤离。',
        en: 'Enter resource triage and decide which people, zones, or systems get protected first while others are degraded or evacuated.',
      },
      forbidden_ritual: {
        zh: '动用一项代价极高且可能不可逆的非常规手段，强行换取局势转折。',
        en: 'Invoke a costly and potentially irreversible extraordinary measure to force a sharp turn in the branch.',
      },
    },
  },
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

const KEYWORD_TO_PROFILE: Array<[GameplayProfileId, string[]]> = [
  ['generic', ['随机交换负责人', '随机交换一次负责人', '每周随机交换一次负责人', '轮换负责人', '抽签换帅', '随机换帅', '每周换负责人', '所有关键城市都必须每三十天由抽签产生的临时委员会接管', '抽签产生的临时委员会', '如果每一项重大决策都必须交给轮值外部评审团重新裁决', '轮值外部评审团重新裁决', '轮值外部评审团', 'lottery-picked emergency committee', 'temporary lottery committee', 'lottery committee', 'rotating external review board', 'every high-stakes decision had to be re-approved by a rotating external review board', 'swap leaders', 'leader shuffle', 'rotating leadership', 'random leadership', 'weekly leadership shuffle']],
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

const PROFILE_SIGNATURE_ARCS: Record<GameplayProfileId, GameplaySignatureArcDefinition> = {
  governance: {
    labelZh: '治理听证链',
    labelEn: 'Governance Hearing Arc',
    sequence: ['public_hearing', 'backchannel_pact', 'mandate_surge'],
    riskLabelZh: '权威噪声',
    riskLabelEn: 'Authority Noise',
    resourceLabelZh: '审议筹码',
    resourceLabelEn: 'Review Leverage',
  },
  war: {
    labelZh: '战线止损链',
    labelEn: 'Frontline Recovery Arc',
    sequence: ['public_hearing', 'evacuation_order', 'resource_triage'],
    riskLabelZh: '升级时钟',
    riskLabelEn: 'Escalation Clock',
    resourceLabelZh: '补给余量',
    resourceLabelEn: 'Supply Margin',
  },
  empire: {
    labelZh: '帝国安抚链',
    labelEn: 'Imperial Pacification Arc',
    sequence: ['public_hearing', 'backchannel_pact', 'resource_triage'],
    riskLabelZh: '行省裂缝',
    riskLabelEn: 'Provincial Friction',
    resourceLabelZh: '统御余量',
    resourceLabelEn: 'Imperial Buffer',
  },
  industry: {
    labelZh: '停机调度链',
    labelEn: 'Shutdown Dispatch Arc',
    sequence: ['public_hearing', 'resource_triage', 'evacuation_order'],
    riskLabelZh: '停摆时钟',
    riskLabelEn: 'Shutdown Clock',
    resourceLabelZh: '产能缓冲',
    resourceLabelEn: 'Throughput Buffer',
  },
  trade: {
    labelZh: '港口博弈链',
    labelEn: 'Harbor Leverage Arc',
    sequence: ['public_hearing', 'backchannel_pact', 'evacuation_order'],
    riskLabelZh: '封锁噪声',
    riskLabelEn: 'Blockade Noise',
    resourceLabelZh: '航道筹码',
    resourceLabelEn: 'Route Leverage',
  },
  law: {
    labelZh: '程序急刹链',
    labelEn: 'Procedural Brake Arc',
    sequence: ['public_hearing', 'backchannel_pact', 'human_takeover'],
    riskLabelZh: '程序风险',
    riskLabelEn: 'Procedure Risk',
    resourceLabelZh: '复核余量',
    resourceLabelEn: 'Review Buffer',
  },
  faith: {
    labelZh: '圣谕偏转链',
    labelEn: 'Sacred Divergence Arc',
    sequence: ['public_hearing', 'backchannel_pact', 'forbidden_ritual'],
    riskLabelZh: '异端时钟',
    riskLabelEn: 'Heresy Clock',
    resourceLabelZh: '圣权余量',
    resourceLabelEn: 'Sacred Margin',
  },
  ecology: {
    labelZh: '阈值撤离链',
    labelEn: 'Threshold Retreat Arc',
    sequence: ['public_hearing', 'resource_triage', 'evacuation_order'],
    riskLabelZh: '阈值时钟',
    riskLabelEn: 'Threshold Clock',
    resourceLabelZh: '韧性余量',
    resourceLabelEn: 'Resilience Buffer',
  },
  frontier: {
    labelZh: '远征续航链',
    labelEn: 'Expedition Sustain Arc',
    sequence: ['public_hearing', 'resource_triage', 'evacuation_order'],
    riskLabelZh: '失压时钟',
    riskLabelEn: 'Pressure-Loss Clock',
    resourceLabelZh: '生命维持',
    resourceLabelEn: 'Life Support',
  },
  mythic: {
    labelZh: '禁术裂变链',
    labelEn: 'Arcane Rupture Arc',
    sequence: ['public_hearing', 'backchannel_pact', 'forbidden_ritual'],
    riskLabelZh: '反噬时钟',
    riskLabelEn: 'Backlash Clock',
    resourceLabelZh: '奥术余量',
    resourceLabelEn: 'Arcane Buffer',
  },
  survival: {
    labelZh: '避难分诊链',
    labelEn: 'Shelter Triage Arc',
    sequence: ['public_hearing', 'resource_triage', 'evacuation_order'],
    riskLabelZh: '崩塌时钟',
    riskLabelEn: 'Collapse Clock',
    resourceLabelZh: '生存余量',
    resourceLabelEn: 'Survival Buffer',
  },
  generic: {
    labelZh: '通用转向链',
    labelEn: 'General Pivot Arc',
    sequence: ['public_hearing', 'backchannel_pact', 'resource_triage'],
    riskLabelZh: '分歧时钟',
    riskLabelEn: 'Tension Clock',
    resourceLabelZh: '转圜筹码',
    resourceLabelEn: 'Pivot Leverage',
  },
};

const CARD_SYSTEM_EFFECTS: Record<GameplayCardId, { risk: number; resource: number }> = {
  civilization_debate: { risk: 1, resource: 0 },
  spy_infiltrate: { risk: 2, resource: -1 },
  backchannel_pact: { risk: 1, resource: 1 },
  human_takeover: { risk: 1, resource: 0 },
  spacetime_rift: { risk: 2, resource: 0 },
  mandate_surge: { risk: 2, resource: -1 },
  evacuation_order: { risk: 1, resource: 1 },
  public_hearing: { risk: 1, resource: 1 },
  resource_triage: { risk: -1, resource: 2 },
  forbidden_ritual: { risk: 3, resource: -2 },
};

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
  const themedProfileId = getThemeProfileId(sceneTheme);
  if (scores.size === 0 && themedProfileId) {
    addScore(themedProfileId, 1);
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
  return GAMEPLAY_PROFILE_FRAME_ASSETS[profileId];
}

export function getGameplayBadgeSrc(badgeId: GameplayBadgeId): string {
  if (badgeId === 'recommended') return GAMEPLAY_BADGE_ASSETS.recommended;
  if (badgeId === 'daily_challenge') return GAMEPLAY_BADGE_ASSETS.dailyChallenge;
  if (badgeId === 'archive_record') return GAMEPLAY_BADGE_ASSETS.archiveRecord;
  return GAMEPLAY_BADGE_ASSETS.betWinner;
}

export function getGameplaySignatureArc(profileId: GameplayProfileId, isZh: boolean) {
  const arc = PROFILE_SIGNATURE_ARCS[profileId];
  return {
    ...arc,
    label: isZh ? arc.labelZh : arc.labelEn,
    riskLabel: isZh ? arc.riskLabelZh : arc.riskLabelEn,
    resourceLabel: isZh ? arc.resourceLabelZh : arc.resourceLabelEn,
  };
}

export function getGameplaySignatureArcState(
  profileId: GameplayProfileId,
  usages: GameplayUsageLike[],
  isZh: boolean,
) {
  const arc = getGameplaySignatureArc(profileId, isZh);
  const relevantUsages = usages
    .filter((usage) => usage.profileId === profileId)
    .sort((a, b) => a.round - b.round);

  let matchedSteps = 0;
  for (const usage of relevantUsages) {
    if (usage.cardId === arc.sequence[matchedSteps]) {
      matchedSteps += 1;
      if (matchedSteps === arc.sequence.length) break;
    }
  }

  const riskValue = relevantUsages.reduce((sum, usage) => sum + CARD_SYSTEM_EFFECTS[usage.cardId].risk, 0);
  const resourceValue = relevantUsages.reduce((sum, usage) => sum + CARD_SYSTEM_EFFECTS[usage.cardId].resource, 0);
  const normalizedRisk = Math.max(0, Math.min(6, riskValue));
  const normalizedResource = Math.max(0, Math.min(6, 3 + resourceValue));
  const nextCardId = arc.sequence[matchedSteps] ?? null;

  return {
    ...arc,
    completedSteps: matchedSteps,
    totalSteps: arc.sequence.length,
    completed: matchedSteps >= arc.sequence.length,
    nextCardId,
    sequenceLabels: arc.sequence.map((cardId) => getGameplayCardLabel(cardId, isZh)),
    riskValue: normalizedRisk,
    resourceValue: normalizedResource,
  };
}

export function getRecommendedGameplayCards(
  profileId: GameplayProfileId,
  usages: GameplayUsageLike[] = [],
): GameplayCardId[] {
  const cards = [...GAMEPLAY_PROFILES[profileId].recommendedCards];
  if (usages.length === 0) {
    return cards;
  }
  const arcState = getGameplaySignatureArcState(profileId, usages, true);
  if (!arcState.nextCardId) {
    return cards;
  }

  return [
    arcState.nextCardId,
    ...cards.filter((cardId) => cardId !== arcState.nextCardId),
  ];
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

function buildSignatureArcContextLines(
  isZh: boolean,
  signatureArcLabel?: string,
  signatureArcProgress?: string,
  systemTrackSummary?: string,
): string[] {
  const lines: string[] = [];
  if (signatureArcLabel) {
    lines.push(isZh ? `题材连锁：${signatureArcLabel}` : `Signature arc: ${signatureArcLabel}`);
  }
  if (signatureArcProgress) {
    lines.push(isZh ? `当前进度：${signatureArcProgress}` : `Current progress: ${signatureArcProgress}`);
  }
  if (systemTrackSummary) {
    lines.push(isZh ? `情势轨道：${systemTrackSummary}` : `System tracks: ${systemTrackSummary}`);
  }
  return lines;
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

  if (cardId === 'civilization_debate' || cardId === 'backchannel_pact') {
    const primary = roleSortedPrimary[0]?.id ?? supporters[0]?.id ?? defaultPrimary;
    const secondary =
      roleSortedSecondary.find((agent) => agent.id !== primary)?.id
      ?? (cardId === 'civilization_debate'
        ? opponents.find((agent) => agent.id !== primary)?.id
        : supporters.find((agent) => agent.id !== primary)?.id)
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

  if (cardId === 'evacuation_order') {
    return {
      primaryAgentId:
        roleSortedPrimary[0]?.id
        ?? neutrals[0]?.id
        ?? supporters[0]?.id
        ?? defaultPrimary,
    };
  }

  if (cardId === 'public_hearing') {
    return {
      primaryAgentId:
        roleSortedPrimary[0]?.id
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
    signatureArcLabel,
    signatureArcProgress,
    systemTrackSummary,
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
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
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
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让 ${primaryAgent} 在下一轮成为隐藏议程的间谍角色，但不要直接公开其身份。`,
          `隐藏任务：${fallbackDirective(customDirective, directive)}`,
          '要求：其他 agent 只能从措辞、立场偏移和策略建议里逐渐察觉异常。',
          '持续效果：这次渗透必须改变信任结构、联盟判断或关键资源/情报流向，而不是只说一句可有可无的话。',
        ].join('\n');
      case 'backchannel_pact':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Backchannel Pact / 密约交易]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让 ${primaryAgent} 与 ${secondaryAgent} 绕开公开议程，在下一轮私下达成一份暂不曝光的密约：${fallbackDirective(customDirective, directive)}`,
          '要求：明确双方各自交换了什么筹码、红线或保护承诺，不能只写成模糊的“秘密合作”。',
          '持续效果：后续轮次要体现说法异常趋同、行动配合、外部阵营误判，或因密约泄漏引发新的裂痕。',
        ].join('\n');
      case 'human_takeover':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Human Takeover / 人类潜入]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
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
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
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
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让当前世界线突然遭遇一波公开且无法忽视的民意/合法性冲击：${fallbackDirective(customDirective, directive)}`,
          '要求：把它写成街头浪潮、请愿、罢工、神殿号召、殖民地集体请命或其他群众性信号，让所有 agent 都必须明确表态。',
          '持续效果：后续轮次要继续体现这波冲击对联盟关系、政策优先级、执行正当性或风险感知的持续影响。',
        ].join('\n');
      case 'evacuation_order':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Evacuation Order / 撤离令]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让 ${primaryAgent} 在下一轮发布一项必须立刻执行的撤离、封锁或转运命令：${fallbackDirective(customDirective, directive)}`,
          '要求：明确谁先撤、谁被限留、哪些通道关闭或开辟、哪些物资与名额必须优先保障，不能只写“大家撤离”。',
          '持续效果：后续轮次要继续体现秩序压力、失序风险、抛弃感、后勤拥堵或新结盟带来的余波。',
        ].join('\n');
      case 'public_hearing':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Public Hearing / 公开听证]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让当前世界线立即进入一场无法跳过的公开听证：${fallbackDirective(customDirective, directive)}`,
          '要求：至少让三个不同立场/阵营拿出证据、条款、账本、代价或红线，不能只重复立场口号。',
          '持续效果：后续轮次要继续引用这场听证暴露出的事实与责任链，并让联盟、优先级或信任结构发生变化。',
        ].join('\n');
      case 'resource_triage':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Resource Triage / 资源分诊]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让当前世界线立刻进入一轮公开且残酷的资源分诊：${fallbackDirective(customDirective, directive)}`,
          '要求：明确谁先获得水、粮、药品、运力、氧气、算力或撤离资格，谁被限供、延后或牺牲，不能只给抽象口号。',
          '持续效果：后续轮次要继续体现这次分诊造成的秩序压力、群体反应、联盟变化或生存代价。',
        ].join('\n');
      case 'forbidden_ritual':
        return [
          ...buildDirectorOverridePrefix(true),
          '[Special Card: Forbidden Ritual / 禁术仪式]',
          `当前 What-If：${question}`,
          `场景主题：${sceneTheme || '当前世界线'}`,
          `目标分支：${targetBranchTitle}`,
          ...buildSignatureArcContextLines(true, signatureArcLabel, signatureArcProgress, systemTrackSummary),
          `请让当前世界线立刻动用一项代价巨大、可能不可逆的禁术/秘仪/例外条款：${fallbackDirective(customDirective, directive)}`,
          '要求：明确这次举动要牺牲什么、冒犯哪条旧秩序、以及为什么各方仍被迫接受它，不能只写成抽象奇观。',
          '持续效果：后续轮次必须持续体现禁术带来的代价、裂痕、反噬或新的依赖关系。',
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
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
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
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Turn ${primaryAgent} into a covert infiltrator in the next round without openly revealing the identity.`,
        `Hidden mission: ${fallbackDirective(customDirective, directive)}`,
        'Other agents should only detect the anomaly through rhetoric, stance drift, and suspicious strategy proposals.',
        'Persistent effect: the infiltration must alter trust, coalitions, or resource/intel flows beyond a single line of dialogue.',
      ].join('\n');
    case 'backchannel_pact':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Backchannel Pact]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Force ${primaryAgent} and ${secondaryAgent} to strike an off-book pact in the next round: ${fallbackDirective(customDirective, directive)}`,
        'Spell out what leverage, protection, access, or silence each side trades instead of vague secret cooperation.',
        'Persistent effect: later rounds should reflect suspicious alignment, coordinated moves, strategic blind spots, or fractures once the pact leaks.',
      ].join('\n');
    case 'human_takeover':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Human Takeover]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
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
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
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
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Hit the branch with a public legitimacy shock that no actor can ignore: ${fallbackDirective(customDirective, directive)}`,
        'Frame it as a strike wave, petition, sacred uprising, colony-wide demand, or any mass signal that forces every agent to answer in public.',
        'Persistent effect: later rounds should keep reflecting how this mandate reshapes alliances, priorities, and perceived legitimacy.',
      ].join('\n');
    case 'evacuation_order':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Evacuation Order]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Make ${primaryAgent} issue an immediate evacuation, lockdown, or emergency transfer order: ${fallbackDirective(customDirective, directive)}`,
        'Specify who gets evacuated first, who is left waiting, which corridors or ports open or close, and what resources are protected instead of saying everyone simply leaves.',
        'Persistent effect: later rounds should keep reflecting panic, coordination gains, moral backlash, logistics jams, or new alliances caused by the order.',
      ].join('\n');
    case 'public_hearing':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Public Hearing]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Force the branch into an immediate public hearing: ${fallbackDirective(customDirective, directive)}`,
        'At least three distinct factions must surface evidence, terms, ledgers, costs, or non-negotiable lines instead of repeating slogans.',
        'Persistent effect: later rounds should keep citing the facts and accountability links exposed by the hearing, with visible shifts in trust, priorities, or alliances.',
      ].join('\n');
    case 'resource_triage':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Resource Triage]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Force the branch into a visible round of resource triage: ${fallbackDirective(customDirective, directive)}`,
        'Make the branch spell out who gets water, food, medicine, transport, oxygen, compute, or evacuation priority first and who gets rationed, delayed, or cut off.',
        'Persistent effect: later rounds should keep reflecting the survival pressure, political backlash, and alliance shifts created by that triage.',
      ].join('\n');
    case 'forbidden_ritual':
      return [
        ...buildDirectorOverridePrefix(false),
        '[Special Card: Forbidden Ritual]',
        `What-if premise: ${question}`,
        `Scene theme: ${sceneTheme || 'current timeline'}`,
        `Target branch: ${targetBranchTitle}`,
        ...buildSignatureArcContextLines(false, signatureArcLabel, signatureArcProgress, systemTrackSummary),
        `Force the branch to invoke a costly and possibly irreversible taboo measure: ${fallbackDirective(customDirective, directive)}`,
        'Spell out what gets sacrificed, which old order gets violated, and why the actors still accept the move instead of treating it as flavor.',
        'Persistent effect: later rounds must keep reflecting the backlash, new dependency, or fractures caused by the ritual.',
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
