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

_LATIN_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ]")
_FRENCH_HINT_RE = re.compile(
    r"\b(le|la|les|des|une|un|est|avec|pour|dans|sur|pas|que|qui|nous|vous|elles|ils)\b",
    re.IGNORECASE,
)
_SPANISH_HINT_RE = re.compile(
    r"\b(el|la|los|las|un|una|es|con|para|por|que|como|pero|esta|este|del|al)\b",
    re.IGNORECASE,
)
_PORTUGUESE_HINT_RE = re.compile(
    r"\b(o|a|os|as|um|uma|é|com|para|por|que|como|mas|não|esta|este|dos|das)\b",
    re.IGNORECASE,
)
_GERMAN_HINT_RE = re.compile(
    r"\b(der|die|das|und|ist|mit|für|auf|nicht|ein|eine|zu|den|von|im|dem)\b",
    re.IGNORECASE,
)
_ITALIAN_HINT_RE = re.compile(
    r"\b(il|lo|la|gli|le|un|una|è|con|per|che|come|ma|non|del|della|nel|nella)\b",
    re.IGNORECASE,
)

_LANGUAGE_HINTS: tuple[tuple[str, re.Pattern[str], str], ...] = (
    ("French", _FRENCH_HINT_RE, "àâçéèêëîïôùûüÿœæ"),
    ("Spanish", _SPANISH_HINT_RE, "áéíóúñ¿¡"),
    ("Portuguese", _PORTUGUESE_HINT_RE, "ãõáâàçéêíóôú"),
    ("German", _GERMAN_HINT_RE, "äöüß"),
    ("Italian", _ITALIAN_HINT_RE, "àèéìíîòóù"),
)


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

    # Latin-script family: use lightweight stopword/diacritic heuristics
    latin_count = len(_LATIN_RE.findall(text))
    if latin_count > 0:
        lowered = text.casefold()
        best_language = "English"
        best_score = 0
        second_best = 0
        for language, pattern, diacritics in _LANGUAGE_HINTS:
            stopword_hits = len(pattern.findall(lowered))
            diacritic_hits = sum(lowered.count(char) for char in diacritics)
            score = stopword_hits + diacritic_hits * 2
            if score > best_score:
                second_best = best_score
                best_score = score
                best_language = language
            elif score > second_best:
                second_best = score

        if best_score >= 2 and best_score > second_best:
            return best_language

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
        "French": "Tout le texte de sortie doit être en français",
        "German": "Alle Ausgaben müssen auf Deutsch sein",
        "Spanish": "Todo el texto de salida debe estar en español",
        "Portuguese": "Todo o texto de saída deve estar em português",
        "Italian": "Tutto il testo in uscita deve essere in italiano",
    }
    return directives.get(language, f"All output text MUST be in {language}")


def get_anonymous_director_name(language: str | None = None) -> str:
    """Return a localized anonymous label for director-facing surfaces."""
    return "匿名导演" if language == "Chinese" else "Anonymous Director"


def get_anonymous_predictor_name(language: str | None = None) -> str:
    """Return a localized anonymous label for prediction-facing surfaces."""
    return "匿名预言家" if language == "Chinese" else "Anonymous Predictor"
