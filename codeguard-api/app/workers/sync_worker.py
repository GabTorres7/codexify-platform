"""
Background worker for syncing MRs/PRs from git platforms.

Pulls open MRs from GitHub/GitLab and upserts them into the database.
Optionally auto-triggers analysis for new MRs if the repo has auto_analyze enabled.
"""
from datetime import UTC, datetime
from uuid import UUID

import structlog

from app.db.client import get_supabase
from app.services.analysis_service import AnalysisService
from app.services.git_platform_factory import get_git_service

logger = structlog.get_logger()

_analysis_svc = AnalysisService()


async def sync_repo_mrs(repo: dict) -> None:
    """
    Fetch all open MRs/PRs from the git platform and upsert into the DB.
    If repo.auto_analyze is True, triggers analysis for newly discovered MRs.
    """
    db = await get_supabase()
    try:
        git_svc = get_git_service(repo["platform"], repo["access_token"])

        if repo["platform"] == "github":
            mrs = await git_svc.list_open_prs(repo["full_name"])
        else:
            mrs = await git_svc.list_open_mrs(repo["platform_id"])

        new_mr_ids: list[UUID] = []

        for mr in mrs:
            payload = {
                "repo_id": repo["id"],
                "platform_id": mr.platform_id,
                "title": mr.title,
                "description": mr.description,
                "branch": mr.branch,
                "target_branch": mr.target_branch,
                "author_name": mr.author_name,
                "author_username": mr.author_username,
                "author_avatar": mr.author_avatar,
                "platform_status": mr.platform_status,
                "files_changed": mr.files_changed,
                "additions": mr.additions,
                "deletions": mr.deletions,
                "comments": mr.comments,
                "platform_url": mr.platform_url,
                "platform_created_at": mr.platform_created_at,
                "updated_at": datetime.now(UTC).isoformat(),
            }

            existing = (
                await db.table("merge_requests")
                .select("id, status")
                .eq("repo_id", repo["id"])
                .eq("platform_id", mr.platform_id)
                .execute()
            )

            if existing.data:
                await db.table("merge_requests").update(payload).eq(
                    "id", existing.data[0]["id"]  # type: ignore[index]
                ).execute()
            else:
                payload["status"] = "pending"
                insert_resp = await db.table("merge_requests").insert(payload).execute()
                if insert_resp.data:
                    new_mr_ids.append(UUID(insert_resp.data[0]["id"]))  # type: ignore[index]

        # Update last synced timestamp
        await db.table("repositories").update(
            {"last_synced_at": datetime.now(UTC).isoformat()}
        ).eq("id", repo["id"]).execute()

        logger.info(
            "sync_completed",
            repo=repo["full_name"],
            total=len(mrs),
            new=len(new_mr_ids),
        )

        # Auto-analyze new MRs if enabled
        if repo.get("auto_analyze") and new_mr_ids:
            for mr_id in new_mr_ids:
                try:
                    analysis_id = await _analysis_svc.trigger_analysis(mr_id)
                    await _analysis_svc.run_analysis(analysis_id)
                except Exception as exc:
                    logger.warning(
                        "auto_analyze_failed",
                        mr_id=str(mr_id),
                        error=str(exc),
                    )

    except Exception as exc:
        logger.error("sync_failed", repo=repo["full_name"], error=str(exc))


async def sync_all_repos(org_id: UUID) -> dict:
    """
    Sync all active repositories for an organization.
    Returns summary of results.
    """
    db = await get_supabase()
    repos_resp = (
        await db.table("repositories")
        .select("*")
        .eq("org_id", str(org_id))
        .eq("is_active", True)
        .execute()
    )

    results = {"synced": 0, "failed": 0}
    for repo in repos_resp.data or []:
        try:
            await sync_repo_mrs(repo)
            results["synced"] += 1
        except Exception:
            results["failed"] += 1

    return results
