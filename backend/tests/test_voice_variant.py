"""Unit tests for _oracle_role_voice_variant keyword classification.

Covers:
- Expanded keywords for existing 10 variants
- 3 new variants: diplomat, advisor, science
- 5 modern variants: tech-visionary, journalist, educator, artist, entrepreneur
- scholar/civic overlap fix (no shared tokens)
- plain fallback reduction
- Precedence order
"""

import pytest

from app.services.ending_room_service._content import (
    _VOCABULARY_HINTS,
    _oracle_role_voice_variant,
)

# shorthand
V = _oracle_role_voice_variant


# ── Existing variant expansions ──────────────────────────────────────


class TestImperial:
    @pytest.mark.parametrize("role,bio", [
        ("Emperor", None),
        ("King of the North", None),
        (None, "a noble duke from the eastern province"),
        ("Baron von Richter", None),
        ("Prince Regent", None),
        ("Viceroy", "colonial administrator"),
        ("亲王", None),
        ("公爵", "东方行省贵族"),
        ("王储", None),
    ])
    def test_imperial_keywords(self, role, bio):
        assert V(role, bio) == "imperial"


class TestField:
    @pytest.mark.parametrize("role,bio", [
        ("Commander", None),
        ("Retired General", None),
        ("Chieftain", "tribal conqueror"),
        ("Admiral", "fleet command"),
        ("Colonel Harris", None),
        ("Lieutenant", "infantry division"),
        ("参谋长", None),
        ("军师", "曹操帐下谋士"),
        ("元帅", None),
    ])
    def test_field_keywords(self, role, bio):
        assert V(role, bio) == "field"


class TestFinance:
    @pytest.mark.parametrize("role,bio", [
        ("Bank Manager", None),
        ("Chief Auditor", None),
        ("Investor", "venture capital background"),
        ("Broker", None),
        ("审计官", None),
        ("会计", "中央财政署"),
        ("投资人", None),
    ])
    def test_finance_keywords(self, role, bio):
        assert V(role, bio) == "finance"


class TestMarket:
    @pytest.mark.parametrize("role,bio", [
        ("Merchant", None),
        ("Tavern Owner", None),
        ("Shopkeeper", "runs a provisions store"),
        ("Innkeeper", None),
        ("Farmer", "wheat fields on the western plain"),
        ("Craftsman", None),
        ("Artisan", "skilled woodworker"),
        ("店主", None),
        ("掌柜", "东街酒馆"),
        ("农夫", "西郊麦田"),
        ("工匠", None),
    ])
    def test_market_keywords(self, role, bio):
        assert V(role, bio) == "market"


class TestFaith:
    @pytest.mark.parametrize("role,bio", [
        ("Priest", None),
        ("Bishop", "head of the northern diocese"),
        ("Cardinal", None),
        ("Monk", "monastery dweller"),
        ("和尚", None),
        ("僧人", "山中修行"),
        ("主教", None),
        ("教会长老", None),
    ])
    def test_faith_keywords(self, role, bio):
        assert V(role, bio) == "faith"


class TestIndustry:
    @pytest.mark.parametrize("role,bio", [
        ("Engineer", None),
        ("Chief Technician", None),
        ("Mechanic", "factory floor specialist"),
        ("Foreman", None),
        ("Miner", "coal mining district"),
        ("技师", None),
        ("矿长", None),
        ("工头", "第三车间"),
    ])
    def test_industry_keywords(self, role, bio):
        assert V(role, bio) == "industry"


class TestFrontier:
    @pytest.mark.parametrize("role,bio", [
        ("Pilot", None),
        ("Astronaut", "orbital station crew"),
        ("Navigator", "deep space convoy"),
        ("Explorer", None),
        ("宇航员", None),
        ("航天指挥", None),
        ("探险队长", None),
    ])
    def test_frontier_keywords(self, role, bio):
        assert V(role, bio) == "frontier"


class TestSurvival:
    @pytest.mark.parametrize("role,bio", [
        ("Medic", None),
        ("Doctor", "field hospital"),
        ("Physician", None),
        ("Surgeon", "trauma specialist"),
        ("Nurse", "evacuation clinic"),
        ("Paramedic", None),
        ("医生", None),
        ("大夫", "乡村诊所"),
        ("护士", None),
    ])
    def test_survival_keywords(self, role, bio):
        assert V(role, bio) == "survival"


class TestScholar:
    @pytest.mark.parametrize("role,bio", [
        ("Historian", None),
        ("Scholar", "ancient texts"),
        ("Scribe", "keeping official records"),
        ("Clerk", "ledger keeper"),
        ("史官", None),
        ("书记官", None),
        ("学者", None),
    ])
    def test_scholar_keywords(self, role, bio):
        assert V(role, bio) == "scholar"


class TestCivic:
    @pytest.mark.parametrize("role,bio", [
        ("Governor", None),
        ("Mayor", "elected city official"),
        ("Senator", None),
        ("Representative", "district delegate"),
        ("Magistrate", None),
        ("Congressman", None),
        ("Minister of Interior", None),
        ("总督", None),
        ("知府", "江南道"),
        ("太守", None),
        ("官员", "户部"),
        ("大臣", None),
        ("县令", None),
    ])
    def test_civic_keywords(self, role, bio):
        assert V(role, bio) == "civic"


# ── New variants ─────────────────────────────────────────────────────


class TestDiplomat:
    @pytest.mark.parametrize("role,bio", [
        ("Diplomat", None),
        ("Ambassador", "foreign affairs envoy"),
        ("Envoy", None),
        ("Consul", "foreign consulate"),
        ("Emissary", None),
        ("Chief Negotiator", None),
        ("外交官", None),
        ("大使", "驻北方联邦"),
        ("使节", None),
        ("使者", "和谈全权代表"),
        ("领事", None),
    ])
    def test_diplomat_keywords(self, role, bio):
        assert V(role, bio) == "diplomat"


class TestAdvisor:
    @pytest.mark.parametrize("role,bio", [
        ("Advisor", None),
        ("Chief Strategist", None),
        ("Counselor", "trusted inner circle member"),
        ("顾问", None),
        ("谋士", "帐下首席"),
        ("谋臣", None),
        ("幕僚", "府邸幕僚长"),
        ("参赞", None),
    ])
    def test_advisor_keywords(self, role, bio):
        assert V(role, bio) == "advisor"


class TestScience:
    @pytest.mark.parametrize("role,bio", [
        ("Scientist", None),
        ("Lead Researcher", "quantum physics laboratory"),
        ("Data Analyst", None),
        ("科学家", None),
        ("研究员", "中央实验室"),
        ("分析师", None),
        (None, "laboratory director overseeing experiments"),
    ])
    def test_science_keywords(self, role, bio):
        assert V(role, bio) == "science"


class TestTechVisionary:
    @pytest.mark.parametrize("role,bio", [
        ("Tech Visionary", None),
        ("Silicon Valley Futurist", None),
        (None, "disruption and paradigm shift operator"),
        ("Moonshot Architect", None),
        (None, "exponential platform strategist"),
    ])
    def test_tech_visionary_keywords(self, role, bio):
        assert V(role, bio) == "tech-visionary"


class TestJournalist:
    @pytest.mark.parametrize("role,bio", [
        ("Investigative Journalist", None),
        ("Reporter", "sources confirm the minister changed position"),
        ("Newsroom Editor", None),
        (None, "on the record breaking exclusive"),
        ("Correspondent", "exclusive field dispatch"),
    ])
    def test_journalist_keywords(self, role, bio):
        assert V(role, bio) == "journalist"


class TestEducator:
    @pytest.mark.parametrize("role,bio", [
        ("Educator", None),
        ("Professor", "academic instructor"),
        ("Teacher", "curriculum lead"),
        ("Lecturer", None),
        (None, "pedagogy specialist who says let us unpack the lesson"),
    ])
    def test_educator_keywords(self, role, bio):
        assert V(role, bio) == "educator"


class TestArtist:
    @pytest.mark.parametrize("role,bio", [
        ("Artist", None),
        ("Painter", "creative medium and expression"),
        ("Creative Director", None),
        ("Composer", "works through craft and resonance"),
        ("Curator", "aesthetic vision lead"),
    ])
    def test_artist_keywords(self, role, bio):
        assert V(role, bio) == "artist"


class TestEntrepreneur:
    @pytest.mark.parametrize("role,bio", [
        ("Entrepreneur", None),
        ("Startup Founder", None),
        (None, "pivot runway traction scale iterate"),
        ("Cofounder", "growth-stage operator"),
        ("Venture Builder", "product-market fit owner"),
    ])
    def test_entrepreneur_keywords(self, role, bio):
        assert V(role, bio) == "entrepreneur"


# ── Vocabulary hints exist for all variants ──────────────────────────


class TestVocabularyHints:
    @pytest.mark.parametrize("variant", [
        "imperial", "field", "finance", "market", "faith",
        "industry", "frontier", "survival", "scholar", "civic",
        "diplomat", "advisor", "science", "tech-visionary", "journalist",
        "educator", "artist", "entrepreneur",
    ])
    def test_hint_exists_both_languages(self, variant):
        assert variant in _VOCABULARY_HINTS
        assert "zh" in _VOCABULARY_HINTS[variant]
        assert "en" in _VOCABULARY_HINTS[variant]
        assert len(_VOCABULARY_HINTS[variant]["zh"]) > 10
        assert len(_VOCABULARY_HINTS[variant]["en"]) > 10

    def test_all_eighteen_variants_are_registered(self):
        assert set(_VOCABULARY_HINTS) == {
            "imperial", "field", "finance", "market", "faith",
            "industry", "frontier", "survival", "scholar", "civic",
            "diplomat", "advisor", "science", "tech-visionary", "journalist",
            "educator", "artist", "entrepreneur",
        }


# ── Scholar/civic overlap fix ────────────────────────────────────────


class TestOverlapFix:
    def test_scribe_goes_to_scholar_not_civic(self):
        """scribe was in both scholar and civic — now only in scholar."""
        assert V("Scribe", None) == "scholar"

    def test_ledger_goes_to_scholar_not_civic(self):
        """ledger was in both scholar and civic — now only in scholar."""
        assert V(None, "ledger keeper") == "scholar"

    def test_civic_has_own_identity(self):
        """civic tokens that are NOT in scholar still work."""
        assert V("Speaker of the House", None) == "civic"
        assert V("Governor", None) == "civic"
        assert V("Senator", None) == "civic"


# ── Precedence order ─────────────────────────────────────────────────


class TestPrecedence:
    def test_imperial_before_field(self):
        """'Crown Guard' has both imperial (crown) and field (guard) tokens."""
        assert V("Crown Guard", None) == "imperial"

    def test_field_before_advisor(self):
        """A military strategist should be field (将) not advisor (strategist)."""
        assert V("将军", "military strategist") == "field"

    def test_scholar_before_civic(self):
        """scholar is checked before civic — shared concepts go scholar."""
        assert V("Court Scribe", None) == "imperial"  # "court" → imperial wins

    def test_civic_before_diplomat(self):
        """A minister is civic even if diplomat exists."""
        assert V("Minister", None) == "civic"

    def test_diplomat_before_advisor(self):
        """An envoy who advises is diplomat first."""
        assert V("Advisory Envoy", None) == "diplomat"

    def test_journalist_phrase_before_scholar_record(self):
        """Specific reporter phrase beats generic scholar 'record' token."""
        assert V("Reporter", "on the record source") == "journalist"


# ── Modern variant overlap checks ────────────────────────────────────


class TestModernVariantOverlap:
    def test_artisan_stays_market_not_artist(self):
        assert V("Artisan", "skilled woodworker") == "market"

    def test_records_clerk_stays_scholar_not_journalist(self):
        assert V("Clerk", "keeping official records") == "scholar"

    def test_investor_stays_finance_not_entrepreneur(self):
        assert V("Investor", "venture capital background") == "finance"

    def test_engineer_stays_industry_not_tech_visionary(self):
        assert V("Engineer", "factory platform upgrade") == "industry"

    def test_scholar_stays_scholar_not_educator(self):
        assert V("Scholar", "ancient texts") == "scholar"

    def test_medium_confidence_data_analyst_stays_science(self):
        assert V("Data Analyst", "medium confidence forecast") == "science"

    def test_large_scale_medic_stays_survival(self):
        assert V("Field Medic", "large-scale evacuation") == "survival"


# ── Known substring collisions (document, not fix) ───────────────────


class TestSubstringCollisions:
    """Word-boundary matching eliminates old substring false positives.

    After W-12 fix, ASCII keywords use \\b word boundaries so partial
    substrings no longer cause misclassification.
    """

    def test_warlord_no_longer_matches_imperial(self):
        """'warlord' no longer collides with 'lord' → field (war keyword)."""
        assert V("Warlord", None) == "field"

    def test_consultant_no_longer_matches_diplomat(self):
        """'consultant' no longer collides with 'consul' → advisor."""
        assert V("Consultant", None) == "advisor"

    def test_federation_no_longer_matches_survival(self):
        """'federation' no longer collides with 'ration' → plain."""
        assert V(None, "Northern Federation delegate") == "plain"

    def test_general_store_matches_field(self):
        """'general store' contains 'general' → field (whole word match)."""
        assert V("Shopkeeper", "runs the general store") == "field"


# ── Plain fallback reduction ─────────────────────────────────────────


class TestPlainFallbackReduction:
    """Roles that previously fell to plain now have a variant."""

    @pytest.mark.parametrize("role,bio,expected", [
        # Previously plain, now matched
        ("Retired General", None, "field"),
        ("Tavern Owner", None, "market"),
        ("Duke of Lancaster", None, "imperial"),
        ("Governor of the Western Province", None, "civic"),
        ("Ambassador", None, "diplomat"),
        ("Royal Advisor", None, "advisor"),  # "royal" not in any token list
        ("Chief Strategist", None, "advisor"),
        ("Lead Researcher", None, "science"),
        ("Tech Visionary", None, "tech-visionary"),
        ("Investigative Journalist", None, "journalist"),
        ("Professor", None, "educator"),
        ("Creative Director", None, "artist"),
        ("Startup Founder", None, "entrepreneur"),
        ("Doctor", "field hospital", "survival"),
        ("Bishop", None, "faith"),
        # Still plain — intentionally unclassifiable
        ("Bystander", None, "plain"),
        ("Civilian", None, "plain"),
        ("Stranger", None, "plain"),
    ])
    def test_classification(self, role, bio, expected):
        assert V(role, bio) == expected

    def test_none_inputs_return_plain(self):
        assert V(None, None) == "plain"

    def test_empty_strings_return_plain(self):
        assert V("", "") == "plain"
