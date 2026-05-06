from uuid import UUID

from fastapi import APIRouter, Depends

from app.core.exceptions import NotFoundError, UnauthorizedError
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_api_key,
    get_key_prefix,
    verify_password,
)
from app.db.client import get_supabase
from app.dependencies import get_current_user, require_admin
from app.models.user import (
    APIKeyCreate,
    APIKeyCreatedOut,
    APIKeyOut,
    LoginRequest,
    RefreshRequest,
    TokenOut,
)

router = APIRouter(prefix="/auth", tags=["Auth"])


@router.post("/login", response_model=TokenOut)
async def login(body: LoginRequest):
    db = await get_supabase()
    resp = (
        await db.table("users")
        .select("*")
        .eq("email", body.email)
        .eq("is_active", True)
        .execute()
    )
    if not resp.data:
        raise UnauthorizedError("Invalid email or password")

    user = resp.data[0]
    if not verify_password(body.password, user["hashed_password"] or ""):
        raise UnauthorizedError("Invalid email or password")

    payload = {"sub": user["id"], "org_id": user["org_id"]}
    return TokenOut(
        access_token=create_access_token(payload),
        refresh_token=create_refresh_token(payload),
    )


@router.post("/refresh", response_model=TokenOut)
async def refresh(body: RefreshRequest):
    try:
        payload = decode_token(body.refresh_token)
    except ValueError as exc:
        raise UnauthorizedError(str(exc)) from exc

    if payload.get("type") != "refresh":
        raise UnauthorizedError("Not a refresh token")

    new_payload = {"sub": payload["sub"], "org_id": payload.get("org_id")}
    return TokenOut(
        access_token=create_access_token(new_payload),
        refresh_token=create_refresh_token(new_payload),
    )


@router.post("/api-keys", response_model=APIKeyCreatedOut)
async def create_api_key(
    body: APIKeyCreate,
    current_user: dict = Depends(require_admin),
):
    db = await get_supabase()
    plain, hashed = generate_api_key()
    prefix = get_key_prefix(plain)

    payload = {
        "org_id": current_user["org_id"],
        "name": body.name,
        "key_hash": hashed,
        "key_prefix": prefix,
        "created_by": current_user.get("id"),
    }
    if body.expires_at:
        payload["expires_at"] = body.expires_at.isoformat()

    resp = await db.table("api_keys").insert(payload).execute()
    row = resp.data[0]
    return APIKeyCreatedOut(**row, plain_key=plain)


@router.get("/api-keys", response_model=list[APIKeyOut])
async def list_api_keys(current_user: dict = Depends(require_admin)):
    db = await get_supabase()
    resp = (
        await db.table("api_keys")
        .select("id, name, key_prefix, created_at, expires_at")
        .eq("org_id", current_user["org_id"])
        .order("created_at", desc=True)
        .execute()
    )
    return resp.data or []


@router.delete("/api-keys/{key_id}", status_code=204)
async def revoke_api_key(
    key_id: UUID,
    current_user: dict = Depends(require_admin),
):
    db = await get_supabase()
    resp = (
        await db.table("api_keys")
        .delete()
        .eq("id", str(key_id))
        .eq("org_id", current_user["org_id"])
        .execute()
    )
    if not resp.data:
        raise NotFoundError("API key", str(key_id))
