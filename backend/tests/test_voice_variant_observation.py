"""Observation rerun: before/after variant distribution comparison.

Simulates realistic role_hint + bio_hint combinations that LLM-generated
scenarios would produce, then counts variant hits vs plain fallback.

This is NOT a regression test — it's a one-time observation script.
Run with: pytest tests/test_voice_variant_observation.py -v -s
"""

from app.services.ending_room_service._content import _oracle_role_voice_variant as V

# ── Sample corpus: realistic role/bio pairs from typical scenarios ────
# These represent the kinds of agents the LLM generates across different
# scenario themes (historical, political, sci-fi, economic, disaster).

SAMPLE_AGENTS = [
    # Historical / Imperial
    ("Emperor Zhaoming", "Ruler of the Eastern Dynasty"),
    ("Duke of Lancaster", "Noble landowner with vast estates"),
    ("Crown Prince", "Heir to the throne"),
    ("Lord Regent", "Acting ruler during the king's absence"),
    ("Baron von Stein", "Prussian reformer"),
    # Military / Field
    ("Retired General", "Former commander of the Northern Army"),
    ("Admiral Chen", "Fleet commander, Pacific theater"),
    ("Colonel Zhang", "Special forces, mountain warfare"),
    ("Sergeant Torres", "Infantry squad leader"),
    ("参谋长", "中央军事委员会"),
    ("军师", "帐下首席谋士"),
    ("元帅", "帝国远征军总司令"),
    # Finance
    ("Chief Financial Officer", "Global bank treasury division"),
    ("Treasury Secretary", "Federal Reserve liaison"),
    ("Investment Banker", "Mergers and acquisitions"),
    ("审计官", "中央审计署副署长"),
    ("会计", "皇家造币厂账房"),
    # Market / Commerce
    ("Tavern Owner", "Runs the only inn in the border town"),
    ("Merchant Li", "Silk road trader, Dunhuang route"),
    ("Shopkeeper", "Runs a provisions store near the docks"),
    ("Farmer", "Wheat fields on the western frontier"),
    ("Craftsman", "Blacksmith and armorer"),
    ("掌柜", "城东米铺"),
    ("工匠", "军械制造"),
    # Faith / Religious
    ("Bishop Marcus", "Head of the northern diocese"),
    ("Monk", "Monastery of the Silent Order"),
    ("Cardinal", "Vatican emissary"),
    ("和尚", "少林寺方丈"),
    ("教会长老", "北方教区"),
    # Industry
    ("Chief Engineer", "Nuclear power plant operations"),
    ("Foreman", "Steel mill floor supervisor"),
    ("Miner", "Coal mining district, shaft 7"),
    ("Technician", "Electrical grid maintenance"),
    ("工头", "第三铸造车间"),
    # Frontier / Space
    ("Pilot", "Cargo shuttle, orbital station"),
    ("Astronaut", "International Space Station crew"),
    ("Navigator", "Deep space convoy escort"),
    ("Explorer", "Uncharted territory expedition leader"),
    ("宇航员", "天宫三号维修组"),
    # Survival / Medical
    ("Doctor", "Field hospital, zone 4"),
    ("Surgeon", "Trauma specialist, evacuation ward"),
    ("Nurse", "Refugee camp clinic"),
    ("Paramedic", "Emergency response team"),
    ("医生", "前线野战医院"),
    # Scholar / Archive
    ("Historian", "Court chronicler"),
    ("Scholar", "Ancient texts specialist"),
    ("Scribe", "Palace document keeper"),
    ("学者", "翰林院编修"),
    # Civic / Government
    ("Governor", "Western Province administrator"),
    ("Mayor", "Elected city official, third term"),
    ("Senator", "Armed Services Committee"),
    ("知府", "江南道杭州府"),
    ("县令", "北方边境小县"),
    ("大臣", "户部尚书"),
    # NEW: Diplomat
    ("Ambassador", "Accredited to the Northern Alliance"),
    ("Envoy", "Peace negotiation delegation"),
    ("Consul", "Foreign consulate, port city"),
    ("外交官", "驻西域联邦大使"),
    ("使节", "南朝和谈全权代表"),
    # NEW: Advisor
    ("Royal Advisor", "Trusted counselor to the throne"),
    ("Chief Strategist", "War council lead planner"),
    ("Counselor", "Inner circle, policy guidance"),
    ("谋士", "丞相府首席"),
    ("幕僚", "总督府幕僚长"),
    # NEW: Science
    ("Scientist", "Viral research laboratory"),
    ("Lead Researcher", "Quantum physics division"),
    ("Data Analyst", "Predictive modeling unit"),
    ("研究员", "中央实验室主任"),
    ("分析师", "战略情报分析处"),
    # Edge: should remain plain
    ("Bystander", None),
    ("Civilian", "Caught in the crossfire"),
    ("Stranger", "No known affiliation"),
    ("Unknown", None),
    ("Witness", None),  # "witness" is in scholar
]


def test_observation_rerun():
    """Print before/after variant distribution for manual review."""
    # ── Simulate "before" with old keyword set ─────────────────────
    OLD_TOKENS: dict[str, tuple[str, ...]] = {
        "imperial": ("皇", "king", "queen", "emperor", "crown", "court"),
        "field": ("将", "统帅", "指挥官", "舰队", "commander", "captain",
                  "marshal", "fleet", "guard"),
        "finance": ("银行", "行长", "财政", "金融", "清算", "流动性",
                    "bank", "banker", "finance", "treasury", "settlement",
                    "liquidity"),
        "market": ("摊主", "商户", "商贩", "市场", "港口", "贸易", "货运",
                   "vendor", "merchant", "market", "port", "trade", "freight"),
        "faith": ("祭司", "祭坛", "神官", "修士", "神谕", "priest", "cleric",
                  "oracle", "temple", "faith", "ritual", "covenant"),
        "industry": ("工程", "工厂", "电网", "产能", "后勤", "调度",
                     "engineer", "factory", "industrial", "grid", "throughput",
                     "logistics", "plant"),
        "frontier": ("边疆", "拓荒", "殖民", "轨道", "补给舱", "生命维持",
                     "pilot", "orbital", "frontier", "colony", "expedition",
                     "convoy", "airlock", "life support"),
        "survival": ("避难", "药品", "口粮", "撤离", "医疗", "scout", "medic",
                     "refuge", "ration", "evacuation", "shelter", "survival"),
        "scholar": ("史官", "书记官", "学者", "档案", "证人", "scribe",
                    "scholar", "historian", "witness", "record", "ledger",
                    "clerk"),
        "civic": ("议长", "speaker", "minister", "scribe", "文书", "ledger",
                  "council"),
    }

    def old_classify(role, bio):
        normalized = f"{role or ''} {bio or ''}".strip().lower()
        for variant, tokens in OLD_TOKENS.items():
            if any(t in normalized for t in tokens):
                return variant
        return "plain"

    # ── Run both classifiers ──────────────────────────────────────
    before_results: dict[str, list[str]] = {}
    after_results: dict[str, list[str]] = {}
    migrations: list[tuple[str, str, str, str]] = []  # (name, old, new, why)

    for role, bio in SAMPLE_AGENTS:
        name = role or bio or "?"
        old_v = old_classify(role, bio)
        new_v = V(role, bio)
        before_results.setdefault(old_v, []).append(name)
        after_results.setdefault(new_v, []).append(name)
        if old_v != new_v:
            if old_v == "plain":
                reason = "NEW COVERAGE"
            elif new_v == "plain":
                reason = "REGRESSION"
            else:
                reason = f"RECLASSIFIED ({old_v}→{new_v})"
            migrations.append((name, old_v, new_v, reason))

    # ── Print report ──────────────────────────────────────────────
    total = len(SAMPLE_AGENTS)
    old_plain = len(before_results.get("plain", []))
    new_plain = len(after_results.get("plain", []))

    print("\n" + "=" * 72)
    print("OBSERVATION RERUN: Voice Variant Coverage Before/After")
    print("=" * 72)

    print(f"\nTotal sample agents: {total}")
    print(f"Plain fallback BEFORE: {old_plain}/{total} ({old_plain*100//total}%)")
    print(f"Plain fallback AFTER:  {new_plain}/{total} ({new_plain*100//total}%)")
    print(f"Reduction:             {old_plain - new_plain} agents rescued from plain")

    print("\n── Distribution BEFORE ──")
    for v in sorted(before_results, key=lambda x: (-len(before_results[x]), x)):
        agents = before_results[v]
        print(f"  {v:12s} ({len(agents):2d}): {', '.join(agents[:5])}"
              f"{'...' if len(agents) > 5 else ''}")

    print("\n── Distribution AFTER ──")
    for v in sorted(after_results, key=lambda x: (-len(after_results[x]), x)):
        agents = after_results[v]
        print(f"  {v:12s} ({len(agents):2d}): {', '.join(agents[:5])}"
              f"{'...' if len(agents) > 5 else ''}")

    print(f"\n── Migrations ({len(migrations)}) ──")
    for name, old_v, new_v, reason in migrations:
        print(f"  {name:30s}  {old_v:10s} → {new_v:10s}  [{reason}]")

    # ── Substring collision inventory ─────────────────────────────
    collisions = [m for m in migrations if "RECLASSIFIED" in m[3]]
    if collisions:
        print(f"\n── Substring Collisions ({len(collisions)}) ──")
        for name, old_v, new_v, _ in collisions:
            print(f"  {name:30s}  was {old_v}, now {new_v} (substring precedence)")

    # ── Assertions for CI (soft) ──────────────────────────────────
    assert new_plain < old_plain, "Plain fallback should decrease"
    assert new_plain <= 5, f"Too many plain agents: {new_plain}"
    regressions = [m for m in migrations if m[3] == "REGRESSION"]
    assert len(regressions) == 0, f"Regressions found: {regressions}"
