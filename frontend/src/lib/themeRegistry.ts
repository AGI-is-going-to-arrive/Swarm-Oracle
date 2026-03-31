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
  | 'finance'
  | 'scholar'
  | 'medical'
  | 'technology'
  | 'entertainment'
  | 'diplomacy'
  | 'generic';

interface ThemeRegistryEntry {
  labelZh: string;
  labelEn: string;
  assetPath: string;
  profileId: GameplayProfileId;
  keywords: string[];
}

export const CHARACTER_SPRITE_KEYS = [
  'sprite_king', 'sprite_warrior', 'sprite_scholar', 'sprite_merchant',
  'sprite_farmer', 'sprite_priest', 'sprite_rebel', 'sprite_diplomat',
  'sprite_villager', 'sprite_spy', 'sprite_explorer', 'sprite_scientist',
  'sprite_general', 'sprite_artist', 'sprite_engineer', 'sprite_noble',
  'sprite_healer', 'sprite_alchemist', 'sprite_assassin', 'sprite_bard',
  'sprite_knight', 'sprite_monk', 'sprite_thief', 'sprite_witch',
  'sprite_default',
] as const;

export const ENDING_ASSET_KEYS = [
  'prosperity', 'peace', 'war', 'ruin', 'tyranny', 'revolution',
] as const;
export type EndingAssetId = typeof ENDING_ASSET_KEYS[number];

export const UI_ASSET_KEYS = [
  'title_screen', 'minimap_frame', 'bet_panel', 'leaderboard',
] as const;

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
  finance: '/assets/ui/generated/gameplay_card_frame_frontier.png',
  scholar: '/assets/ui/generated/gameplay_card_frame_generic.png',
  medical: '/assets/ui/generated/gameplay_card_frame_ecology.png',
  technology: '/assets/ui/generated/gameplay_card_frame_frontier.png',
  entertainment: '/assets/ui/generated/gameplay_card_frame_mythic.png',
  diplomacy: '/assets/ui/generated/gameplay_card_frame_governance.png',
  generic: '/assets/ui/generated/gameplay_card_frame_generic.png',
};

export const GAMEPLAY_BADGE_ASSETS = {
  recommended: '/assets/ui/generated/badge_recommended.png',
  dailyChallenge: '/assets/ui/generated/badge_daily_challenge.png',
  archiveRecord: '/assets/ui/generated/badge_archive_record.png',
  betWinner: '/assets/ui/generated/badge_bet_winner.png',
} as const;

export const GAMEPLAY_PANEL_ASSET = '/assets/ui/generated/gameplay_panel.png';

export const DEBATE_UI_ASSETS = {
  stageBanner: '/assets/ui/generated/debate_stage_banner.png',
  verdictPanel: '/assets/ui/generated/debate_verdict_panel.png',
  scoreMeter: '/assets/ui/generated/debate_score_meter.png',
  badgeProposition: '/assets/ui/generated/debate_badge_proposition.png',
  badgeOpposition: '/assets/ui/generated/debate_badge_opposition.png',
  badgeJudge: '/assets/ui/generated/debate_badge_judge.png',
  quoteFrame: '/assets/ui/generated/debate_quote_frame.png',
} as const;

export const ORACLE_UI_ASSETS = {
  chamberPanel: '/assets/ui/generated/oracle_chamber_panel.png',
  chamberCrest: '/assets/ui/generated/oracle_chamber_crest.png',
  roundtablePanel: '/assets/ui/generated/worldline_roundtable_panel.png',
  roundtableBanner: '/assets/ui/generated/worldline_roundtable_banner.png',
  quoteFrame: '/assets/ui/generated/oracle_quote_frame.png',
  badgeEndingChamber: '/assets/ui/generated/badge_ending_chamber.png',
  badgeWorldlineRoundtable: '/assets/ui/generated/badge_worldline_roundtable.png',
  badgeCrosslineGallery: '/assets/ui/generated/badge_crossline_gallery.png',
  participantFrame: '/assets/ui/generated/ending_room_participant_frame.png',
  influenceBadge: '/assets/ui/generated/ending_room_influence_badge.png',
  timelineMarkerChamber: '/assets/ui/generated/timeline_marker_chamber.png',
  timelineMarkerRoundtable: '/assets/ui/generated/timeline_marker_roundtable.png',
  speakerGlow: '/assets/ui/generated/ending_room_speaker_glow.png',
  archivistEmblem: '/assets/ui/generated/archivist_emblem.png',
  dossierDivider: '/assets/ui/generated/worldline_dossier_divider.png',
} as const;

export const ASSET_MANIFEST = {
  runtime: {
    characters: CHARACTER_SPRITE_KEYS,
    endings: ENDING_ASSET_KEYS,
    ui: UI_ASSET_KEYS,
  },
  inventory: {
    characters: [
      'sprite_alchemist',
      'sprite_artist',
      'sprite_assassin',
      'sprite_bard',
      'sprite_default',
      'sprite_diplomat',
      'sprite_engineer',
      'sprite_explorer',
      'sprite_farmer',
      'sprite_general',
      'sprite_healer',
      'sprite_king',
      'sprite_knight',
      'sprite_merchant',
      'sprite_monk',
      'sprite_noble',
      'sprite_priest',
      'sprite_rebel',
      'sprite_scholar',
      'sprite_scientist',
      'sprite_spy',
      'sprite_thief',
      'sprite_villager',
      'sprite_warrior',
      'sprite_witch',
    ],
    effects: [
      'branch_split',
      'debate',
      'earthquake',
      'fire',
      'fog',
      'generic_flash',
      'handshake',
      'particle_smoke',
      'particle_star',
      'player_swap',
      'portal',
      'spy',
      'tech',
      'treasure',
    ],
    endings: [
      'peace',
      'prosperity',
      'revolution',
      'ruin',
      'tyranny',
      'war',
    ],
    scenes: [
      'ancient_empire',
      'arcane_sanctum',
      'civic_chamber',
      'debate_arena_civic',
      'debate_arena_forum',
      'debate_arena_judicial',
      'desert_outpost',
      'dynastic_palace',
      'ecology_wasteland',
      'factory_foundry',
      'faith_temple',
      'faith_temple_variant',
      'fantasy_kingdom',
      'frontier_colony',
      'imperial_forum',
      'industrial_city',
      'law_court',
      'law_court_variant',
      'logistics_hub',
      'medieval_village',
      'modern_city',
      'post_apocalypse',
      'power_grid_nexus',
      'refuge_compound',
      'scifi_base',
      'space_station',
      'surveillance_megacity',
      'switchboard_forum',
      'switchboard_forum_variant',
      'trade_harbor',
      'underwater_kingdom',
      'war_battlefield',
      'war_command',
    ],
    ui: {
      core: [
        'bet_panel',
        'buttons',
        'dialog_panel',
        'health_bar',
        'leaderboard',
        'minimap_frame',
        'panel_bg',
        'status_icons',
        'title_screen',
      ],
      generated: [
        'archive_panel',
        'archive_seal',
        'badge_archive_record',
        'badge_bet_winner',
        'badge_daily_challenge',
        'badge_recommended',
        'daily_challenge_badge',
        'daily_challenge_panel',
        'debate_badge_judge',
        'debate_badge_opposition',
        'debate_badge_proposition',
        'debate_quote_frame',
        'debate_score_meter',
        'debate_stage_banner',
        'debate_verdict_panel',
        'oracle_chamber_crest',
        'oracle_chamber_panel',
        'oracle_quote_frame',
        'badge_ending_chamber',
        'badge_worldline_roundtable',
        'badge_crossline_gallery',
        'ending_room_participant_frame',
        'ending_room_influence_badge',
        'ending_room_speaker_glow',
        'archivist_emblem',
        'timeline_marker_chamber',
        'timeline_marker_roundtable',
        'worldline_dossier_divider',
        'worldline_roundtable_panel',
        'worldline_roundtable_banner',
        'gameplay_card_frame_ecology',
        'gameplay_card_frame_empire',
        'gameplay_card_frame_faith',
        'gameplay_card_frame_frontier',
        'gameplay_card_frame_generic',
        'gameplay_card_frame_governance',
        'gameplay_card_frame_industry',
        'gameplay_card_frame_law',
        'gameplay_card_frame_mythic',
        'gameplay_card_frame_survival',
        'gameplay_card_frame_trade',
        'gameplay_card_frame_war',
        'gameplay_crest',
        'gameplay_panel',
        'timeline_marker_bet',
        'timeline_marker_card',
        'timeline_marker_fork',
        'timeline_marker_result',
      ],
    },
  },
} as const;

export const ASSET_MANIFEST_TOTAL =
  ASSET_MANIFEST.inventory.characters.length
  + ASSET_MANIFEST.inventory.effects.length
  + ASSET_MANIFEST.inventory.endings.length
  + ASSET_MANIFEST.inventory.scenes.length
  + ASSET_MANIFEST.inventory.ui.core.length
  + ASSET_MANIFEST.inventory.ui.generated.length;

export const THEME_REGISTRY = {
  switchboard_forum: {
    labelZh: '轮值议堂',
    labelEn: 'Switchboard Forum',
    assetPath: '/assets/scenes/switchboard_forum.png',
    profileId: 'generic',
    keywords: [
      'weekly leadership shuffle',
      'rotating leadership',
      'leader rotation',
      'leader shuffle',
      'swap leaders',
      'random leadership',
      'randomly swap leaders',
      'organizational roulette',
      'lottery-picked emergency committee',
      'temporary lottery committee',
      'lottery committee',
      'rotating external review board',
      'every high-stakes decision had to be re-approved by a rotating external review board',
      '负责人轮换',
      '随机换帅',
      '随机交换负责人',
      '每周随机交换一次负责人',
      '组织轮值',
      '抽签换帅',
      '所有关键城市都必须每三十天由抽签产生的临时委员会接管',
      '抽签产生的临时委员会',
      '轮值外部评审团重新裁决',
      '轮值外部评审团',
    ],
  },
  switchboard_forum_variant: {
    labelZh: '轮值审查议场',
    labelEn: 'Rotating Review Chamber',
    assetPath: '/assets/scenes/switchboard_forum_variant.png',
    profileId: 'generic',
    keywords: [
      'rotating review chamber',
      'procedural tribunal',
      'civic switchboard chamber',
      'committee dais',
      'oversight chamber',
      '轮值审查议场',
      '程序议场',
      '外部审查议场',
      '轮值委员会中枢',
      '程序委员会大厅',
    ],
  },
  medieval_village: {
    labelZh: '中世纪村庄',
    labelEn: 'Medieval Village',
    assetPath: '/assets/scenes/medieval_village.png',
    profileId: 'empire',
    keywords: ['medieval', 'middle age', '中世纪', '骑士', 'castle', '城堡', 'feudal'],
  },
  ancient_empire: {
    labelZh: '古代帝国',
    labelEn: 'Ancient Empire',
    assetPath: '/assets/scenes/ancient_empire.png',
    profileId: 'empire',
    keywords: ['ancient', 'rome', 'roman', 'empire', '古代', '帝国', '罗马', 'egypt', '埃及', 'greek', '希腊'],
  },
  industrial_city: {
    labelZh: '工业都市',
    labelEn: 'Industrial City',
    assetPath: '/assets/scenes/industrial_city.png',
    profileId: 'industry',
    keywords: ['industrial', 'factory', 'revolution', '工业', '工厂', 'steam', '蒸汽'],
  },
  surveillance_megacity: {
    labelZh: '监控巨城',
    labelEn: 'Surveillance Megacity',
    assetPath: '/assets/scenes/surveillance_megacity.png',
    profileId: 'governance',
    keywords: [
      'platform state',
      'social credit',
      'surveillance grid',
      'monitoring network',
      'digital checkpoint',
      'all-seeing network',
      'surveillance',
      '监控城市',
      '全域监控',
      '社会信用',
      '平台统治',
      '数字哨卡',
      '监控网络',
    ],
  },
  civic_chamber: {
    labelZh: '公民议会',
    labelEn: 'Civic Chamber',
    assetPath: '/assets/scenes/civic_chamber.png',
    profileId: 'governance',
    keywords: [
      'public oversight',
      'local accountability',
      'citizens assembly',
      'civic review',
      'parliament',
      'assembly',
      'election',
      'democracy',
      'oversight',
      '议会',
      '公民大会',
      '地方问责',
      '公共监督',
      '民意反馈',
      '审议',
      '选举',
      '民主',
    ],
  },
  debate_arena_civic: {
    labelZh: '公民辩论剧场',
    labelEn: 'Civic Debate Arena',
    assetPath: '/assets/scenes/debate_arena_civic.png',
    profileId: 'governance',
    keywords: [
      'civic debate',
      'citizens debate',
      'public policy showdown',
      'democratic duel',
      '公民辩论',
      '治理对决',
      '民主程序',
      '政策辩局',
    ],
  },
  debate_arena_judicial: {
    labelZh: '法政辩论法庭',
    labelEn: 'Judicial Debate Arena',
    assetPath: '/assets/scenes/debate_arena_judicial.png',
    profileId: 'law',
    keywords: [
      'judicial debate',
      'legal showdown',
      'procedural duel',
      'constitutional debate',
      '法庭辩论',
      '程序对决',
      '宪政辩论',
      '紧急否决',
    ],
  },
  debate_arena_forum: {
    labelZh: '高冲突议场',
    labelEn: 'Conflict Forum Arena',
    assetPath: '/assets/scenes/debate_arena_forum.png',
    profileId: 'generic',
    keywords: [
      'arena forum',
      'public forum clash',
      'oversight duel',
      'committee arena',
      '议场对决',
      '审查议场',
      '制度博弈',
      '委员会对抗',
    ],
  },
  law_court: {
    labelZh: '宪政法庭',
    labelEn: 'Constitutional Court',
    assetPath: '/assets/scenes/law_court.png',
    profileId: 'law',
    keywords: [
      'supreme court',
      'constitutional court',
      'courtroom',
      'tribunal',
      'judicial review',
      'legal review',
      'emergency veto',
      'court',
      'judge',
      'legal',
      'law',
      'constitutional',
      'judicial',
      'veto',
      'audit',
      '最高法院',
      '宪法法院',
      '法庭',
      '审判庭',
      '司法审查',
      '程序正义',
      '紧急否决权',
      '法院',
      '法官',
      '法律',
      '宪法',
      '司法',
      '否决',
      '审计',
    ],
  },
  law_court_variant: {
    labelZh: '大审判庭',
    labelEn: 'Grand Tribunal',
    assetPath: '/assets/scenes/law_court_variant.png',
    profileId: 'law',
    keywords: [
      'grand tribunal',
      'constitutional chamber',
      'appellate bench',
      'multi-judge hearing',
      'judicial archive',
      '合议庭',
      '大审判庭',
      '终审法庭',
      '法官合议',
      '司法档案厅',
    ],
  },
  modern_city: {
    labelZh: '现代都市',
    labelEn: 'Modern City',
    assetPath: '/assets/scenes/modern_city.png',
    profileId: 'governance',
    keywords: ['modern', 'city', 'urban', '现代', '城市', '民主'],
  },
  scifi_base: {
    labelZh: '科幻基地',
    labelEn: 'Sci-Fi Base',
    assetPath: '/assets/scenes/scifi_base.png',
    profileId: 'governance',
    keywords: [
      'artificial intelligence',
      'algorithmic governance',
      'autonomous system',
      'algorithmic',
      'autonomous',
      'algorithm',
      'scifi',
      'sci-fi',
      'space',
      'mars',
      'future',
      '人工智能',
      '算法治理',
      '自治系统',
      '机器人',
      '科幻',
      '太空',
      '火星',
      '未来',
      'AI',
      'robot',
    ],
  },
  post_apocalypse: {
    labelZh: '末日废土',
    labelEn: 'Post-Apocalypse',
    assetPath: '/assets/scenes/post_apocalypse.png',
    profileId: 'survival',
    keywords: ['apocalypse', 'disaster', 'collapse', '末日', '灾难', '崩溃', 'nuclear', '核'],
  },
  power_grid_nexus: {
    labelZh: '电网中枢',
    labelEn: 'Power Grid Nexus',
    assetPath: '/assets/scenes/power_grid_nexus.png',
    profileId: 'industry',
    keywords: [
      'grid failure',
      'dispatch center',
      'blackout',
      'substation',
      'load shedding',
      'power grid',
      '电网',
      '停电',
      '调度中心',
      '变电站',
      '负荷',
      '限电',
    ],
  },
  factory_foundry: {
    labelZh: '熔炉工场',
    labelEn: 'Factory Foundry',
    assetPath: '/assets/scenes/factory_foundry.png',
    profileId: 'industry',
    keywords: [
      'resource bottleneck',
      'assembly line',
      'power grid',
      'foundry',
      'smelter',
      'refinery',
      '输电',
      '冶炼',
      '熔炉',
      '工厂调度',
      '产能瓶颈',
      '能源调度',
    ],
  },
  frontier_colony: {
    labelZh: '边疆殖民地',
    labelEn: 'Frontier Colony',
    assetPath: '/assets/scenes/frontier_colony.png',
    profileId: 'frontier',
    keywords: [
      'autonomous city-state',
      'frontier colony',
      'colony charter',
      'surface settlement',
      'expedition camp',
      'terraform',
      '自治城邦',
      '流动城邦',
      '殖民章程',
      '前哨殖民地',
      '拓荒营地',
      '地表殖民',
    ],
  },
  imperial_forum: {
    labelZh: '帝国元老院',
    labelEn: 'Imperial Forum',
    assetPath: '/assets/scenes/imperial_forum.png',
    profileId: 'empire',
    keywords: [
      'imperial senate',
      'roman senate',
      'imperial capital',
      'caesar',
      'senate',
      'consul',
      'roman empire',
      '元老院',
      '帝都',
      '凯撒',
      '执政官',
      '罗马帝国',
      '罗马',
    ],
  },
  dynastic_palace: {
    labelZh: '王朝宫廷',
    labelEn: 'Dynastic Palace',
    assetPath: '/assets/scenes/dynastic_palace.png',
    profileId: 'empire',
    keywords: [
      'succession crisis',
      'palace intrigue',
      'royal court',
      'inheritance crisis',
      'dynastic marriage',
      'court faction',
      '宫廷',
      '继承危机',
      '王位',
      '贵族联盟',
      '后宫',
      '宫变',
    ],
  },
  faith_temple: {
    labelZh: '圣谕神殿',
    labelEn: 'Sacred Temple',
    assetPath: '/assets/scenes/faith_temple.png',
    profileId: 'faith',
    keywords: [
      'prophecy',
      'church',
      'religion',
      'sacred',
      'heresy',
      'temple',
      'oracle',
      'priesthood',
      'divine law',
      '神谕',
      '教会',
      '宗教',
      '神权',
      '异端',
      '祭司',
      '圣谕',
      '神殿',
      '神启',
    ],
  },
  faith_temple_variant: {
    labelZh: '圣议会殿',
    labelEn: 'Sacred Council Hall',
    assetPath: '/assets/scenes/faith_temple_variant.png',
    profileId: 'faith',
    keywords: [
      'sacred council',
      'doctrinal council',
      'clerical schism',
      'ritual council',
      'canon schism',
      '圣议会',
      '教义议会',
      '祭司议会',
      '教团分裂',
      '神殿议事',
    ],
  },
  fantasy_kingdom: {
    labelZh: '奇幻王国',
    labelEn: 'Fantasy Kingdom',
    assetPath: '/assets/scenes/fantasy_kingdom.png',
    profileId: 'mythic',
    keywords: ['fantasy', 'magic', '奇幻', '魔法'],
  },
  arcane_sanctum: {
    labelZh: '秘法圣所',
    labelEn: 'Arcane Sanctum',
    assetPath: '/assets/scenes/arcane_sanctum.png',
    profileId: 'mythic',
    keywords: ['arcane', 'sorcerer', 'spell', 'rune', 'wizard', '奥术', '秘法', '法师', '符文'],
  },
  refuge_compound: {
    labelZh: '避难营地',
    labelEn: 'Refuge Compound',
    assetPath: '/assets/scenes/refuge_compound.png',
    profileId: 'survival',
    keywords: [
      'survival compound',
      'refuge camp',
      'quarantine zone',
      'shelter network',
      'aid camp',
      'bunker',
      'refuge',
      'quarantine',
      'famine',
      'shelter',
      '避难所',
      '避难营地',
      '生存营地',
      '隔离区',
      '防疫营',
      '救援营地',
    ],
  },
  war_battlefield: {
    labelZh: '战争前线',
    labelEn: 'War Battlefield',
    assetPath: '/assets/scenes/war_battlefield.png',
    profileId: 'war',
    keywords: ['war', 'battle', 'military', '战争', '战场', '军事', 'conflict', '冲突'],
  },
  logistics_hub: {
    labelZh: '后勤枢纽',
    labelEn: 'Logistics Hub',
    assetPath: '/assets/scenes/logistics_hub.png',
    profileId: 'war',
    keywords: [
      'supply line',
      'logistics hub',
      'convoy',
      'rail hub',
      'transport corridor',
      'munitions depot',
      'logistics',
      '补给线',
      '后勤',
      '运输枢纽',
      '军工运输',
      '车队',
      '补给站',
    ],
  },
  war_command: {
    labelZh: '战争指挥室',
    labelEn: 'War Command',
    assetPath: '/assets/scenes/war_command.png',
    profileId: 'war',
    keywords: [
      'automated arsenal',
      'launch authority',
      'command chain',
      'command bunker',
      'war room',
      'missile command',
      'automated weapons',
      '开火权',
      '自动化军备',
      '指挥链',
      '导弹指挥',
      '误判升级',
    ],
  },
  space_station: {
    labelZh: '空间站',
    labelEn: 'Space Station',
    assetPath: '/assets/scenes/space_station.png',
    profileId: 'frontier',
    keywords: [
      'mars colony',
      'martian colony',
      'space colony',
      'orbital colony',
      'life support',
      'evacuation route',
      'evac route',
      'frontier',
      'station',
      'orbital',
      '空间站',
      '火星殖民地',
      '太空殖民地',
      '轨道殖民地',
      '生命维持',
      '撤离路线',
      '强制撤离',
      '边疆',
      'satellite',
      '卫星',
    ],
  },
  underwater_kingdom: {
    labelZh: '海底王国',
    labelEn: 'Underwater Kingdom',
    assetPath: '/assets/scenes/underwater_kingdom.png',
    profileId: 'ecology',
    keywords: ['underwater', 'ocean', 'sea', '海底', '海洋', 'atlantis', '亚特兰蒂斯'],
  },
  trade_harbor: {
    labelZh: '贸易海港',
    labelEn: 'Trade Harbor',
    assetPath: '/assets/scenes/trade_harbor.png',
    profileId: 'trade',
    keywords: [
      'maritime trade',
      'port authority',
      'trade chokepoint',
      'shipping lane',
      'customs gate',
      'merchant guild',
      'convoy route',
      'trade route',
      'supply chain',
      'trade',
      'merchant',
      'tariff',
      'strait',
      'chokepoint',
      'harbor',
      'port',
      'maritime',
      '海上商团',
      '航运',
      '港口',
      '海港',
      '海峡',
      '贸易咽喉',
      '贸易',
      '关税',
      '商团',
      '封港',
      '供应链',
    ],
  },
  ecology_wasteland: {
    labelZh: '生态阈值区',
    labelEn: 'Ecology Threshold Zone',
    assetPath: '/assets/scenes/ecology_wasteland.png',
    profileId: 'ecology',
    keywords: [
      'climate migration',
      'water rationing',
      'dry reservoir',
      'freshwater collapse',
      'water shortage',
      'freshwater',
      'drought',
      'ecology',
      'climate',
      'migration camp',
      '淡水供应',
      '淡水',
      '水资源短缺',
      '限水',
      '水源枯竭',
      '干旱',
      '迁徙',
      '生态',
      '气候',
    ],
  },
  desert_outpost: {
    labelZh: '沙漠前哨',
    labelEn: 'Desert Outpost',
    assetPath: '/assets/scenes/desert_outpost.png',
    profileId: 'trade',
    keywords: ['desert', 'sahara', 'oasis', '沙漠', '绿洲'],
  },
  finance_exchange: {
    labelZh: '金融交易所',
    labelEn: 'Finance Exchange',
    assetPath: '/assets/scenes/trade_harbor.png',
    profileId: 'finance',
    keywords: [
      'stock market', 'stock exchange', 'wall street', 'central bank',
      'financial crisis', 'currency', 'inflation', 'interest rate',
      'quantitative easing', 'bond market', 'hedge fund', 'investment',
      'banking', 'credit', 'debt', 'derivatives', 'futures',
      '股市', '股票交易所', '华尔街', '央行', '金融危机',
      '货币', '通胀', '利率', '量化宽松', '债券', '对冲基金',
      '投资', '银行', '信贷', '债务', '金融',
    ],
  },
  cyber_market: {
    labelZh: '数字黑市',
    labelEn: 'Cyber Marketplace',
    assetPath: '/assets/scenes/surveillance_megacity.png',
    profileId: 'finance',
    keywords: [
      'cryptocurrency', 'bitcoin', 'blockchain', 'digital currency',
      'dark market', 'cyber economy', 'token', 'NFT', 'DeFi',
      '加密货币', '比特币', '区块链', '数字货币',
      '暗网', '数字经济', '代币',
    ],
  },
  medical_institute: {
    labelZh: '医学研究院',
    labelEn: 'Medical Research Institute',
    assetPath: '/assets/scenes/modern_city.png',
    profileId: 'medical',
    keywords: [
      'pandemic', 'vaccine', 'hospital', 'epidemic', 'quarantine',
      'clinical trial', 'pharmaceutical', 'WHO', 'public health',
      'biotech', 'gene therapy', 'virus', 'antibiotic', 'surgery',
      'organ', 'transplant', 'medical ethics', 'triage',
      '疫情', '疫苗', '医院', '流行病', '隔离',
      '临床试验', '制药', '公共卫生', '生物技术',
      '基因', '病毒', '抗生素', '手术', '器官',
      '移植', '医学伦理', '分诊',
    ],
  },
  academy_hall: {
    labelZh: '学府大殿',
    labelEn: 'Academy Grand Hall',
    assetPath: '/assets/scenes/civic_chamber.png',
    profileId: 'scholar',
    keywords: [
      'university', 'academy', 'school', 'education', 'professor',
      'student', 'research', 'thesis', 'library', 'curriculum',
      'exam', 'scholarship', 'lecture', 'seminar', 'campus',
      'dean', 'faculty', 'academic freedom', 'peer review',
      '大学', '学院', '学校', '教育', '教授',
      '学生', '研究', '论文', '图书馆', '课程',
      '考试', '奖学金', '讲座', '校园', '学术自由',
      '同行评审', '院长', '教务',
    ],
  },
  tech_campus: {
    labelZh: '科技园区',
    labelEn: 'Tech Innovation Campus',
    assetPath: '/assets/scenes/scifi_base.png',
    profileId: 'technology',
    keywords: [
      'startup', 'silicon valley', 'tech company', 'innovation',
      'venture capital', 'IPO', 'disruption', 'platform',
      'app', 'software', 'hardware', 'chip', 'semiconductor',
      'data center', 'cloud computing', 'quantum computing',
      '创业', '硅谷', '科技公司', '创新',
      '风险投资', '颠覆', '平台', '应用',
      '软件', '硬件', '芯片', '半导体',
      '数据中心', '云计算', '量子计算',
    ],
  },
  arena_colosseum: {
    labelZh: '竞技场',
    labelEn: 'Arena Colosseum',
    assetPath: '/assets/scenes/ancient_empire.png',
    profileId: 'entertainment',
    keywords: [
      'gladiator', 'colosseum', 'arena', 'sports', 'olympics',
      'competition', 'tournament', 'champion', 'stadium', 'athlete',
      'referee', 'league', 'world cup', 'game', 'match',
      '角斗士', '竞技场', '体育', '奥运', '比赛',
      '锦标赛', '冠军', '体育场', '运动员', '裁判',
      '联赛', '世界杯',
    ],
  },
  concert_hall: {
    labelZh: '音乐厅',
    labelEn: 'Concert Hall',
    assetPath: '/assets/scenes/dynastic_palace.png',
    profileId: 'entertainment',
    keywords: [
      'concert', 'music', 'theater', 'opera', 'symphony',
      'performance', 'art', 'artist', 'gallery', 'museum',
      'cinema', 'film', 'festival', 'culture', 'creative',
      '音乐会', '音乐', '剧院', '歌剧', '交响乐',
      '表演', '艺术', '艺术家', '画廊', '博物馆',
      '电影', '电影院', '节日', '文化', '创意',
    ],
  },
  media_tower: {
    labelZh: '传媒之塔',
    labelEn: 'Media Broadcast Tower',
    assetPath: '/assets/scenes/surveillance_megacity.png',
    profileId: 'technology',
    keywords: [
      'media', 'broadcast', 'propaganda', 'censorship', 'press freedom',
      'news', 'journalist', 'social media', 'fake news', 'misinformation',
      'algorithm bias', 'content moderation', 'information warfare',
      '媒体', '广播', '宣传', '审查', '新闻自由',
      '新闻', '记者', '社交媒体', '假新闻', '虚假信息',
      '算法偏见', '内容审核', '信息战',
    ],
  },
  diplomatic_summit: {
    labelZh: '外交峰会',
    labelEn: 'Diplomatic Summit',
    assetPath: '/assets/scenes/civic_chamber.png',
    profileId: 'diplomacy',
    keywords: [
      'diplomacy', 'summit', 'treaty', 'alliance', 'embargo',
      'sanctions', 'negotiation', 'ceasefire', 'peace talks',
      'UN', 'NATO', 'ASEAN', 'EU', 'G20', 'ambassador',
      'bilateral', 'multilateral', 'sovereignty',
      '外交', '峰会', '条约', '联盟', '禁运',
      '制裁', '谈判', '停火', '和谈',
      '联合国', '大使', '双边', '多边', '主权',
    ],
  },
  underground_network: {
    labelZh: '地下组织',
    labelEn: 'Underground Network',
    assetPath: '/assets/scenes/refuge_compound.png',
    profileId: 'survival',
    keywords: [
      'underground', 'resistance', 'rebel network', 'secret society',
      'safe house', 'smuggling', 'black market', 'espionage',
      'insurgency', 'guerrilla', 'clandestine', 'operative',
      '地下组织', '抵抗', '秘密社团', '安全屋',
      '走私', '黑市', '间谍', '叛乱', '游击',
    ],
  },
} as const satisfies Record<string, ThemeRegistryEntry>;

export type SceneThemeId = keyof typeof THEME_REGISTRY;

export const SCENE_THEME_IDS = Object.keys(THEME_REGISTRY) as SceneThemeId[];

export function isSceneThemeId(themeId: string): themeId is SceneThemeId {
  return SCENE_THEME_IDS.includes(themeId as SceneThemeId);
}

export function getSceneTextureKey(themeId: SceneThemeId): string {
  return `scene_${themeId}`;
}

export function getThemeAssetPath(themeId: SceneThemeId): string {
  return THEME_REGISTRY[themeId].assetPath;
}

export function isEndingAssetId(endingId: string): endingId is EndingAssetId {
  return ENDING_ASSET_KEYS.includes(endingId as EndingAssetId);
}

export function getEndingTextureKey(endingId: EndingAssetId): string {
  return `ending_${endingId}`;
}

export function getEndingAssetPath(endingId: EndingAssetId): string {
  return `/assets/endings/${endingId}.png`;
}

export function getThemeProfileId(themeId: string | null | undefined): GameplayProfileId | null {
  if (!themeId) return null;
  return THEME_REGISTRY[themeId as SceneThemeId]?.profileId ?? null;
}

export function getTheaterThemeLabel(themeId: string | null | undefined, isZh: boolean): string | null {
  if (!themeId) return null;
  const match = THEME_REGISTRY[themeId as SceneThemeId];
  if (!match) return themeId.replace(/_/g, ' ');
  return isZh ? match.labelZh : match.labelEn;
}

export function inferSceneThemeFromQuestion(question: string): SceneThemeId {
  const qLower = question.toLowerCase();
  const keywordPairs = SCENE_THEME_IDS
    .flatMap((themeId) => THEME_REGISTRY[themeId].keywords.map((keyword) => [themeId, keyword] as const))
    .sort((a, b) => b[1].length - a[1].length);

  for (const [themeId, keyword] of keywordPairs) {
    if (qLower.includes(keyword.toLowerCase())) {
      return themeId;
    }
  }

  if (qLower.includes('互联网') || qLower.includes('internet') || qLower.includes('computer') || qLower.includes('电脑')) {
    return 'modern_city';
  }
  if (qLower.includes('人工智能') || qLower.includes('算法') || qLower.includes('robot') || qLower.includes('ai')) {
    return 'scifi_base';
  }
  if (qLower.includes('贝多芬') || qLower.includes('beethoven') || qLower.includes('art') || qLower.includes('music')) {
    return 'concert_hall';
  }
  if (qLower.includes('诸葛亮') || qLower.includes('三国') || qLower.includes('zhuge')) {
    return 'ancient_empire';
  }
  if (qLower.includes('爱因斯坦') || qLower.includes('einstein') || qLower.includes('physics') || qLower.includes('物理')) {
    return 'modern_city';
  }

  return 'medieval_village';
}
