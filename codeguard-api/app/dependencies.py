from datetime import UTC, datetime
from uuid import UUID

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from supabase import AsyncClient

from app.core.exceptions import ForbiddenError, UnauthorizedError
from app.core.security import decode_token, hash_api_key
from app.db.client import get_supabase

bearer_scheme = HTTPBearer(auto_error=False)


async def get_db() -> AsyncClient:
    try:
        return await get_supabase()
    except Exception as exc:
        if "Invalid API key" in str(exc) or "Supabase" in type(exc).__name__:
            raise HTTPException(
                status_code=503,
                detail="Supabase não configurado. Preencha SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no arquivo .env",
            )
        raise


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncClient = Depends(get_db),
) -> dict:
    """
    Authenticate via JWT Bearer token OR API key (cg_live_... prefix).
    Returns the user dict if JWT or a synthetic user dict for API keys.
    """
    if not credentials:
        raise UnauthorizedError("Authorization header required")

    token = credentials.credentials

    # API Key auth
    if token.startswith("cg_"):
        hashed = hash_api_key(token)
        key_resp = (
            await db.table("api_keys")
            .select("*, organizations(id, name, slug)")
            .eq("key_hash", hashed)
            .execute()
        )
        if not key_resp.data:
            raise UnauthorizedError("Invalid API key")
        key_row = key_resp.data[0]  # type: ignore[index]

        if key_row.get("expires_at") and datetime.fromisoformat(
            key_row["expires_at"]
        ) < datetime.now(UTC):
            raise UnauthorizedError("API key has expired")

        # Update last_used_at
        await db.table("api_keys").update(
            {"last_used_at": datetime.now(UTC).isoformat()}
        ).eq("id", key_row["id"]).execute()

        return {
            "id": key_row.get("created_by"),
            "org_id": key_row["org_id"],
            "role": "admin",
            "auth_type": "api_key",
        }

    # JWT auth
    try:
        payload = decode_token(token)
    except ValueError as exc:
        raise UnauthorizedError(str(exc)) from exc

    if payload.get("type") != "access":
        raise UnauthorizedError("Invalid token type")

    user_resp = (
        await db.table("users")
        .select("*")
        .eq("id", payload["sub"])
        .eq("is_active", True)
        .execute()
    )
    if not user_resp.data:
        raise UnauthorizedError("User not found or inactive")

    return user_resp.data[0]  # type: ignore[index]


def require_org_access(org_id: UUID):
    """Dependency factory: ensures the current user belongs to the given org."""

    async def _check(current_user: dict = Depends(get_current_user)):
        if str(current_user.get("org_id")) != str(org_id):
            raise ForbiddenError("Access to this organization is not allowed")
        return current_user

    return _check


def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    if current_user.get("role") != "admin":
        raise ForbiddenError("Admin role required")
    return current_user
