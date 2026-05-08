"""
Billing service — plan management, usage tracking, Stripe integration.
"""
from datetime import UTC, datetime
from uuid import UUID

import structlog

from app.db.client import get_supabase

logger = structlog.get_logger()


def _current_month() -> str:
    return datetime.now(UTC).strftime("%Y-%m")


class BillingService:
    _FALLBACK_PLANS = [
        {"id": "free", "slug": "free", "name": "Free", "price_monthly": 0, "price_yearly": 0, "max_repos": 3, "max_analyses": 50, "max_members": 3, "max_chat_msgs": 20, "features": ["upload_analysis", "basic_rules"], "is_active": True},
        {"id": "starter", "slug": "starter", "name": "Starter", "price_monthly": 2900, "price_yearly": 27900, "max_repos": 10, "max_analyses": 300, "max_members": 10, "max_chat_msgs": 100, "features": ["upload_analysis", "basic_rules", "auto_comment", "analytics"], "is_active": True},
        {"id": "pro", "slug": "pro", "name": "Pro", "price_monthly": 7900, "price_yearly": 75900, "max_repos": 50, "max_analyses": 2000, "max_members": 30, "max_chat_msgs": 500, "features": ["upload_analysis", "basic_rules", "auto_comment", "analytics", "chat", "priority_support"], "is_active": True},
        {"id": "enterprise", "slug": "enterprise", "name": "Enterprise", "price_monthly": 19900, "price_yearly": 190000, "max_repos": -1, "max_analyses": -1, "max_members": -1, "max_chat_msgs": -1, "features": ["upload_analysis", "basic_rules", "auto_comment", "analytics", "chat", "priority_support", "sso", "custom_rules", "api_access"], "is_active": True},
    ]

    async def get_plans(self) -> list[dict]:
        try:
            db = await get_supabase()
            resp = (
                await db.table("plans")
                .select("*")
                .eq("is_active", True)
                .order("price_monthly")
                .execute()
            )
            return resp.data or self._FALLBACK_PLANS
        except Exception:
            return self._FALLBACK_PLANS

    async def get_subscription(self, org_id: UUID) -> dict | None:
        try:
            db = await get_supabase()
            resp = (
                await db.table("subscriptions")
                .select("*, plans(*)")
                .eq("org_id", str(org_id))
                .limit(1)
                .execute()
            )
            if not resp.data:
                plans = await self.get_plans()
                free_plan = next((p for p in plans if p["slug"] == "free"), None)
                if free_plan:
                    now = datetime.now(UTC).isoformat()
                    try:
                        insert_resp = await db.table("subscriptions").insert({
                            "org_id": str(org_id),
                            "plan_id": free_plan["id"],
                            "status": "active",
                            "current_period_start": now,
                        }).execute()
                        if insert_resp.data:
                            row = insert_resp.data[0]  # type: ignore[index]
                            row["plans"] = free_plan
                            return row
                    except Exception:
                        pass
                return {"plans": free_plan or self._FALLBACK_PLANS[0], "status": "active"}
            return resp.data[0]  # type: ignore[index]
        except Exception:
            return {"plans": self._FALLBACK_PLANS[0], "status": "active"}

    async def get_usage(self, org_id: UUID) -> dict:
        try:
            db = await get_supabase()
            month = _current_month()
            resp = (
                await db.table("usage_records")
                .select("*")
                .eq("org_id", str(org_id))
                .eq("month", month)
                .limit(1)
                .execute()
            )
            if resp.data:
                return resp.data[0]  # type: ignore[index]
            insert_resp = await db.table("usage_records").insert({
                "org_id": str(org_id),
                "month": month,
            }).execute()
            return insert_resp.data[0] if insert_resp.data else {"analyses": 0, "chat_msgs": 0, "api_calls": 0}  # type: ignore[index]
        except Exception:
            return {"analyses": 0, "chat_msgs": 0, "api_calls": 0}

    async def increment_usage(self, org_id: UUID, field: str, amount: int = 1) -> None:
        try:
            db = await get_supabase()
            month = _current_month()
            existing = (
                await db.table("usage_records")
                .select("id, " + field)
                .eq("org_id", str(org_id))
                .eq("month", month)
                .limit(1)
                .execute()
            )
            if existing.data:
                current = existing.data[0].get(field, 0)  # type: ignore[index]
                await db.table("usage_records").update({
                    field: current + amount,
                    "updated_at": datetime.now(UTC).isoformat(),
                }).eq("id", existing.data[0]["id"]).execute()  # type: ignore[index]
            else:
                await db.table("usage_records").insert({
                    "org_id": str(org_id),
                    "month": month,
                    field: amount,
                }).execute()
        except Exception:
            pass  # billing tables may not exist yet

    async def check_quota(self, org_id: UUID, field: str) -> dict:
        """
        Check if the org has quota remaining for a given field.
        Returns { allowed: bool, current: int, limit: int, plan: str }
        """
        sub = await self.get_subscription(org_id)
        if not sub or not sub.get("plans"):
            return {"allowed": True, "current": 0, "limit": -1, "plan": "unknown"}

        plan = sub["plans"]
        limit_map = {
            "analyses": plan.get("max_analyses", -1),
            "chat_msgs": plan.get("max_chat_msgs", -1),
            "api_calls": plan.get("max_analyses", -1),
        }
        limit = limit_map.get(field, -1)

        usage = await self.get_usage(org_id)
        current = usage.get(field, 0)

        allowed = limit == -1 or current < limit

        return {
            "allowed": allowed,
            "current": current,
            "limit": limit,
            "plan": plan.get("slug", "free"),
        }

    async def change_plan(self, org_id: UUID, plan_slug: str) -> dict:
        # Find plan from DB or fallback
        plan = None
        try:
            db = await get_supabase()
            plan_resp = (
                await db.table("plans")
                .select("*")
                .eq("slug", plan_slug)
                .eq("is_active", True)
                .limit(1)
                .execute()
            )
            if plan_resp.data:
                plan = plan_resp.data[0]  # type: ignore[index]
        except Exception:
            pass

        if not plan:
            plan = next((p for p in self._FALLBACK_PLANS if p["slug"] == plan_slug), None)

        if not plan:
            raise ValueError(f"Plano '{plan_slug}' não encontrado")

        now = datetime.now(UTC).isoformat()

        try:
            db = await get_supabase()
            existing = (
                await db.table("subscriptions")
                .select("id")
                .eq("org_id", str(org_id))
                .limit(1)
                .execute()
            )
            if existing.data:
                resp = await db.table("subscriptions").update({
                    "plan_id": plan["id"],
                    "status": "active",
                    "updated_at": now,
                }).eq("id", existing.data[0]["id"]).execute()  # type: ignore[index]
            else:
                resp = await db.table("subscriptions").insert({
                    "org_id": str(org_id),
                    "plan_id": plan["id"],
                    "status": "active",
                    "current_period_start": now,
                }).execute()
            row = resp.data[0] if resp.data else {}  # type: ignore[index]
            row["plans"] = plan
            return row
        except Exception:
            # Tables don't exist yet — return fallback
            return {"plans": plan, "status": "active"}
