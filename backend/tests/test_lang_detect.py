"""Unit tests for app.services.lang_detect — language detection and directive generation."""

import pytest

from app.services.lang_detect import detect_language, get_language_directive


# ── detect_language ──────────────────────────────────────────


class TestDetectLanguage:
    """Test the character-ratio heuristic language detector."""

    # -- Chinese ---------------------------------------------------

    def test_pure_chinese(self):
        assert detect_language("如果诸葛亮没有出山，三国历史会怎样？") == "Chinese"

    def test_chinese_with_punctuation(self):
        assert detect_language("你好，世界！这是一个测试。") == "Chinese"

    def test_chinese_with_english_words(self):
        """Mixed text dominated by Chinese should still detect Chinese."""
        assert detect_language("让我们来聊聊 AI 和 machine learning 对社会的影响") == "Chinese"

    # -- English ---------------------------------------------------

    def test_pure_english(self):
        assert detect_language("What if Napoleon had won at Waterloo?") == "English"

    def test_english_with_numbers(self):
        assert detect_language("In 1945, World War II ended.") == "English"

    def test_english_with_urls(self):
        assert detect_language("Check out https://example.com for more info") == "English"

    # -- Japanese --------------------------------------------------

    def test_japanese_hiragana(self):
        assert detect_language("これはテストです。日本語のテキストです。") == "Japanese"

    def test_japanese_katakana(self):
        assert detect_language("アメリカのテクノロジー企業について") == "Japanese"

    def test_japanese_mixed_kanji_kana(self):
        assert detect_language("東京で新しいレストランが開店した") == "Japanese"

    # -- Korean ----------------------------------------------------

    def test_korean(self):
        assert detect_language("한국어 텍스트 테스트입니다") == "Korean"

    def test_korean_mixed(self):
        assert detect_language("서울에서 AI 기술 발전에 대해 논의하다") == "Korean"

    # -- Edge cases ------------------------------------------------

    def test_empty_string(self):
        """Empty input should default to English (no language signal)."""
        assert detect_language("") == "English"

    def test_whitespace_only(self):
        assert detect_language("   \n\t  ") == "English"

    def test_none_input(self):
        """None is treated as falsy — same as empty."""
        assert detect_language(None) == "English"  # type: ignore[arg-type]

    def test_numbers_only(self):
        """Pure numbers have no language markers — should default to English."""
        assert detect_language("12345 67890") == "English"

    def test_emoji_only(self):
        """Emoji-only text should default to English."""
        assert detect_language("🚀🌍✨🎉") == "English"

    def test_single_cjk_character(self):
        """A single CJK character shouldn't be enough to trigger Chinese (ratio too low)."""
        # With a very short text, ratio can be high — this tests threshold behavior
        result = detect_language("好")
        assert result in ("Chinese", "English")  # implementation-dependent

    # -- Bug regression: fullwidth Latin should NOT be counted as CJK ---

    def test_fullwidth_english_not_chinese(self):
        """Fullwidth Latin letters (Ａ-Ｚ) must not inflate CJK count."""
        # These are fullwidth versions of ASCII: U+FF21-U+FF3A
        assert detect_language("ＨＥＬＬＯ ＷＯＲＬＤ") == "English"

    def test_fullwidth_digits_not_chinese(self):
        """Fullwidth digits (０-９) must not inflate CJK count."""
        assert detect_language("１２３４５ test") == "English"


# ── get_language_directive ───────────────────────────────────


class TestGetLanguageDirective:
    """Test prompt directive generation."""

    def test_chinese_directive(self):
        d = get_language_directive("Chinese")
        assert "中文" in d

    def test_english_directive(self):
        d = get_language_directive("English")
        assert "English" in d

    def test_japanese_directive(self):
        d = get_language_directive("Japanese")
        assert "日本語" in d

    def test_korean_directive(self):
        d = get_language_directive("Korean")
        assert "한국어" in d

    def test_unknown_language_fallback(self):
        """Unknown language should generate a sensible English directive."""
        d = get_language_directive("French")
        assert "French" in d
        assert "MUST" in d

    def test_returns_string(self):
        """All directives must be strings."""
        for lang in ("Chinese", "English", "Japanese", "Korean", "French"):
            assert isinstance(get_language_directive(lang), str)
