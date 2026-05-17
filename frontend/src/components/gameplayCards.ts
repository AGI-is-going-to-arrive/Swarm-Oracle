import type { AgentInfo, BranchInfo } from '../types';
import {
  CONTRACT_CARD_SYSTEM_EFFECTS,
  CONTRACT_GAMEPLAY_CARD_DEFS,
  CONTRACT_SIGNATURE_ARCS,
} from '../lib/gameplayContract';
import {
  GAMEPLAY_PROFILE_CATALOG,
  getGameplayBadgeSrc,
  type GameplayProfileCatalogEntry,
} from '../lib/gameplayProfileCatalog';
import {
  GAMEPLAY_PROFILE_FRAME_ASSETS,
  getThemeProfileId,
  type GameplayProfileId,
} from '../lib/themeRegistry';

export type { GameplayProfileId } from '../lib/themeRegistry';
export { getGameplayBadgeSrc };
export type { GameplayBadgeId } from '../lib/gameplayProfileCatalog';

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
  | 'forbidden_ritual'
  | 'audit_reckoning'
  | 'intel_blowback'
  | 'mandate_snapback'
  | 'ceasefire_committee';

export interface GameplayCardDefinition {
  id: GameplayCardId;
  icon: string;
  labelZh: string;
  labelEn: string;
  descriptionZh: string;
  descriptionEn: string;
  animation: string;
  cost: number;
  cooldownRounds: number;
  autoCooldownRounds: number;
  minRound: number;
  triggerType: 'auto' | 'manual';
  manualEnabled: boolean;
  autoEnabled: boolean;
  branchingBonus: number;
  requiresPrimaryAgent: boolean;
  requiresSecondaryAgent: boolean;
  requiresSourceBranch: boolean;
  placeholderZh: string;
  placeholderEn: string;
  promptLinesZh: string[];
  promptLinesEn: string[];
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
  profileDoctrine?: string;
  isZh: boolean;
}

type GameplayProfileDefinition = Omit<GameplayProfileCatalogEntry, 'recommendedCards' | 'defaultDirectives'> & {
  recommendedCards: GameplayCardId[];
  defaultDirectives: Record<GameplayCardId, { zh: string; en: string }>;
};

interface GameplayProfileHeuristics {
  primaryRoleKeywords?: string[];
  secondaryRoleKeywords?: string[];
  sourceBranchKeywords?: string[];
}

type GameplayTacticalMode = 'opening' | 'pressure' | 'committed';

interface GameplayTacticalPreset {
  labelZh: string;
  labelEn: string;
  noteZh: string;
  noteEn: string;
  focusCards: GameplayCardId[];
}

interface GameplayProfileStrategyDefinition {
  opening: GameplayTacticalPreset;
  pressure: GameplayTacticalPreset;
  committed: GameplayTacticalPreset;
}

interface GameplayUsageLike {
  cardId: GameplayCardId;
  profileId: GameplayProfileId;
  round: number;
}

interface BranchCommitmentLike {
  active: boolean;
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

const gameplayCardDefs = CONTRACT_GAMEPLAY_CARD_DEFS as GameplayCardDefinition[];
const gameplayProfiles = GAMEPLAY_PROFILE_CATALOG as Partial<Record<GameplayProfileId, GameplayProfileDefinition>>;
const gameplaySignatureArcs = CONTRACT_SIGNATURE_ARCS as Partial<Record<GameplayProfileId, GameplaySignatureArcDefinition>>;
const gameplayCardEffects = CONTRACT_CARD_SYSTEM_EFFECTS as Record<GameplayCardId, { risk: number; resource: number }>;
const neutralCardEffect = { risk: 0, resource: 0 } as const;
const COUNTERPLAY_CARD_IDS = new Set<GameplayCardId>([
  'audit_reckoning',
  'intel_blowback',
  'mandate_snapback',
  'ceasefire_committee',
  'resource_triage',
  'public_hearing',
]);

export type GameplayCardGroupId =
  | 'role_play'
  | 'worldline_distort'
  | 'crisis_dispatch'
  | 'counter_cool';

const GROUP_DEFINITIONS: Array<{ id: GameplayCardGroupId; cards: GameplayCardId[] }> = [
  { id: 'role_play', cards: ['human_takeover', 'civilization_debate'] },
  {
    id: 'worldline_distort',
    cards: ['spacetime_rift', 'spy_infiltrate', 'backchannel_pact', 'forbidden_ritual'],
  },
  { id: 'crisis_dispatch', cards: ['evacuation_order', 'resource_triage', 'mandate_surge'] },
  {
    id: 'counter_cool',
    cards: [
      'public_hearing',
      'audit_reckoning',
      'intel_blowback',
      'mandate_snapback',
      'ceasefire_committee',
    ],
  },
];

export interface GameplayCardGroupModel {
  id: GameplayCardGroupId;
  cardIds: GameplayCardId[];
}

export interface GameplayCardDisplayModel {
  recommended: GameplayCardId[];
  groups: GameplayCardGroupModel[];
}

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
  finance: {
    primaryRoleKeywords: ['银行', '央行', '财政', '风控', 'bank', 'central bank', 'treasury', 'risk', 'finance'],
    secondaryRoleKeywords: ['监管', '交易', '审计', 'regulator', 'trader', 'auditor', 'market'],
    sourceBranchKeywords: ['挤兑', '流动性', '信用', 'bailout', 'liquidity', 'credit', 'market'],
  },
  scholar: {
    primaryRoleKeywords: ['学者', '教授', '研究', '教育', 'scholar', 'professor', 'research', 'educator'],
    secondaryRoleKeywords: ['学生', '审稿', '学院', 'student', 'reviewer', 'faculty'],
    sourceBranchKeywords: ['范式', '论文', '学院', 'paradigm', 'paper', 'campus'],
  },
  medical: {
    primaryRoleKeywords: ['医生', '医院', '医疗', '公共卫生', 'doctor', 'hospital', 'medical', 'public health'],
    secondaryRoleKeywords: ['患者', '护士', '伦理', 'patient', 'nurse', 'ethics'],
    sourceBranchKeywords: ['分诊', '疫情', '疫苗', 'triage', 'pandemic', 'vaccine'],
  },
  technology: {
    primaryRoleKeywords: ['技术', '工程', '算法', '架构', 'engineer', 'technology', 'platform', 'architecture'],
    secondaryRoleKeywords: ['安全', '产品', '开源', 'security', 'product', 'open source'],
    sourceBranchKeywords: ['算力', '芯片', '平台', 'compute', 'chip', 'platform', 'stack'],
  },
  entertainment: {
    primaryRoleKeywords: ['媒体', '娱乐', '明星', '导演', 'media', 'entertainment', 'celebrity', 'director'],
    secondaryRoleKeywords: ['粉丝', '记者', '平台', 'fan', 'journalist', 'platform'],
    sourceBranchKeywords: ['舆论', '流量', '票房', 'reputation', 'audience', 'box office'],
  },
  diplomacy: {
    primaryRoleKeywords: ['外交', '使节', '条约', '峰会', 'diplomat', 'envoy', 'treaty', 'summit'],
    secondaryRoleKeywords: ['联盟', '中立', '调解', 'alliance', 'neutral', 'mediator'],
    sourceBranchKeywords: ['停火', '制裁', '条约', 'ceasefire', 'sanction', 'treaty'],
  },
};

const PROFILE_STRATEGY_RULES: Record<GameplayProfileId, GameplayProfileStrategyDefinition> = {
  governance: {
    opening: {
      labelZh: '合法性推进',
      labelEn: 'Legitimacy Push',
      noteZh: '先摊开程序与民意，再决定谁能拿走最后否决权。',
      noteEn: 'Surface procedure and legitimacy first, then decide who gets the final veto.',
      focusCards: ['public_hearing', 'mandate_surge', 'human_takeover'],
    },
    pressure: {
      labelZh: '审计回拉',
      labelEn: 'Audit Pullback',
      noteZh: '高压时优先公开账本、责任链和回摆民意，别让黑箱继续扩张。',
      noteEn: 'Under pressure, expose ledgers, accountability chains, and mandate snapback before the black box expands.',
      focusCards: ['audit_reckoning', 'mandate_snapback', 'public_hearing'],
    },
    committed: {
      labelZh: '主线锁定',
      labelEn: 'Worldline Lock',
      noteZh: '承诺后继续用听证和民意冲击把主线叙事钉住。',
      noteEn: 'After commitment, keep the main line pinned through hearings and public mandate shocks.',
      focusCards: ['public_hearing', 'mandate_surge', 'audit_reckoning'],
    },
  },
  war: {
    opening: {
      labelZh: '火线拉扯',
      labelEn: 'Frontline Tug',
      noteZh: '优先制造停火窗口和情报错位，让前线与后方目标脱钩。',
      noteEn: 'Open by creating ceasefire windows and intelligence asymmetry so front and rear objectives diverge.',
      focusCards: ['ceasefire_committee', 'intel_blowback', 'mandate_surge'],
    },
    pressure: {
      labelZh: '止损优先',
      labelEn: 'Loss Control',
      noteZh: '战局过热时先控补给与停火，不要让分支只剩单向升级。',
      noteEn: 'When the branch overheats, stabilize supply and ceasefire lanes before escalation becomes one-way.',
      focusCards: ['ceasefire_committee', 'resource_triage', 'intel_blowback'],
    },
    committed: {
      labelZh: '战线钉住',
      labelEn: 'Front Hold',
      noteZh: '承诺后继续围绕停火、反间与配给重新排阵。',
      noteEn: 'After commitment, keep reshaping the branch around ceasefire, counter-intelligence, and rationing.',
      focusCards: ['ceasefire_committee', 'intel_blowback', 'resource_triage'],
    },
  },
  empire: {
    opening: {
      labelZh: '宫廷操盘',
      labelEn: 'Court Maneuver',
      noteZh: '优先拆穿密约和血统叙事，再决定是收权还是放权。',
      noteEn: 'Expose hidden pacts and succession narratives before choosing centralization or concession.',
      focusCards: ['backchannel_pact', 'public_hearing', 'human_takeover'],
    },
    pressure: {
      labelZh: '王朝止血',
      labelEn: 'Dynastic Bleed Control',
      noteZh: '危机抬头时先审计藩属、军团与财政，不要只靠权威宣示硬压。',
      noteEn: 'As pressure rises, audit provinces, legions, and treasuries instead of relying on pure authority signaling.',
      focusCards: ['audit_reckoning', 'mandate_snapback', 'backchannel_pact'],
    },
    committed: {
      labelZh: '正统维稳',
      labelEn: 'Orthodoxy Hold',
      noteZh: '承诺后继续围绕宫廷密约、听证和人治接管稳住主线。',
      noteEn: 'After commitment, keep the worldline steady through court pacts, hearings, and direct human intervention.',
      focusCards: ['backchannel_pact', 'public_hearing', 'human_takeover'],
    },
  },
  industry: {
    opening: {
      labelZh: '产能调度',
      labelEn: 'Throughput Tuning',
      noteZh: '先重排产能和资源走向，再决定是否公开冲突。',
      noteEn: 'Re-route throughput and resource flow first, then decide whether to surface conflict publicly.',
      focusCards: ['resource_triage', 'backchannel_pact', 'mandate_surge'],
    },
    pressure: {
      labelZh: '系统排障',
      labelEn: 'System Triage',
      noteZh: '能源和物流吃紧时先保关键节点，再处理舆论反弹。',
      noteEn: 'When energy and logistics tighten, protect critical nodes first, then handle the backlash.',
      focusCards: ['resource_triage', 'audit_reckoning', 'evacuation_order'],
    },
    committed: {
      labelZh: '供应链锁线',
      labelEn: 'Supply Lock',
      noteZh: '承诺后继续围绕配给、隐性交易和人工接管稳住主线。',
      noteEn: 'After commitment, keep the line stable through rationing, off-book deals, and direct takeovers.',
      focusCards: ['resource_triage', 'backchannel_pact', 'human_takeover'],
    },
  },
  trade: {
    opening: {
      labelZh: '筹码交易',
      labelEn: 'Leverage Trade',
      noteZh: '优先做港口、关税和护航筹码交换，而不是立刻公开摊牌。',
      noteEn: 'Lead with ports, tariffs, and convoy leverage instead of going public immediately.',
      focusCards: ['backchannel_pact', 'spy_infiltrate', 'intel_blowback'],
    },
    pressure: {
      labelZh: '市场灭火',
      labelEn: 'Market Firebreak',
      noteZh: '市场失衡时先切断坏情报与黑箱交易，再决定公开听证。',
      noteEn: 'When markets seize up, cut poisoned intel and opaque deals before opening the hearing.',
      focusCards: ['intel_blowback', 'audit_reckoning', 'public_hearing'],
    },
    committed: {
      labelZh: '商路钉住',
      labelEn: 'Route Lock',
      noteZh: '承诺后继续围绕密约、听证和情报反噬控制航线叙事。',
      noteEn: 'After commitment, keep the branch on-route through pacts, hearings, and intel blowback.',
      focusCards: ['backchannel_pact', 'public_hearing', 'intel_blowback'],
    },
  },
  law: {
    opening: {
      labelZh: '程序立场',
      labelEn: 'Procedural Posture',
      noteZh: '优先把证据、判例和程序红线摆上桌，再决定谁能越权。',
      noteEn: 'Put evidence, precedent, and procedural red lines on the table before anyone overreaches.',
      focusCards: ['public_hearing', 'audit_reckoning', 'human_takeover'],
    },
    pressure: {
      labelZh: '程序冻结',
      labelEn: 'Procedure Freeze',
      noteZh: '局势过热时先冻结例外条款和黑箱裁量，再让各方重新举证。',
      noteEn: 'When the branch overheats, freeze emergency exceptions and black-box discretion, then force everyone back to evidence.',
      focusCards: ['audit_reckoning', 'public_hearing', 'mandate_snapback'],
    },
    committed: {
      labelZh: '判例锁链',
      labelEn: 'Precedent Chain',
      noteZh: '承诺后继续用听证、程序接管和审计把主线钉成可执行判例。',
      noteEn: 'After commitment, keep the worldline enforceable through hearings, procedural takeovers, and audit.',
      focusCards: ['public_hearing', 'human_takeover', 'audit_reckoning'],
    },
  },
  faith: {
    opening: {
      labelZh: '教义试探',
      labelEn: 'Doctrine Probe',
      noteZh: '先测试神谕、仪式和密约之间的张力，再决定要不要公开断裂。',
      noteEn: 'Probe the tension between prophecy, ritual, and secret bargains before making the schism public.',
      focusCards: ['forbidden_ritual', 'backchannel_pact', 'mandate_surge'],
    },
    pressure: {
      labelZh: '教团止裂',
      labelEn: 'Schism Control',
      noteZh: '当信众失控时先回摆民意和责任链，避免禁术把分支直接点燃。',
      noteEn: 'When the faithful destabilize, pull back with public mandate and accountability before the rite ignites the branch.',
      focusCards: ['mandate_snapback', 'audit_reckoning', 'ceasefire_committee'],
    },
    committed: {
      labelZh: '神谕锁定',
      labelEn: 'Prophecy Lock',
      noteZh: '承诺后持续用禁术、密约和回摆维持教义主线。',
      noteEn: 'After commitment, keep the prophecy line stable through rites, secret pacts, and snapback control.',
      focusCards: ['forbidden_ritual', 'backchannel_pact', 'mandate_snapback'],
    },
  },
  ecology: {
    opening: {
      labelZh: '阈值调度',
      labelEn: 'Threshold Dispatch',
      noteZh: '优先决定水、迁徙和防疫配给，别让分支先陷入抽象争论。',
      noteEn: 'Prioritize water, migration, and containment allocation before the branch drifts into abstraction.',
      focusCards: ['resource_triage', 'evacuation_order', 'public_hearing'],
    },
    pressure: {
      labelZh: '生存止跌',
      labelEn: 'Survival Brake',
      noteZh: '生态崩压时先保命与撤离，再用公开听证处理正当性争议。',
      noteEn: 'Under ecological collapse, secure survival and evacuation first, then litigate legitimacy in public.',
      focusCards: ['evacuation_order', 'resource_triage', 'ceasefire_committee'],
    },
    committed: {
      labelZh: '走廊守住',
      labelEn: 'Corridor Hold',
      noteZh: '承诺后继续围绕迁徙走廊、配给和停火窗口守住主线。',
      noteEn: 'After commitment, keep the line anchored around migration corridors, rationing, and ceasefire windows.',
      focusCards: ['resource_triage', 'evacuation_order', 'ceasefire_committee'],
    },
  },
  frontier: {
    opening: {
      labelZh: '边疆试探',
      labelEn: 'Frontier Probe',
      noteZh: '优先制造轨道信号、自治筹码和补给窗口，而不是直接宣布新秩序。',
      noteEn: 'Open with orbital signals, autonomy leverage, and supply windows before declaring a new order.',
      focusCards: ['spacetime_rift', 'resource_triage', 'human_takeover'],
    },
    pressure: {
      labelZh: '生命维持',
      labelEn: 'Life Support Hold',
      noteZh: '生命维持线紧绷时先撤离、分诊和切断错误情报。',
      noteEn: 'When life support tightens, prioritize evacuation, triage, and severing bad intelligence.',
      focusCards: ['evacuation_order', 'resource_triage', 'intel_blowback'],
    },
    committed: {
      labelZh: '自治主线',
      labelEn: 'Autonomy Track',
      noteZh: '承诺后继续围绕裂隙信号、接管与配给把自治主线钉住。',
      noteEn: 'After commitment, keep the autonomy line stable through rift signals, takeovers, and rationing.',
      focusCards: ['spacetime_rift', 'human_takeover', 'resource_triage'],
    },
  },
  mythic: {
    opening: {
      labelZh: '秘仪试压',
      labelEn: 'Arcane Probe',
      noteZh: '先试探禁术、盟约和舞台叙事，再决定是否公开裂开秩序。',
      noteEn: 'Probe rites, pacts, and ritual theater first before openly rupturing the order.',
      focusCards: ['forbidden_ritual', 'backchannel_pact', 'civilization_debate'],
    },
    pressure: {
      labelZh: '反噬管理',
      labelEn: 'Backlash Control',
      noteZh: '当代价失控时，优先回摆民意与错误情报，别连续叠禁术。',
      noteEn: 'When the costs spiral, stabilize public mandate and bad intelligence before stacking more rites.',
      focusCards: ['mandate_snapback', 'intel_blowback', 'public_hearing'],
    },
    committed: {
      labelZh: '预言锁线',
      labelEn: 'Prophecy Rail',
      noteZh: '承诺后继续用禁术、辩论和密约维持预言主线的仪式感。',
      noteEn: 'After commitment, keep the prophecy rail alive through rites, debate, and clandestine bargains.',
      focusCards: ['forbidden_ritual', 'civilization_debate', 'backchannel_pact'],
    },
  },
  survival: {
    opening: {
      labelZh: '保命优先',
      labelEn: 'Survival First',
      noteZh: '先决定谁能活、谁先走、哪些管线必须让路，再谈宏观叙事。',
      noteEn: 'Decide who lives, who moves first, and which lifelines get priority before debating grand strategy.',
      focusCards: ['resource_triage', 'evacuation_order', 'human_takeover'],
    },
    pressure: {
      labelZh: '极限止损',
      labelEn: 'Critical Loss Control',
      noteZh: '快撑不住时优先撤离、停火和切断错误链路，别让分支直接崩盘。',
      noteEn: 'When the branch is close to collapse, prioritize evacuation, ceasefire, and severing bad chains.',
      focusCards: ['evacuation_order', 'ceasefire_committee', 'intel_blowback'],
    },
    committed: {
      labelZh: '避难主线',
      labelEn: 'Refuge Hold',
      noteZh: '承诺后继续围绕撤离、分诊和人工接管守住避难主线。',
      noteEn: 'After commitment, keep the refuge line stable through evacuation, triage, and direct intervention.',
      focusCards: ['evacuation_order', 'resource_triage', 'human_takeover'],
    },
  },
  finance: {
    opening: {
      labelZh: '资本试探',
      labelEn: 'Capital Probe',
      noteZh: '先摸清资金流向、做空筹码和监管口径，再决定是否公开引爆信用裂缝。',
      noteEn: 'Map capital flows, short leverage, and regulatory posture before publicly triggering a credit fault line.',
      focusCards: ['backchannel_pact', 'audit_reckoning', 'spy_infiltrate'],
    },
    pressure: {
      labelZh: '流动性止血',
      labelEn: 'Liquidity Tourniquet',
      noteZh: '挤兑蔓延时先冻结错误情报和暗箱交易，再决定是否公开救助。',
      noteEn: 'When a run spreads, freeze bad intelligence and opaque deals before deciding on a public bailout.',
      focusCards: ['intel_blowback', 'audit_reckoning', 'resource_triage'],
    },
    committed: {
      labelZh: '信用锚定',
      labelEn: 'Credit Anchor',
      noteZh: '承诺后继续围绕审计、密约和听证把信用主线钉住。',
      noteEn: 'After commitment, keep the credit line anchored through audits, back-channel pacts, and public hearings.',
      focusCards: ['audit_reckoning', 'backchannel_pact', 'public_hearing'],
    },
  },
  scholar: {
    opening: {
      labelZh: '学说试压',
      labelEn: 'Thesis Probe',
      noteZh: '先用辩论和听证暴露学派分歧，再决定是否拉出暗线盟约。',
      noteEn: 'Surface factional schisms through debate and hearings before pulling hidden alliances into the open.',
      focusCards: ['civilization_debate', 'public_hearing', 'backchannel_pact'],
    },
    pressure: {
      labelZh: '学术止裂',
      labelEn: 'Schism Brake',
      noteZh: '当学派对立白热化时，先回摆民意和审计证据链，阻止话语垄断。',
      noteEn: 'When factional tensions peak, pull back with mandate snapback and audit evidence to prevent discourse monopoly.',
      focusCards: ['mandate_snapback', 'audit_reckoning', 'public_hearing'],
    },
    committed: {
      labelZh: '范式锁定',
      labelEn: 'Paradigm Lock',
      noteZh: '承诺后继续围绕辩论、听证和人工接管把主流范式钉住。',
      noteEn: 'After commitment, keep the dominant paradigm pinned through debate, hearings, and direct intervention.',
      focusCards: ['civilization_debate', 'public_hearing', 'human_takeover'],
    },
  },
  medical: {
    opening: {
      labelZh: '诊疗分诊',
      labelEn: 'Triage Dispatch',
      noteZh: '优先决定资源配给和撤离优先级，不要让分支先陷入伦理抽象争论。',
      noteEn: 'Prioritize resource allocation and evacuation order before the branch drifts into abstract ethical debate.',
      focusCards: ['resource_triage', 'evacuation_order', 'public_hearing'],
    },
    pressure: {
      labelZh: '院内止损',
      labelEn: 'Clinical Loss Control',
      noteZh: '医疗系统过载时先保命、撤离和切断错误情报链路。',
      noteEn: 'When the medical system overloads, secure lives, evacuate, and sever bad intelligence chains first.',
      focusCards: ['evacuation_order', 'resource_triage', 'intel_blowback'],
    },
    committed: {
      labelZh: '生命线锁定',
      labelEn: 'Lifeline Lock',
      noteZh: '承诺后继续围绕配给、撤离和人工接管守住医疗主线。',
      noteEn: 'After commitment, keep the medical line stable through rationing, evacuation, and direct intervention.',
      focusCards: ['resource_triage', 'evacuation_order', 'human_takeover'],
    },
  },
  technology: {
    opening: {
      labelZh: '技术路线试探',
      labelEn: 'Tech Stack Probe',
      noteZh: '先用情报和密约厘清技术路线依赖，再决定是否公开推翻现有架构。',
      noteEn: 'Clarify technology stack dependencies through intelligence and pacts before publicly dismantling existing architecture.',
      focusCards: ['spy_infiltrate', 'backchannel_pact', 'spacetime_rift'],
    },
    pressure: {
      labelZh: '系统熔断',
      labelEn: 'System Circuit Breaker',
      noteZh: '技术债爆发时先分诊关键节点、切断坏情报，再用听证定责。',
      noteEn: 'When technical debt explodes, triage critical nodes, sever bad intel, then assign accountability through hearings.',
      focusCards: ['resource_triage', 'intel_blowback', 'public_hearing'],
    },
    committed: {
      labelZh: '技术栈锁线',
      labelEn: 'Stack Lock',
      noteZh: '承诺后继续围绕裂隙信号、密约和接管把技术主线钉住。',
      noteEn: 'After commitment, keep the tech line stable through rift signals, pacts, and direct takeovers.',
      focusCards: ['spacetime_rift', 'backchannel_pact', 'human_takeover'],
    },
  },
  entertainment: {
    opening: {
      labelZh: '舆论造势',
      labelEn: 'Narrative Hype',
      noteZh: '先用辩论和民意冲击制造话题热度，再决定暗线操作。',
      noteEn: 'Build narrative heat through debate and mandate surges before moving to off-book maneuvers.',
      focusCards: ['civilization_debate', 'mandate_surge', 'backchannel_pact'],
    },
    pressure: {
      labelZh: '口碑灭火',
      labelEn: 'Reputation Firebreak',
      noteZh: '舆论翻车时先回摆民意、审计责任链，再用听证重建叙事。',
      noteEn: 'When public opinion crashes, pull back with mandate snapback and audit before rebuilding through hearings.',
      focusCards: ['mandate_snapback', 'audit_reckoning', 'public_hearing'],
    },
    committed: {
      labelZh: '叙事锁定',
      labelEn: 'Narrative Lock',
      noteZh: '承诺后继续围绕辩论、民意冲击和密约维持叙事主线。',
      noteEn: 'After commitment, keep the narrative line alive through debate, mandate surges, and secret bargains.',
      focusCards: ['civilization_debate', 'mandate_surge', 'backchannel_pact'],
    },
  },
  diplomacy: {
    opening: {
      labelZh: '外交试探',
      labelEn: 'Diplomatic Probe',
      noteZh: '先用密约和停火窗口建立筹码，再决定是否公开摊牌。',
      noteEn: 'Build leverage through pacts and ceasefire windows before deciding on a public showdown.',
      focusCards: ['backchannel_pact', 'ceasefire_committee', 'spy_infiltrate'],
    },
    pressure: {
      labelZh: '外交止损',
      labelEn: 'Diplomatic Damage Control',
      noteZh: '谈判破裂时先停火和切断错误情报，再用听证重启对话。',
      noteEn: 'When negotiations collapse, secure ceasefire and sever bad intelligence before restarting dialogue through hearings.',
      focusCards: ['ceasefire_committee', 'intel_blowback', 'public_hearing'],
    },
    committed: {
      labelZh: '条约锁定',
      labelEn: 'Treaty Lock',
      noteZh: '承诺后继续围绕密约、停火和听证把条约主线钉住。',
      noteEn: 'After commitment, keep the treaty line stable through pacts, ceasefire, and public hearings.',
      focusCards: ['backchannel_pact', 'ceasefire_committee', 'public_hearing'],
    },
  },
  generic: {
    opening: {
      labelZh: '试探重心',
      labelEn: 'Center Probe',
      noteZh: '先用公开听证和辩论制造新的重心，再决定要不要走暗线。',
      noteEn: 'Use hearings and debate to create a new center of gravity before moving off-book.',
      focusCards: ['public_hearing', 'civilization_debate', 'backchannel_pact'],
    },
    pressure: {
      labelZh: '回摆纠偏',
      labelEn: 'Correction Loop',
      noteZh: '当分支失控时优先回摆民意、审计责任，再决定是否升级反制。',
      noteEn: 'When the branch loses shape, pull back through mandate and audit before escalating the counterplay.',
      focusCards: ['mandate_snapback', 'audit_reckoning', 'intel_blowback'],
    },
    committed: {
      labelZh: '主线维持',
      labelEn: 'Line Maintenance',
      noteZh: '承诺后继续围绕听证、密约和人工接管把主线维持住。',
      noteEn: 'After commitment, maintain the line through hearings, bargains, and direct intervention.',
      focusCards: ['public_hearing', 'backchannel_pact', 'human_takeover'],
    },
  },
};

const KEYWORD_TO_PROFILE: Array<[GameplayProfileId, string[]]> = [
  ['generic', ['随机交换负责人', '随机交换一次负责人', '每周随机交换一次负责人', '轮换负责人', '抽签换帅', '随机换帅', '每周换负责人', '所有关键城市都必须每三十天由抽签产生的临时委员会接管', '抽签产生的临时委员会', '如果每一项重大决策都必须交给轮值外部评审团重新裁决', '轮值外部评审团重新裁决', '轮值外部评审团', 'lottery-picked emergency committee', 'temporary lottery committee', 'lottery committee', 'rotating external review board', 'every high-stakes decision had to be re-approved by a rotating external review board', 'swap leaders', 'leader shuffle', 'rotating leadership', 'random leadership', 'weekly leadership shuffle']],
  ['law', ['法院', '法庭', '法律', '合规', '宪法', '宪章', '司法', '审计', '否决', 'court', 'legal', 'constitutional', 'judicial', 'compliance', 'audit', 'veto']],
  ['finance', ['金融', '银行', '央行', '挤兑', '流动性', '信用违约', '财政', 'finance', 'bank', 'central bank', 'liquidity', 'credit crisis', 'default', 'bailout', 'market panic']],
  ['trade', ['贸易', '商路', '港口', '关税', '商团', '供应链', '海峡', 'trade', 'tariff', 'port', 'merchant', 'supply chain', 'logistics', 'harbor']],
  ['faith', ['宗教', '教会', '神谕', '异端', '神权', '圣', 'religion', 'church', 'faith', 'prophecy', 'heresy', 'sacred', 'temple']],
  ['ecology', ['生态', '气候', '森林', '水源', '淡水', '枯竭', '干旱', '迁徙', '瘟疫', '洪水', '环境', 'climate', 'ecology', 'forest', 'migration', 'plague', 'drought', 'water', 'freshwater', 'environment']],
  ['governance', ['人工智能', '算法', '民主', '治理', '选举', 'ai', 'algorithm', 'govern', 'democracy', 'internet']],
  ['medical', ['医疗', '医院', '医生', '护士', '患者', '公共卫生', '疫情', '疫苗', '分诊', 'medical', 'hospital', 'doctor', 'nurse', 'patient', 'public health', 'pandemic', 'vaccine', 'triage']],
  ['technology', ['技术', '软件', '芯片', '算力', '开源', '网络安全', 'technology', 'software', 'chip', 'compute', 'open source', 'cybersecurity', 'tech stack']],
  ['scholar', ['学术', '学院', '大学', '教授', '论文', '范式', 'academic', 'academy', 'university', 'professor', 'paper', 'paradigm']],
  ['entertainment', ['娱乐', '媒体', '明星', '粉丝', '票房', '流量', 'entertainment', 'media', 'celebrity', 'fan', 'box office', 'audience']],
  ['diplomacy', ['外交', '峰会', '条约', '联盟', '制裁', '大使', 'diplomacy', 'summit', 'treaty', 'alliance', 'sanction', 'ambassador']],
  ['war', ['战争', '战场', '围攻', '军', '补给线', '后勤', '车队', '运输枢纽', 'war', 'battle', 'invasion', 'siege', 'supply line', 'convoy', 'logistics hub']],
  ['empire', ['帝国', '王朝', '王国', '古罗马', '三国', 'empire', 'dynasty', 'kingdom', 'roman']],
  ['industry', ['工业', '工厂', '资源', '能源', '市场', '蒸汽', 'industrial', 'factory', 'resource', 'market', 'energy']],
  ['frontier', ['边疆', '远征', '舰队', '自治城邦', '流动城邦', '殖民地', '轨道', '太空', '火星', '空间站', '海洋', '深海', '星域', 'frontier', 'expedition', 'fleet', 'autonomous city-state', 'orbital', 'space', 'mars', 'colony', 'ocean', 'underwater', 'starfield']],
  ['mythic', ['奇幻', '魔法', '龙', '巫师', '法师', '秘法', '奥术', '符文', '巨龙', 'fantasy', 'magic', 'dragon', 'wizard', 'arcane', 'rune', 'sorcerer']],
  ['survival', ['末日', '崩塌', '灾难', '灭绝', 'survival', 'collapse', 'apocalypse', 'disaster', 'extinction']],
];

function hasOwnRecordKey<T>(
  record: Partial<Record<GameplayProfileId, T>>,
  profileId: string | null | undefined,
): profileId is GameplayProfileId {
  return (
    typeof profileId === 'string'
    && Object.prototype.hasOwnProperty.call(record, profileId)
    && Boolean(record[profileId as GameplayProfileId])
  );
}

function getGameplayCardEffect(cardId: GameplayCardId): { risk: number; resource: number } {
  return gameplayCardEffects[cardId] ?? neutralCardEffect;
}

function resolveGameplayProfileId(
  profileId: GameplayProfileId | string | null | undefined,
): GameplayProfileId {
  return hasOwnRecordKey(gameplayProfiles, profileId) ? profileId : 'generic';
}

function getGameplayProfile(
  profileId: GameplayProfileId | string | null | undefined,
): GameplayProfileDefinition {
  const profile = gameplayProfiles[resolveGameplayProfileId(profileId)] ?? gameplayProfiles.generic;
  if (!profile) {
    throw new Error('Gameplay profile contract is missing the generic fallback profile.');
  }
  return profile;
}

function getGameplaySignatureArcDefinition(
  profileId: GameplayProfileId | string | null | undefined,
): GameplaySignatureArcDefinition {
  const arc = gameplaySignatureArcs[resolveGameplayProfileId(profileId)] ?? gameplaySignatureArcs.generic;
  if (!arc) {
    throw new Error('Gameplay signature arc contract is missing the generic fallback profile.');
  }
  return arc;
}

export function getGameplayCardDefinition(cardId: GameplayCardId): GameplayCardDefinition {
  return (
    gameplayCardDefs.find((card) => card.id === cardId)
    ?? gameplayCardDefs[0]
  );
}

export function isGameplayCardId(cardId: string | null | undefined): cardId is GameplayCardId {
  return typeof cardId === 'string' && gameplayCardDefs.some((card) => card.id === cardId);
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
    if (!hasOwnRecordKey(gameplayProfiles, profileId)) return;
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

  return bestProfileId ? getGameplayProfile(bestProfileId) : getGameplayProfile('generic');
}

export function getGameplayProfileDescription(profileId: GameplayProfileId, isZh: boolean): string {
  const profile = getGameplayProfile(profileId);
  return isZh ? profile.descriptionZh : profile.descriptionEn;
}

export function getGameplayProfileLabel(profileId: GameplayProfileId, isZh: boolean): string {
  const profile = getGameplayProfile(profileId);
  return isZh ? profile.labelZh : profile.labelEn;
}

export function getGameplayProfileSignatureHooks(
  profileId: GameplayProfileId,
  isZh: boolean,
): string[] {
  const profile = getGameplayProfile(profileId);
  return isZh ? profile.signatureHooksZh : profile.signatureHooksEn;
}

export function getGameplayCardDirectivePreview(
  profileId: GameplayProfileId,
  cardId: GameplayCardId,
  isZh: boolean,
): string {
  return resolveGameplayDirective(profileId, cardId, isZh);
}

export function getGameplayProfileFrameSrc(profileId: GameplayProfileId): string {
  return GAMEPLAY_PROFILE_FRAME_ASSETS[resolveGameplayProfileId(profileId)];
}

export function getGameplaySignatureArc(profileId: GameplayProfileId, isZh: boolean) {
  const arc = getGameplaySignatureArcDefinition(profileId);
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
  const resolvedProfileId = resolveGameplayProfileId(profileId);
  const arc = getGameplaySignatureArc(resolvedProfileId, isZh);
  const relevantUsages = usages
    .filter((usage) => resolveGameplayProfileId(usage.profileId) === resolvedProfileId)
    .sort((a, b) => a.round - b.round);

  let matchedSteps = 0;
  for (const usage of relevantUsages) {
    if (usage.cardId === arc.sequence[matchedSteps]) {
      matchedSteps += 1;
      if (matchedSteps === arc.sequence.length) break;
    }
  }

  const riskValue = relevantUsages.reduce((sum, usage) => sum + getGameplayCardEffect(usage.cardId).risk, 0);
  const resourceValue = relevantUsages.reduce((sum, usage) => sum + getGameplayCardEffect(usage.cardId).resource, 0);
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

export function isCounterplayCard(cardId: GameplayCardId): boolean {
  return COUNTERPLAY_CARD_IDS.has(cardId);
}

export function getScenarioSystemTrackState(
  profileId: GameplayProfileId,
  usages: GameplayUsageLike[],
  commitment: BranchCommitmentLike | null | undefined,
  isZh: boolean,
) {
  const arc = getGameplaySignatureArc(resolveGameplayProfileId(profileId), isZh);
  const totalRisk = usages.reduce((sum, usage) => sum + getGameplayCardEffect(usage.cardId).risk, 0);
  const totalResource = usages.reduce((sum, usage) => sum + getGameplayCardEffect(usage.cardId).resource, 0);
  const commitmentRisk = commitment?.active ? 1 : 0;
  const commitmentResource = commitment?.active ? -1 : 0;
  const riskValue = Math.max(0, Math.min(6, totalRisk + commitmentRisk));
  const resourceValue = Math.max(0, Math.min(6, 3 + totalResource + commitmentResource));
  const pressure = riskValue >= 5
    ? (isZh ? '高压' : 'Critical')
    : riskValue >= 3
      ? (isZh ? '紧绷' : 'Strained')
      : (isZh ? '可控' : 'Stable');
  const counterplayRecommended = riskValue >= 4 || resourceValue <= 2;

  return {
    label: arc.label,
    riskLabel: arc.riskLabel,
    resourceLabel: arc.resourceLabel,
    riskValue,
    resourceValue,
    pressure,
    counterplayRecommended,
  };
}

export function getGameplayProfileTacticalState(
  profileId: GameplayProfileId,
  usages: GameplayUsageLike[] = [],
  commitment?: BranchCommitmentLike | null,
  isZh = true,
) {
  const resolvedProfileId = resolveGameplayProfileId(profileId);
  const strategy = PROFILE_STRATEGY_RULES[resolvedProfileId] ?? PROFILE_STRATEGY_RULES.generic;
  const systemTracks = getScenarioSystemTrackState(resolvedProfileId, usages, commitment, isZh);

  let mode: GameplayTacticalMode = 'opening';
  if (systemTracks.riskValue >= 4 || systemTracks.resourceValue <= 2) {
    mode = 'pressure';
  } else if (commitment?.active) {
    mode = 'committed';
  }

  const preset = strategy[mode];
  return {
    mode,
    label: isZh ? preset.labelZh : preset.labelEn,
    note: isZh ? preset.noteZh : preset.noteEn,
    focusCards: preset.focusCards,
  };
}

export function getGameplayCardDisplayModel(
  profileId: GameplayProfileId | string | null | undefined,
  scenarioContext?: {
    usages?: GameplayUsageLike[];
    commitment?: BranchCommitmentLike | null;
  } | null,
): GameplayCardDisplayModel {
  const ranked = getRecommendedGameplayCards(
    resolveGameplayProfileId(profileId),
    scenarioContext?.usages ?? [],
    scenarioContext?.commitment ?? null,
  );
  const recommended = ranked.slice(0, 3);
  const recommendedSet = new Set<GameplayCardId>(recommended);

  const groups: GameplayCardGroupModel[] = GROUP_DEFINITIONS.map((definition) => ({
    id: definition.id,
    cardIds: definition.cards.filter((cardId) => !recommendedSet.has(cardId)),
  }));

  return { recommended, groups };
}

export function getRecommendedGameplayCards(
  profileId: GameplayProfileId,
  usages: GameplayUsageLike[] = [],
  commitment?: BranchCommitmentLike | null,
): GameplayCardId[] {
  const resolvedProfileId = resolveGameplayProfileId(profileId);
  const cards = [...getGameplayProfile(resolvedProfileId).recommendedCards];
  const arcState = getGameplaySignatureArcState(resolvedProfileId, usages, true);
  const systemTracks = getScenarioSystemTrackState(resolvedProfileId, usages, commitment, true);
  const tacticalState = getGameplayProfileTacticalState(resolvedProfileId, usages, commitment, true);
  const counterplayCards = Array.from(COUNTERPLAY_CARD_IDS);
  const priorities: GameplayCardId[] = [];

  priorities.push(...tacticalState.focusCards);
  if (usages.length === 0 && cards.length > 0) {
    priorities.push(cards[0]);
  }
  if (arcState.nextCardId) {
    priorities.push(arcState.nextCardId);
  }
  if (commitment?.active) {
    priorities.push(...(PROFILE_STRATEGY_RULES[resolvedProfileId] ?? PROFILE_STRATEGY_RULES.generic).committed.focusCards);
  }
  if (systemTracks.counterplayRecommended) {
    priorities.push(
      ...counterplayCards.filter((cardId) => tacticalState.focusCards.includes(cardId)),
      ...counterplayCards,
    );
  }

  return [
    ...priorities.filter((cardId, index, array) => array.indexOf(cardId) === index),
    ...cards.filter((cardId) => !priorities.includes(cardId)),
  ];
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
  profileDoctrine?: string,
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
  if (profileDoctrine) {
    lines.push(isZh ? `当前打法：${profileDoctrine}` : `Current play pattern: ${profileDoctrine}`);
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

function interpolateGameplayPromptLine(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, key: string) => values[key] ?? '');
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
  const heuristics = PROFILE_HEURISTICS[resolveGameplayProfileId(profileId)];
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
  const keywords = PROFILE_HEURISTICS[resolveGameplayProfileId(profileId)]?.sourceBranchKeywords ?? [];
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
  const base = resolveGameplayDirective(profileId, cardId, isZh);

  if (isZh) {
    return `基于「${question}」${sceneTheme ? `和${sceneTheme}场景` : '在当前场景'}推进：${base}`;
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
    profileDoctrine,
    isZh,
  } = input;

  const primaryAgent = resolveAgentName(agentsById, primaryAgentId);
  const secondaryAgent = resolveAgentName(agentsById, secondaryAgentId);
  const card = getGameplayCardDefinition(cardId);
  const directive = buildGameplayAutoDirective({
    cardId,
    question,
    sceneTheme,
    profileId,
    isZh,
  });
  const sourceBranchLabel = sourceBranchTitle || (isZh ? '另一条世界线' : 'another timeline');
  const promptLines = (isZh ? card.promptLinesZh : card.promptLinesEn).map((line) => (
    interpolateGameplayPromptLine(line, {
      primary_agent: primaryAgent,
      secondary_agent: secondaryAgent,
      directive: fallbackDirective(customDirective, directive),
      source_branch: sourceBranchLabel,
    })
  ));

  return [
    ...buildDirectorOverridePrefix(isZh),
    isZh ? `[Gameplay Action: ${card.labelEn} / ${card.labelZh}]` : `[Gameplay Action: ${card.labelEn}]`,
    isZh ? `当前 What-If：${question}` : `What-if premise: ${question}`,
    isZh ? `场景主题：${sceneTheme || '当前世界线'}` : `Scene theme: ${sceneTheme || 'current timeline'}`,
    isZh ? `目标分支：${targetBranchTitle}` : `Target branch: ${targetBranchTitle}`,
    ...(card.requiresSourceBranch
      ? [isZh ? `信息来源分支：${sourceBranchLabel}` : `Source branch: ${sourceBranchLabel}`]
      : []),
    ...buildSignatureArcContextLines(isZh, signatureArcLabel, signatureArcProgress, systemTrackSummary, profileDoctrine),
    ...promptLines,
  ].join('\n');
}

export function buildAgentsById(agents: AgentInfo[]): Record<string, AgentInfo> {
  return agents.reduce<Record<string, AgentInfo>>((accumulator, agent) => {
    accumulator[agent.id] = agent;
    return accumulator;
  }, {});
}

export function getDefaultGameplayTargetBranch(branches: BranchInfo[]): string | null {
  return branches.find((branch) => branch.status === 'ACTIVE')?.id ?? null;
}

function resolveGameplayDirective(
  profileId: GameplayProfileId,
  cardId: GameplayCardId,
  isZh: boolean,
): string {
  const profile = getGameplayProfile(profileId);
  const directive = profile.defaultDirectives[cardId];
  if (directive) {
    return isZh ? directive.zh : directive.en;
  }

  const card = getGameplayCardDefinition(cardId);
  return isZh
    ? `围绕${profile.labelZh}局势执行「${card.labelZh}」，明确要反制什么、代价落到谁头上、以及后续余波。`
    : `Use "${card.labelEn}" inside the ${profile.labelEn.toLowerCase()} situation and spell out what is being countered, who pays the cost, and what follow-on consequences remain.`;
}
