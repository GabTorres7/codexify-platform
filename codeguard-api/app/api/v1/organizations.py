import secrets
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends

from app.core.exceptions import ConflictError, NotFoundError
from app.core.security import hash_password
from app.db.client import get_supabase
from app.dependencies import get_current_user, require_admin
from app.models.organization import (
    OrgSettingsOut,
    OrgSettingsUpdate,
    OrganizationCreate,
    OrganizationOut,
    OrganizationUpdate,
)
from app.models.user import UserInvite, UserOut

router = APIRouter(prefix="/orgs", tags=["Organizations"])


@router.post("", response_model=OrganizationOut, status_code=201)
async def create_org(body: OrganizationCreate):
    db = await get_supabase()

    # Check slug uniqueness
    existing = (
        await db.table("organizations").select("id").eq("slug", body.slug).execute()
    )
    if existing.data:
        raise ConflictError(f"Slug '{body.slug}' is already taken")

    org_resp = await db.table("organizations").insert(body.model_dump()).execute()
    if not org_resp.data:
        raise ConflictError("Failed to create organization")
    org = org_resp.data[0]  # type: ignore[index]

    # Create default org settings
    await db.table("org_settings").insert({"org_id": org["id"]}).execute()

    # Seed builtin rules for this org
    builtin_resp = (
        await db.table("rules").select("*").eq("is_builtin", True).is_("org_id", "null").execute()
    )
    if builtin_resp.data:
        await db.table("rules").insert(
            [
                {
                    "org_id": org["id"],
                    "name": r["name"],
                    "description": r["description"],
                    "severity": r["severity"],
                    "is_active": r["is_active"],
                    "is_builtin": True,
                    "prompt_hint": r["prompt_hint"],
                }
                for r in builtin_resp.data
            ]
        ).execute()

    return org


@router.get("/{org_id}", response_model=OrganizationOut)
async def get_org(
    org_id: UUID,
    _current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    resp = (
        await db.table("organizations").select("*").eq("id", str(org_id)).execute()
    )
    if not resp.data:
        raise NotFoundError("Organization", str(org_id))
    return resp.data[0]  # type: ignore[index]


@router.patch("/{org_id}", response_model=OrganizationOut)
async def update_org(
    org_id: UUID,
    body: OrganizationUpdate,
    _current_user: dict = Depends(require_admin),
):
    db = await get_supabase()
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    data["updated_at"] = datetime.now(UTC).isoformat()
    resp = (
        await db.table("organizations")
        .update(data)
        .eq("id", str(org_id))
        .execute()
    )
    if not resp.data:
        raise NotFoundError("Organization", str(org_id))
    return resp.data[0]  # type: ignore[index]


@router.get("/{org_id}/settings", response_model=OrgSettingsOut)
async def get_org_settings(
    org_id: UUID,
    _current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    resp = (
        await db.table("org_settings").select("*").eq("org_id", str(org_id)).execute()
    )
    if not resp.data:
        raise NotFoundError("Org settings", str(org_id))
    return resp.data[0]  # type: ignore[index]


@router.put("/{org_id}/settings", response_model=OrgSettingsOut)
async def update_org_settings(
    org_id: UUID,
    body: OrgSettingsUpdate,
    _current_user: dict = Depends(require_admin),
):
    db = await get_supabase()
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    data["updated_at"] = datetime.now(UTC).isoformat()
    resp = (
        await db.table("org_settings")
        .update(data)
        .eq("org_id", str(org_id))
        .execute()
    )
    if not resp.data:
        raise NotFoundError("Org settings", str(org_id))
    return resp.data[0]  # type: ignore[index]


@router.get("/{org_id}/members", response_model=list[UserOut])
async def list_members(
    org_id: UUID,
    _current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    resp = (
        await db.table("users")
        .select("*")
        .eq("org_id", str(org_id))
        .order("created_at")
        .execute()
    )
    return resp.data or []


@router.post("/{org_id}/members/invite", response_model=UserOut, status_code=201)
async def invite_member(
    org_id: UUID,
    body: UserInvite,
    _current_user: dict = Depends(require_admin),
):
    db = await get_supabase()

    existing = await db.table("users").select("id").eq("email", body.email).execute()
    if existing.data:
        raise ConflictError(f"User with email '{body.email}' already exists")

    initials = "".join(w[0].upper() for w in body.name.split()[:2])
    temp_password = secrets.token_urlsafe(16)

    # Generate a default avatar color
    colors = ["#818cf8", "#f472b6", "#34d399", "#fbbf24", "#60a5fa", "#a78bfa", "#f87171"]
    color = colors[sum(ord(c) for c in body.email) % len(colors)]

    resp = await db.table("users").insert(
        {
            "org_id": str(org_id),
            "email": body.email,
            "name": body.name,
            "initials": initials,
            "color": color,
            "role": body.role,
            "hashed_password": hash_password(temp_password),
        }
    ).execute()
    return resp.data[0]  # type: ignore[index]


@router.patch("/{org_id}/members/{user_id}", response_model=UserOut)
async def update_member(
    org_id: UUID,
    user_id: UUID,
    body: dict,
    _current_user: dict = Depends(require_admin),
):
    """Update a team member's profile (name, role, color)."""
    db = await get_supabase()

    existing = (
        await db.table("users")
        .select("id")
        .eq("id", str(user_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not existing.data:
        raise NotFoundError("User", str(user_id))

    allowed = {"name", "role", "color", "initials"}
    data = {k: v for k, v in body.items() if k in allowed and v is not None}
    if not data:
        return existing.data[0]  # type: ignore[index]

    if "name" in data:
        data["initials"] = "".join(w[0].upper() for w in data["name"].split()[:2])

    resp = (
        await db.table("users")
        .update(data)
        .eq("id", str(user_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    return resp.data[0]  # type: ignore[index]
