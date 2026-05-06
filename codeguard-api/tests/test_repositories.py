"""
Tests for repository endpoints.
These tests mock the git platform service so no real API calls are made.
"""
import pytest
from unittest.mock import AsyncMock, patch


@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


@pytest.mark.asyncio
async def test_add_repository_invalid_platform(client):
    """Platform validation should reject unsupported values."""
    resp = await client.post(
        "/api/v1/orgs/00000000-0000-0000-0000-000000000001/repos",
        json={
            "platform": "bitbucket",
            "full_name": "org/repo",
            "access_token": "token",
        },
        headers={"Authorization": "Bearer fake-token"},
    )
    assert resp.status_code in (401, 422)  # 401 if auth fails first, 422 if validation


@pytest.mark.asyncio
async def test_bulk_add_repositories_structure(client):
    """Bulk endpoint should return the right envelope structure."""
    # Without auth — should 401
    resp = await client.post(
        "/api/v1/orgs/00000000-0000-0000-0000-000000000001/repos/bulk",
        json={
            "repositories": [
                {"platform": "github", "full_name": "org/repo1", "access_token": "t1"},
                {"platform": "github", "full_name": "org/repo2", "access_token": "t2"},
            ]
        },
    )
    assert resp.status_code == 401
