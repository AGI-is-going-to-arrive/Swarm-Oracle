"""Tests for Agent Identity favorite/bookmark endpoints."""

import pytest
from httpx import ASGITransport, AsyncClient
from sqlmodel import Session

from app.api import agents as agents_api
from app.main import app
from app.models.agent_identity import AgentIdentity
from app.models.database import get_engine

TEST_USER = "favorite-user"
OTHER_USER = "favorite-other-user"


@pytest.fixture(autouse=True)
def _feature_flags(monkeypatch):
    monkeypatch.setattr(agents_api.settings, "FEATURE_CUSTOM_AGENTS", True)
    yield


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _create_identity(
    identity_id: str,
    *,
    user_id: str = TEST_USER,
    is_favorite: bool = False,
) -> None:
    with Session(get_engine()) as session:
        session.add(
            AgentIdentity(
                id=identity_id,
                user_id=user_id,
                kind="custom",
                display_name=f"Agent {identity_id}",
                role="analyst",
                continuity_key=f"{identity_id}-key",
                is_favorite=is_favorite,
            )
        )
        session.commit()


def _get_identity(identity_id: str) -> AgentIdentity:
    with Session(get_engine()) as session:
        identity = session.get(AgentIdentity, identity_id)
        assert identity is not None
        return identity


async def test_mark_favorite_returns_200_and_is_favorite_true(client: AsyncClient):
    _create_identity("favorite-mark-1")

    resp = await client.post(
        "/api/agents/identities/favorite-mark-1/favorite",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 200
    assert resp.json()["is_favorite"] is True
    assert _get_identity("favorite-mark-1").is_favorite is True


async def test_unmark_favorite_returns_200_and_is_favorite_false(client: AsyncClient):
    _create_identity("favorite-unmark-1", is_favorite=True)

    resp = await client.delete(
        "/api/agents/identities/favorite-unmark-1/favorite",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 200
    assert resp.json()["is_favorite"] is False
    assert _get_identity("favorite-unmark-1").is_favorite is False


async def test_list_favorites_returns_only_favorited_identities_for_user(
    client: AsyncClient,
):
    _create_identity("favorite-list-1", is_favorite=True)
    _create_identity("favorite-list-2", is_favorite=False)
    _create_identity("favorite-list-3", is_favorite=True)

    resp = await client.get(
        "/api/agents/identities/favorites",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 200
    ids = {item["id"] for item in resp.json()}
    assert ids == {"favorite-list-1", "favorite-list-3"}
    assert all(item["is_favorite"] is True for item in resp.json())


async def test_list_favorites_does_not_return_other_users_favorited_identities(
    client: AsyncClient,
):
    _create_identity("favorite-own-1", is_favorite=True)
    _create_identity("favorite-other-1", user_id=OTHER_USER, is_favorite=True)

    resp = await client.get(
        "/api/agents/identities/favorites",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 200
    ids = {item["id"] for item in resp.json()}
    assert ids == {"favorite-own-1"}


async def test_marking_another_users_identity_returns_404(client: AsyncClient):
    _create_identity("favorite-foreign-mark", user_id=OTHER_USER)

    resp = await client.post(
        "/api/agents/identities/favorite-foreign-mark/favorite",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 404
    assert _get_identity("favorite-foreign-mark").is_favorite is False


async def test_unmarking_another_users_identity_returns_404(client: AsyncClient):
    _create_identity("favorite-foreign-unmark", user_id=OTHER_USER, is_favorite=True)

    resp = await client.delete(
        "/api/agents/identities/favorite-foreign-unmark/favorite",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 404
    assert _get_identity("favorite-foreign-unmark").is_favorite is True


async def test_get_favorites_cannot_see_other_users_favorites(client: AsyncClient):
    _create_identity("favorite-foreign-list", user_id=OTHER_USER, is_favorite=True)

    resp = await client.get(
        "/api/agents/identities/favorites",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 200
    assert resp.json() == []


async def test_feature_flag_disabled_post_returns_404(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _create_identity("favorite-disabled-post")
    monkeypatch.setattr(agents_api.settings, "FEATURE_CUSTOM_AGENTS", False)

    resp = await client.post(
        "/api/agents/identities/favorite-disabled-post/favorite",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "FEATURE_DISABLED"


async def test_feature_flag_disabled_delete_returns_404(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    _create_identity("favorite-disabled-delete", is_favorite=True)
    monkeypatch.setattr(agents_api.settings, "FEATURE_CUSTOM_AGENTS", False)

    resp = await client.delete(
        "/api/agents/identities/favorite-disabled-delete/favorite",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "FEATURE_DISABLED"


async def test_feature_flag_disabled_get_returns_404(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(agents_api.settings, "FEATURE_CUSTOM_AGENTS", False)

    resp = await client.get(
        "/api/agents/identities/favorites",
        params={"user_id": TEST_USER},
    )

    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "FEATURE_DISABLED"


async def test_double_mark_is_idempotent(client: AsyncClient):
    _create_identity("favorite-double-mark")

    first = await client.post(
        "/api/agents/identities/favorite-double-mark/favorite",
        params={"user_id": TEST_USER},
    )
    second = await client.post(
        "/api/agents/identities/favorite-double-mark/favorite",
        params={"user_id": TEST_USER},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["is_favorite"] is True
    assert _get_identity("favorite-double-mark").is_favorite is True


async def test_double_unmark_is_idempotent(client: AsyncClient):
    _create_identity("favorite-double-unmark")

    first = await client.delete(
        "/api/agents/identities/favorite-double-unmark/favorite",
        params={"user_id": TEST_USER},
    )
    second = await client.delete(
        "/api/agents/identities/favorite-double-unmark/favorite",
        params={"user_id": TEST_USER},
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["is_favorite"] is False
    assert _get_identity("favorite-double-unmark").is_favorite is False
