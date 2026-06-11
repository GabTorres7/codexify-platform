"""
Repository management:
  - Add single repo
  - Bulk add many repos (enterprise)
  - List, update, delete
  - Manual sync trigger
  - Whole-repo analysis
"""
import secrets
from datetime import UTC, datetime
from uuid import UUID

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, Query

from app.config import get_settings
from app.core.exceptions import ConflictError, NotFoundError
from app.db.client import get_supabase
from app.dependencies import get_current_user, require_admin
from app.models.repository import (
    RepositoryBulkCreate,
    RepositoryBulkResult,
    RepositoryCreate,
    RepositoryOut,
    RepositoryUpdate,
)
from app.services.analysis_service import AnalysisService
from app.services.git_platform_factory import get_git_service

logger = structlog.get_logger()
settings = get_settings()
_analysis_svc = AnalysisService()

router = APIRouter(prefix="/orgs/{org_id}/repos", tags=["Repositories"])


async def _add_single_repo(org_id: UUID, body: RepositoryCreate, db) -> dict:
    """
    Validate the token, fetch repo metadata from the git platform,
    and persist the repository record. Returns the row dict or raises.
    """
    git_svc = get_git_service(body.platform, body.access_token)
    repo_info = await git_svc.validate_token(body.full_name)

    # Platform-specific ID
    platform_id = str(repo_info.get("id", body.full_name))
    name = repo_info.get("name", body.full_name.split("/")[-1])
    url = repo_info.get("html_url") or repo_info.get("web_url", "")

    # Check for duplicates in this org
    existing = (
        await db.table("repositories")
        .select("id")
        .eq("org_id", str(org_id))
        .eq("platform", body.platform)
        .eq("platform_id", platform_id)
        .execute()
    )
    if existing.data:
        raise ConflictError(f"Repository '{body.full_name}' is already registered in this org")

    webhook_secret = secrets.token_hex(32)

    row = {
        "org_id": str(org_id),
        "platform": body.platform,
        "platform_id": platform_id,
        "full_name": body.full_name,
        "name": name,
        "url": url,
        "default_branch": body.default_branch,
        "access_token": body.access_token,
        "auto_analyze": body.auto_analyze,
        "min_score": body.min_score,
        "webhook_secret": webhook_secret,
    }
    resp = await db.table("repositories").insert(row).execute()
    return resp.data[0]  # type: ignore[index]


async def _register_webhook_bg(repo_row: dict) -> None:
    """Background task: register webhook on the git platform."""
    try:
        git_svc = get_git_service(repo_row["platform"], repo_row["access_token"])
        callback_url = (
            f"{settings.public_api_url}/api/v1/webhooks/{repo_row['platform']}"
        )
        webhook_id = await git_svc.register_webhook(
            repo_row["full_name"] if repo_row["platform"] == "github" else repo_row["platform_id"],
            callback_url,
            repo_row["webhook_secret"],
        )
        db = await get_supabase()
        await db.table("repositories").update({"webhook_id": webhook_id}).eq(
            "id", repo_row["id"]
        ).execute()
        logger.info("webhook_registered", repo=repo_row["full_name"], webhook_id=webhook_id)
    except Exception as exc:
        logger.warning("webhook_registration_failed", repo=repo_row["full_name"], error=str(exc))


@router.post("", response_model=RepositoryOut, status_code=201)
async def add_repository(
    org_id: UUID,
    body: RepositoryCreate,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(require_admin),
):
    """Add a single repository to the organization."""
    db = await get_supabase()
    repo_row = await _add_single_repo(org_id, body, db)
    background_tasks.add_task(_register_webhook_bg, repo_row)
    logger.info("repository_added", org_id=str(org_id), repo=body.full_name)
    return repo_row


@router.post("/bulk", response_model=RepositoryBulkResult, status_code=207)
async def bulk_add_repositories(
    org_id: UUID,
    body: RepositoryBulkCreate,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(require_admin),
):
    """
    Add many repositories at once.
    Returns a 207 Multi-Status with succeeded and failed lists.
    Useful for onboarding an entire organization's repos in one request.
    """
    db = await get_supabase()
    succeeded: list[RepositoryOut] = []
    failed: list[dict] = []

    for repo_body in body.repositories:
        try:
            repo_row = await _add_single_repo(org_id, repo_body, db)
            background_tasks.add_task(_register_webhook_bg, repo_row)
            succeeded.append(RepositoryOut(**repo_row))
            logger.info("bulk_repo_added", repo=repo_body.full_name)
        except Exception as exc:
            failed.append({"full_name": repo_body.full_name, "error": str(exc)})
            logger.warning("bulk_repo_failed", repo=repo_body.full_name, error=str(exc))

    return RepositoryBulkResult(succeeded=succeeded, failed=failed)


@router.get("/available")
async def list_available_repos(
    org_id: UUID,
    platform: str = Query("github"),
    token: str = Query(...),
    current_user: dict = Depends(require_admin),
):
    """Fetch all repos accessible by the provided token from GitHub/GitLab."""
    git_svc = get_git_service(platform, token)
    repos = await git_svc.list_user_repos()

    db = await get_supabase()
    existing = (
        await db.table("repositories")
        .select("full_name")
        .eq("org_id", str(org_id))
        .execute()
    )
    already_added = [r["full_name"] for r in (existing.data or [])]

    return {"repos": repos, "already_added": already_added}


@router.get("")
async def list_repositories(
    org_id: UUID,
    active_only: bool = Query(False),
    current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    query = (
        db.table("repositories")
        .select("*")
        .eq("org_id", str(org_id))
        .order("created_at", desc=True)
    )
    if active_only:
        query = query.eq("is_active", True)
    resp = await query.execute()
    repos = resp.data or []

    for repo in repos:
        mr_resp = (
            await db.table("merge_requests")
            .select("ai_score")
            .eq("repo_id", repo["id"])
            .not_.is_("ai_score", "null")
            .execute()
        )
        scores = [r["ai_score"] for r in (mr_resp.data or []) if r.get("ai_score") is not None]
        repo["avg_score"] = round(sum(scores) / len(scores)) if scores else None
        repo["total_analyses"] = len(scores)

    return repos


@router.get("/{repo_id}", response_model=RepositoryOut)
async def get_repository(
    org_id: UUID,
    repo_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    resp = (
        await db.table("repositories")
        .select("*")
        .eq("id", str(repo_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not resp.data:
        raise NotFoundError("Repository", str(repo_id))
    return resp.data[0]  # type: ignore[index]


@router.patch("/{repo_id}", response_model=RepositoryOut)
async def update_repository(
    org_id: UUID,
    repo_id: UUID,
    body: RepositoryUpdate,
    current_user: dict = Depends(require_admin),
):
    db = await get_supabase()
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    resp = (
        await db.table("repositories")
        .update(data)
        .eq("id", str(repo_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not resp.data:
        raise NotFoundError("Repository", str(repo_id))
    return resp.data[0]  # type: ignore[index]


@router.delete("/{repo_id}", status_code=204)
async def delete_repository(
    org_id: UUID,
    repo_id: UUID,
    current_user: dict = Depends(require_admin),
):
    db = await get_supabase()
    # Load repo to delete webhook
    repo_resp = (
        await db.table("repositories")
        .select("*")
        .eq("id", str(repo_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not repo_resp.data:
        raise NotFoundError("Repository", str(repo_id))

    repo = repo_resp.data[0]  # type: ignore[index]

    # Delete webhook from platform
    if repo.get("webhook_id"):
        try:
            git_svc = get_git_service(repo["platform"], repo["access_token"])
            if repo["platform"] == "github":
                await git_svc.delete_webhook(repo["full_name"], repo["webhook_id"])
            else:
                await git_svc.delete_webhook(repo["platform_id"], repo["webhook_id"])
        except Exception as exc:
            logger.warning("webhook_delete_failed", error=str(exc))

    await db.table("repositories").delete().eq("id", str(repo_id)).execute()


@router.post("/{repo_id}/sync", status_code=202)
async def sync_repository(
    org_id: UUID,
    repo_id: UUID,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Manually trigger a sync of open MRs/PRs from the git platform."""
    db = await get_supabase()
    repo_resp = (
        await db.table("repositories")
        .select("*")
        .eq("id", str(repo_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not repo_resp.data:
        raise NotFoundError("Repository", str(repo_id))

    repo = repo_resp.data[0]  # type: ignore[index]
    background_tasks.add_task(_sync_mrs_bg, repo)
    return {"message": "Sync started", "repo_id": str(repo_id)}


@router.get("/{repo_id}/rules")
async def get_repo_rules(
    org_id: UUID,
    repo_id: UUID,
    active_only: bool = Query(False),
    current_user: dict = Depends(get_current_user),
):
    """List rules applicable to this repo (org-wide defaults + repo-specific overrides)."""
    db = await get_supabase()
    from app.services.rule_service import RuleService
    svc = RuleService(db)
    if active_only:
        return await svc.get_effective_rules(org_id, repo_id)
    return await svc.list_rules(org_id, repo_id=repo_id)


@router.post("/{repo_id}/analyze", status_code=202)
async def analyze_repository(
    org_id: UUID,
    repo_id: UUID,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Analyze the entire repository's source code (not just a MR diff)."""
    db = await get_supabase()
    repo_resp = (
        await db.table("repositories")
        .select("*")
        .eq("id", str(repo_id))
        .eq("org_id", str(org_id))
        .execute()
    )
    if not repo_resp.data:
        raise NotFoundError("Repository", str(repo_id))

    repo = repo_resp.data[0]

    mr_resp = await db.table("merge_requests").insert({
        "repo_id": str(repo_id),
        "platform_id": f"repo-analysis-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}",
        "title": f"Análise completa: {repo['full_name']}",
        "description": "Análise automática do repositório inteiro",
        "branch": repo.get("default_branch", "main"),
        "target_branch": repo.get("default_branch", "main"),
        "author_name": current_user.get("name", "System"),
        "author_username": current_user.get("email", "system"),
        "status": "analyzing",
        "files_changed": 0,
        "additions": 0,
        "deletions": 0,
        "comments": 0,
    }).execute()
    mr_id = mr_resp.data[0]["id"]

    analysis_resp = await db.table("analyses").insert({
        "mr_id": mr_id,
        "status": "queued",
    }).execute()
    analysis_id = analysis_resp.data[0]["id"]

    background_tasks.add_task(_run_repo_analysis, repo, mr_id, analysis_id)
    return {"message": "Análise do repositório iniciada", "analysis_id": analysis_id, "mr_id": mr_id}


async def _run_repo_analysis(repo: dict, mr_id: str, analysis_id: str) -> None:
    """Background: fetch repo files and run AI analysis."""
    db = await get_supabase()
    try:
        await db.table("analyses").update({
            "status": "running",
            "started_at": datetime.now(UTC).isoformat(),
        }).eq("id", analysis_id).execute()

        git_svc = get_git_service(repo["platform"], repo["access_token"])
        files_diff = await git_svc.fetch_repo_files(
            repo["full_name"], repo.get("default_branch", "main")
        )

        if not files_diff:
            raise Exception("Nenhum arquivo fonte encontrado no repositório")

        claude_result = await _analysis_svc._ai.analyze_merge_request(
            mr_title=f"Análise completa: {repo['full_name']}",
            mr_description="Análise de qualidade do repositório inteiro",
            files_diff=files_diff,
            rules=[],
        )

        from app.services.analysis_service import compute_weighted_score
        ai_score = compute_weighted_score(claude_result)
        claude_result["ai_score"] = ai_score
        claude_result["_files_diff"] = files_diff

        now = datetime.now(UTC).isoformat()
        new_status = "approved" if ai_score >= repo.get("min_score", 50) else "issues"

        await db.table("analyses").update({
            "status": "completed",
            "ai_score": ai_score,
            "score_security": claude_result.get("score_security"),
            "score_performance": claude_result.get("score_performance"),
            "score_readability": claude_result.get("score_readability"),
            "score_business_rules": claude_result.get("score_business_rules"),
            "raw_claude_response": claude_result,
            "completed_at": now,
        }).eq("id", analysis_id).execute()

        if claude_result.get("issues"):
            await db.table("analysis_issues").insert([
                {
                    "analysis_id": analysis_id,
                    "severity": i.get("severity", "info"),
                    "title": i.get("title", ""),
                    "description": i.get("description"),
                    "file_path": i.get("file_path"),
                    "line_ref": i.get("line_ref"),
                    "suggestion": i.get("suggestion"),
                }
                for i in claude_result["issues"]
            ]).execute()

        await db.table("merge_requests").update({
            "status": new_status, "ai_score": ai_score, "updated_at": now,
        }).eq("id", mr_id).execute()

        logger.info("repo_analysis_completed", repo=repo["full_name"], ai_score=ai_score)

    except Exception as exc:
        logger.error("repo_analysis_failed", repo=repo["full_name"], error=str(exc))
        await db.table("analyses").update({
            "status": "failed",
            "error_message": str(exc),
            "completed_at": datetime.now(UTC).isoformat(),
        }).eq("id", analysis_id).execute()
        await db.table("merge_requests").update({"status": "issues"}).eq("id", mr_id).execute()


async def _sync_mrs_bg(repo: dict) -> None:
    """Background task: fetch open MRs and upsert into the database."""
    from datetime import UTC, datetime

    db = await get_supabase()
    try:
        git_svc = get_git_service(repo["platform"], repo["access_token"])

        if repo["platform"] == "github":
            mrs = await git_svc.list_open_prs(repo["full_name"])
        else:
            mrs = await git_svc.list_open_mrs(repo["platform_id"])

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
            # Upsert — update if already exists
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
                await db.table("merge_requests").insert(payload).execute()

        await db.table("repositories").update(
            {"last_synced_at": datetime.now(UTC).isoformat()}
        ).eq("id", repo["id"]).execute()

        logger.info("sync_completed", repo=repo["full_name"], count=len(mrs))

    except Exception as exc:
        logger.error("sync_failed", repo=repo["full_name"], error=str(exc))
