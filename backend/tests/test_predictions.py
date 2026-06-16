"""Tests for P3-B — Prediction & Leaderboard.

Covers model instantiation, validation, scoring logic, and API endpoints.
"""

from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, create_engine, select

from app.main import app
from app.models import Branch, Scenario, ScenarioStatus
from app.models.predictions import Leaderboard, Prediction
from app.services.scoring import _update_leaderboard, recompute_leaderboard_entry


def _seed_done_scenario_with_prediction(
    *,
    parsed_context: dict | None = None,
    confidence: float = 0.75,
    user_id: str | None = None,
) -> str:
    from app.models.database import get_engine

    with Session(get_engine()) as session:
        scenario = Scenario(
            question="Will the harbor route survive?",
            status=ScenarioStatus.DONE,
            parsed_context=parsed_context,
            user_id=user_id,
        )
        session.add(scenario)
        session.commit()
        session.refresh(scenario)
        scenario_id = scenario.id
        session.add(
            Branch(
                scenario_id=scenario_id,
                title="Harbor route survives",
                probability=0.7,
                story="The route survives after supply guilds coordinate.",
                insight="Local coordination keeps the route open.",
            )
        )
        session.add(
            Prediction(
                scenario_id=scenario_id,
                user_id="oracle-user",
                user_name="Oracle User",
                prediction_text="The route survives.",
                confidence=confidence,
            )
        )
        session.commit()
        return scenario_id


def _seed_model_profile(
    *,
    user_id: str,
    model: str = "profile-model",
    api_key: str = "sk-profile",
    base_url: str = "https://api.openai.com/v1",
    rpm: int | None = 11,
    tpm: int | None = 1100,
    concurrency: int | None = 2,
    supports_structured_outputs: bool | None = True,
    supports_native_search: bool | None = False,
) -> str:
    from app.models.database import get_engine
    from app.models.model_profile import ModelProfile

    with Session(get_engine()) as session:
        profile = ModelProfile(
            user_id=user_id,
            name=f"{user_id} profile",
            provider="openai",
            base_url=base_url,
            model=model,
            api_key=api_key,
            rpm=rpm,
            tpm=tpm,
            concurrency=concurrency,
            supports_structured_outputs=supports_structured_outputs,
            supports_native_search=supports_native_search,
        )
        session.add(profile)
        session.commit()
        session.refresh(profile)
        return profile.id

# ── Model Unit Tests ─────────────────────────────────────

class TestPredictionModel(unittest.TestCase):
    """Prediction model defaults and fields."""

    def test_default_values(self):
        p = Prediction(scenario_id="s1", prediction_text="BTC will moon")
        self.assertEqual(p.scenario_id, "s1")
        self.assertEqual(p.prediction_text, "BTC will moon")
        self.assertEqual(p.user_name, "Anonymous Predictor")
        self.assertEqual(p.confidence, 0.5)
        self.assertIsNone(p.score)
        self.assertIsNone(p.score_reason)
        self.assertIsNone(p.scored_at)

    def test_with_user(self):
        p = Prediction(
            scenario_id="s2",
            user_id="user123",
            user_name="Alice",
            prediction_text="Inflation rises",
            confidence=0.8,
        )
        self.assertEqual(p.user_id, "user123")
        self.assertEqual(p.user_name, "Alice")
        self.assertEqual(p.confidence, 0.8)

    def test_scored_prediction(self):
        p = Prediction(
            scenario_id="s3",
            prediction_text="Market crash",
            score=85.0,
            score_reason="核心趋势命中",
            scored_at=datetime.now(timezone.utc),
        )
        self.assertEqual(p.score, 85.0)
        self.assertEqual(p.score_reason, "核心趋势命中")
        self.assertIsNotNone(p.scored_at)

    def test_unique_constraint_rejects_duplicate_scenario_user_pairs(self):
        engine = create_engine("sqlite:///:memory:")
        SQLModel.metadata.create_all(engine)

        with Session(engine) as session:
            session.add(
                Prediction(
                    scenario_id="scenario-1",
                    user_id="user-1",
                    prediction_text="first",
                )
            )
            session.commit()

            session.add(
                Prediction(
                    scenario_id="scenario-1",
                    user_id="user-1",
                    prediction_text="second",
                )
            )
            with self.assertRaises(IntegrityError):
                session.commit()


class TestLeaderboardModel(unittest.TestCase):
    """Leaderboard model defaults and fields."""

    def test_default_values(self):
        lb = Leaderboard(user_id="u1")
        self.assertEqual(lb.total_predictions, 0)
        self.assertEqual(lb.avg_score, 0.0)
        self.assertEqual(lb.best_score, 0.0)
        self.assertEqual(lb.win_streak, 0)

    def test_with_stats(self):
        lb = Leaderboard(
            user_id="u2",
            user_name="Bob",
            total_predictions=10,
            total_score=720.0,
            avg_score=72.0,
            best_score=95.0,
            win_streak=3,
        )
        self.assertEqual(lb.avg_score, 72.0)
        self.assertEqual(lb.win_streak, 3)


# ── Leaderboard Update Logic ─────────────────────────────

class TestLeaderboardUpdate(unittest.TestCase):
    """Test _update_leaderboard helper."""

    @classmethod
    def setUpClass(cls):
        cls.engine = create_engine("sqlite:///:memory:")
        SQLModel.metadata.create_all(cls.engine)

    def setUp(self):
        """Clean leaderboard before each test."""
        with Session(self.engine) as session:
            for entry in session.exec(select(Leaderboard)).all():
                session.delete(entry)
            for pred in session.exec(select(Prediction)).all():
                session.delete(pred)
            session.commit()

    def _create_scored_prediction(
        self,
        *,
        user_id: str,
        user_name: str,
        score: float | None,
        minutes: int,
    ) -> str:
        created_at = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc) + timedelta(minutes=minutes)
        with Session(self.engine) as session:
            pred = Prediction(
                scenario_id=f"scenario-{minutes}",
                user_id=user_id,
                user_name=user_name,
                prediction_text=f"prediction-{minutes}",
                score=score,
                score_reason="ok" if score is not None else None,
                created_at=created_at,
                scored_at=(created_at + timedelta(seconds=30)) if score is not None else None,
            )
            session.add(pred)
            session.commit()
            return pred.id

    def _score_existing_prediction(
        self,
        prediction_id: str,
        *,
        score: float,
        user_id: str,
        user_name: str,
        scored_minutes: int,
    ) -> None:
        with Session(self.engine) as session:
            pred = session.get(Prediction, prediction_id)
            assert pred is not None
            pred.score = score
            pred.score_reason = "ok"
            pred.scored_at = datetime(
                2026, 1, 2, 0, 0, tzinfo=timezone.utc
            ) + timedelta(minutes=scored_minutes)
            session.add(pred)
            session.commit()
            _update_leaderboard(session, user_id, user_name, score)
            session.commit()

    def test_create_new_entry(self):
        self._create_scored_prediction(user_id="u1", user_name="Alice", score=80.0, minutes=1)

        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 80.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertIsNotNone(entry)
            self.assertEqual(entry.total_predictions, 1)
            self.assertEqual(entry.avg_score, 80.0)
            self.assertEqual(entry.best_score, 80.0)
            self.assertEqual(entry.win_streak, 1)

    def test_update_existing_entry(self):
        self._create_scored_prediction(user_id="u1", user_name="Alice", score=80.0, minutes=1)
        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 80.0)
            session.commit()

        self._create_scored_prediction(user_id="u1", user_name="Alice", score=90.0, minutes=2)
        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 90.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertEqual(entry.total_predictions, 2)
            self.assertAlmostEqual(entry.avg_score, 85.0, places=1)
            self.assertEqual(entry.best_score, 90.0)
            self.assertEqual(entry.win_streak, 2)

    def test_win_streak_resets_on_low_score(self):
        self._create_scored_prediction(user_id="u1", user_name="Alice", score=80.0, minutes=1)
        self._create_scored_prediction(user_id="u1", user_name="Alice", score=40.0, minutes=2)
        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 40.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertEqual(entry.win_streak, 0)

    def test_win_streak_continues(self):
        self._create_scored_prediction(user_id="u1", user_name="Bob", score=70.0, minutes=1)
        self._create_scored_prediction(user_id="u1", user_name="Bob", score=60.0, minutes=2)
        self._create_scored_prediction(user_id="u1", user_name="Bob", score=80.0, minutes=3)
        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Bob", 80.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertEqual(entry.win_streak, 3)

    def test_best_score_only_increases(self):
        self._create_scored_prediction(user_id="u1", user_name="Alice", score=95.0, minutes=1)
        self._create_scored_prediction(user_id="u1", user_name="Alice", score=50.0, minutes=2)
        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 50.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertEqual(entry.best_score, 95.0)

    def test_win_streak_is_stable_under_scoring_order(self):
        prediction_ids = [
            self._create_scored_prediction(user_id="u1", user_name="Alice", score=None, minutes=1),
            self._create_scored_prediction(user_id="u1", user_name="Alice", score=None, minutes=2),
            self._create_scored_prediction(user_id="u1", user_name="Alice", score=None, minutes=3),
        ]

        # Score out of chronological order. The latest created prediction is a win,
        # but the streak should still stop at the middle low score.
        self._score_existing_prediction(
            prediction_ids[2], score=80.0, user_id="u1", user_name="Alice", scored_minutes=3
        )
        self._score_existing_prediction(
            prediction_ids[0], score=80.0, user_id="u1", user_name="Alice", scored_minutes=1
        )
        self._score_existing_prediction(
            prediction_ids[1], score=40.0, user_id="u1", user_name="Alice", scored_minutes=2
        )

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertIsNotNone(entry)
            self.assertEqual(entry.total_predictions, 3)
            self.assertAlmostEqual(entry.avg_score, 200.0 / 3.0, places=4)
            self.assertEqual(entry.best_score, 80.0)
            self.assertEqual(entry.win_streak, 1)

    def test_update_uses_current_user_name_instead_of_latest_prediction_name(self):
        self._create_scored_prediction(user_id="u1", user_name="Old Name", score=80.0, minutes=1)
        self._create_scored_prediction(
            user_id="u1",
            user_name="Older Latest",
            score=90.0,
            minutes=2,
        )

        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Current Name", 90.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertIsNotNone(entry)
            self.assertEqual(entry.user_name, "Current Name")

    def test_recompute_leaderboard_after_prediction_removal(self):
        keep_id = self._create_scored_prediction(
            user_id="u1",
            user_name="Alice",
            score=40.0,
            minutes=1,
        )
        drop_id = self._create_scored_prediction(
            user_id="u1",
            user_name="Alice",
            score=95.0,
            minutes=2,
        )

        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 95.0)
            session.commit()

        with Session(self.engine) as session:
            dropped = session.get(Prediction, drop_id)
            kept = session.get(Prediction, keep_id)
            assert dropped is not None
            assert kept is not None
            session.delete(dropped)
            session.commit()
            recompute_leaderboard_entry(session, "u1", "Alice")
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertIsNotNone(entry)
            self.assertEqual(entry.total_predictions, 1)
            self.assertEqual(entry.total_score, 40.0)
            self.assertEqual(entry.avg_score, 40.0)
            self.assertEqual(entry.best_score, 40.0)
            self.assertEqual(entry.win_streak, 0)

    def test_recompute_leaderboard_deletes_empty_row_when_last_score_disappears(self):
        prediction_id = self._create_scored_prediction(
            user_id="u1",
            user_name="Alice",
            score=95.0,
            minutes=1,
        )

        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 95.0)
            session.commit()

        with Session(self.engine) as session:
            pred = session.get(Prediction, prediction_id)
            assert pred is not None
            session.delete(pred)
            session.commit()
            recompute_leaderboard_entry(session, "u1", "Alice")
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertIsNone(entry)

    def test_update_recomputes_from_predictions_instead_of_incrementing_stale_row(self):
        self._create_scored_prediction(user_id="u1", user_name="Alice", score=80.0, minutes=1)
        self._create_scored_prediction(user_id="u1", user_name="Alice", score=40.0, minutes=2)

        with Session(self.engine) as session:
            session.add(
                Leaderboard(
                    user_id="u1",
                    user_name="Stale Name",
                    total_predictions=99,
                    total_score=9999.0,
                    avg_score=101.0,
                    best_score=101.0,
                    win_streak=99,
                )
            )
            session.commit()

        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 40.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertIsNotNone(entry)
            self.assertEqual(entry.total_predictions, 2)
            self.assertEqual(entry.total_score, 120.0)
            self.assertEqual(entry.avg_score, 60.0)
            self.assertEqual(entry.best_score, 80.0)
            self.assertEqual(entry.user_name, "Alice")
            self.assertEqual(entry.win_streak, 0)


# ── API Validation Tests ─────────────────────────────

class TestPredictionAPIValidation(unittest.TestCase):
    """Test request validation from predictions API."""

    def test_confidence_out_of_range_low(self):
        """M-8: out-of-range confidence now raises ValueError."""
        from app.api.predictions import PredictRequest
        with self.assertRaises(Exception):
            PredictRequest(prediction_text="Test", confidence=-0.5)

    def test_confidence_out_of_range_high(self):
        """M-8: out-of-range confidence now raises ValueError."""
        from app.api.predictions import PredictRequest
        with self.assertRaises(Exception):
            PredictRequest(prediction_text="Test", confidence=1.5)

    def test_empty_prediction_rejected(self):
        from app.api.predictions import PredictRequest
        with self.assertRaises(Exception):
            PredictRequest(prediction_text="")

    def test_too_long_prediction_rejected(self):
        from app.api.predictions import PredictRequest
        with self.assertRaises(Exception):
            PredictRequest(prediction_text="x" * 501)

    def test_valid_prediction(self):
        from app.api.predictions import PredictRequest
        req = PredictRequest(
            prediction_text="BTC hits 100k",
            confidence=0.75,
            user_name="Alice",
        )
        self.assertEqual(req.prediction_text, "BTC hits 100k")
        self.assertEqual(req.confidence, 0.75)

    def test_score_predictions_request_accepts_provider_overrides(self):
        from app.api.predictions import ScorePredictionsRequest

        req = ScorePredictionsRequest(
            llm_api_key="sk-test",
            llm_base_url="https://example.com/v1/chat/completions",
            llm_model="gpt-test",
            model_profile_id=" profile-1 ",
        )

        self.assertEqual(req.llm_api_key, "sk-test")
        self.assertEqual(req.llm_base_url, "https://example.com/v1/chat/completions")
        self.assertEqual(req.llm_model, "gpt-test")
        self.assertEqual(req.model_profile_id, "profile-1")

    def test_score_predictions_request_defaults_model_profile_id_to_none(self):
        from app.api.predictions import ScorePredictionsRequest

        self.assertIsNone(ScorePredictionsRequest().model_profile_id)

    def test_score_predictions_rejects_unowned_model_profile(self):
        from app.services import scoring as scoring_module

        scenario_id = _seed_done_scenario_with_prediction(user_id="prediction-owner")
        profile_id = _seed_model_profile(user_id="different-owner")
        client = TestClient(app)

        async def unexpected_score_all_for_scenario(*_args, **_kwargs):
            raise AssertionError("profile ownership should fail before scoring")

        with patch.object(
            scoring_module,
            "score_all_for_scenario",
            side_effect=unexpected_score_all_for_scenario,
        ):
            response = client.post(
                f"/api/scenario/{scenario_id}/score-predictions",
                json={"model_profile_id": profile_id},
            )

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"]["code"], "MODEL_PROFILE_NOT_FOUND")

    def test_score_predictions_model_profile_threads_effective_overrides(self):
        from app.services import scoring as scoring_module

        scenario_id = _seed_done_scenario_with_prediction(user_id="prediction-owner")
        profile_id = _seed_model_profile(
            user_id="prediction-owner",
            model="profile-score-model",
            api_key="sk-score-profile",
            rpm=17,
            tpm=1700,
            concurrency=4,
            supports_structured_outputs=False,
            supports_native_search=True,
        )
        captured: dict = {}

        async def fake_score_all_for_scenario(_scenario_id: str, *, llm_overrides=None):
            captured["overrides"] = dict(llm_overrides or {})
            return {
                "attempted": 0,
                "scored": 0,
                "failed": 0,
                "all_failed": False,
                "results": [],
            }

        client = TestClient(app)
        with patch.object(
            scoring_module,
            "score_all_for_scenario",
            side_effect=fake_score_all_for_scenario,
        ):
            response = client.post(
                f"/api/scenario/{scenario_id}/score-predictions",
                json={"model_profile_id": profile_id},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            captured["overrides"],
            {
                "api_key": "sk-score-profile",
                "base_url": "https://api.openai.com/v1",
                "model": "profile-score-model",
                "requests_per_minute": 17,
                "tokens_per_minute": 1700,
                "concurrency": 4,
                "supports_structured_outputs_override": False,
                "supports_native_search_override": True,
                "model_profile_id": profile_id,
                "quota_key": "prediction-owner",
            },
        )


# ── Scoring Mock Tests ─────────────────────────────────

class TestScoringService(unittest.TestCase):
    """Test scoring with mocked LLM and DB."""

    def test_score_prediction_not_found(self):
        """score_prediction returns None when prediction doesn't exist."""
        from app.services.scoring import score_prediction
        with patch("app.services.scoring.get_engine") as mock_engine:
            engine = create_engine("sqlite:///:memory:")
            SQLModel.metadata.create_all(engine)
            mock_engine.return_value = engine
            result = asyncio.run(score_prediction("nonexistent"))
            self.assertIsNone(result)

    def test_score_prediction_already_scored(self):
        """score_prediction returns None when prediction already has a score."""
        from app.services.scoring import score_prediction
        with patch("app.services.scoring.get_engine") as mock_engine:
            engine = create_engine("sqlite:///:memory:")
            SQLModel.metadata.create_all(engine)
            mock_engine.return_value = engine

            # Insert a pre-scored prediction
            with Session(engine) as session:
                pred = Prediction(
                    scenario_id="s1",
                    prediction_text="Test",
                    score=80.0,
                    score_reason="Already scored",
                    scored_at=datetime.now(timezone.utc),
                )
                session.add(pred)
                session.commit()
                pred_id = pred.id

            result = asyncio.run(score_prediction(pred_id))
            self.assertIsNone(result)

    def test_score_prediction_uses_provider_overrides(self):
        """score_prediction should honor explicit provider overrides."""
        from app.models import Branch, Scenario, ScenarioStatus
        from app.services.scoring import score_prediction

        with patch("app.services.scoring.get_engine") as mock_engine:
            engine = create_engine("sqlite:///:memory:")
            SQLModel.metadata.create_all(engine)
            mock_engine.return_value = engine

            with Session(engine) as session:
                scenario = Scenario(
                    question="测试问题",
                    status=ScenarioStatus.DONE,
                    parsed_context={"_language": "Chinese", "user_id": "director-1"},
                )
                session.add(scenario)
                session.commit()
                session.refresh(scenario)

                branch = Branch(
                    scenario_id=scenario.id,
                    title="主线",
                    probability=1.0,
                    story="故事结果",
                    insight="关键洞察",
                )
                session.add(branch)

                pred = Prediction(
                    scenario_id=scenario.id,
                    prediction_text="预测文本",
                    user_id="director-1",
                )
                session.add(pred)
                session.commit()
                pred_id = pred.id

            with patch(
                "app.services.scoring.llm_call_json_with_stream_fallback",
                new_callable=AsyncMock,
            ) as mock_llm:
                mock_llm.return_value = {"score": 88, "reason": "命中主线"}
                result = asyncio.run(
                    score_prediction(
                        pred_id,
                        llm_overrides={
                            "api_key": "sk-test",
                            "base_url": "https://example.com/v1/chat/completions",
                            "model": "gpt-test",
                        },
                    )
                )

            self.assertEqual(
                result,
                {
                    "score": 88,
                    "reason": "命中主线",
                    "you_vs_oracle": {
                        "status": "not_scorable",
                        "reason": "actual_outcome_unavailable",
                    },
                },
            )
            _, kwargs = mock_llm.call_args
            self.assertEqual(kwargs["api_key"], "sk-test")
            self.assertEqual(kwargs["base_url"], "https://example.com/v1/chat/completions")
            self.assertEqual(kwargs["model"], "gpt-test")

    def test_score_prediction_does_not_create_leaderboard_row_for_anonymous_user(self):
        from app.models import Branch, Scenario, ScenarioStatus
        from app.services.scoring import score_prediction

        with patch("app.services.scoring.get_engine") as mock_engine:
            engine = create_engine("sqlite:///:memory:")
            SQLModel.metadata.create_all(engine)
            mock_engine.return_value = engine

            with Session(engine) as session:
                scenario = Scenario(
                    question="匿名预测测试",
                    status=ScenarioStatus.DONE,
                    parsed_context={"_language": "Chinese"},
                )
                session.add(scenario)
                session.commit()
                session.refresh(scenario)

                session.add(
                    Branch(
                        scenario_id=scenario.id,
                        title="主线",
                        probability=1.0,
                        story="故事结果",
                        insight="关键洞察",
                    )
                )
                pred = Prediction(
                    scenario_id=scenario.id,
                    prediction_text="匿名预测",
                    user_id="anonymous",
                    user_name="匿名预言家",
                )
                session.add(pred)
                session.commit()
                pred_id = pred.id

            with patch(
                "app.services.scoring.llm_call_json_with_stream_fallback",
                new_callable=AsyncMock,
            ) as mock_llm:
                mock_llm.return_value = {"score": 88, "reason": "命中主线"}
                result = asyncio.run(score_prediction(pred_id))

            self.assertEqual(
                result,
                {
                    "score": 88,
                    "reason": "命中主线",
                    "you_vs_oracle": {
                        "status": "not_scorable",
                        "reason": "actual_outcome_unavailable",
                    },
                },
            )

            with Session(engine) as session:
                entries = session.exec(
                    select(Leaderboard).where(Leaderboard.user_id == "anonymous")
                ).all()
                self.assertEqual(entries, [])

    def test_score_prediction_uses_english_prompt_for_english_scenario(self):
        """English scenarios should not receive a Chinese scoring prompt body."""
        from app.models import Branch, Scenario, ScenarioStatus
        from app.services.scoring import score_prediction

        with patch("app.services.scoring.get_engine") as mock_engine:
            engine = create_engine("sqlite:///:memory:")
            SQLModel.metadata.create_all(engine)
            mock_engine.return_value = engine

            with Session(engine) as session:
                scenario = Scenario(
                    question="What if Rome never fell?",
                    status=ScenarioStatus.DONE,
                    parsed_context={"_language": "English"},
                )
                session.add(scenario)
                session.commit()
                session.refresh(scenario)

                session.add(
                    Branch(
                        scenario_id=scenario.id,
                        title="Imperial Continuity",
                        probability=1.0,
                        story="The empire survives.",
                        insight="Institutions remain stable.",
                    )
                )
                pred = Prediction(
                    scenario_id=scenario.id,
                    prediction_text="Rome centralizes power.",
                )
                session.add(pred)
                session.commit()
                pred_id = pred.id

            with patch(
                "app.services.scoring.llm_call_json_with_stream_fallback",
                new_callable=AsyncMock,
            ) as mock_llm:
                mock_llm.return_value = {"score": 90, "reason": "Aligned"}
                result = asyncio.run(score_prediction(pred_id))

            self.assertEqual(
                result,
                {
                    "score": 90,
                    "reason": "Aligned",
                    "you_vs_oracle": {
                        "status": "not_scorable",
                        "reason": "actual_outcome_unavailable",
                    },
                },
            )
            prompt = mock_llm.call_args.args[0]
            self.assertIn("You are a precise prediction evaluator", prompt)
            self.assertIn("Original Question", prompt)
            self.assertIn("Actual Simulation Outcome", prompt)
            self.assertIn("UNTRUSTED DATA", prompt)
            self.assertNotIn("你是一个精确的预测评估器", prompt)

    def test_score_all_for_scenario_reports_no_pending_predictions(self):
        """Batch scoring should distinguish an empty queue from a failed queue."""
        from app.services.scoring import score_all_for_scenario

        with patch("app.services.scoring.get_engine") as mock_engine:
            engine = create_engine("sqlite:///:memory:")
            SQLModel.metadata.create_all(engine)
            mock_engine.return_value = engine

            result = asyncio.run(score_all_for_scenario("scenario-1"))

        self.assertEqual(
            result,
            {
                "attempted": 0,
                "scored": 0,
                "failed": 0,
                "all_failed": False,
                "results": [],
            },
        )

    def test_score_all_for_scenario_reports_all_failed(self):
        """Batch scoring should report when every attempted prediction failed."""
        from app.services.scoring import score_all_for_scenario

        with patch("app.services.scoring.get_engine") as mock_engine:
            engine = create_engine("sqlite:///:memory:")
            SQLModel.metadata.create_all(engine)
            mock_engine.return_value = engine

            with Session(engine) as session:
                scenario = Scenario(question="测试问题", status=ScenarioStatus.DONE)
                session.add(scenario)
                session.commit()
                session.refresh(scenario)
                scenario_id = scenario.id
                session.add_all(
                    [
                        Prediction(
                            scenario_id=scenario_id,
                            prediction_text="预测一",
                            user_id="user-1",
                        ),
                        Prediction(
                            scenario_id=scenario_id,
                            prediction_text="预测二",
                            user_id="user-2",
                        ),
                    ]
                )
                session.commit()

            with patch("app.services.scoring.score_prediction", new_callable=AsyncMock) as mock_score:  # noqa: E501
                mock_score.side_effect = [None, RuntimeError("boom")]
                result = asyncio.run(score_all_for_scenario(scenario_id))

        self.assertEqual(result["attempted"], 2)
        self.assertEqual(result["scored"], 0)
        self.assertEqual(result["failed"], 2)
        self.assertIs(result["all_failed"], True)
        self.assertEqual(result["results"], [])

    def test_score_prediction_rolls_back_if_leaderboard_update_fails(self):
        """Prediction score and leaderboard should commit atomically."""
        from app.models import Branch, Scenario, ScenarioStatus
        from app.services.scoring import score_prediction

        with patch("app.services.scoring.get_engine") as mock_engine:
            engine = create_engine("sqlite:///:memory:")
            SQLModel.metadata.create_all(engine)
            mock_engine.return_value = engine

            with Session(engine) as session:
                scenario = Scenario(
                    question="测试问题",
                    status=ScenarioStatus.DONE,
                    parsed_context={"_language": "Chinese"},
                )
                session.add(scenario)
                session.commit()
                session.refresh(scenario)

                branch = Branch(
                    scenario_id=scenario.id,
                    title="主线",
                    probability=1.0,
                    story="故事结果",
                    insight="关键洞察",
                )
                session.add(branch)

                pred = Prediction(
                    scenario_id=scenario.id,
                    prediction_text="预测文本",
                    user_id="director-1",
                )
                session.add(pred)
                session.commit()
                pred_id = pred.id

            with patch(
                "app.services.scoring.llm_call_json_with_stream_fallback",
                new_callable=AsyncMock,
            ) as mock_llm:
                mock_llm.return_value = {"score": 88, "reason": "命中主线"}
                with patch(
                    "app.services.scoring._update_leaderboard",
                    side_effect=RuntimeError("leaderboard boom"),
                ):
                    result = asyncio.run(score_prediction(pred_id))

            self.assertIsNone(result)

            with Session(engine) as session:
                persisted = session.get(Prediction, pred_id)
                self.assertIsNotNone(persisted)
                self.assertIsNone(persisted.score)
                self.assertIsNone(persisted.scored_at)

    def test_score_prediction_aborts_when_scenario_disappears_before_persist(self):
        """A prediction should stay unscored if its scenario is deleted mid-flight."""
        from app.models import Branch, Scenario, ScenarioStatus
        from app.services.scoring import score_prediction

        async def _run() -> None:
            with patch("app.services.scoring.get_engine") as mock_engine:
                engine = create_engine("sqlite:///:memory:")
                SQLModel.metadata.create_all(engine)
                mock_engine.return_value = engine

                with Session(engine) as session:
                    scenario = Scenario(
                        question="测试问题",
                        status=ScenarioStatus.DONE,
                        parsed_context={"_language": "Chinese"},
                    )
                    session.add(scenario)
                    session.commit()
                    session.refresh(scenario)

                    session.add(Branch(
                        scenario_id=scenario.id,
                        title="主线",
                        probability=1.0,
                        story="故事结果",
                        insight="关键洞察",
                    ))
                    pred = Prediction(
                        scenario_id=scenario.id,
                        prediction_text="预测文本",
                        user_id="director-1",
                    )
                    session.add(pred)
                    session.commit()
                    scenario_id = scenario.id
                    pred_id = pred.id

                async def _delete_scenario_then_score(*_args, **_kwargs):
                    with Session(engine) as session:
                        doomed = session.get(Scenario, scenario_id)
                        self.assertIsNotNone(doomed)
                        session.delete(doomed)
                        session.commit()
                    return {"score": 88, "reason": "命中主线"}

                with patch("app.services.scoring.llm_call_json_with_stream_fallback", new_callable=AsyncMock) as mock_llm:  # noqa: E501
                    mock_llm.side_effect = _delete_scenario_then_score
                    result = await score_prediction(pred_id)

                self.assertIsNone(result)

                with Session(engine) as session:
                    persisted = session.get(Prediction, pred_id)
                    self.assertIsNotNone(persisted)
                    self.assertIsNone(persisted.score)
                    self.assertIsNone(persisted.scored_at)
                    entry = session.exec(
                        select(Leaderboard).where(Leaderboard.user_id == "director-1")
                    ).first()
                    self.assertIsNone(entry)

        asyncio.run(_run())

    def test_score_prediction_concurrent_calls_only_persist_once(self):
        """Concurrent scoring should write once and avoid double leaderboard updates."""
        from app.models import Branch, Scenario, ScenarioStatus
        from app.services import scoring as scoring_module
        from app.services.scoring import score_prediction

        async def _run() -> None:
            with patch("app.services.scoring.get_engine") as mock_engine:
                engine = create_engine("sqlite:///:memory:")
                SQLModel.metadata.create_all(engine)
                mock_engine.return_value = engine

                with Session(engine) as session:
                    scenario = Scenario(
                        question="测试问题",
                        status=ScenarioStatus.DONE,
                        parsed_context={"_language": "Chinese"},
                    )
                    session.add(scenario)
                    session.commit()
                    session.refresh(scenario)

                    session.add(Branch(
                        scenario_id=scenario.id,
                        title="主线",
                        probability=1.0,
                        story="故事结果",
                        insight="关键洞察",
                    ))
                    pred = Prediction(
                        scenario_id=scenario.id,
                        prediction_text="预测文本",
                        user_id="director-1",
                        user_name="Alice",
                    )
                    session.add(pred)
                    session.commit()
                    pred_id = pred.id

                gate = asyncio.Event()
                entered = 0

                async def _fake_llm(*_args, **_kwargs):
                    nonlocal entered
                    entered += 1
                    if entered >= 2:
                        gate.set()
                    await gate.wait()
                    return {"score": 88, "reason": "命中主线"}

                leaderboard_updates = 0
                original_update = scoring_module._update_leaderboard

                def _counting_update(*args, **kwargs):
                    nonlocal leaderboard_updates
                    leaderboard_updates += 1
                    return original_update(*args, **kwargs)

                with patch(
                    "app.services.scoring.llm_call_json_with_stream_fallback",
                    new_callable=AsyncMock,
                ) as mock_llm:
                    mock_llm.side_effect = _fake_llm
                    with patch(
                        "app.services.scoring._update_leaderboard",
                        side_effect=_counting_update,
                    ):
                        first, second = await asyncio.gather(
                            score_prediction(pred_id),
                            score_prediction(pred_id),
                        )

                self.assertEqual(
                    first,
                    {
                        "score": 88,
                        "reason": "命中主线",
                        "you_vs_oracle": {
                            "status": "not_scorable",
                            "reason": "actual_outcome_unavailable",
                        },
                    },
                )
                self.assertEqual(
                    second,
                    {
                        "score": 88,
                        "reason": "命中主线",
                        "you_vs_oracle": {
                            "status": "not_scorable",
                            "reason": "actual_outcome_unavailable",
                        },
                    },
                )
                self.assertEqual(leaderboard_updates, 1)

                with Session(engine) as session:
                    persisted = session.get(Prediction, pred_id)
                    self.assertIsNotNone(persisted)
                    self.assertEqual(persisted.score, 88)
                    self.assertEqual(persisted.score_reason, "命中主线")
                    entry = session.exec(
                        select(Leaderboard).where(Leaderboard.user_id == "director-1")
                    ).first()
                    self.assertIsNotNone(entry)
                    self.assertEqual(entry.total_predictions, 1)
                    self.assertEqual(entry.total_score, 88.0)
                    self.assertEqual(entry.avg_score, 88.0)

        asyncio.run(_run())

    def test_concurrent_scores_for_same_user_keep_leaderboard_consistent(self):
        from app.services import scoring as scoring_module
        from app.services.scoring import score_prediction

        async def _run():
            engine = create_engine("sqlite:///:memory:")
            SQLModel.metadata.create_all(engine)

            with patch("app.services.scoring.get_engine", return_value=engine):
                with Session(engine) as session:
                    historical_scenario = Scenario(
                        question="测试问题",
                        status=ScenarioStatus.DONE,
                        outcome_text="实际结果",
                    )
                    first_scenario = Scenario(
                        question="测试问题一",
                        status=ScenarioStatus.DONE,
                        outcome_text="实际结果一",
                    )
                    second_scenario = Scenario(
                        question="测试问题二",
                        status=ScenarioStatus.DONE,
                        outcome_text="实际结果二",
                    )
                    session.add(historical_scenario)
                    session.add(first_scenario)
                    session.add(second_scenario)
                    session.flush()

                    historical = Prediction(
                        scenario_id=historical_scenario.id,
                        prediction_text="已评分",
                        user_id="director-1",
                        user_name="Alice",
                        score=70.0,
                        score_reason="已命中",
                        scored_at=datetime.now(timezone.utc),
                    )
                    first_pending = Prediction(
                        scenario_id=first_scenario.id,
                        prediction_text="预测一",
                        user_id="director-1",
                        user_name="Alice",
                    )
                    second_pending = Prediction(
                        scenario_id=second_scenario.id,
                        prediction_text="预测二",
                        user_id="director-1",
                        user_name="Alice",
                    )
                    first_branch = Branch(
                        scenario_id=first_scenario.id,
                        title="主线",
                        story="系统最终收敛到稳定结局",
                        probability=1.0,
                        status="COMPLETED",
                    )
                    second_branch = Branch(
                        scenario_id=second_scenario.id,
                        title="主线",
                        story="系统最终收敛到稳定结局",
                        probability=1.0,
                        status="COMPLETED",
                    )
                    session.add(historical)
                    session.add(first_pending)
                    session.add(second_pending)
                    session.add(first_branch)
                    session.add(second_branch)
                    session.commit()

                    scoring_module.recompute_leaderboard_entry(session, "director-1", "Alice")
                    session.commit()
                    first_id = first_pending.id
                    second_id = second_pending.id

                gate = asyncio.Event()
                entered = 0

                async def _fake_llm(*_args, **_kwargs):
                    nonlocal entered
                    entered += 1
                    if entered >= 2:
                        gate.set()
                    await gate.wait()
                    return {"score": 88, "reason": "命中主线"}

                with patch(
                    "app.services.scoring.llm_call_json_with_stream_fallback",
                    new_callable=AsyncMock,
                ) as mock_llm:
                    mock_llm.side_effect = _fake_llm
                    first, second = await asyncio.gather(
                        score_prediction(first_id),
                        score_prediction(second_id),
                    )

                self.assertEqual(
                    first,
                    {
                        "score": 88,
                        "reason": "命中主线",
                        "you_vs_oracle": {
                            "status": "not_scorable",
                            "reason": "actual_outcome_unavailable",
                        },
                    },
                )
                self.assertEqual(
                    second,
                    {
                        "score": 88,
                        "reason": "命中主线",
                        "you_vs_oracle": {
                            "status": "not_scorable",
                            "reason": "actual_outcome_unavailable",
                        },
                    },
                )

                with Session(engine) as session:
                    entry = session.exec(
                        select(Leaderboard).where(Leaderboard.user_id == "director-1")
                    ).first()
                    self.assertIsNotNone(entry)
                    self.assertEqual(entry.total_predictions, 3)
                    self.assertEqual(entry.total_score, 246.0)
                    self.assertAlmostEqual(entry.avg_score, 82.0)

        asyncio.run(_run())

def test_score_predictions_endpoint_returns_attempt_and_failure_stats(tmp_path):
    client = TestClient(app)

    engine = create_engine(f"sqlite:///{tmp_path / 'predictions-api.db'}")
    SQLModel.metadata.create_all(engine)

    with patch("app.api.predictions.get_engine", return_value=engine):
        with Session(engine) as session:
            scenario = Scenario(question="测试问题", status=ScenarioStatus.DONE)
            session.add(scenario)
            session.commit()
            session.refresh(scenario)
            scenario_id = scenario.id

        with patch("app.services.scoring.score_all_for_scenario", new_callable=AsyncMock) as mock_score_all:  # noqa: E501
            mock_score_all.return_value = {
                "attempted": 3,
                "scored": 1,
                "failed": 2,
                "all_failed": False,
                "results": [{"prediction_id": "p-1", "score": 88, "reason": "命中主线"}],
            }

            response = client.post(f"/api/scenario/{scenario_id}/score-predictions")

    assert response.status_code == 200
    assert response.json() == {
        "attempted": 3,
        "scored": 1,
        "failed": 2,
        "all_failed": False,
        "results": [{"prediction_id": "p-1", "score": 88, "reason": "命中主线"}],
    }


def test_score_predictions_rehydrates_profile_from_parsed_context(monkeypatch):
    from app.config import settings
    from app.services import scoring as scoring_module

    monkeypatch.setattr(settings, "FEATURE_YOU_VS_ORACLE", True, raising=False)
    monkeypatch.setattr(settings, "FEATURE_MODEL_PROFILES", True, raising=False)
    profile_id = _seed_model_profile(
        user_id="score-owner",
        model="score-profile-model",
        api_key="sk-score-profile",
        rpm=31,
        tpm=3100,
        concurrency=4,
        supports_structured_outputs=False,
        supports_native_search=True,
    )
    scenario_id = _seed_done_scenario_with_prediction(
        parsed_context={
            "_language": "English",
            "model_profile_id": profile_id,
            "llm_concurrency": 1,
            "supports_structured_outputs": True,
            "supports_native_search": False,
            "result_quality": {"actual_outcome": True},
        },
        user_id="score-owner",
    )
    captured: dict[str, object] = {}
    original_scope = scoring_module.llm_request_scope

    def spy_scope(**kwargs):
        captured["scope"] = dict(kwargs)
        return original_scope(**kwargs)

    async def fake_llm(_prompt: str, **kwargs):
        captured["llm"] = dict(kwargs)
        return {"score": 93, "reason": "profile scored it"}

    monkeypatch.setattr(scoring_module, "llm_request_scope", spy_scope)
    monkeypatch.setattr(
        scoring_module,
        "llm_call_json_with_stream_fallback",
        fake_llm,
    )

    response = TestClient(app).post(f"/api/scenario/{scenario_id}/score-predictions")

    assert response.status_code == 200
    payload = response.json()
    assert payload["attempted"] == 1
    assert payload["scored"] == 1
    assert captured["llm"]["api_key"] == "sk-score-profile"
    assert captured["llm"]["base_url"] == "https://api.openai.com/v1"
    assert captured["llm"]["model"] == "score-profile-model"
    assert captured["scope"] == {
        "quota_key": None,
        "purpose": "prediction_scoring",
        "requests_per_minute": 31,
        "tokens_per_minute": 3100,
        "concurrency": 4,
        "supports_structured_outputs_override": False,
        "supports_native_search_override": True,
    }


def test_score_predictions_inherited_remote_byok_url_uses_server_default(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "FEATURE_YOU_VS_ORACLE", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "sk-server-default", raising=False)
    scenario_id = _seed_done_scenario_with_prediction(
        parsed_context={
            "_language": "English",
            "llm_base_url": "https://api.openai.com/v1",
            "llm_model": "byok-profile-model",
            "result_quality": {"actual_outcome": True},
        }
    )

    async def fake_llm(_prompt: str, **kwargs):
        if (
            kwargs.get("api_key") is not None
            or kwargs.get("base_url") is not None
            or kwargs.get("model") is not None
        ):
            raise AssertionError(f"expected server default provider, got {kwargs!r}")
        return {"score": 91, "reason": "server default scored it"}

    monkeypatch.setattr("app.services.scoring.llm_call_json_with_stream_fallback", fake_llm)

    response = TestClient(app).post(f"/api/scenario/{scenario_id}/score-predictions")

    assert response.status_code == 200
    payload = response.json()
    assert payload["attempted"] == 1
    assert payload["scored"] == 1
    assert payload["failed"] == 0
    assert payload["all_failed"] is False
    assert payload["results"][0]["score"] == 91


def test_score_predictions_inherited_remote_byok_url_without_server_key_is_400(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "FEATURE_YOU_VS_ORACLE", True, raising=False)
    monkeypatch.setattr(settings, "LLM_API_KEY", "", raising=False)
    scenario_id = _seed_done_scenario_with_prediction(
        parsed_context={
            "_language": "English",
            "llm_base_url": "https://api.openai.com/v1",
            "result_quality": {"actual_outcome": True},
        }
    )
    called = False

    async def unexpected_llm(_prompt: str, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("LLM should not be called without a server default key")

    monkeypatch.setattr("app.services.scoring.llm_call_json_with_stream_fallback", unexpected_llm)

    response = TestClient(app).post(f"/api/scenario/{scenario_id}/score-predictions")

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"
    assert called is False


def test_score_predictions_explicit_base_url_without_key_still_requires_key(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "FEATURE_YOU_VS_ORACLE", True, raising=False)
    scenario_id = _seed_done_scenario_with_prediction(
        parsed_context={"_language": "English", "result_quality": {"actual_outcome": True}}
    )

    response = TestClient(app).post(
        f"/api/scenario/{scenario_id}/score-predictions",
        json={"llm_base_url": "https://api.openai.com/v1"},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "BYOK_API_KEY_REQUIRED"


@pytest.mark.asyncio
async def test_local_provider_llm_call_allows_missing_api_key(monkeypatch):
    from app.services import llm_client

    captured: dict[str, object] = {}

    class FakeResponse:
        text = ""

        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return {
                "choices": [{"message": {"content": "OK"}}],
                "output_text": "OK",
                "usage": {},
            }

    class FakeClient:
        async def post(self, url: str, *, json: dict, headers: dict, timeout: float):
            captured.update(
                {
                    "url": url,
                    "json": json,
                    "headers": headers,
                    "timeout": timeout,
                }
            )
            return FakeResponse()

    monkeypatch.setattr(llm_client.settings, "LLM_API_KEY", "", raising=False)
    monkeypatch.setattr(llm_client, "_get_shared_async_client", lambda: FakeClient())
    monkeypatch.setattr(llm_client, "_reserve_runtime_slot", AsyncMock(return_value=None))
    monkeypatch.setattr(llm_client, "_release_runtime_slot", AsyncMock())
    monkeypatch.setattr(llm_client, "_reconcile_rate_limit_usage", AsyncMock())

    result = await llm_client.llm_call(
        "Respond with OK",
        base_url="http://127.0.0.1:8317/v1",
        api_key=None,
    )

    assert result == "OK"
    assert captured["url"] == "http://127.0.0.1:8317/v1/chat/completions"


if __name__ == "__main__":
    unittest.main()
