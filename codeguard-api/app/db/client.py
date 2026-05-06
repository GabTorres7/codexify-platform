from fastapi import HTTPException
from supabase import AsyncClient, acreate_client

from app.config import get_settings

settings = get_settings()

_client: AsyncClient | None = None


async def get_supabase() -> AsyncClient:
    """Return a shared Supabase async client (service-role key for backend use)."""
    global _client
    if _client is None:
        try:
            _client = await acreate_client(
                settings.supabase_url,
                settings.supabase_service_role_key,
            )
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Supabase não configurado. "
                    "Preencha SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no arquivo .env"
                ),
            ) from exc
    return _client
