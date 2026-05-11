import json

import structlog
from openai import AsyncOpenAI

from app.config import get_settings
from app.core.exceptions import AIServiceError
from app.schemas.claude_prompts import SYSTEM_PROMPT, build_analysis_prompt

logger = structlog.get_logger()
settings = get_settings()


class OpenAIService:
    def __init__(self):
        self._client = AsyncOpenAI(api_key=settings.openai_api_key)

    async def analyze_merge_request(
        self,
        mr_title: str,
        mr_description: str,
        files_diff: list[dict],
        rules: list[dict],
    ) -> dict:
        """
        Call OpenAI (GPT) to analyze a merge request diff.
        Same interface as ClaudeService — returns parsed analysis dict.
        """
        prompt = build_analysis_prompt(mr_title, mr_description, files_diff, rules)

        try:
            response = await self._client.chat.completions.create(
                model=settings.openai_model,
                max_tokens=settings.openai_max_tokens,
                temperature=0.1,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
            )
        except Exception as exc:
            logger.error("openai_api_error", error=str(exc))
            raise AIServiceError(f"OpenAI API call failed: {exc}") from exc

        raw_text = (response.choices[0].message.content or "").strip()

        # Strip markdown fences if GPT added them
        if raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1]
            if raw_text.startswith("json"):
                raw_text = raw_text[4:]

        try:
            result = json.loads(raw_text)
        except json.JSONDecodeError as exc:
            logger.error("openai_json_parse_error", raw=raw_text[:500])
            raise AIServiceError(f"OpenAI returned non-JSON response: {exc}") from exc

        logger.info(
            "openai_analysis_complete",
            ai_score=result.get("ai_score"),
            issues=len(result.get("issues", [])),
        )
        return result
