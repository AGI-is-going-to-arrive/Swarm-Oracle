"""Application-level ASGI middleware for SwarmOracle backend."""

from app.middleware.observability import ObservabilityMiddleware

__all__ = ["ObservabilityMiddleware"]
