"""Language detection utility for auto-matching LLM output language to user input."""

from __future__ import annotations

import re

# CJK Unicode ranges (Chinese, Japanese common Kanji)
# NOTE: \uff00-\uffef intentionally excluded — it contains fullwidth Latin
# letters (Ａ-Ｚ) and digits that would inflate CJK count on English text.
_CJK_RE = re.compile(
    r"[\u4e00-\u9fff\u3400-\u4dbf\u2e80-\u2eff\u3000-\u303f]"
)

# Japanese-specific (Hiragana + Katakana)
_JA_RE = re.compile(r"[\u3040-\u309f\u30a0-\u30ff]")
_JA_PARTICLE_RE = re.compile(r"(の|は|が|を|に|へ|と|で|です|ます|でした|ません)")

# Korean Hangul
_KO_RE = re.compile(r"[\uac00-\ud7af\u1100-\u11ff]")


def detect_language(text: str) -> str:
    """Detect the dominant language of the input text.

    Returns a human-readable language name suitable for prompt injection,
    e.g. "Chinese", "English", "Japanese", "Korean".

    Strategy: character-ratio heuristic (no external dependencies).
    """
    if not text or not text.strip():
        return "English"  # default fallback — no language signal

    # Count character types
    cjk_count = len(_CJK_RE.findall(text))
    ja_count = len(_JA_RE.findall(text))
    ko_count = len(_KO_RE.findall(text))

    # Total non-whitespace characters (includes CJK, Latin, etc.)
    # Using simple whitespace/digit strip avoids \W removing CJK punctuation
    # that was already counted in cjk_count, which would corrupt the ratio.
    non_ws = re.sub(r"[\s\d]", "", text)
    total = max(len(non_ws), 1)

    # Japanese: has Hiragana/Katakana
    if ja_count > 2 or (ja_count > 0 and ja_count / total > 0.1):
        return "Japanese"
    if cjk_count > 0 and _JA_PARTICLE_RE.search(text):
        return "Japanese"

    # Korean: has Hangul
    if ko_count > 2 or (ko_count > 0 and ko_count / total > 0.1):
        return "Korean"

    # Chinese: significant CJK without Japanese/Korean markers
    if cjk_count / total > 0.3:
        return "Chinese"

    # Default: English (covers Latin-script languages)
    return "English"


def get_language_directive(language: str) -> str:
    """Return a prompt directive instructing the LLM to output in the given language.

    This is appended to system prompts to ensure output matches the user's input language.
    """
    directives = {
        "Chinese": "所有文本使用中文",
        "English": "All output text MUST be in English",
        "Japanese": "すべてのテキストは日本語で出力してください (All output text must be in Japanese)",
        "Korean": "모든 텍스트는 한국어로 출력해 주세요 (All output text must be in Korean)",
    }
    return directives.get(language, f"All output text MUST be in {language}")


def get_anonymous_director_name(language: str | None = None) -> str:
    """Return a localized anonymous label for director-facing surfaces."""
    return "匿名导演" if language == "Chinese" else "Anonymous Director"


def get_anonymous_predictor_name(language: str | None = None) -> str:
    """Return a localized anonymous label for prediction-facing surfaces."""
    return "匿名预言家" if language == "Chinese" else "Anonymous Predictor"
