import json

import anthropic
import structlog

from app.config import get_settings
from app.core.exceptions import AIServiceError
from app.schemas.claude_prompts import SYSTEM_PROMPT, build_analysis_prompt

logger = structlog.get_logger()
settings = get_settings()


class ClaudeService:
    def __init__(self):
        self._client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)

    async def analyze_merge_request(
        self,
        mr_title: str,
        mr_description: str,
        files_diff: list[dict],
        rules: list[dict],
    ) -> dict:
        """
        Call Claude to analyze a merge request diff.
        Returns parsed analysis dict matching the DB schema.
        """
        prompt = build_analysis_prompt(mr_title, mr_description, files_diff, rules)

        try:
            response = await self._client.messages.create(
                model=settings.claude_model,
                max_tokens=settings.claude_max_tokens,
                system=SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
        except anthropic.APIError as exc:
            logger.error("claude_api_error", error=str(exc))
            raise AIServiceError(f"Claude API call failed: {exc}") from exc

        raw_text = response.content[0].text.strip()

        # Strip markdown fences if Claude added them despite instructions
        if raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1]
            if raw_text.startswith("json"):
                raw_text = raw_text[4:]

        try:
            result = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            logger.error("claude_json_parse_error", raw=raw_text[:500])
            raise AIServiceError(f"Claude returned non-JSON response: {exc}") from exc

        logger.info(
            "claude_analysis_complete",
            ai_score=result.get("ai_score"),
            issues=len(result.get("issues", [])),
        )
        return result
