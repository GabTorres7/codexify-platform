from uuid import UUID

import structlog
from supabase import AsyncClient

logger = structlog.get_logger()


class RuleService:
    def __init__(self, db: AsyncClient):
        self._db = db

    async def get_effective_rules(self, org_id: UUID, repo_id: UUID) -> list[dict]:
        """
        Get the effective rule set for a repository:
        org-wide active rules + repo-specific overrides.
        Repo-level active flag takes precedence over org-level.
        """
        # Fetch all active rules for this org (repo_id IS NULL = org-wide)
        org_resp = (
            await self._db.table("rules")
            .select("*")
            .eq("org_id", str(org_id))
            .is_("repo_id", "null")
            .eq("is_active", True)
            .execute()
        )
        org_rules = {r["name"]: r for r in (org_resp.data or [])}

        # Fetch repo-specific rule overrides
        repo_resp = (
            await self._db.table("rules")
            .select("*")
            .eq("org_id", str(org_id))
            .eq("repo_id", str(repo_id))
            .execute()
        )
        for r in repo_resp.data or []:
            if r["is_active"]:
                org_rules[r["name"]] = r
            else:
                # Repo explicitly disabled this rule
                org_rules.pop(r["name"], None)

        return list(org_rules.values())

    async def list_rules(
        self, org_id: UUID, repo_id: UUID | None = None, active_only: bool = False
    ) -> list[dict]:
        query = (
            self._db.table("rules")
            .select("*")
            .eq("org_id", str(org_id))
            .order("created_at")
        )
        if repo_id:
            query = query.eq("repo_id", str(repo_id))
        if active_only:
            query = query.eq("is_active", True)
        resp = await query.execute()
        return resp.data or []

    async def create_rule(self, org_id: UUID, data: dict) -> dict:
        payload = {"org_id": str(org_id), **data}
        resp = await self._db.table("rules").insert(payload).execute()
        return resp.data[0]  # type: ignore[index]

    async def update_rule(self, rule_id: UUID, data: dict) -> dict | None:
        from datetime import UTC, datetime
        data["updated_at"] = datetime.now(UTC).isoformat()
        resp = (
            await self._db.table("rules")
            .update(data)
            .eq("id", str(rule_id))
            .execute()
        )
        return resp.data[0] if resp.data else None  # type: ignore[index]

    async def delete_rule(self, rule_id: UUID) -> bool:
        resp = (
            await self._db.table("rules")
            .delete()
            .eq("id", str(rule_id))
            .eq("is_builtin", False)  # cannot delete builtin rules
            .execute()
        )
        return bool(resp.data)

    async def bulk_update_active(self, rule_ids: list[UUID], is_active: bool) -> int:
        from datetime import UTC, datetime
        ids = [str(r) for r in rule_ids]
        resp = (
            await self._db.table("rules")
            .update({"is_active": is_active, "updated_at": datetime.now(UTC).isoformat()})
            .in_("id", ids)
            .execute()
        )
        return len(resp.data or [])
