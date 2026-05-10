"""DPD (Debate-Phase) Hallucination Verification Gate.

A warning-only post-verdict pipeline that extracts verifiable factual claims
from a debate verdict, cross-references them against graph + web evidence
using lightweight string operations (substring containment and keyword
overlap), and emits per-claim confidence + global warnings.

Design constraints:
  * NO external NLP libs (no spacy/nltk/transformers) — pure Python string ops.
  * NEVER blocks the debate verdict — failures upstream are absorbed by the
    caller (see `app.services.debate._apply_hallucination_gate_metadata`).
  * Stateless and side-effect free; results are deterministic for the same
    input pair.

Public API:
  * extract_verifiable_claims(verdict_text) -> list[dict]
  * verify_claims(claims, graph_evidence, web_evidence) -> list[dict]
  * apply_hallucination_gate(verdict_text, graph_evidence, web_evidence,
                             threshold=0.75) -> dict
"""

from __future__ import annotations

import re
from typing import Any, Iterable

# ── Tunables ────────────────────────────────────────────────────────────────
# Default acceptance threshold: claims below this confidence flag the verdict
# as "low-confidence" but never block it.
DEFAULT_THRESHOLD = 0.75

# Minimum normalized token overlap required to count an evidence snippet as
# "supporting" a claim. Below this we still record evidence but do not bump
# confidence above the unverified ceiling.
SUPPORT_OVERLAP_FLOOR = 0.45
STRONG_OVERLAP_FLOOR = 0.7

# Confidence levels used through the pipeline. Containment (substring match)
# yields the strongest signal; overlap-only matches stay below the
# verification threshold (0.75) unless reinforced by a second source.
CONFIDENCE_BASELINE = 0.30
CONFIDENCE_OVERLAP_SUPPORT = 0.55
CONFIDENCE_STRONG_SUPPORT = 0.78
CONFIDENCE_CONTAINMENT = 0.85
CONFIDENCE_DUAL_BONUS = 0.10
CONFIDENCE_CAP = 0.95
CONFIDENCE_CONTRADICTION = 0.20

# Claim-detection vocabularies. Keep these small + scrutable; we trade recall
# for predictability and zero NLP-lib dependencies.
HEDGE_TOKENS: tuple[str, ...] = (
    "可能",
    "也许",
    "或许",
    "大概",
    "似乎",
    "据说",
    "听说",
    "maybe",
    "perhaps",
    "possibly",
    "probably",
    "might",
    "could be",
    "appears to",
    "seems to",
    "allegedly",
    "rumored",
    "reportedly",
)

CAUSAL_TOKENS: tuple[str, ...] = (
    "因为",
    "由于",
    "导致",
    "造成",
    "使得",
    "因此",
    "所以",
    "because",
    "due to",
    "caused by",
    "leads to",
    "led to",
    "resulted in",
    "therefore",
    "hence",
    "thus",
)

TEMPORAL_TOKENS: tuple[str, ...] = (
    "今年",
    "去年",
    "上月",
    "本月",
    "本季度",
    "上季度",
    "this year",
    "last year",
    "this quarter",
    "last quarter",
    "yesterday",
    "today",
    "in 19",
    "in 20",
)

# Negation cues used to flag contradictions between a claim and an evidence
# snippet that otherwise has high overlap.
NEGATION_TOKENS: tuple[str, ...] = (
    "不",
    "没",
    "没有",
    "未",
    "并未",
    "并非",
    "绝非",
    "not",
    "no",
    "never",
    "neither",
    "nor",
    "without",
    "fails to",
    "did not",
    "does not",
    "didn't",
    "doesn't",
    "isn't",
    "wasn't",
    "weren't",
    "won't",
    "n't",
)

# Stop-words removed before token-overlap scoring. Mixed CN/EN — keep tight.
STOPWORDS: frozenset[str] = frozenset(
    {
        "the",
        "a",
        "an",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "of",
        "in",
        "on",
        "at",
        "to",
        "for",
        "by",
        "with",
        "from",
        "and",
        "or",
        "but",
        "if",
        "then",
        "than",
        "as",
        "this",
        "that",
        "these",
        "those",
        "it",
        "its",
        "into",
        "out",
        "up",
        "down",
        "over",
        "under",
        "about",
        "可能",
        "也许",
        "的",
        "了",
        "和",
        "与",
        "也",
        "在",
        "是",
        "为",
        "及",
        "等",
        "并",
    }
)

# Sentence terminators in CN + EN. The pipeline is intentionally simple:
# split, strip, filter empties.
_SENTENCE_SPLIT_RE = re.compile(r"[。！？!?\.](?:\s|$)")

# A claim is "verifiable" if it contains a number / percentage / date /
# named entity-ish capitalization or a causal/temporal cue.
_NUMERIC_RE = re.compile(r"\d")
_PERCENT_RE = re.compile(r"\d+\s*%|\d+\s*percent|百分之|个百分点")
# Treat 4-digit years as a strong temporal anchor.
_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
# An English capitalized word that isn't sentence-initial — weak proper-noun
# heuristic. We inspect the trimmed sentence.
_CAPITAL_WORD_RE = re.compile(r"(?<!^)(?<!\s)\b[A-Z][a-zA-Z]{2,}\b")


# ── Helpers ─────────────────────────────────────────────────────────────────


def _normalize(text: str) -> str:
    """Lower-case, collapse whitespace; preserves CJK characters as-is."""
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _tokenize(text: str) -> list[str]:
    """Token list for overlap scoring.

    Latin tokens are split on non-word boundaries; CJK characters are kept as
    individual tokens (one char == one token). This keeps the algorithm
    parameter-free but workable for both languages.
    """
    norm = _normalize(text)
    if not norm:
        return []
    tokens: list[str] = []
    # Latin words first.
    for word in re.findall(r"[a-z][a-z0-9'\-]*|\d+(?:\.\d+)?%?", norm):
        if word in STOPWORDS or len(word) < 2:
            continue
        tokens.append(word)
    # CJK — emit each character that isn't whitespace/punctuation.
    for ch in norm:
        if "一" <= ch <= "鿿":
            if ch in STOPWORDS:
                continue
            tokens.append(ch)
    return tokens


def _token_overlap(a: str, b: str) -> float:
    """Symmetric token overlap in [0, 1]; 0 if either side is empty."""
    a_tokens = set(_tokenize(a))
    b_tokens = set(_tokenize(b))
    if not a_tokens or not b_tokens:
        return 0.0
    inter = a_tokens & b_tokens
    union = a_tokens | b_tokens
    return len(inter) / len(union)


# Negator words to strip when comparing polarity-flipped texts. Stem-aware
# pairings (grew/grow, was/were) are handled by stemming below.
_POLARITY_STRIP_TOKENS: frozenset[str] = frozenset(
    {
        "not",
        "no",
        "never",
        "neither",
        "nor",
        "did",
        "does",
        "do",
        "is",
        "are",
        "was",
        "were",
        "n't",
        "didn't",
        "doesn't",
        "isn't",
        "wasn't",
        "weren't",
        "won't",
        "fails",
        "fail",
        "without",
        "并未",
        "并非",
        "未",
        "没",
        "不",
        "没有",
        "绝非",
    }
)


def _stem(token: str) -> str:
    """Tiny suffix stripper sufficient for grew/grow, growed/growing pairs.

    English-only; CJK tokens (single chars) are returned unchanged.
    """
    if not token or not token[0].isascii():
        return token
    for suffix in ("ing", "ed", "es", "s", "ew"):
        if len(token) > len(suffix) + 2 and token.endswith(suffix):
            return token[: -len(suffix)]
    return token


def _content_overlap(a: str, b: str) -> float:
    """Overlap that ignores negation/aux tokens and applies tiny stemming.

    Used as a tiebreaker for polarity-flipped sentences where standard
    overlap is depressed by the negation insertion (e.g. "grew" vs "did
    not grow").
    """
    a_tokens = {_stem(t) for t in _tokenize(a) if t not in _POLARITY_STRIP_TOKENS}
    b_tokens = {_stem(t) for t in _tokenize(b) if t not in _POLARITY_STRIP_TOKENS}
    if not a_tokens or not b_tokens:
        return 0.0
    inter = a_tokens & b_tokens
    union = a_tokens | b_tokens
    return len(inter) / len(union)


def _contains_any(text: str, tokens: Iterable[str]) -> bool:
    norm = _normalize(text)
    return any(tok.lower() in norm for tok in tokens)


def _has_hedge(text: str) -> bool:
    return _contains_any(text, HEDGE_TOKENS)


def _has_negation(text: str) -> bool:
    """Detect negation cues robust to CN/EN quirks (e.g., "did not", "n't")."""
    norm = _normalize(text)
    for tok in NEGATION_TOKENS:
        tok_l = tok.lower()
        if tok_l in {"not", "no", "never", "n't", "neither", "nor"}:
            # Word-boundary match for short Latin tokens to avoid e.g.
            # matching "no" inside "now". CJK negators fall through and use
            # plain substring matching below.
            if re.search(rf"(?:^|\W){re.escape(tok_l)}(?:\W|$)", norm):
                return True
        else:
            if tok_l in norm:
                return True
    return False


def _split_sentences(text: str) -> list[str]:
    if not text:
        return []
    raw = _SENTENCE_SPLIT_RE.split(text)
    return [s.strip() for s in raw if s and s.strip()]


def _is_question_only(sentence: str) -> bool:
    """Sentences ending with ? / ? are questions; not verifiable claims."""
    return sentence.rstrip().endswith(("?", "？"))


def _classify_claim(sentence: str) -> str | None:
    """Return claim type if the sentence is verifiable, else None.

    Order matters: statistical > temporal > causal > entity. We probe
    statistics first because a sentence like "公司增长了 300% 因为 X" is more
    usefully indexed by its number than by its causal cue.
    """
    if _is_question_only(sentence):
        return None
    if _has_hedge(sentence):
        return None
    if _PERCENT_RE.search(sentence) or _NUMERIC_RE.search(sentence):
        return "statistical"
    if _YEAR_RE.search(sentence) or _contains_any(sentence, TEMPORAL_TOKENS):
        return "temporal"
    if _contains_any(sentence, CAUSAL_TOKENS):
        return "causal"
    if _CAPITAL_WORD_RE.search(sentence):
        return "entity"
    return None


# ── Public API ──────────────────────────────────────────────────────────────


def extract_verifiable_claims(verdict_text: str) -> list[dict[str, Any]]:
    """Split a verdict into verifiable claims.

    Returned dicts contain: {text, source_sentence, claim_type}. Sentence
    terminators are stripped from `text` so downstream string matching is
    less brittle, while `source_sentence` preserves the raw split.
    """
    if not verdict_text or not verdict_text.strip():
        return []

    claims: list[dict[str, Any]] = []
    for sentence in _split_sentences(verdict_text):
        claim_type = _classify_claim(sentence)
        if claim_type is None:
            continue
        # Strip trailing CN/EN sentence terminators from the canonical text.
        text = sentence.rstrip("。.!！?？ ").strip()
        if not text:
            continue
        claims.append(
            {
                "text": text,
                "source_sentence": sentence,
                "claim_type": claim_type,
            }
        )
    return claims


def _score_evidence_match(claim_text: str, evidence_text: str) -> tuple[float, bool]:
    """Score one (claim, evidence) pair.

    Returns (confidence_contribution, contradiction_flag).

    - Substring containment in either direction is the strongest signal.
    - Token overlap above STRONG_OVERLAP_FLOOR is treated as supporting.
    - Token overlap above SUPPORT_OVERLAP_FLOOR but with negation in only
      one side is treated as a contradiction.
    """
    claim_norm = _normalize(claim_text)
    evidence_norm = _normalize(evidence_text)
    if not claim_norm or not evidence_norm:
        return 0.0, False

    overlap = _token_overlap(claim_text, evidence_text)
    content_overlap = _content_overlap(claim_text, evidence_text)
    claim_neg = _has_negation(claim_text)
    evidence_neg = _has_negation(evidence_text)
    polarity_mismatch = claim_neg != evidence_neg

    # Polarity-flip contradiction: when the texts share most non-negation
    # content but only one side carries a negation cue, treat as a direct
    # contradiction even though raw overlap may have been depressed by the
    # extra negation tokens themselves (e.g. "grew" vs "did not grow").
    if polarity_mismatch and content_overlap >= SUPPORT_OVERLAP_FLOOR:
        return CONFIDENCE_CONTRADICTION, True

    # Containment — strongest match. If polarity mismatches we still flag
    # a contradiction (e.g. "X grew 20%" vs "X did not grow 20%").
    if claim_norm in evidence_norm or evidence_norm in claim_norm:
        if polarity_mismatch:
            return CONFIDENCE_CONTRADICTION, True
        return CONFIDENCE_CONTAINMENT, False

    if overlap >= STRONG_OVERLAP_FLOOR:
        if polarity_mismatch:
            return CONFIDENCE_CONTRADICTION, True
        return CONFIDENCE_STRONG_SUPPORT, False

    if overlap >= SUPPORT_OVERLAP_FLOOR:
        if polarity_mismatch:
            return CONFIDENCE_CONTRADICTION, True
        return CONFIDENCE_OVERLAP_SUPPORT, False

    return 0.0, False


def _evidence_text(item: Any) -> str:
    if isinstance(item, dict):
        return str(item.get("text") or item.get("content") or "")
    return str(item or "")


def _evidence_source(item: Any, default: str) -> str:
    if isinstance(item, dict):
        src = item.get("source") or item.get("id") or item.get("uri")
        if src:
            return str(src)
    return default


def verify_claims(
    claims: list[dict[str, Any]],
    graph_evidence: list[dict[str, Any]] | None,
    web_evidence: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Cross-verify each claim against graph + web evidence pools.

    Each claim dict is augmented (non-mutating) with:
      verified, confidence, evidence_sources, contradiction_found,
      matched_graph, matched_web.
    """
    graph_pool = list(graph_evidence or [])
    web_pool = list(web_evidence or [])
    results: list[dict[str, Any]] = []

    for claim in claims:
        claim_text = str(claim.get("text") or claim.get("source_sentence") or "")
        best_graph = 0.0
        best_web = 0.0
        contradiction_found = False
        evidence_sources: list[dict[str, Any]] = []

        for idx, item in enumerate(graph_pool):
            score, contradict = _score_evidence_match(claim_text, _evidence_text(item))
            if contradict:
                contradiction_found = True
                evidence_sources.append(
                    {
                        "source": _evidence_source(item, f"graph:{idx}"),
                        "kind": "graph",
                        "polarity": "contradicts",
                        "score": round(score, 3),
                    }
                )
                continue
            if score > 0:
                evidence_sources.append(
                    {
                        "source": _evidence_source(item, f"graph:{idx}"),
                        "kind": "graph",
                        "polarity": "supports",
                        "score": round(score, 3),
                    }
                )
            best_graph = max(best_graph, score)

        for idx, item in enumerate(web_pool):
            score, contradict = _score_evidence_match(claim_text, _evidence_text(item))
            if contradict:
                contradiction_found = True
                evidence_sources.append(
                    {
                        "source": _evidence_source(item, f"web:{idx}"),
                        "kind": "web",
                        "polarity": "contradicts",
                        "score": round(score, 3),
                    }
                )
                continue
            if score > 0:
                evidence_sources.append(
                    {
                        "source": _evidence_source(item, f"web:{idx}"),
                        "kind": "web",
                        "polarity": "supports",
                        "score": round(score, 3),
                    }
                )
            best_web = max(best_web, score)

        # Aggregate: take the dominant signal, give a small boost when both
        # graph and web agree (i.e., independent corroboration).
        confidence = max(best_graph, best_web, CONFIDENCE_BASELINE if not evidence_sources else 0.0)
        if best_graph > 0 and best_web > 0:
            confidence = min(CONFIDENCE_CAP, confidence + CONFIDENCE_DUAL_BONUS)

        if contradiction_found:
            confidence = min(confidence, CONFIDENCE_CONTRADICTION)
            verified = False
        else:
            verified = confidence >= DEFAULT_THRESHOLD

        # If no supporting evidence at all, normalize confidence to a
        # below-threshold value so callers can distinguish "no signal" from
        # "weak signal".
        if not evidence_sources:
            confidence = min(confidence, CONFIDENCE_BASELINE)
            verified = False

        results.append(
            {
                **claim,
                "verified": bool(verified),
                "confidence": round(confidence, 3),
                "evidence_sources": evidence_sources,
                "contradiction_found": bool(contradiction_found),
                "matched_graph": round(best_graph, 3),
                "matched_web": round(best_web, 3),
            }
        )
    return results


def apply_hallucination_gate(
    verdict_text: str,
    graph_evidence: list[dict[str, Any]] | None,
    web_evidence: list[dict[str, Any]] | None,
    threshold: float = DEFAULT_THRESHOLD,
) -> dict[str, Any]:
    """Run the full pipeline. Always warning-only; never raises on input.

    Returns:
      {
        "claims": [...verified claim dicts...],
        "overall_confidence": float in [0, 1],
        "warnings": [str, ...],
        "gate_passed": bool,
        "threshold": float,
      }
    """
    warnings: list[str] = []
    if not verdict_text or not verdict_text.strip():
        return {
            "claims": [],
            "overall_confidence": 0.0,
            "warnings": ["empty_verdict"],
            "gate_passed": False,
            "threshold": threshold,
        }

    claims = extract_verifiable_claims(verdict_text)
    if not claims:
        warnings.append("no_verifiable_claims")
        return {
            "claims": [],
            "overall_confidence": 0.0,
            "warnings": warnings,
            "gate_passed": False,
            "threshold": threshold,
        }

    verified = verify_claims(claims, graph_evidence, web_evidence)

    # Aggregate stats. `overall_confidence` is the mean per-claim confidence.
    confidences = [float(c.get("confidence") or 0.0) for c in verified]
    overall = sum(confidences) / len(confidences) if confidences else 0.0
    contradictions = sum(1 for c in verified if c.get("contradiction_found"))
    unverified = sum(1 for c in verified if not c.get("verified"))

    if contradictions:
        warnings.append("contradictions_detected")
    if unverified:
        warnings.append("low_confidence_claims")
    if overall < threshold:
        warnings.append("verdict_below_threshold")

    gate_passed = overall >= threshold and contradictions == 0 and unverified == 0

    return {
        "claims": verified,
        "overall_confidence": round(overall, 3),
        "warnings": warnings,
        "gate_passed": bool(gate_passed),
        "threshold": threshold,
        "stats": {
            "claim_count": len(verified),
            "contradictions": contradictions,
            "unverified": unverified,
        },
    }
