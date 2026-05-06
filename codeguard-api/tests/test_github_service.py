"""
Tests for GitHubService — mock httpx responses.
"""
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from app.services.github_service import GitHubService
from app.core.exceptions import GitPlatformError


def _mock_response(status_code: int, data: dict):
    resp = MagicMock(spec=httpx.Response)
    resp.status_code = status_code
    resp.is_success = 200 <= status_code < 300
    resp.json.return_value = data
    resp.text = str(data)
    return resp


@pytest.mark.asyncio
async def test_validate_token_success():
    repo_data = {"id": 123, "name": "myrepo", "html_url": "https://github.com/org/myrepo"}

    svc = GitHubService("fake-token")
    with patch.object(svc, "_client") as mock_client_factory:
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_ctx)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_ctx.get = AsyncMock(return_value=_mock_response(200, repo_data))
        mock_client_factory.return_value = mock_ctx

        result = await svc.validate_token("org/myrepo")
        assert result["id"] == 123


@pytest.mark.asyncio
async def test_validate_token_not_found():
    svc = GitHubService("bad-token")
    with patch.object(svc, "_client") as mock_client_factory:
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_ctx)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mock_ctx.get = AsyncMock(return_value=_mock_response(404, {}))
        mock_client_factory.return_value = mock_ctx

        with pytest.raises(GitPlatformError, match="not found"):
            await svc.validate_token("org/nonexistent")
