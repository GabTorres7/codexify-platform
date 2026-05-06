from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.db.client import get_supabase
from app.dependencies import get_current_user

router = APIRouter(prefix="/orgs/{org_id}/dashboard", tags=["Dashboard"])


@router.get("/metrics")
async def get_metrics(
    org_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    """Aggregated metrics for the dashboard cards."""
    db = await get_supabase()

    # Get all repos in the org
    repos_resp = (
        await db.table("repositories")
        .select("id")
        .eq("org_id", str(org_id))
        .execute()
    )
    repo_ids = [r["id"] for r in (repos_resp.data or [])]

    if not repo_ids:
        return {
            "pending": 0,
            "approved": 0,
            "issues": 0,
            "merged": 0,
            "avg_score": 0,
            "total_repos": 0,
        }

    mrs_resp = (
        await db.table("merge_requests")
        .select("status, ai_score")
        .in_("repo_id", repo_ids)
        .execute()
    )
    mrs = mrs_resp.data or []

    counts = {"pending": 0, "approved": 0, "issues": 0, "merged": 0, "analyzing": 0}
    scores = []
    for mr in mrs:
        status = mr.get("status", "pending")
        if status in counts:
            counts[status] += 1
        if mr.get("ai_score") is not None:
            scores.append(mr["ai_score"])

    avg_score = round(sum(scores) / len(scores)) if scores else 0

    return {
        **counts,
        "avg_score": avg_score,
        "total_repos": len(repo_ids),
    }


@router.get("/activity")
async def get_activity(
    org_id: UUID,
    limit: int = Query(20, le=100),
    current_user: dict = Depends(get_current_user),
):
    """Recent activity feed."""
    db = await get_supabase()
    resp = (
        await db.table("activity_log")
        .select("*")
        .eq("org_id", str(org_id))
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return resp.data or []


@router.get("/chart")
async def get_chart_data(
    org_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    """Weekly MR activity counts for the bar chart (last 7 days)."""
    from datetime import UTC, datetime, timedelta

    db = await get_supabase()
    repos_resp = (
        await db.table("repositories")
        .select("id")
        .eq("org_id", str(org_id))
        .execute()
    )
    repo_ids = [r["id"] for r in (repos_resp.data or [])]
    if not repo_ids:
        return []

    now = datetime.now(UTC)
    seven_days_ago = (now - timedelta(days=7)).isoformat()

    mrs_resp = (
        await db.table("merge_requests")
        .select("created_at, status")
        .in_("repo_id", repo_ids)
        .gte("created_at", seven_days_ago)
        .execute()
    )

    # Bucket by day
    days: dict[str, dict] = {}
    for i in range(7):
        day = (now - timedelta(days=6 - i)).strftime("%a")
        days[day] = {"day": day, "opened": 0, "merged": 0}

    for mr in mrs_resp.data or []:
        day_label = datetime.fromisoformat(mr["created_at"]).strftime("%a")
        if day_label in days:
            days[day_label]["opened"] += 1
            if mr["status"] == "merged":
                days[day_label]["merged"] += 1

    return list(days.values())
