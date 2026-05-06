"""
Tests for ClaudeService — mock the Anthropic client.
"""
import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.claude_service import ClaudeService
from app.core.exceptions import AIServiceError


MOCK_ANALYSIS = {
    "ai_score": 72,
    "score_security": 55,
    "score_performance": 80,
    "score_readability": 78,
    "score_business_rules": 70,
    "issues": [
        {
            "severity": "critical",
            "title": "Token in localStorage",
            "description": "Access token stored in localStorage is vulnerable to XSS.",
            "file_path": "src/auth.js",
            "line_ref": "12",
            "suggestion": "Use httpOnly cookies instead.",
        }
    ],
    "diff_annotations": [
        {
            "file_path": "src/auth.js",
            "after_line": 12,
            "type": "danger",
            "text": "Never store tokens in localStorage",
        }
    ],
    "rule_results": [
        {
            "rule_name": "Armazenamento Seguro",
            "status": "fail",
            "description": "Token stored in localStorage",
        }
    ],
}


@pytest.mark.asyncio
async def test_analyze_merge_request_success():
    with patch("app.services.claude_service.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_cls.return_value = mock_client

        mock_message = MagicMock()
        mock_message.content = [MagicMock(text=json.dumps(MOCK_ANALYSIS))]
        mock_client.messages.create = AsyncMock(return_value=mock_message)

        svc = ClaudeService()
        result = await svc.analyze_merge_request(
            mr_title="Add OAuth2 auth",
            mr_description="Implements token-based auth",
            files_diff=[{"file": "src/auth.js", "diff_text": "+localStorage.setItem('token', t)"}],
            rules=[
                {
                    "name": "Armazenamento Seguro",
                    "description": "Avoid localStorage for tokens",
                    "severity": "critical",
                    "prompt_hint": "Flag localStorage usage for sensitive data",
                }
            ],
        )

        assert result["ai_score"] == 72
        assert len(result["issues"]) == 1
        assert result["issues"][0]["severity"] == "critical"


@pytest.mark.asyncio
async def test_analyze_merge_request_invalid_json():
    with patch("app.services.claude_service.anthropic.AsyncAnthropic") as mock_cls:
        mock_client = AsyncMock()
        mock_cls.return_value = mock_client

        mock_message = MagicMock()
        mock_message.content = [MagicMock(text="This is not JSON")]
        mock_client.messages.create = AsyncMock(return_value=mock_message)

        svc = ClaudeService()
        with pytest.raises(AIServiceError, match="non-JSON"):
            await svc.analyze_merge_request(
                mr_title="Test",
                mr_description="",
                files_diff=[],
                rules=[],
            )
