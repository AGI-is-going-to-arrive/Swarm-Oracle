"""Select pixel scene theme based on question era / setting.

The parser extracts ``era`` and ``setting`` from the user's question.
This module maps those values to a pixel scene identifier that the
frontend uses to load the correct tileset.

Supports two calling conventions:
- ``select_scene("如果三国时期曹操赢了赤壁之战")``  — scans full question text
- ``select_scene(era="三国时期", setting="赤壁之战")``  — keyword-targeted
"""

from __future__ import annotations

# ──────────────────────────────────────────────────────────
# Scene theme mapping
# ──────────────────────────────────────────────────────────

SCENE_MAP: dict[str, str] = {
    # ── switchboard_forum (generic institutional shuffle / rotating leadership) ──
    "weekly leadership shuffle": "switchboard_forum",
    "rotating leadership": "switchboard_forum",
    "leader rotation": "switchboard_forum",
    "leader shuffle": "switchboard_forum",
    "swap leaders": "switchboard_forum",
    "random leadership": "switchboard_forum",
    "randomly swap leaders": "switchboard_forum",
    "organizational roulette": "switchboard_forum",
    "temporary lottery committee": "switchboard_forum",
    "lottery committee": "switchboard_forum",
    "rotating external review board": "switchboard_forum",
    "负责人轮换": "switchboard_forum",
    "随机换帅": "switchboard_forum",
    "随机交换负责人": "switchboard_forum",
    "每周随机交换一次负责人": "switchboard_forum",
    "组织轮值": "switchboard_forum",
    "抽签换帅": "switchboard_forum",
    "临时抽签委员会": "switchboard_forum",
    "抽签委员会": "switchboard_forum",
    "抽签产生的临时委员会": "switchboard_forum",
    "轮值外部评审团重新裁决": "switchboard_forum",
    "轮值外部评审团": "switchboard_forum",
    "lottery-picked emergency committee": "switchboard_forum",
    "every high-stakes decision had to be re-approved by a rotating external review board": (
        "switchboard_forum"
    ),
    "所有关键城市都必须每三十天由抽签产生的临时委员会接管": "switchboard_forum",

    # ── switchboard_forum_variant (more ceremonial / procedural generic governance) ──
    "rotating review chamber": "switchboard_forum_variant",
    "procedural tribunal": "switchboard_forum_variant",
    "civic switchboard chamber": "switchboard_forum_variant",
    "committee dais": "switchboard_forum_variant",
    "oversight chamber": "switchboard_forum_variant",
    "轮值审查议场": "switchboard_forum_variant",
    "程序议场": "switchboard_forum_variant",
    "外部审查议场": "switchboard_forum_variant",
    "轮值委员会中枢": "switchboard_forum_variant",
    "程序委员会大厅": "switchboard_forum_variant",

    # ── surveillance_megacity (platform governance / monitoring city) ──
    "platform state": "surveillance_megacity",
    "social credit": "surveillance_megacity",
    "surveillance grid": "surveillance_megacity",
    "monitoring network": "surveillance_megacity",
    "digital checkpoint": "surveillance_megacity",
    "all-seeing network": "surveillance_megacity",
    "surveillance": "surveillance_megacity",
    "监控城市": "surveillance_megacity",
    "全域监控": "surveillance_megacity",
    "社会信用": "surveillance_megacity",
    "平台统治": "surveillance_megacity",
    "数字哨卡": "surveillance_megacity",
    "监控网络": "surveillance_megacity",

    # ── civic_chamber (governance via elections / public oversight) ──
    "public oversight": "civic_chamber",
    "local accountability": "civic_chamber",
    "citizens assembly": "civic_chamber",
    "civic review": "civic_chamber",
    "parliament": "civic_chamber",
    "assembly": "civic_chamber",
    "election": "civic_chamber",
    "democracy": "civic_chamber",
    "oversight": "civic_chamber",
    "议会": "civic_chamber",
    "公民大会": "civic_chamber",
    "地方问责": "civic_chamber",
    "公共监督": "civic_chamber",
    "民意反馈": "civic_chamber",
    "审议": "civic_chamber",
    "选举": "civic_chamber",
    "民主": "civic_chamber",

    # ── frontier_colony (surface settlement / autonomous colony) ──
    "autonomous city-state": "frontier_colony",
    "frontier colony": "frontier_colony",
    "colony charter": "frontier_colony",
    "surface settlement": "frontier_colony",
    "expedition camp": "frontier_colony",
    "terraform": "frontier_colony",
    "自治城邦": "frontier_colony",
    "流动城邦": "frontier_colony",
    "殖民章程": "frontier_colony",
    "前哨殖民地": "frontier_colony",
    "拓荒营地": "frontier_colony",
    "地表殖民": "frontier_colony",

    # ── space_station (frontier-specific phrases must beat generic sci-fi) ──
    "mars colony": "space_station",
    "martian colony": "space_station",
    "space colony": "space_station",
    "orbital colony": "space_station",
    "life support": "space_station",
    "evacuation route": "space_station",
    "evac route": "space_station",
    "frontier": "space_station",
    "火星殖民地": "space_station",
    "太空殖民地": "space_station",
    "轨道殖民地": "space_station",
    "生命维持": "space_station",
    "撤离路线": "space_station",
    "强制撤离": "space_station",
    "边疆": "space_station",

    # ── law_court (must beat generic modern-city legal cues) ──
    "supreme court": "law_court",
    "constitutional court": "law_court",
    "courtroom": "law_court",
    "tribunal": "law_court",
    "judicial review": "law_court",
    "legal review": "law_court",
    "public hearing": "law_court",
    "emergency veto": "law_court",
    "court": "law_court",
    "judge": "law_court",
    "legal": "law_court",
    "law": "law_court",
    "constitutional": "law_court",
    "judicial": "law_court",
    "veto": "law_court",
    "audit": "law_court",
    "最高法院": "law_court",
    "宪法法院": "law_court",
    "法庭": "law_court",
    "法庭听证": "law_court",
    "审判庭": "law_court",
    "司法审查": "law_court",
    "程序正义": "law_court",
    "紧急否决权": "law_court",
    "法院": "law_court",
    "法官": "law_court",
    "法律": "law_court",
    "宪法": "law_court",
    "司法": "law_court",
    "否决": "law_court",
    "审计": "law_court",

    # ── law_court_variant (more ceremonial / archival legal conflict) ──
    "grand tribunal archive chamber": "law_court_variant",
    "grand tribunal": "law_court_variant",
    "constitutional chamber": "law_court_variant",
    "appellate bench": "law_court_variant",
    "multi-judge hearing": "law_court_variant",
    "judicial archive": "law_court_variant",
    "合议庭": "law_court_variant",
    "大审判庭": "law_court_variant",
    "终审法庭": "law_court_variant",
    "法官合议": "law_court_variant",
    "司法档案厅": "law_court_variant",

    # ── trade_harbor (must beat generic desert on maritime trade cues) ──
    "maritime trade": "trade_harbor",
    "port authority": "trade_harbor",
    "trade chokepoint": "trade_harbor",
    "shipping lane": "trade_harbor",
    "customs gate": "trade_harbor",
    "merchant guild": "trade_harbor",
    "convoy route": "trade_harbor",
    "trade route": "trade_harbor",
    "supply chain": "trade_harbor",
    "trade": "trade_harbor",
    "merchant": "trade_harbor",
    "tariff": "trade_harbor",
    "strait": "trade_harbor",
    "chokepoint": "trade_harbor",
    "harbor": "trade_harbor",
    "port": "trade_harbor",
    "maritime": "trade_harbor",
    "海上商团": "trade_harbor",
    "航运": "trade_harbor",
    "港口": "trade_harbor",
    "海港": "trade_harbor",
    "海峡": "trade_harbor",
    "贸易咽喉": "trade_harbor",
    "贸易": "trade_harbor",
    "关税": "trade_harbor",
    "商团": "trade_harbor",
    "供应链": "trade_harbor",
    "封港": "trade_harbor",

    # ── factory_foundry (industry / energy / throughput bottleneck) ──
    "resource bottleneck": "factory_foundry",
    "assembly line": "factory_foundry",
    "foundry": "factory_foundry",
    "smelter": "factory_foundry",
    "refinery": "factory_foundry",
    "输电": "factory_foundry",
    "冶炼": "factory_foundry",
    "熔炉": "factory_foundry",
    "工厂调度": "factory_foundry",
    "产能瓶颈": "factory_foundry",
    "能源调度": "factory_foundry",

    # ── dynastic_palace (succession / court intrigue / noble power) ──
    "succession crisis": "dynastic_palace",
    "palace intrigue": "dynastic_palace",
    "royal court": "dynastic_palace",
    "inheritance crisis": "dynastic_palace",
    "dynastic marriage": "dynastic_palace",
    "court faction": "dynastic_palace",
    "宫廷": "dynastic_palace",
    "继承危机": "dynastic_palace",
    "王位": "dynastic_palace",
    "贵族联盟": "dynastic_palace",
    "后宫": "dynastic_palace",
    "宫变": "dynastic_palace",

    # ── imperial_forum (roman / senate / imperial capital) ──
    "imperial senate": "imperial_forum",
    "roman senate": "imperial_forum",
    "imperial capital": "imperial_forum",
    "caesar": "imperial_forum",
    "senate": "imperial_forum",
    "consul": "imperial_forum",
    "roman empire": "imperial_forum",
    "元老院": "imperial_forum",
    "帝都": "imperial_forum",
    "凯撒": "imperial_forum",
    "执政官": "imperial_forum",
    "罗马帝国": "imperial_forum",
    "罗马": "imperial_forum",

    # ── ecology_wasteland (must beat generic desert on water-collapse cues) ──
    "climate migration": "ecology_wasteland",
    "water rationing": "ecology_wasteland",
    "dry reservoir": "ecology_wasteland",
    "freshwater collapse": "ecology_wasteland",
    "water shortage": "ecology_wasteland",
    "freshwater": "ecology_wasteland",
    "drought": "ecology_wasteland",
    "ecology": "ecology_wasteland",
    "climate": "ecology_wasteland",
    "migration camp": "ecology_wasteland",
    "淡水供应": "ecology_wasteland",
    "淡水": "ecology_wasteland",
    "水资源短缺": "ecology_wasteland",
    "限水": "ecology_wasteland",
    "水源枯竭": "ecology_wasteland",
    "干旱": "ecology_wasteland",
    "迁徙": "ecology_wasteland",
    "生态": "ecology_wasteland",
    "气候": "ecology_wasteland",

    # ── refuge_compound (organized survival / quarantine / shelter) ──
    "survival compound": "refuge_compound",
    "refuge camp": "refuge_compound",
    "quarantine zone": "refuge_compound",
    "shelter network": "refuge_compound",
    "aid camp": "refuge_compound",
    "bunker": "refuge_compound",
    "refuge": "refuge_compound",
    "quarantine": "refuge_compound",
    "famine": "refuge_compound",
    "shelter": "refuge_compound",
    "避难所": "refuge_compound",
    "避难营地": "refuge_compound",
    "生存营地": "refuge_compound",
    "隔离区": "refuge_compound",
    "防疫营": "refuge_compound",
    "救援营地": "refuge_compound",

    # ── faith_temple (must beat generic fantasy on prophecy / religion) ──
    "prophecy": "faith_temple",
    "church": "faith_temple",
    "religion": "faith_temple",
    "sacred": "faith_temple",
    "heresy": "faith_temple",
    "temple": "faith_temple",
    "oracle": "faith_temple",
    "priesthood": "faith_temple",
    "divine law": "faith_temple",
    "god-king": "faith_temple",
    "神谕": "faith_temple",
    "教会": "faith_temple",
    "宗教": "faith_temple",
    "神权": "faith_temple",
    "异端": "faith_temple",
    "祭司": "faith_temple",
    "圣谕": "faith_temple",
    "神殿": "faith_temple",

    # ── faith_temple_variant (doctrine council / clerical split) ──
    "sacred council": "faith_temple_variant",
    "doctrinal council": "faith_temple_variant",
    "clerical schism": "faith_temple_variant",
    "ritual council": "faith_temple_variant",
    "canon schism": "faith_temple_variant",
    "圣议会": "faith_temple_variant",
    "教义议会": "faith_temple_variant",
    "祭司议会": "faith_temple_variant",
    "教团分裂": "faith_temple_variant",
    "神殿议事": "faith_temple_variant",
    "神启": "faith_temple",

    # ── arcane_sanctum (mythic magic / wizard / dragon) ──
    "arcane": "arcane_sanctum",
    "sorcerer": "arcane_sanctum",
    "spell": "arcane_sanctum",
    "rune": "arcane_sanctum",
    "wizard": "arcane_sanctum",
    "奥术": "arcane_sanctum",
    "秘法": "arcane_sanctum",
    "法师": "arcane_sanctum",
    "符文": "arcane_sanctum",

    # ── fantasy_kingdom (must precede medieval_village to win on 'kingdom') ──
    "fantasy": "fantasy_kingdom",
    "magic": "fantasy_kingdom",
    "dragon": "fantasy_kingdom",
    "elf": "fantasy_kingdom",
    "魔法": "fantasy_kingdom",
    "奇幻": "fantasy_kingdom",
    "精灵": "fantasy_kingdom",
    "龙": "fantasy_kingdom",

    # ── medieval_village ──────────────────────────────
    "medieval": "medieval_village",
    "middle ages": "medieval_village",
    "renaissance": "medieval_village",
    "village": "medieval_village",
    "kingdom": "medieval_village",
    "中世纪": "medieval_village",
    "村庄": "medieval_village",
    "王国": "medieval_village",

    # ── ancient_empire ────────────────────────────────
    "ancient": "ancient_empire",
    "roman": "ancient_empire",
    "empire": "ancient_empire",
    "dynasty": "ancient_empire",
    "pharaoh": "ancient_empire",
    "古代": "ancient_empire",
    "帝国": "ancient_empire",
    "王朝": "ancient_empire",
    "秦": "ancient_empire",
    "汉": "ancient_empire",
    "三国": "ancient_empire",
    "埃及": "ancient_empire",

    # ── war_command (automated command / launch authority) ──
    "automated arsenal": "war_command",
    "launch authority": "war_command",
    "command chain": "war_command",
    "command bunker": "war_command",
    "war room": "war_command",
    "missile command": "war_command",
    "automated weapons": "war_command",
    "开火权": "war_command",
    "自动化军备": "war_command",
    "指挥链": "war_command",
    "导弹指挥": "war_command",
    "误判升级": "war_command",

    # ── logistics_hub (war logistics / convoy / rail/port supply) ──
    "supply line": "logistics_hub",
    "logistics hub": "logistics_hub",
    "convoy": "logistics_hub",
    "rail hub": "logistics_hub",
    "transport corridor": "logistics_hub",
    "munitions depot": "logistics_hub",
    "logistics": "logistics_hub",
    "补给线": "logistics_hub",
    "后勤": "logistics_hub",
    "运输枢纽": "logistics_hub",
    "军工运输": "logistics_hub",
    "车队": "logistics_hub",
    "补给站": "logistics_hub",

    # ── industrial_city ───────────────────────────────
    "industrial": "industrial_city",
    "victorian": "industrial_city",
    "steam": "industrial_city",
    "factory": "industrial_city",
    "19th century": "industrial_city",
    "工业": "industrial_city",
    "维多利亚": "industrial_city",
    "蒸汽": "industrial_city",
    "工厂": "industrial_city",

    # ── power_grid_nexus (industry / energy dispatch / blackout) ──
    "grid failure": "power_grid_nexus",
    "dispatch center": "power_grid_nexus",
    "blackout": "power_grid_nexus",
    "substation": "power_grid_nexus",
    "load shedding": "power_grid_nexus",
    "power grid": "power_grid_nexus",
    "电网": "power_grid_nexus",
    "停电": "power_grid_nexus",
    "调度中心": "power_grid_nexus",
    "变电站": "power_grid_nexus",
    "负荷": "power_grid_nexus",
    "限电": "power_grid_nexus",

    # ── modern_city ───────────────────────────────────
    "modern": "modern_city",
    "contemporary": "modern_city",
    "20th century": "modern_city",
    "21st century": "modern_city",
    "city": "modern_city",
    "urban": "modern_city",
    "现代": "modern_city",
    "当代": "modern_city",
    "城市": "modern_city",

    # ── scifi_base ────────────────────────────────────
    "artificial intelligence": "scifi_base",
    "algorithmic governance": "scifi_base",
    "algorithmic": "scifi_base",
    "autonomous system": "scifi_base",
    "autonomous": "scifi_base",
    "algorithm": "scifi_base",
    "robot": "scifi_base",
    "android": "scifi_base",
    "mars": "scifi_base",
    "future": "scifi_base",
    "futuristic": "scifi_base",
    "sci-fi": "scifi_base",
    "cyberpunk": "scifi_base",
    "人工智能": "scifi_base",
    "算法治理": "scifi_base",
    "自治系统": "scifi_base",
    "机器人": "scifi_base",
    "火星": "scifi_base",
    "算法": "scifi_base",
    "未来": "scifi_base",
    "科幻": "scifi_base",
    "赛博朋克": "scifi_base",

    # ── post_apocalypse ───────────────────────────────
    "apocalypse": "post_apocalypse",
    "post-apocalyptic": "post_apocalypse",
    "wasteland": "post_apocalypse",
    "collapse": "post_apocalypse",
    "extinction": "post_apocalypse",
    "末日": "post_apocalypse",
    "废墟": "post_apocalypse",
    "荒废": "post_apocalypse",
    "灭绝": "post_apocalypse",
    "末世": "post_apocalypse",



    # ── war_battlefield ───────────────────────────────
    "war": "war_battlefield",
    "battle": "war_battlefield",
    "conflict": "war_battlefield",
    "invasion": "war_battlefield",
    "siege": "war_battlefield",
    "战争": "war_battlefield",
    "战场": "war_battlefield",
    "冲突": "war_battlefield",
    "入侵": "war_battlefield",
    "围攻": "war_battlefield",
    "赤壁": "war_battlefield",

    # ── space_station ─────────────────────────────────
    "space": "space_station",
    "station": "space_station",
    "orbital": "space_station",
    "astronaut": "space_station",
    "太空": "space_station",
    "空间站": "space_station",
    "轨道": "space_station",
    "宇航员": "space_station",

    # ── underwater_kingdom ────────────────────────────
    "underwater": "underwater_kingdom",
    "ocean": "underwater_kingdom",
    "deep sea": "underwater_kingdom",
    "atlantis": "underwater_kingdom",
    "海底": "underwater_kingdom",
    "深海": "underwater_kingdom",
    "海洋": "underwater_kingdom",
    "亚特兰蒂斯": "underwater_kingdom",

    # ── desert_outpost ────────────────────────────────
    "desert": "desert_outpost",
    "oasis": "desert_outpost",
    "sahara": "desert_outpost",
    "arid": "desert_outpost",
    "沙漠": "desert_outpost",
    "绿洲": "desert_outpost",
}

DEFAULT_SCENE = "medieval_village"

# Available scene IDs — must match BootScene SCENE_KEYS exactly
AVAILABLE_SCENES = frozenset({
    "medieval_village",
    "ancient_empire",
    "industrial_city",
    "modern_city",
    "switchboard_forum",
    "surveillance_megacity",
    "civic_chamber",
    "law_court",
    "law_court_variant",
    "imperial_forum",
    "dynastic_palace",
    "scifi_base",
    "power_grid_nexus",
    "factory_foundry",
    "frontier_colony",
    "post_apocalypse",
    "fantasy_kingdom",
    "arcane_sanctum",
    "faith_temple",
    "faith_temple_variant",
    "refuge_compound",
    "war_command",
    "logistics_hub",
    "war_battlefield",
    "space_station",
    "underwater_kingdom",
    "desert_outpost",
    "trade_harbor",
    "switchboard_forum_variant",
    "ecology_wasteland",
})


def select_scene(
    question: str | None = None,
    *,
    era: str | None = None,
    setting: str | None = None,
) -> str:
    """Return a scene theme ID based on *question* text or *era*/*setting*.

    Supports two calling conventions:

    1. Single-string scan (used by simulator):
       ``select_scene("如果三国时期曹操赢了赤壁之战")``

    2. Keyword-targeted (used by tests / direct calls):
       ``select_scene(era="三国时期", setting="赤壁之战")``

    Parameters
    ----------
    question:
        Full question text to scan for keyword matches.
    era:
        Extracted era text from the parser (e.g. "medieval", "modern").
    setting:
        Extracted setting text from the parser (e.g. "battlefield").

    Returns
    -------
    str
        A scene identifier from ``AVAILABLE_SCENES``.
    """
    # Prefer the raw question first: parser-derived era/setting are often
    # helpful, but can be too generic (for example just "kingdom"), which
    # should not override a more specific question-level cue like "prophecy".
    texts: list[str] = []
    if question:
        texts.append(question)
    if era:
        texts.append(era)
    if setting:
        texts.append(setting)

    for text in texts:
        lower = text.lower()
        # Sort by key length descending so longer (more specific) keywords
        # match first — consistent with mapper._resolve_animation strategy.
        for keyword in sorted(SCENE_MAP, key=len, reverse=True):
            if keyword in lower:
                return SCENE_MAP[keyword]

    return DEFAULT_SCENE
