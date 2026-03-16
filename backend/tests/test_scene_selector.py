"""Tests for app.visualization.scene_selector — select_scene function.

Covers era/setting keyword matching, Chinese keywords, edge cases.
Updated to match the current scene SCENE_MAP and keyword-only API.
"""

import pytest

from app.visualization.scene_selector import (
    AVAILABLE_SCENES,
    DEFAULT_SCENE,
    SCENE_MAP,
    select_scene,
)


class TestSelectScene:
    """Test scene theme selection based on era and setting."""

    # ── Era keywords ──

    @pytest.mark.parametrize(
        "era, expected",
        [
            ("medieval", "medieval_village"),
            ("middle ages", "medieval_village"),
            ("ancient", "ancient_empire"),
            ("renaissance", "medieval_village"),
            ("modern", "modern_city"),
            ("contemporary", "modern_city"),
            ("surveillance", "surveillance_megacity"),
            ("democracy", "civic_chamber"),
            ("supreme court", "law_court"),
            ("resource bottleneck", "factory_foundry"),
            ("frontier colony", "frontier_colony"),
            ("succession crisis", "dynastic_palace"),
            ("industrial", "industrial_city"),
            ("roman empire", "imperial_forum"),
            ("blackout", "power_grid_nexus"),
            ("20th century", "modern_city"),
            ("future", "scifi_base"),
            ("futuristic", "scifi_base"),
            ("cyberpunk", "scifi_base"),
            ("sci-fi era", "scifi_base"),
        ],
    )
    def test_era_keywords(self, era, expected):
        result = select_scene(era=era)
        assert result == expected, f"Expected {expected} for era='{era}', got {result}"

    # ── Setting keywords ──

    @pytest.mark.parametrize(
        "setting, expected",
        [
            ("war zone", "war_battlefield"),
            ("battle", "war_battlefield"),
            ("the great conflict", "war_battlefield"),
            ("war room", "war_command"),
            ("supply line", "logistics_hub"),
            ("constitutional court chamber", "law_court"),
            ("foundry floor", "factory_foundry"),
            ("surface settlement", "frontier_colony"),
            ("arcane rune chamber", "arcane_sanctum"),
            ("quarantine zone", "refuge_compound"),
            ("deep sea exploration", "underwater_kingdom"),
            ("desert oasis", "desert_outpost"),
            ("busy maritime harbor", "trade_harbor"),
            ("island paradise", DEFAULT_SCENE),  # 'island' not in current SCENE_MAP → default
            ("ocean depths", "underwater_kingdom"),
            ("village", "medieval_village"),
            ("city", "modern_city"),
            ("urban", "modern_city"),
            ("kingdom", "medieval_village"),
            ("empire", "ancient_empire"),
        ],
    )
    def test_setting_keywords(self, setting, expected):
        result = select_scene(setting=setting)
        assert result == expected, f"Expected {expected} for setting='{setting}', got {result}"

    # ── Chinese keywords ──

    @pytest.mark.parametrize(
        "era, expected",
        [
            ("中世纪", "medieval_village"),
            ("古代", "ancient_empire"),
            ("现代", "modern_city"),
            ("未来", "scifi_base"),
            ("科幻", "scifi_base"),
            ("算法治理", "scifi_base"),
            ("人工智能", "scifi_base"),
            ("社会信用", "surveillance_megacity"),
            ("民主", "civic_chamber"),
            ("最高法院", "law_court"),
            ("产能瓶颈", "factory_foundry"),
            ("自治城邦", "frontier_colony"),
            ("宫廷", "dynastic_palace"),
            ("秘法", "arcane_sanctum"),
            ("避难所", "refuge_compound"),
            ("元老院", "imperial_forum"),
            ("限电", "power_grid_nexus"),
        ],
    )
    def test_chinese_era_keywords(self, era, expected):
        result = select_scene(era=era)
        assert result == expected

    @pytest.mark.parametrize(
        "setting, expected",
        [
            ("战争", "war_battlefield"),
            ("战场", "war_battlefield"),
            ("沙漠", "desert_outpost"),
            ("海港", "trade_harbor"),
            ("神殿", "faith_temple"),
            ("迁徙营地", "ecology_wasteland"),
            ("指挥链", "war_command"),
            ("补给线", "logistics_hub"),
            ("熔炉", "factory_foundry"),
            ("拓荒营地", "frontier_colony"),
            ("符文", "arcane_sanctum"),
            ("隔离区", "refuge_compound"),
            ("海底世界", "underwater_kingdom"),
            ("城市", "modern_city"),
            ("村庄", "medieval_village"),
            ("王国", "medieval_village"),
        ],
    )
    def test_chinese_setting_keywords(self, setting, expected):
        result = select_scene(setting=setting)
        assert result == expected

    # ── Scene coverage ──

    @pytest.mark.parametrize(
        "keyword, expected",
        [
            ("post-apocalyptic", "post_apocalypse"),
            ("wasteland", "post_apocalypse"),
            ("末日", "post_apocalypse"),
            ("citizens assembly after election crisis", "civic_chamber"),
            ("platform state with social credit checkpoints", "surveillance_megacity"),
            ("resource bottleneck in a massive foundry complex", "factory_foundry"),
            ("autonomous city-state on a frontier colony", "frontier_colony"),
            ("fantasy", "fantasy_kingdom"),
            ("dragon", "fantasy_kingdom"),
            ("奇幻", "fantasy_kingdom"),
            ("arcane wizard conclave in a rune sanctuary", "arcane_sanctum"),
            ("如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？", "law_court"),
            ("constitutional court emergency veto", "law_court"),
            ("如果罗马帝国从未衰落？", "imperial_forum"),
            ("roman senate power struggle", "imperial_forum"),
            ("succession crisis inside a dynastic palace", "dynastic_palace"),
            ("space station", "space_station"),
            ("orbital", "space_station"),
            ("太空", "space_station"),
            ("atlantis", "underwater_kingdom"),
            ("深海", "underwater_kingdom"),
            ("sahara", "desert_outpost"),
            ("绿洲", "desert_outpost"),
            ("blackout cascade inside a continental power grid nexus", "power_grid_nexus"),
            ("如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？", "trade_harbor"),
            ("merchant guild blocks a strategic harbor", "trade_harbor"),
            ("如果跨大陆淡水供应在十年内枯竭，会发生什么？", "ecology_wasteland"),
            ("climate migration after freshwater collapse", "ecology_wasteland"),
            ("如果一则神谕成为整个王国唯一合法的统治依据，会发生什么？", "faith_temple"),
            ("prophecy-backed temple rule", "faith_temple"),
            ("fortified quarantine refuge after famine", "refuge_compound"),
            ("如果世界大战在高度自动化军备时代再次爆发？", "war_command"),
            ("automated arsenal launch authority crisis", "war_command"),
            ("supply line collapse at a fortified logistics hub", "logistics_hub"),
            ("victorian", "industrial_city"),
            ("蒸汽", "industrial_city"),
            ("pharaoh", "ancient_empire"),
            ("三国", "ancient_empire"),
            ("如果人工智能统治世界？", "scifi_base"),
            ("algorithmic government", "scifi_base"),
            ("如果火星殖民地在补给断裂后必须决定是否强制撤离，会发生什么？", "space_station"),
            ("What if a Mars colony lost life support and had to choose an evacuation route?", "space_station"),
        ],
    )
    def test_scene_keywords(self, keyword, expected):
        result = select_scene(keyword)
        assert result == expected, f"Expected {expected} for question='{keyword}', got {result}"

    # ── Priority rules ──

    def test_era_priority_over_setting(self):
        """When both match, era is checked first and wins."""
        result = select_scene(era="medieval", setting="city")
        assert result == "medieval_village"  # era=medieval wins over setting=city

    def test_setting_used_when_era_no_match(self):
        """When era doesn't match, setting is used."""
        result = select_scene(era="xyz_no_match", setting="war")
        assert result == "war_battlefield"

    # ── Single-string question API ──

    def test_question_string_scan(self):
        """select_scene('question text') should scan full text for keywords."""
        result = select_scene("如果三国时期曹操赢了赤壁之战")
        assert result == "ancient_empire"  # '三国' matches

    def test_question_with_era_and_setting_override(self):
        """A more specific question should override generic parser hints."""
        result = select_scene("futuristic world", era="medieval")
        assert result == "scifi_base"

    def test_question_used_as_fallback_when_parser_fields_miss(self):
        """If parsed era/setting are unhelpful, the raw question still drives the theme."""
        result = select_scene(
            "如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？",
            era="",
            setting="全球议会",
        )
        assert result == "scifi_base"

    # ── Edge cases ──

    def test_both_none(self):
        assert select_scene() == DEFAULT_SCENE

    def test_no_args(self):
        assert select_scene(None) == DEFAULT_SCENE

    def test_empty_question(self):
        assert select_scene("") == DEFAULT_SCENE

    def test_no_match(self):
        result = select_scene("nonexistent totally unrelated text")
        assert result == DEFAULT_SCENE

    def test_case_insensitive(self):
        assert select_scene(era="MEDIEVAL") == "medieval_village"
        assert select_scene(era="Modern") == "modern_city"
        assert select_scene(setting="WAR") == "war_battlefield"

    def test_return_always_in_available(self):
        inputs = [
            {},
            {"question": ""},
            {"question": "random gibberish"},
            {"era": "中文", "setting": "abc"},
        ]
        for kwargs in inputs:
            result = select_scene(**kwargs)
            assert result in AVAILABLE_SCENES, f"'{result}' not in AVAILABLE_SCENES"

    def test_partial_match(self):
        """A longer string containing the keyword should still match."""
        assert select_scene("a futuristic world") == "scifi_base"
        assert select_scene("the great war of kings") == "war_battlefield"


class TestAvailableScenes:
    """Validate AVAILABLE_SCENES and SCENE_MAP consistency."""

    def test_all_scene_map_values_in_available(self):
        for keyword, scene_id in SCENE_MAP.items():
            assert scene_id in AVAILABLE_SCENES, f"SCENE_MAP['{keyword}'] = '{scene_id}' not in AVAILABLE_SCENES"

    def test_default_scene_in_available(self):
        assert DEFAULT_SCENE in AVAILABLE_SCENES

    def test_available_scenes_not_empty(self):
        assert len(AVAILABLE_SCENES) > 0

    def test_exactly_26_scenes(self):
        assert len(AVAILABLE_SCENES) == 26
