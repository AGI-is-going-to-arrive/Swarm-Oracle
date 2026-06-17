"""Regression tests for security audit fixes."""

import importlib
from contextlib import contextmanager
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlmodel import Session

from app.api.debate import DEBATE_START_DELAY_SECONDS
from app.api.helpers import _OpaqueStr
from app.api.predictions import PredictRequest
from app.api.scenarios import CreateReplayArtifactRequest
from app.api.schemas import (
    CreateScenarioRequest,
    InterveneRequest,
    RetrospectiveInterveneRequest,
)
from app.api.ws import WSManager, run_websocket_session
from app.models import Scenario, ScenarioStatus
from app.models.database import get_engine
from app.services.ending_room_service import _detect_language
from app.services.simulator import _get_fork_prompt_template, _record_fork_debug_trace


def _seed_scenario(question: str = "audit fix regression") -> str:
    engine = get_engine()
    with Session(engine) as session:
        scenario = Scenario(question=question, status=ScenarioStatus.SIMULATING)
        session.add(scenario)
        session.commit()
        return scenario.id


def _wrap_optional_secret(value: str | None):
    return _OpaqueStr(value) if value else None


@contextmanager
def _reloaded_main_module(monkeypatch, *, expose_api_docs: str = "false", log_level: str = "INFO"):
    import app.config as config_module
    import app.main as main_module

    # Preserve identity of the original `settings` instance so that any test
    # module that did ``from app.config import settings`` at import time
    # continues to share the same object the rest of the app references after
    # this contextmanager exits.
    original_settings = config_module.settings

    monkeypatch.setenv("LOG_LEVEL", log_level)
    monkeypatch.setenv("EXPOSE_API_DOCS", expose_api_docs)
    importlib.reload(config_module)
    reloaded_main = importlib.reload(main_module)
    try:
        yield reloaded_main
    finally:
        monkeypatch.delenv("EXPOSE_API_DOCS", raising=False)
        monkeypatch.delenv("LOG_LEVEL", raising=False)
        # Restore the original Settings instance identity so attributes set
        # via ``monkeypatch.setattr(settings, ...)`` in unrelated test modules
        # continue to take effect against the same instance the API endpoints
        # read from. Reloading config_module again would create yet another
        # fresh instance and silently desynchronize callers that captured the
        # original via ``from app.config import settings``.
        config_module.settings = original_settings
        importlib.reload(main_module)
        # Re-bind settings in all modules that cache it via
        # ``from app.config import settings`` at import time.
        import app.api.agents as _agt
        import app.api.debate as _api_deb
        import app.api.graphs as _grf
        import app.api.helpers as _hlp
        import app.api.scenarios as _scn
        import app.api.schemas as _sch
        import app.api.ws as _api_ws
        import app.models.database as _db
        import app.services.debate as _deb
        import app.services.debate_argument_map as _deb_arg
        import app.services.ending_room_service as _ers
        import app.services.ending_room_service._content as _ers_c
        import app.services.ending_room_service._threads as _ers_t
        import app.services.llm_client as _llm
        import app.services.memory as _mem
        import app.services.runtime_lock as _rl
        import app.services.simulator as _sim
        import app.services.vector_store as _vec
        for _mod in (
            _agt, _api_deb, _grf, _api_ws,
            _llm, _sim, _deb, _mem, _vec, _rl,
            _deb_arg,
            _ers, _ers_c, _ers_t,
            _db, _scn, _sch, _hlp,
        ):
            _mod.settings = original_settings


async def _always_exists(_scenario_id: str) -> bool:
    return True


@pytest.fixture(autouse=True)
def _use_isolated_test_db(setup_test_db):
    """Reuse conftest's per-test temp DB isolation for DB-writing audit tests.

    This module writes rows via helpers such as _seed_scenario(), but
    backend/tests/conftest.py creates a fresh SQLite database for each test and
    disposes the engine afterward, so a transaction rollback wrapper would be
    redundant here.
    """
    yield


class TestOpaqueStrRegression:
    def test_repr_redacts_secret(self):
        secret = _OpaqueStr("sk-secret")
        assert repr(secret) == "***"

    def test_str_and_f_string_preserve_raw_secret_for_headers(self):
        secret = _OpaqueStr("sk-secret")
        assert str(secret) == "sk-secret"
        assert f"Bearer {secret}" == "Bearer sk-secret"

    def test_dict_value_remains_usable_while_dict_repr_stays_redacted(self):
        secret = _OpaqueStr("sk-secret")
        payload = {"api_key": secret}
        assert payload["api_key"] == "sk-secret"
        assert repr(payload) == "{'api_key': ***}"

    def test_empty_string_and_none_edges(self):
        empty_secret = _OpaqueStr("")
        assert str(empty_secret) == ""
        assert repr(empty_secret) == "***"
        assert f"Bearer {empty_secret}" == "Bearer "
        assert _wrap_optional_secret(None) is None

    def test_json_log_serialization_masks_secret(self):
        """Regression: _OpaqueStr must not leak in structured JSON logs."""
        import json as _json
        import logging as _logging

        from app.logging_utils import JsonLogFormatter

        secret = _OpaqueStr("sk-real-key-12345")
        record = _logging.LogRecord("test", _logging.INFO, __file__, 1, "hello", (), None)
        record.api_key = secret  # type: ignore[attr-defined]
        output = JsonLogFormatter().format(record)
        parsed = _json.loads(output)
        assert "sk-real-key-12345" not in output
        assert parsed["extra"]["api_key"] == "***"


class TestInterveneRequestTextValidation:
    @pytest.mark.parametrize("raw_text", ["", "   \n\t  "])
    def test_rejects_empty_or_whitespace_only_text(self, raw_text):
        with pytest.raises(ValidationError, match="intervention text cannot be empty"):
            InterveneRequest(branch_id="branch-1", text=raw_text)

    def test_rejects_text_longer_than_2000_characters(self):
        with pytest.raises(ValidationError, match="intervention text too long"):
            InterveneRequest(branch_id="branch-1", text="x" * 2001)

    def test_accepts_text_at_2000_character_limit(self):
        request = InterveneRequest(branch_id="branch-1", text="x" * 2000)
        assert request.text == "x" * 2000

    def test_strips_valid_text(self):
        request = InterveneRequest(branch_id="branch-1", text="  keep history intact  ")
        assert request.text == "keep history intact"


class TestRetrospectiveInterveneRequestTextValidation:
    @pytest.mark.parametrize("raw_text", ["", "   \n\t  "])
    def test_rejects_empty_or_whitespace_only_text(self, raw_text):
        with pytest.raises(ValidationError, match="intervention text cannot be empty"):
            RetrospectiveInterveneRequest(branch_id="branch-1", round_number=1, text=raw_text)

    def test_rejects_text_longer_than_2000_characters(self):
        with pytest.raises(ValidationError, match="intervention text too long"):
            RetrospectiveInterveneRequest(branch_id="branch-1", round_number=1, text="x" * 2001)

    def test_accepts_text_at_2000_character_limit(self):
        request = RetrospectiveInterveneRequest(
            branch_id="branch-1", round_number=1, text="x" * 2000
        )
        assert request.text == "x" * 2000

    def test_strips_valid_text(self):
        request = RetrospectiveInterveneRequest(
            branch_id="branch-1",
            round_number=1,
            text="  replay from here  ",
        )
        assert request.text == "replay from here"


class TestCreateScenarioRequestUserIdValidation:
    def test_rejects_user_id_longer_than_128_characters(self):
        with pytest.raises(ValidationError, match="user_id must be at most 128 characters"):
            CreateScenarioRequest(question="What changed?", user_id="u" * 129)

    def test_accepts_user_id_at_128_character_limit(self):
        request = CreateScenarioRequest(question="What changed?", user_id="u" * 128)
        assert request.user_id == "u" * 128

    def test_accepts_none_user_id(self):
        request = CreateScenarioRequest(question="What changed?", user_id=None)
        assert request.user_id is None


class TestPredictRequestIdentityValidation:
    @pytest.mark.parametrize("field_name", ["user_id", "user_name"])
    def test_rejects_identity_fields_longer_than_128_characters(self, field_name):
        with pytest.raises(ValidationError, match="user_id and user_name must be at most 128 characters"):  # noqa: E501
            PredictRequest(prediction_text="Outcome", **{field_name: "u" * 129})

    @pytest.mark.parametrize("field_name", ["user_id", "user_name"])
    def test_accepts_identity_fields_at_128_character_limit(self, field_name):
        request = PredictRequest(prediction_text="Outcome", **{field_name: "u" * 128})
        assert getattr(request, field_name) == "u" * 128


class TestCreateReplayArtifactRequestValidation:
    def test_rejects_empty_kind(self):
        with pytest.raises(ValidationError, match="kind cannot be empty"):
            CreateReplayArtifactRequest(kind="   ", payload={})

    def test_rejects_kind_longer_than_64_characters(self):
        with pytest.raises(ValidationError, match="kind too long"):
            CreateReplayArtifactRequest(kind="k" * 65, payload={})

    def test_accepts_and_strips_valid_kind(self):
        request = CreateReplayArtifactRequest(kind="  scenario_result_v1  ", payload={})
        assert request.kind == "scenario_result_v1"


class TestForkDebugTraceRetention:
    def test_keeps_only_latest_200_entries(self):
        engine = get_engine()
        scenario_id = _seed_scenario()

        for round_number in range(205):
            _record_fork_debug_trace(
                engine,
                scenario_id,
                {
                    "round": round_number,
                    "decision": f"decision-{round_number}",
                },
            )

        with Session(engine) as session:
            scenario = session.get(Scenario, scenario_id)
            assert scenario is not None
            trace = (scenario.parsed_context or {}).get("fork_debug_trace") or []

        assert len(trace) == 200
        assert trace[0]["round"] == 5
        assert trace[-1]["round"] == 204


class TestOpenAPIDocsVisibility:
    def test_docs_hidden_by_default(self, monkeypatch):
        with _reloaded_main_module(monkeypatch, expose_api_docs="false") as main_module:
            with TestClient(main_module.app) as client:
                assert client.get("/docs").status_code == 404
                assert client.get("/redoc").status_code == 404
                assert client.get("/openapi.json").status_code == 404

    def test_docs_available_when_explicitly_enabled(self, monkeypatch):
        with _reloaded_main_module(monkeypatch, expose_api_docs="true") as main_module:
            with TestClient(main_module.app) as client:
                assert client.get("/docs").status_code == 200
                assert client.get("/redoc").status_code == 200
                response = client.get("/openapi.json")
        assert response.status_code == 200
        assert response.json()["info"]["title"] == "SwarmOracle"

    def test_debug_log_level_does_not_expose_docs(self, monkeypatch):
        """Regression: LOG_LEVEL=DEBUG must NOT auto-expose API docs."""
        with _reloaded_main_module(monkeypatch, expose_api_docs="false", log_level="DEBUG") as main_module:  # noqa: E501
            with TestClient(main_module.app) as client:
                assert client.get("/docs").status_code == 404
                assert client.get("/openapi.json").status_code == 404

    def test_settings_identity_stable_after_contextmanager_exit(self, monkeypatch):
        """Regression: ``_reloaded_main_module`` must preserve the original
        ``settings`` instance identity. Reloading config_module twice would
        leak a fresh Settings instance and silently desynchronize unrelated
        test modules that captured the original via
        ``from app.config import settings`` at import time.
        """
        import app.api.graphs as graphs_module
        import app.config as config_module

        original = config_module.settings
        original_graphs_settings = graphs_module.settings
        with _reloaded_main_module(monkeypatch, expose_api_docs="false"):
            pass
        assert config_module.settings is original
        assert graphs_module.settings is original
        # Sanity: the cross-module identity that endpoint code relies on must
        # also match the binding test modules see.
        assert graphs_module.settings is original_graphs_settings


class TestSqliteWalMode:
    def test_wal_mode_active_on_file_based_db(self):
        """WAL journal mode must be active for file-based SQLite databases."""
        engine = get_engine()
        with engine.connect() as conn:
            result = conn.exec_driver_sql("PRAGMA journal_mode")
            mode = result.scalar()
            assert mode == "wal", f"Expected WAL mode, got {mode}"

    def test_busy_timeout_is_set(self):
        """busy_timeout must be set to 5000ms for file-based SQLite databases."""
        engine = get_engine()
        with engine.connect() as conn:
            result = conn.exec_driver_sql("PRAGMA busy_timeout")
            timeout = result.scalar()
            assert timeout == 5000, f"Expected busy_timeout=5000, got {timeout}"


class TestDebateConstants:
    def test_debate_start_delay_is_one_second(self):
        assert DEBATE_START_DELAY_SECONDS == 1.0


class TestWebSocketMessageSizeLimit:
    @pytest.mark.asyncio
    async def test_allows_utf8_messages_below_64kb(self):
        manager = WSManager()
        websocket = AsyncMock()
        payload = "你" * 21845
        assert len(payload.encode("utf-8")) == 65535
        websocket.receive_text.side_effect = [payload, WebSocketDisconnect()]

        await run_websocket_session(manager, "scenario-1", websocket, exists_check=_always_exists)

        websocket.accept.assert_awaited_once()
        websocket.close.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_closes_with_1009_when_utf8_message_exceeds_64kb(self):
        manager = WSManager()
        websocket = AsyncMock()
        payload = "你" * 21846
        assert len(payload.encode("utf-8")) > 65536
        websocket.receive_text.side_effect = [payload]

        await run_websocket_session(manager, "scenario-1", websocket, exists_check=_always_exists)

        websocket.accept.assert_awaited_once()
        websocket.close.assert_awaited_once_with(code=1009)


class TestForkPromptTemplateConsistency:
    """Golden test: all 12 template variants must render correctly."""

    @pytest.mark.parametrize("variant", ["a", "b", "c", "d", "e", "f"])
    @pytest.mark.parametrize("language", ["Chinese", "English"])
    def test_template_renders_without_error(self, variant, language):
        template = _get_fork_prompt_template(language, variant)
        assert "{recent_summary}" in template
        assert "{diverge_signals}" in template
        assert "{sensitivity}" in template
        assert len(template) > 100

    @pytest.mark.parametrize("variant", ["a", "b", "c", "d", "e", "f"])
    @pytest.mark.parametrize("language", ["Chinese", "English"])
    def test_template_has_language_directive_placeholder(self, variant, language):
        template = _get_fork_prompt_template(language, variant)
        assert "{language_directive}" in template

    @pytest.mark.parametrize("variant", ["a", "b", "c", "d", "e", "f"])
    def test_template_guides_branch_titles_toward_plain_language(self, variant):
        zh_template = _get_fork_prompt_template("Chinese", variant)
        en_template = _get_fork_prompt_template("English", variant)

        assert "通俗语言" in zh_template
        assert "最终世界状态如何回答原问题" in zh_template
        assert "必须一眼回答原问题" in zh_template
        assert "禁止内部术语/黑话" in zh_template
        assert "plain language" in en_template
        assert "final world ending state that answers the original question" in en_template
        assert "MUST answer the original question" in en_template
        assert "Forbid insider terminology and internal jargon" in en_template

    def test_variant_a_examples_use_plain_modern_scenarios(self):
        zh_template = _get_fork_prompt_template("Chinese", "a")
        en_template = _get_fork_prompt_template("English", "a")

        assert "人类每天点名鞠躬，被降为附庸" in zh_template
        assert "地下复辟派起诉猫议会却败诉" in zh_template
        assert "先查源头再发声明" not in zh_template
        assert "巩固粮道再北伐" not in zh_template
        assert "曹操集结二十万大军" not in zh_template

        assert "humans forced into daily bowing roll-call, demoted to vassals" in en_template
        assert "underground restoration faction sues the cat council and loses" in en_template
        assert "Verify Source First" not in en_template
        assert "Secure Supply Lines Before Northern Push" not in en_template
        assert "Cao Cao mobilizes" not in en_template

    def test_unknown_variant_falls_back_to_a(self):
        default_zh = _get_fork_prompt_template("Chinese", "a")
        fallback_zh = _get_fork_prompt_template("Chinese", "z")
        assert default_zh == fallback_zh

        default_en = _get_fork_prompt_template("English", "a")
        fallback_en = _get_fork_prompt_template("English", "z")
        assert default_en == fallback_en


class TestLanguageDetectionConsolidation:
    """Verify _detect_language delegates to lang_detect and maps correctly."""

    def test_chinese_detected_as_zh(self):
        assert _detect_language("这是中文测试", None) == "zh"

    def test_english_detected_as_en(self):
        assert _detect_language("This is English", None) == "en"

    def test_japanese_not_misclassified_as_zh(self):
        """Regression: Japanese was previously misclassified as Chinese."""
        assert _detect_language("これは日本語です", None) == "en"  # Falls to non-zh

    def test_korean_not_misclassified_as_zh(self):
        """Regression: Korean was previously misclassified as Chinese."""
        assert _detect_language("이것은 한국어입니다", None) == "en"  # Falls to non-zh

    def test_explicit_zh_request_overrides_detection(self):
        assert _detect_language("This is English", "zh") == "zh"

    def test_explicit_en_request_overrides_detection(self):
        assert _detect_language("这是中文", "en") == "en"
