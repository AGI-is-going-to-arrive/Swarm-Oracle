"""Tests for P3-B — Prediction & Leaderboard.

Covers model instantiation, validation, scoring logic, and API endpoints.
"""

from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from sqlmodel import Session, SQLModel, create_engine, select

from app.models.predictions import Leaderboard, Prediction
from app.services.scoring import _update_leaderboard

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
                scenario_id="scenario-1",
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
        )

        self.assertEqual(req.llm_api_key, "sk-test")
        self.assertEqual(req.llm_base_url, "https://example.com/v1/chat/completions")
        self.assertEqual(req.llm_model, "gpt-test")


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

            with patch("app.services.scoring.llm_call_json", new_callable=AsyncMock) as mock_llm:
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

            self.assertEqual(result, {"score": 88, "reason": "命中主线"})
            _, kwargs = mock_llm.call_args
            self.assertEqual(kwargs["api_key"], "sk-test")
            self.assertEqual(kwargs["base_url"], "https://example.com/v1/chat/completions")
            self.assertEqual(kwargs["model"], "gpt-test")


if __name__ == "__main__":
    unittest.main()
