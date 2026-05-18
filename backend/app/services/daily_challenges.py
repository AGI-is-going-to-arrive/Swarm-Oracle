"""Daily challenge catalog and rotation helpers.

The catalog is a hand-curated set of ~50 "what-if" scenarios spanning AI
governance, history, geopolitics, philosophy, ecology, mythology, science
fiction, survival, social dilemmas, and culture. Each entry carries:

- ``id``            kebab-case stable identifier (<=64 chars).
- ``question`` /    bilingual prompts. ``question`` is the Chinese variant
  ``question_en``   (legacy field name) and ``question_en`` mirrors it in
                    English. Frontends fall back to ``question`` when an
                    English value is missing.
- ``subtitle_zh`` / single-line bilingual subtitle used by the daily card.
  ``subtitle_en``
- ``profile_id``    director-profile bucket; drives rule-of-three and archive
                    grade nuances downstream.
- ``rounds``        2-5 — recommended scenario rounds.
- ``num_agents``    3-8 — recommended Agent count.
- ``mode``          ``"blackboard"`` or ``"raw"``.
- ``hierarchical``  bool — whether the scenario uses hierarchical groups.
- ``visualization_enabled`` bool.
- ``difficulty_tier`` ``"easy"`` / ``"normal"`` / ``"hard"`` / ``"expert"``.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

DAILY_CHALLENGES: tuple[dict[str, Any], ...] = (
    # ─── Originals (Phase 1 baseline) ────────────────────────────────────
    {
        "id": "daily-ai-governance",
        "question": "如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？",
        "question_en": "What if artificial intelligence ruled the world and every nation were governed directly by algorithms?",  # noqa: E501
        "subtitle_zh": "治理博弈 · 中央算法与地方民意",
        "subtitle_en": "Governance Conflict · Algorithmic Rule vs Local Voice",
        "profile_id": "governance",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-roman-empire",
        "question": "如果罗马帝国从未衰落？",
        "question_en": "What if the Roman Empire never fell?",
        "subtitle_zh": "帝国统合 · 中央铁军与地方自治",
        "subtitle_en": "Imperial Balance · Central Order vs Provincial Autonomy",
        "profile_id": "empire",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-war-front",
        "question": "如果世界大战在高度自动化军备时代再次爆发？",
        "question_en": "What if a world war erupted again in an age of highly automated arsenals?",
        "subtitle_zh": "战争抉择 · 补给线与停火窗口",
        "subtitle_en": "War Doctrine · Supply Lines and Ceasefire Windows",
        "profile_id": "war",
        "rounds": 4,
        "num_agents": 5,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-industry",
        "question": "如果工业革命提前一百年到来？",
        "question_en": "What if the Industrial Revolution arrived a hundred years earlier?",
        "subtitle_zh": "工业与资源 · 产能扩张与社会缓冲",
        "subtitle_en": "Industry and Resources · Throughput vs Social Buffering",
        "profile_id": "industry",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-frontier",
        "question": "如果人类在 2000 年就建立了火星殖民地？",
        "question_en": "What if humanity had established a colony on Mars by the year 2000?",
        "subtitle_zh": "边疆探索 · 远征速度与生存规则",
        "subtitle_en": "Frontier Expansion · Expedition Pace vs Survival Rules",
        "profile_id": "frontier",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-trade-chokepoint",
        "question": "如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？",
        "question_en": "What if the world's most critical strait were permanently monopolized by a maritime trade consortium?",  # noqa: E501
        "subtitle_zh": "贸易绞盘 · 关税杠杆与港口封锁",
        "subtitle_en": "Trade Leverage · Tariff Pressure and Port Choke Points",
        "profile_id": "trade",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-legal-veto",
        "question": "如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？",
        "question_en": "What if the supreme court held an emergency veto that could pause every algorithmic policy?",  # noqa: E501
        "subtitle_zh": "法律红线 · 紧急否决与程序补丁",
        "subtitle_en": "Legal Red Lines · Emergency Vetoes and Procedural Patches",
        "profile_id": "law",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-faith-order",
        "question": "如果一则神谕成为整个王国唯一合法的统治依据，会发生什么？",
        "question_en": "What if a single prophecy became the only legitimate basis for ruling an entire kingdom?",  # noqa: E501
        "subtitle_zh": "神权号角 · 圣谕改写与异端审判",
        "subtitle_en": "Sacred Order · Rewritten Prophecy and Heresy Trials",
        "profile_id": "faith",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-ecology-threshold",
        "question": "如果跨大陆淡水供应在十年内枯竭，会发生什么？",
        "question_en": "What if the cross-continental freshwater supply ran dry within a decade?",
        "subtitle_zh": "生态阈值 · 迁徙窗口与系统韧性",
        "subtitle_en": "Ecology Thresholds · Migration Windows and System Resilience",
        "profile_id": "ecology",
        "rounds": 4,
        "num_agents": 5,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-mythic-pact",
        "question": "如果王国与巨龙订立的守护契约在一夜之间失效，会发生什么？",
        "question_en": "What if the kingdom's protective pact with its dragons failed overnight?",
        "subtitle_zh": "神话秩序 · 龙契约与禁术代价",
        "subtitle_en": "Mythic Order · Dragon Pacts and Forbidden Costs",
        "profile_id": "mythic",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-survival-grid",
        "question": "如果最后一座避难城只能再维持三十天供电，会发生什么？",
        "question_en": "What if the last refuge city had only thirty days of power left?",
        "subtitle_zh": "生存极限 · 最后冗余与撤退路线",
        "subtitle_en": "Survival Pressure · Last Reserves and Retreat Routes",
        "profile_id": "survival",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-generic-shuffle",
        "question": "如果所有大型组织都必须每周随机交换一次负责人，会发生什么？",
        "question_en": (
            "What if every major organization had to randomly swap its leader once a week?"
        ),
        "subtitle_zh": "通用博弈 · 关键分歧与隐藏议程",
        "subtitle_en": "General Tension · Core Frictions and Hidden Agendas",
        "profile_id": "generic",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    # ─── New: AI / Technology Ethics (4) ─────────────────────────────────
    {
        "id": "daily-ai-personhood",
        "question": "如果一个 AI 系统在法律上被授予公民身份，会发生什么？",
        "question_en": "What if an AI system were granted legal citizenship?",
        "subtitle_zh": "AI 法权 · 投票权与刑事责任",
        "subtitle_en": "AI Personhood · Voting Rights and Criminal Liability",
        "profile_id": "governance",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-ai-misalignment",
        "question": "如果通用人工智能在公开部署一周后被发现目标偏移，会发生什么？",
        "question_en": "What if a general-purpose AI were found to be misaligned a week after public deployment?",  # noqa: E501
        "subtitle_zh": "对齐危机 · 关停代价与影子部署",
        "subtitle_en": "Alignment Crisis · Shutdown Cost vs Shadow Deployments",
        "profile_id": "governance",
        "rounds": 4,
        "num_agents": 5,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "expert",
    },
    {
        "id": "daily-ai-creative-monopoly",
        "question": "如果三家公司垄断了所有 AI 生成内容的版权，会发生什么？",
        "question_en": "What if three companies owned the copyright to every AI-generated artifact?",  # noqa: E501
        "subtitle_zh": "版权垄断 · 创作者抗议与监管裂缝",
        "subtitle_en": "Copyright Monopoly · Creator Protest and Regulatory Cracks",
        "profile_id": "law",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-brain-interface",
        "question": "如果所有 18 岁以上公民都被要求佩戴脑机接口，会发生什么？",
        "question_en": "What if every adult citizen were required to wear a brain-computer interface?",  # noqa: E501
        "subtitle_zh": "脑机普及 · 同意边界与神经隐私",
        "subtitle_en": "BCI Mandate · Consent Boundaries and Neural Privacy",
        "profile_id": "governance",
        "rounds": 4,
        "num_agents": 5,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    # ─── New: Economics (4) ──────────────────────────────────────────────
    {
        "id": "daily-ubi-rollout",
        "question": "如果某国突然实施全民基本收入并废除大部分福利项目，会发生什么？",
        "question_en": "What if one country suddenly rolled out universal basic income and abolished most welfare programs?",  # noqa: E501
        "subtitle_zh": "全民保障 · 通胀联动与劳动激励",
        "subtitle_en": "Universal Income · Inflation Coupling and Labor Incentive",
        "profile_id": "industry",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-crypto-reserve",
        "question": "如果一个 G20 国家把主权储备的一半换成去中心化加密资产，会发生什么？",
        "question_en": "What if a G20 nation moved half its sovereign reserves into decentralized crypto assets?",  # noqa: E501
        "subtitle_zh": "货币重构 · 储备波动与制裁回路",
        "subtitle_en": "Reserve Shock · Volatility and Sanctions Feedback",
        "profile_id": "trade",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-shrinkflation",
        "question": "如果跨国食品集团联手把所有包装重量缩水 20%，会发生什么？",
        "question_en": "What if multinational food groups jointly shrank every package weight by 20%?",  # noqa: E501
        "subtitle_zh": "缩水共谋 · 消费抵抗与监管追责",
        "subtitle_en": "Shrinkflation Cartel · Consumer Pushback and Regulator Accountability",
        "profile_id": "trade",
        "rounds": 3,
        "num_agents": 4,
        "mode": "raw",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    {
        "id": "daily-debt-jubilee",
        "question": "如果一国政府在一夜之间宣布所有个人债务清零，会发生什么？",
        "question_en": "What if a government cancelled all personal debt overnight?",
        "subtitle_zh": "债务赦免 · 信用崩塌与新合约浪潮",
        "subtitle_en": "Debt Jubilee · Credit Collapse and New Contract Waves",
        "profile_id": "industry",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    # ─── New: History What-Ifs (5) ───────────────────────────────────────
    {
        "id": "daily-bronze-age-survives",
        "question": "如果青铜时代晚期文明集体灭亡的灾难从未发生？",
        "question_en": "What if the Late Bronze Age collapse had never happened?",
        "subtitle_zh": "古代联通 · 海上民族与贸易圈",
        "subtitle_en": "Bronze Age Continuity · Sea Peoples and Trade Webs",
        "profile_id": "empire",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-mongol-naval",
        "question": "如果蒙古帝国成功建立了远洋舰队，会发生什么？",
        "question_en": "What if the Mongol Empire had successfully built a blue-water navy?",
        "subtitle_zh": "草原远洋 · 海权奠基与殖民提前",
        "subtitle_en": "Steppe Goes Naval · Sea Power and Early Colonization",
        "profile_id": "empire",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-printing-press-delayed",
        "question": "如果活字印刷术晚了两百年才传入欧洲，会发生什么？",
        "question_en": "What if movable-type printing reached Europe two centuries later?",
        "subtitle_zh": "知识延迟 · 抄本霸权与宗教权威",
        "subtitle_en": "Knowledge Delay · Scribal Monopolies and Religious Authority",
        "profile_id": "faith",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    {
        "id": "daily-cold-war-thawed-early",
        "question": "如果冷战在 1965 年就以联合签约方式结束，会发生什么？",
        "question_en": "What if the Cold War had ended via joint treaty in 1965?",
        "subtitle_zh": "提早握手 · 阵营经济与文化反差",
        "subtitle_en": "Early Handshake · Bloc Economies and Cultural Contrast",
        "profile_id": "war",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-zheng-he-continues",
        "question": "如果郑和的宝船舰队没有被中断，明朝继续远航百年，会发生什么？",
        "question_en": "What if Zheng He's treasure fleet had continued voyaging for another century?",  # noqa: E501
        "subtitle_zh": "宝船未停 · 朝贡体系与航海主权",
        "subtitle_en": "Treasure Fleet Endures · Tribute Order and Maritime Sovereignty",
        "profile_id": "trade",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    # ─── New: Geopolitics (4) ────────────────────────────────────────────
    {
        "id": "daily-arctic-thaw",
        "question": "如果北极航道全年通航并被一国设为内海，会发生什么？",
        "question_en": "What if Arctic shipping lanes opened year-round and one nation declared them inland waters?",  # noqa: E501
        "subtitle_zh": "极地主权 · 通行权与生态封锁",
        "subtitle_en": "Polar Sovereignty · Transit Rights and Ecological Lockout",
        "profile_id": "trade",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-city-state-revival",
        "question": "如果三十座超级城市宣布脱离母国并互相结盟，会发生什么？",
        "question_en": "What if thirty mega-cities seceded from their parent nations and federated with each other?",  # noqa: E501
        "subtitle_zh": "城邦复兴 · 跨国联盟与边境失序",
        "subtitle_en": "City-State Revival · Translocal Alliances and Border Chaos",
        "profile_id": "governance",
        "rounds": 4,
        "num_agents": 6,
        "mode": "blackboard",
        "hierarchical": True,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-non-state-army",
        "question": "如果一个跨国非国家军事组织获得了堪比中等国家的常规军力，会发生什么？",
        "question_en": "What if a transnational non-state militia matched the conventional power of a mid-sized state?",  # noqa: E501
        "subtitle_zh": "私军崛起 · 雇佣边界与外交压力",
        "subtitle_en": "Private Force Rises · Mercenary Limits and Diplomatic Strain",
        "profile_id": "war",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-pacific-pact",
        "question": "如果太平洋岛国结成统一政体来对抗海平面上升，会发生什么？",
        "question_en": "What if Pacific island nations formed one unified polity to confront sea level rise?",  # noqa: E501
        "subtitle_zh": "海洋公约 · 迁徙安置与碳赔偿",
        "subtitle_en": "Pacific Pact · Migration Settlements and Carbon Reparations",
        "profile_id": "ecology",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    # ─── New: Environment / Ecology (3) ──────────────────────────────────
    {
        "id": "daily-bee-collapse",
        "question": "如果全球蜜蜂种群在一年内消失 80%，会发生什么？",
        "question_en": "What if 80% of the global bee population vanished within a year?",
        "subtitle_zh": "授粉危机 · 粮食重构与替代昆虫",
        "subtitle_en": "Pollination Crisis · Food Reshuffle and Substitute Insects",
        "profile_id": "ecology",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-cloud-seeding",
        "question": "如果两国同时对相邻雨林进行规模性人工降雨干预，会发生什么？",
        "question_en": "What if two states simultaneously cloud-seeded an adjacent rainforest at industrial scale?",  # noqa: E501
        "subtitle_zh": "气候干预 · 主权外溢与连锁反应",
        "subtitle_en": "Climate Intervention · Sovereign Spillover and Cascade Effects",
        "profile_id": "ecology",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-solar-grid-down",
        "question": "如果太阳风暴让全球电网瘫痪三个月，会发生什么？",
        "question_en": "What if a solar storm took the global power grid offline for three months?",
        "subtitle_zh": "无电三月 · 物资链断与社群自治",
        "subtitle_en": "Three Powerless Months · Supply Break and Community Rule",
        "profile_id": "survival",
        "rounds": 4,
        "num_agents": 5,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "expert",
    },
    # ─── New: Social Dilemmas (4) ────────────────────────────────────────
    {
        "id": "daily-screen-ban",
        "question": "如果某国对 16 岁以下未成年人完全禁用社交媒体，会发生什么？",
        "question_en": "What if a country fully banned social media for everyone under sixteen?",
        "subtitle_zh": "屏幕禁令 · 家庭执行与影子平台",
        "subtitle_en": "Screen Ban · Family Enforcement and Shadow Platforms",
        "profile_id": "law",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    {
        "id": "daily-workweek-three-day",
        "question": "如果一个先进经济体把法定工作周缩短为三天，会发生什么？",
        "question_en": "What if a developed economy cut the legal workweek to three days?",
        "subtitle_zh": "三天工作 · 产能交换与社会节奏",
        "subtitle_en": "Three-Day Workweek · Productivity Trade and Social Tempo",
        "profile_id": "industry",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    {
        "id": "daily-citizens-jury",
        "question": "如果所有重大政策必须由抽签产生的公民陪审团裁定，会发生什么？",
        "question_en": "What if every major policy had to be decided by a randomly drawn citizens' jury?",  # noqa: E501
        "subtitle_zh": "抽签民主 · 专家旁听与民间共识",
        "subtitle_en": "Sortition Democracy · Expert Briefings and Civic Consensus",
        "profile_id": "governance",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-anonymity-banned",
        "question": "如果一国宣布所有公共数字交流必须实名，会发生什么？",
        "question_en": "What if a country mandated real-name identification for every public digital exchange?",  # noqa: E501
        "subtitle_zh": "实名网空 · 言论收敛与抗议出口",
        "subtitle_en": "Real-Name Internet · Speech Chilling and Protest Outlets",
        "profile_id": "law",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    # ─── New: Philosophy / Culture (3) ───────────────────────────────────
    {
        "id": "daily-truth-machine",
        "question": "如果有一台机器能 100% 判定任何陈述的真伪，会发生什么？",
        "question_en": "What if a machine could perfectly verify the truth of any statement?",
        "subtitle_zh": "真理之机 · 政治诚信与新型谎言",
        "subtitle_en": "Truth Machine · Political Honesty and Novel Lying",
        "profile_id": "faith",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-language-extinction",
        "question": "如果世界主要语言之一在一代人内被弃用，会发生什么？",
        "question_en": "What if one of the world's major languages were abandoned within a single generation?",  # noqa: E501
        "subtitle_zh": "语种断代 · 文献抢救与身份政治",
        "subtitle_en": "Language Extinction · Archive Triage and Identity Politics",
        "profile_id": "generic",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    {
        "id": "daily-public-funeral",
        "question": "如果举行公开葬礼成为政治领导人卸任的强制条件，会发生什么？",
        "question_en": "What if a public funeral became the mandatory rite for stepping down from political office?",  # noqa: E501
        "subtitle_zh": "公共告别 · 卸任权力与情感叙事",
        "subtitle_en": "Ritual Farewell · Power Handover and Emotional Narrative",
        "profile_id": "faith",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    # ─── New: Science Fiction / Frontier (4) ─────────────────────────────
    {
        "id": "daily-alien-signal",
        "question": "如果一个来源于 60 光年外的有意识信号被证实，会发生什么？",
        "question_en": "What if a deliberately encoded signal from 60 light-years away were confirmed?",  # noqa: E501
        "subtitle_zh": "首次接触 · 应答协议与信息封锁",
        "subtitle_en": "First Contact · Response Protocol and Information Lockdown",
        "profile_id": "frontier",
        "rounds": 4,
        "num_agents": 5,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-orbital-station-strike",
        "question": "如果国际空间站工作人员集体罢工要求重新议价，会发生什么？",
        "question_en": "What if the international space station crew jointly went on strike for new terms?",  # noqa: E501
        "subtitle_zh": "轨道罢工 · 续约博弈与紧急船次",
        "subtitle_en": "Orbital Strike · Contract Standoff and Emergency Launches",
        "profile_id": "frontier",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-fusion-breakthrough",
        "question": "如果聚变能源在三年内实现商业化并价格腰斩，会发生什么？",
        "question_en": "What if fusion energy reached commercial scale within three years and cost halved?",  # noqa: E501
        "subtitle_zh": "聚变跨越 · 化石资产清算与地缘洗牌",
        "subtitle_en": "Fusion Leap · Fossil Asset Reset and Geopolitical Reshuffle",
        "profile_id": "industry",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-time-loop-broadcast",
        "question": "如果一段公开时间循环录像证实未来某周将发生重大事件，会发生什么？",
        "question_en": "What if a public time-loop broadcast proved a major event would happen in a specific future week?",  # noqa: E501
        "subtitle_zh": "未来已写 · 预言市场与自我应验",
        "subtitle_en": "Future Foretold · Prediction Markets and Self-fulfilment",
        "profile_id": "mythic",
        "rounds": 4,
        "num_agents": 5,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "expert",
    },
    # ─── New: Survival / Crisis (3) ──────────────────────────────────────
    {
        "id": "daily-water-rationing",
        "question": "如果一座超大城市必须在两周内执行严格定量供水，会发生什么？",
        "question_en": "What if a megacity had to enforce strict water rationing within two weeks?",
        "subtitle_zh": "限水令 · 公共秩序与黑市供水",
        "subtitle_en": "Water Rationing · Public Order and Black-market Supply",
        "profile_id": "survival",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    {
        "id": "daily-pandemic-quarantine",
        "question": "如果一种潜伏期 30 天的烈性传染病爆发，会发生什么？",
        "question_en": "What if a virulent disease with a 30-day incubation period broke out?",
        "subtitle_zh": "潜伏未现 · 边境关闭与数据真实性",
        "subtitle_en": "Silent Carrier · Border Closure and Data Integrity",
        "profile_id": "survival",
        "rounds": 4,
        "num_agents": 5,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    {
        "id": "daily-grid-cyberattack",
        "question": "如果敌对势力对全国电网发起一次成功的协同网络攻击，会发生什么？",
        "question_en": "What if a hostile actor pulled off a coordinated cyberattack on a national grid?",  # noqa: E501
        "subtitle_zh": "断电七日 · 攻防归因与社会信任",
        "subtitle_en": "Seven Powerless Days · Attribution and Public Trust",
        "profile_id": "war",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "hard",
    },
    # ─── New: Mythic / Legend (3) ────────────────────────────────────────
    {
        "id": "daily-norse-return",
        "question": "如果北欧诸神被证实存在并要求复辟旧信仰，会发生什么？",
        "question_en": "What if the Norse pantheon were proven real and demanded the old faith be restored?",  # noqa: E501
        "subtitle_zh": "诸神回归 · 信仰冲突与世俗法",
        "subtitle_en": "Pantheon Returns · Faith Conflict and Secular Law",
        "profile_id": "mythic",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    {
        "id": "daily-djinn-bargain",
        "question": "如果一座沙漠城市与精灵立下了不可违背的契约，会发生什么？",
        "question_en": "What if a desert city signed an unbreakable pact with the djinn?",
        "subtitle_zh": "精灵契约 · 字句缝隙与代际抵押",
        "subtitle_en": "Djinn Pact · Loopholes and Inherited Debts",
        "profile_id": "mythic",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    {
        "id": "daily-prophet-pretender",
        "question": "如果两位先知同时宣布同一神谕但内容互相矛盾，会发生什么？",
        "question_en": "What if two prophets simultaneously announced contradictory versions of the same prophecy?",  # noqa: E501
        "subtitle_zh": "双先知 · 真伪审判与教廷分裂",
        "subtitle_en": "Twin Prophets · Authenticity Trial and Schism Risk",
        "profile_id": "faith",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "normal",
    },
    # ─── New: Open-ended / Generic (3) ───────────────────────────────────
    {
        "id": "daily-anonymous-grant",
        "question": "如果每位公民都得到一笔可一次性投入任何公共项目的匿名拨款，会发生什么？",
        "question_en": "What if every citizen received a one-time anonymous grant to spend on any public project?",  # noqa: E501
        "subtitle_zh": "匿名公益 · 项目选择与寻租阻断",
        "subtitle_en": "Anonymous Grant · Project Choice and Capture Resistance",
        "profile_id": "generic",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    {
        "id": "daily-time-bank",
        "question": "如果一国推出可交易的时间银行，每个人都能买卖闲暇小时，会发生什么？",
        "question_en": "What if a nation rolled out a tradable 'time bank' where everyone could buy and sell leisure hours?",  # noqa: E501
        "subtitle_zh": "时间银行 · 闲暇价格与社会公平",
        "subtitle_en": "Time Bank · Pricing Leisure and Distributive Fairness",
        "profile_id": "generic",
        "rounds": 3,
        "num_agents": 4,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "easy",
    },
    {
        "id": "daily-shared-memory",
        "question": "如果一种技术让记忆可以在自愿者之间精确转移，会发生什么？",
        "question_en": "What if a technology let people precisely transfer memories between willing parties?",  # noqa: E501
        "subtitle_zh": "记忆迁移 · 同意框架与作伪证据",
        "subtitle_en": "Memory Transfer · Consent Frame and Fabricated Evidence",
        "profile_id": "generic",
        "rounds": 4,
        "num_agents": 5,
        "mode": "blackboard",
        "hierarchical": False,
        "visualization_enabled": True,
        "difficulty_tier": "expert",
    },
)


def _build_default_rotation_order(challenges: tuple[dict[str, Any], ...]) -> tuple[str, ...]:
    """Default rotation walks the catalog in declaration order."""
    return tuple(challenge["id"] for challenge in challenges)


_DAILY_ROTATION_ORDER: tuple[str, ...] = _build_default_rotation_order(DAILY_CHALLENGES)
_DAILY_CHALLENGE_BY_ID = {challenge["id"]: challenge for challenge in DAILY_CHALLENGES}


def _parse_local_date(local_date: str) -> date:
    return date.fromisoformat(local_date)


def _date_key(value: date) -> str:
    return value.isoformat()


def _rotation_catalog() -> tuple[dict[str, Any], ...]:
    catalog: list[dict[str, Any]] = []
    for challenge_id in _DAILY_ROTATION_ORDER:
        challenge = _DAILY_CHALLENGE_BY_ID.get(challenge_id)
        if challenge is None:
            raise RuntimeError(
                f"Daily challenge rotation references unknown challenge id: {challenge_id}"
            )
        catalog.append(challenge)
    return tuple(catalog)


def _day_index(local_date: date) -> int:
    epoch = date(1970, 1, 1)
    return (local_date - epoch).days


def challenge_week_key(local_date: str) -> str:
    """Legacy Monday-of-week date string (``YYYY-MM-DD``) for backward compat."""
    target_date = _parse_local_date(local_date)
    monday_offset = 6 if target_date.weekday() == 6 else target_date.weekday()
    week_start = target_date - timedelta(days=monday_offset)
    return _date_key(week_start)


def iso_week_key(local_date: str) -> str:
    """Return the ISO calendar week-key (``YYYY-Wnn``) for ``local_date``.

    Phase 2b: the durable ledger uses ISO week labels (matching the
    ``Scenario.parsed_context.campaign_context.week_key`` written by
    ``create_scenario``). The legacy Monday-date variant is kept available via
    ``challenge_week_key`` because older clients still consume that envelope.
    """
    target_date = _parse_local_date(local_date)
    iso_year, iso_week, _iso_weekday = target_date.isocalendar()
    return f"{iso_year:04d}-W{iso_week:02d}"


def get_today_challenge_definition(local_date: str) -> dict[str, Any]:
    target_date = _parse_local_date(local_date)
    catalog = _rotation_catalog()
    return catalog[_day_index(target_date) % len(catalog)].copy()


def get_weekly_challenge_definitions(local_date: str, count: int = 3) -> list[dict[str, Any]]:
    target_date = _parse_local_date(local_date)
    catalog = _rotation_catalog()
    week_index = _day_index(target_date) // 7
    start = (week_index * count) % len(catalog)
    return [
        catalog[(start + offset) % len(catalog)].copy()
        for offset in range(count)
    ]


def _recommended_params_for(challenge_def: dict[str, Any]) -> dict[str, Any]:
    """Pull recommended scenario parameters from a catalog entry."""
    return {
        "num_agents": challenge_def.get("num_agents"),
        "rounds": challenge_def.get("rounds"),
        "mode": challenge_def.get("mode"),
        "hierarchical": bool(challenge_def.get("hierarchical", False)),
        "visualization_enabled": bool(
            challenge_def.get("visualization_enabled", True)
        ),
        "difficulty_tier": challenge_def.get("difficulty_tier"),
    }


def _next_utc_midnight_iso() -> str:
    """ISO-8601 timestamp for the next UTC 00:00:00 boundary."""
    now = datetime.now(timezone.utc)
    next_midnight = (now + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return next_midnight.isoformat()


# ─── Weekly track registry (Phase 2b) ────────────────────────────────────


WEEKLY_TRACKS: tuple[dict[str, Any], ...] = (
    {
        "id": "weekly-governance-week",
        "title_zh": "治理之周",
        "title_en": "Week of Governance",
        "subtitle_zh": "围绕公共决策与制度边界",
        "subtitle_en": "Around public decisions and institutional limits",
        "profile_ids": ("governance", "law"),
        "recommended_params": {"rounds": 3, "num_agents": 4, "mode": "blackboard"},
        "bonus_rules": "完成本周任一治理类每日挑战 +1 weekly bonus (单 track 周上限 3 次)",
        "bonus_rules_zh": "完成本周任一治理类每日挑战：+1 周赛奖励（单 track 每周最多 3 次）",
        "bonus_rules_en": (
            "Complete any governance daily challenge this week: +1 weekly bonus "
            "(max 3 per track each week)."
        ),
    },
    {
        "id": "weekly-empire-week",
        "title_zh": "帝国回响",
        "title_en": "Echoes of Empire",
        "subtitle_zh": "穿越古典与近代的统合主题",
        "subtitle_en": "Spanning classical and modern consolidation",
        "profile_ids": ("empire", "war"),
        "recommended_params": {"rounds": 3, "num_agents": 4, "mode": "blackboard"},
        "bonus_rules": "完成本周任一帝国/战争类每日挑战 +1 weekly bonus (单 track 周上限 3 次)",
        "bonus_rules_zh": "完成本周任一帝国/战争类每日挑战：+1 周赛奖励（单 track 每周最多 3 次）",
        "bonus_rules_en": (
            "Complete any empire or war daily challenge this week: +1 weekly bonus "
            "(max 3 per track each week)."
        ),
    },
    {
        "id": "weekly-frontier-week",
        "title_zh": "边疆纪事",
        "title_en": "Frontier Chronicle",
        "subtitle_zh": "探索极地、深海、火星与轨道",
        "subtitle_en": "Polar, deep-sea, Mars, and orbital expansion",
        "profile_ids": ("frontier", "ecology"),
        "recommended_params": {"rounds": 3, "num_agents": 4, "mode": "blackboard"},
        "bonus_rules": "完成本周任一前沿/生态类每日挑战 +1 weekly bonus (单 track 周上限 3 次)",
        "bonus_rules_zh": "完成本周任一前沿/生态类每日挑战：+1 周赛奖励（单 track 每周最多 3 次）",
        "bonus_rules_en": (
            "Complete any frontier or ecology daily challenge this week: +1 weekly bonus "
            "(max 3 per track each week)."
        ),
    },
    {
        "id": "weekly-trade-week",
        "title_zh": "贸易棋局",
        "title_en": "Trade Gambits",
        "subtitle_zh": "货币、关税与航线交错",
        "subtitle_en": "Currency, tariffs, and shipping crossroads",
        "profile_ids": ("trade", "industry"),
        "recommended_params": {"rounds": 3, "num_agents": 4, "mode": "blackboard"},
        "bonus_rules": "完成本周任一贸易/工业类每日挑战 +1 weekly bonus (单 track 周上限 3 次)",
        "bonus_rules_zh": "完成本周任一贸易/工业类每日挑战：+1 周赛奖励（单 track 每周最多 3 次）",
        "bonus_rules_en": (
            "Complete any trade or industry daily challenge this week: +1 weekly bonus "
            "(max 3 per track each week)."
        ),
    },
    {
        "id": "weekly-myth-week",
        "title_zh": "神话回廊",
        "title_en": "Mythic Corridor",
        "subtitle_zh": "神谕、契约与传说重启",
        "subtitle_en": "Prophecies, pacts, and re-awakened legends",
        "profile_ids": ("mythic", "faith"),
        "recommended_params": {"rounds": 3, "num_agents": 4, "mode": "blackboard"},
        "bonus_rules": "完成本周任一神话/信仰类每日挑战 +1 weekly bonus (单 track 周上限 3 次)",
        "bonus_rules_zh": "完成本周任一神话/信仰类每日挑战：+1 周赛奖励（单 track 每周最多 3 次）",
        "bonus_rules_en": (
            "Complete any mythic or faith daily challenge this week: +1 weekly bonus "
            "(max 3 per track each week)."
        ),
    },
    {
        "id": "weekly-survival-week",
        "title_zh": "生存赛季",
        "title_en": "Survival Season",
        "subtitle_zh": "限电、断网、瘟疫与避难",
        "subtitle_en": "Blackouts, lockdowns, pandemics, and refuges",
        "profile_ids": ("survival", "ecology"),
        "recommended_params": {"rounds": 4, "num_agents": 5, "mode": "blackboard"},
        "bonus_rules": "完成本周任一生存类每日挑战 +1 weekly bonus (单 track 周上限 3 次)",
        "bonus_rules_zh": "完成本周任一生存类每日挑战：+1 周赛奖励（单 track 每周最多 3 次）",
        "bonus_rules_en": (
            "Complete any survival daily challenge this week: +1 weekly bonus "
            "(max 3 per track each week)."
        ),
    },
    {
        "id": "weekly-open-week",
        "title_zh": "通用之周",
        "title_en": "Open Week",
        "subtitle_zh": "把镜头让给社会、文化与日常",
        "subtitle_en": "Society, culture, and the everyday",
        "profile_ids": ("generic",),
        "recommended_params": {"rounds": 3, "num_agents": 4, "mode": "blackboard"},
        "bonus_rules": "完成本周任一通用类每日挑战 +1 weekly bonus (单 track 周上限 3 次)",
        "bonus_rules_zh": "完成本周任一通用类每日挑战：+1 周赛奖励（单 track 每周最多 3 次）",
        "bonus_rules_en": (
            "Complete any open-track daily challenge this week: +1 weekly bonus "
            "(max 3 per track each week)."
        ),
    },
)

_WEEKLY_TRACK_BY_ID = {track["id"]: track for track in WEEKLY_TRACKS}


def get_weekly_track_definitions() -> list[dict[str, Any]]:
    """Return a (copy of) every registered weekly track."""
    return [dict(track) for track in WEEKLY_TRACKS]


def get_weekly_track_by_id(track_id: str) -> dict[str, Any] | None:
    track = _WEEKLY_TRACK_BY_ID.get(track_id)
    return dict(track) if track is not None else None


def get_current_weekly_track(local_date: str) -> dict[str, Any]:
    """Return the weekly track active for the ISO calendar week of ``local_date``.

    Rotation is deterministic: ``iso_week % len(WEEKLY_TRACKS)``. ISO weeks
    align with the durable ``week_key`` written into the campaign ledger.
    """
    target_date = _parse_local_date(local_date)
    _iso_year, iso_week, _iso_weekday = target_date.isocalendar()
    return dict(WEEKLY_TRACKS[iso_week % len(WEEKLY_TRACKS)])


def is_known_weekly_track_id(track_id: str) -> bool:
    return track_id in _WEEKLY_TRACK_BY_ID


def get_challenge_rotation(local_date: str, weekly_count: int = 3) -> dict[str, Any]:
    """Return today's daily challenge + the weekly slate + the active track.

    Phase 2a adds ``difficulty_tier`` (already on each challenge),
    ``today_recommended_params``, and ``next_refresh_at`` (next UTC midnight).
    Phase 2b adds the ``weekly_track`` block (id, ISO ``week_key``, titles,
    profile_ids, recommended_params, bonus_rules).

    ``current_streak`` / ``recent_daily_completion_days`` are NOT computed here
    because the catalog module has no DB access; the campaign service fills
    those in for the ``/profile/{user_id}/daily-status`` envelope instead.
    """
    normalized_count = max(1, min(weekly_count, len(_rotation_catalog())))
    today_def = get_today_challenge_definition(local_date)
    weekly_defs = get_weekly_challenge_definitions(local_date, normalized_count)
    weekly_track = get_current_weekly_track(local_date)
    return {
        "local_date": local_date,
        "week_key": challenge_week_key(local_date),
        "iso_week_key": iso_week_key(local_date),
        "next_refresh_at": _next_utc_midnight_iso(),
        "today_challenge": today_def,
        "today_recommended_params": _recommended_params_for(today_def),
        "weekly_challenges": weekly_defs,
        "weekly_track": {
            "id": weekly_track["id"],
            "title_zh": weekly_track["title_zh"],
            "title_en": weekly_track["title_en"],
            "subtitle_zh": weekly_track["subtitle_zh"],
            "subtitle_en": weekly_track["subtitle_en"],
            "profile_ids": list(weekly_track["profile_ids"]),
            "recommended_params": dict(weekly_track["recommended_params"]),
            "bonus_rules": weekly_track["bonus_rules"],
            "bonus_rules_zh": weekly_track["bonus_rules_zh"],
            "bonus_rules_en": weekly_track["bonus_rules_en"],
            "week_key": iso_week_key(local_date),
        },
    }


def is_known_challenge_id(challenge_id: str) -> bool:
    """Return True iff ``challenge_id`` is registered in the daily catalog."""
    return challenge_id in _DAILY_CHALLENGE_BY_ID


def validate_campaign_context_against_catalog(
    *,
    challenge_id: str | None,
    weekly_track_id: str | None,
    is_daily_challenge: bool,
    is_weekly_track: bool,
) -> str | None:
    """Validate intent-specific challenge / track identifiers against the catalog.

    Returns ``None`` on success or a short human-readable reason on failure.
    Callers convert the reason into ``CAMPAIGN_CONTEXT_INVALID`` 422 responses.

    ``weekly_track_id`` is checked against the dedicated weekly-track registry.
    Legacy callers should omit ``campaign_context`` entirely and use the
    finalize-time boolean fallback; accepting arbitrary daily ids here would let
    a client split one active weekly track into multiple forged tracks.
    """
    if is_daily_challenge:
        if challenge_id is None:
            return "challenge_id is required when is_daily_challenge=True"
        if not is_known_challenge_id(challenge_id):
            return f"challenge_id '{challenge_id}' not found in daily catalog"
    if is_weekly_track:
        if weekly_track_id is None:
            return "weekly_track_id is required when is_weekly_track=True"
        if not is_known_weekly_track_id(weekly_track_id):
            return (
                f"weekly_track_id '{weekly_track_id}' not found in weekly track registry"
            )
    return None
