"""Tests for P3-B — Prediction & Leaderboard.

Covers model instantiation, validation, scoring logic, and API endpoints.
"""

from __future__ import annotations

import asyncio
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

from sqlmodel import Session, SQLModel, create_engine, select

from app.models.predictions import Prediction, Leaderboard
from app.services.scoring import _update_leaderboard


# ── Model Unit Tests ─────────────────────────────────────

class TestPredictionModel(unittest.TestCase):
    """Prediction model defaults and fields."""

    def test_default_values(self):
        p = Prediction(scenario_id="s1", prediction_text="BTC will moon")
        self.assertEqual(p.scenario_id, "s1")
        self.assertEqual(p.prediction_text, "BTC will moon")
        self.assertEqual(p.user_name, "匿名预言家")
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
            session.commit()

    def test_create_new_entry(self):
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
        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 80.0)
            session.commit()

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
        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 80.0)
            session.commit()

        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 40.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertEqual(entry.win_streak, 0)

    def test_win_streak_continues(self):
        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Bob", 70.0)
            session.commit()

        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Bob", 60.0)
            session.commit()

        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Bob", 80.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertEqual(entry.win_streak, 3)

    def test_best_score_only_increases(self):
        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 95.0)
            session.commit()

        with Session(self.engine) as session:
            _update_leaderboard(session, "u1", "Alice", 50.0)
            session.commit()

        with Session(self.engine) as session:
            entry = session.exec(select(Leaderboard).where(Leaderboard.user_id == "u1")).first()
            self.assertEqual(entry.best_score, 95.0)


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


if __name__ == "__main__":
    unittest.main()
