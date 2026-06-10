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


@router.get("/analytics")
async def get_analytics(
    org_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    """
    Historical analytics: dev ranking, issue heatmap, score evolution.
    """
    import asyncio
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
        return {"dev_ranking": [], "issue_heatmap": [], "score_evolution": []}

    now = datetime.now(UTC)
    eight_weeks_ago = (now - timedelta(weeks=8)).isoformat()

    # Parallel: fetch MRs + MR IDs for analyses in one shot
    mrs_task = (
        db.table("merge_requests")
        .select("id, author_username, author_name, ai_score, status, created_at")
        .in_("repo_id", repo_ids)
        .execute()
    )
    mrs_resp = await mrs_task
    all_mrs = mrs_resp.data or []

    # ── Dev Ranking ──
    dev_stats: dict[str, dict] = {}
    mr_ids = []
    for mr in all_mrs:
        mr_ids.append(mr["id"])
        author = mr.get("author_username") or mr.get("author_name") or "unknown"
        if author not in dev_stats:
            dev_stats[author] = {
                "author": mr.get("author_name") or author,
                "total_mrs": 0,
                "scores": [],
                "approved": 0,
                "issues": 0,
            }
        dev_stats[author]["total_mrs"] += 1
        if mr.get("ai_score") is not None:
            dev_stats[author]["scores"].append(mr["ai_score"])
        if mr.get("status") in ("approved", "merged"):
            dev_stats[author]["approved"] += 1
        elif mr.get("status") == "issues":
            dev_stats[author]["issues"] += 1

    dev_ranking = sorted(
        [
            {
                "author": d["author"],
                "total_mrs": d["total_mrs"],
                "avg_score": round(sum(d["scores"]) / len(d["scores"])) if d["scores"] else 0,
                "approved": d["approved"],
                "issues": d["issues"],
            }
            for d in dev_stats.values()
        ],
        key=lambda x: x["avg_score"],
        reverse=True,
    )

    # ── Issue Heatmap + Score Evolution: parallel queries ──
    async def fetch_issue_heatmap():
        if not mr_ids:
            return {"critical": 0, "warning": 0, "info": 0, "suggestion": 0}
        analyses_resp = (
            await db.table("analyses")
            .select("id")
            .in_("mr_id", mr_ids[:200])
            .eq("status", "completed")
            .execute()
        )
        analysis_ids = [a["id"] for a in (analyses_resp.data or [])]
        heatmap = {"critical": 0, "warning": 0, "info": 0, "suggestion": 0}
        if analysis_ids:
            issues_resp = (
                await db.table("analysis_issues")
                .select("severity")
                .in_("analysis_id", analysis_ids[:200])
                .execute()
            )
            for issue in issues_resp.data or []:
                sev = issue.get("severity", "info")
                if sev in heatmap:
                    heatmap[sev] += 1
        return heatmap

    async def fetch_score_evolution():
        score_mrs_resp = (
            await db.table("merge_requests")
            .select("ai_score, created_at")
            .in_("repo_id", repo_ids)
            .gte("created_at", eight_weeks_ago)
            .not_.is_("ai_score", "null")
            .execute()
        )
        score_mrs = score_mrs_resp.data or []
        evolution = []
        for weeks_ago in range(7, -1, -1):
            week_start = now - timedelta(weeks=weeks_ago + 1)
            week_end = now - timedelta(weeks=weeks_ago)
            scores = [
                m["ai_score"] for m in score_mrs
                if m.get("ai_score") and week_start.isoformat() <= m["created_at"] < week_end.isoformat()
            ]
            evolution.append({
                "week": week_end.strftime("%d/%m"),
                "avg_score": round(sum(scores) / len(scores)) if scores else None,
                "count": len(scores),
            })
        return evolution

    issue_heatmap, score_evolution = await asyncio.gather(
        fetch_issue_heatmap(),
        fetch_score_evolution(),
    )

    return {
        "dev_ranking": dev_ranking,
        "issue_heatmap": issue_heatmap,
        "score_evolution": score_evolution,
    }
