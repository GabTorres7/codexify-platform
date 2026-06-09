import structlog
from fastapi import HTTPException
from supabase import AsyncClient, acreate_client

from app.config import get_settings

logger = structlog.get_logger()
settings = get_settings()

_client: AsyncClient | None = None


async def get_supabase() -> AsyncClient:
    """Return a shared Supabase async client (service-role key for backend use)."""
    global _client
    if _client is None:
        url = settings.supabase_url
        key = settings.supabase_service_role_key
        logger.info("supabase_connect", url=url[:30] if url else "EMPTY", key_len=len(key) if key else 0)
        if not url or not key:
            raise HTTPException(status_code=503, detail="SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY vazio")
        try:
            _client = await acreate_client(url, key)
        except Exception as exc:
            logger.error("supabase_connect_failed", error=str(exc), error_type=type(exc).__name__)
            raise HTTPException(
                status_code=503,
                detail=f"Supabase erro: {type(exc).__name__}: {exc}",
            ) from exc
    return _client
