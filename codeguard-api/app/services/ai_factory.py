"""
AI provider factory.

Returns the configured AI service (Claude or OpenAI) based on the
AI_PROVIDER setting in .env. Both services share the same interface:

    async def analyze_merge_request(mr_title, mr_description, files_diff, rules) -> dict
"""
from app.config import get_settings

settings = get_settings()


def get_ai_service():
    """Return the AI service instance based on AI_PROVIDER config."""
    provider = settings.ai_provider.lower()

    if provider == "openai":
        from app.services.openai_service import OpenAIService
        return OpenAIService()

    # Default: Anthropic Claude
    from app.services.claude_service import ClaudeService
    return ClaudeService()
