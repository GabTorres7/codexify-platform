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
    RegisterRequest,
    TokenOut,
)

router = APIRouter(prefix="/auth", tags=["Auth"])


@router.post("/register", response_model=TokenOut)
async def register(body: RegisterRequest):
    """
    Register a new user. Creates the user in the DB and returns JWT tokens.
    If no organization exists yet, creates a default one.
    """
    from app.core.security import hash_password as _hash

    name = body.name.strip()
    email = body.email.strip()
    password = body.password

    if not name or not email or len(password) < 6:
        raise UnauthorizedError("Nome, e-mail e senha (min 6 chars) são obrigatórios")

    db = await get_supabase()

    # Check if email already exists
    existing = await db.table("users").select("id").eq("email", email).execute()
    if existing.data:
        raise UnauthorizedError("Este e-mail já está cadastrado. Faça login.")

    # Find or create a default org
    orgs_resp = await db.table("organizations").select("id").limit(1).execute()
    if orgs_resp.data:
        org_id = orgs_resp.data[0]["id"]  # type: ignore[index]
    else:
        # Create default org
        from datetime import UTC, datetime
        org_resp = await db.table("organizations").insert({
            "name": "Minha Organização",
            "slug": "minha-org",
            "created_at": datetime.now(UTC).isoformat(),
        }).execute()
        org_id = org_resp.data[0]["id"]  # type: ignore[index]
        # Create default settings
        await db.table("org_settings").insert({"org_id": org_id}).execute()

    initials = "".join(w[0].upper() for w in name.split()[:2]) or "U"

    # Generate a default avatar color
    colors = ["#818cf8", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#a78bfa", "#f87171"]
    color = colors[sum(ord(c) for c in email) % len(colors)]

    user_resp = await db.table("users").insert({
        "org_id": org_id,
        "email": email,
        "name": name,
        "initials": initials,
        "color": color,
        "role": "admin",
        "hashed_password": _hash(password),
        "is_active": True,
    }).execute()

    user = user_resp.data[0]  # type: ignore[index]
    payload = {"sub": user["id"], "org_id": str(org_id)}
    return TokenOut(
        access_token=create_access_token(payload),
        refresh_token=create_refresh_token(payload),
    )


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

    user = resp.data[0]  # type: ignore[index]
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
    row = resp.data[0]  # type: ignore[index]
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
