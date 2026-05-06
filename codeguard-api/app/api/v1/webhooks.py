"""
Webhook receivers for GitHub and GitLab.
Verify signature → find repository → trigger analysis in background.
"""
from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request

from app.db.client import get_supabase
from app.services.analysis_service import AnalysisService
from app.services.webhook_service import (
    is_github_pr_event,
    is_gitlab_mr_event,
    verify_github_signature,
    verify_gitlab_token,
)

router = APIRouter(prefix="/webhooks", tags=["Webhooks"])

_analysis_svc = AnalysisService()


@router.post("/github")
async def github_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_github_event: str = Header(default=""),
    x_hub_signature_256: str = Header(default=""),
):
    payload_bytes = await request.body()
    payload = await request.json()

    repo_full_name = payload.get("repository", {}).get("full_name", "")
    if not repo_full_name:
        raise HTTPException(status_code=400, detail="Missing repository in payload")

    db = await get_supabase()
    repo_resp = (
        await db.table("repositories")
        .select("id, webhook_secret, auto_analyze")
        .eq("full_name", repo_full_name)
        .eq("platform", "github")
        .execute()
    )
    if not repo_resp.data:
        raise HTTPException(status_code=404, detail="Repository not registered")

    repo = repo_resp.data[0]

    # Verify signature
    if not verify_github_signature(payload_bytes, x_hub_signature_256, repo["webhook_secret"]):
        raise HTTPException(status_code=403, detail="Invalid webhook signature")

    if not is_github_pr_event(x_github_event, payload):
        return {"status": "ignored", "reason": "Not a relevant PR event"}

    # Find or create the MR record
    pr = payload.get("pull_request", {})
    mr_resp = (
        await db.table("merge_requests")
        .select("id")
        .eq("repo_id", repo["id"])
        .eq("platform_id", str(pr.get("number", "")))
        .execute()
    )

    if not mr_resp.data:
        from datetime import UTC, datetime

        mr_insert = await db.table("merge_requests").insert(
            {
                "repo_id": repo["id"],
                "platform_id": str(pr["number"]),
                "title": pr.get("title", ""),
                "description": pr.get("body"),
                "branch": pr["head"]["ref"],
                "target_branch": pr["base"]["ref"],
                "author_name": pr["user"]["login"],
                "author_username": pr["user"]["login"],
                "author_avatar": pr["user"].get("avatar_url"),
                "platform_status": pr.get("state", "open"),
                "files_changed": pr.get("changed_files", 0),
                "additions": pr.get("additions", 0),
                "deletions": pr.get("deletions", 0),
                "comments": pr.get("comments", 0),
                "platform_url": pr.get("html_url"),
                "platform_created_at": pr.get("created_at"),
                "status": "pending",
            }
        ).execute()
        mr_id = mr_insert.data[0]["id"]
    else:
        mr_id = mr_resp.data[0]["id"]

    if repo["auto_analyze"]:
        from uuid import UUID
        analysis_id = await _analysis_svc.trigger_analysis(UUID(mr_id))
        background_tasks.add_task(_analysis_svc.run_analysis, analysis_id)

    return {"status": "queued", "mr_id": mr_id}


@router.post("/gitlab")
async def gitlab_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
    x_gitlab_token: str = Header(default=""),
):
    payload = await request.json()

    project_id = str(payload.get("project", {}).get("id", ""))
    if not project_id:
        raise HTTPException(status_code=400, detail="Missing project ID in payload")

    db = await get_supabase()
    repo_resp = (
        await db.table("repositories")
        .select("id, webhook_secret, auto_analyze")
        .eq("platform_id", project_id)
        .eq("platform", "gitlab")
        .execute()
    )
    if not repo_resp.data:
        raise HTTPException(status_code=404, detail="Repository not registered")

    repo = repo_resp.data[0]

    if not verify_gitlab_token(x_gitlab_token, repo["webhook_secret"]):
        raise HTTPException(status_code=403, detail="Invalid webhook token")

    if not is_gitlab_mr_event(payload):
        return {"status": "ignored", "reason": "Not a relevant MR event"}

    attrs = payload.get("object_attributes", {})
    mr_iid = str(attrs.get("iid", ""))

    mr_resp = (
        await db.table("merge_requests")
        .select("id")
        .eq("repo_id", repo["id"])
        .eq("platform_id", mr_iid)
        .execute()
    )

    if not mr_resp.data:
        author = payload.get("user", {})
        mr_insert = await db.table("merge_requests").insert(
            {
                "repo_id": repo["id"],
                "platform_id": mr_iid,
                "title": attrs.get("title", ""),
                "description": attrs.get("description"),
                "branch": attrs.get("source_branch", ""),
                "target_branch": attrs.get("target_branch", ""),
                "author_name": author.get("name", ""),
                "author_username": author.get("username", ""),
                "author_avatar": author.get("avatar_url"),
                "platform_status": attrs.get("state", "opened"),
                "platform_url": attrs.get("url"),
                "status": "pending",
            }
        ).execute()
        mr_id = mr_insert.data[0]["id"]
    else:
        mr_id = mr_resp.data[0]["id"]

    if repo["auto_analyze"]:
        from uuid import UUID
        analysis_id = await _analysis_svc.trigger_analysis(UUID(mr_id))
        background_tasks.add_task(_analysis_svc.run_analysis, analysis_id)

    return {"status": "queued", "mr_id": mr_id}
