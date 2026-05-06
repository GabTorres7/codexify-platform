from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.core.exceptions import ForbiddenError, NotFoundError
from app.db.client import get_supabase
from app.dependencies import get_current_user, require_admin
from app.models.rule import RuleBulkUpdate, RuleCreate, RuleOut, RuleUpdate
from app.services.rule_service import RuleService

router = APIRouter(prefix="/orgs/{org_id}/rules", tags=["Rules"])


def _get_rule_svc():
    from app.db.client import get_supabase as _get_db
    # RuleService needs the db client — instantiated per-request via dependency
    return None  # placeholder; see endpoint bodies


@router.get("", response_model=list[RuleOut])
async def list_rules(
    org_id: UUID,
    active_only: bool = Query(False),
    repo_id: UUID | None = Query(None),
    current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    svc = RuleService(db)
    return await svc.list_rules(org_id, repo_id=repo_id, active_only=active_only)


@router.post("", response_model=RuleOut, status_code=201)
async def create_rule(
    org_id: UUID,
    body: RuleCreate,
    current_user: dict = Depends(require_admin),
):
    db = await get_supabase()
    svc = RuleService(db)
    data = body.model_dump()
    if data.get("repo_id"):
        data["repo_id"] = str(data["repo_id"])
    return await svc.create_rule(org_id, data)


@router.patch("/{rule_id}", response_model=RuleOut)
async def update_rule(
    org_id: UUID,
    rule_id: UUID,
    body: RuleUpdate,
    current_user: dict = Depends(require_admin),
):
    db = await get_supabase()

    # Verify ownership
    existing = (
        await db.table("rules")
        .select("id, is_builtin")
        .eq("id", str(rule_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not existing.data:
        raise NotFoundError("Rule", str(rule_id))

    svc = RuleService(db)
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    updated = await svc.update_rule(rule_id, data)
    if not updated:
        raise NotFoundError("Rule", str(rule_id))
    return updated


@router.delete("/{rule_id}", status_code=204)
async def delete_rule(
    org_id: UUID,
    rule_id: UUID,
    current_user: dict = Depends(require_admin),
):
    db = await get_supabase()

    existing = (
        await db.table("rules")
        .select("id, is_builtin")
        .eq("id", str(rule_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not existing.data:
        raise NotFoundError("Rule", str(rule_id))
    if existing.data[0]["is_builtin"]:
        raise ForbiddenError("Built-in rules cannot be deleted — disable them instead")

    svc = RuleService(db)
    await svc.delete_rule(rule_id)


@router.post("/bulk-update", status_code=200)
async def bulk_update_rules(
    org_id: UUID,
    body: RuleBulkUpdate,
    current_user: dict = Depends(require_admin),
):
    """Enable or disable multiple rules at once."""
    db = await get_supabase()
    svc = RuleService(db)
    count = await svc.bulk_update_active(body.rule_ids, body.is_active)
    return {"updated": count}
