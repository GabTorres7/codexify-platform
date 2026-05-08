"""
Public API — designed for CI/CD and CLI usage.

All endpoints require API key auth (cg_live_...) and respect plan quotas.

POST /api/v1/public/analyze          — submit a diff for analysis (sync or async)
GET  /api/v1/public/analyze/{id}     — poll analysis result
GET  /api/v1/public/status           — API key info + usage + plan
"""
import asyncio
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, File, Form, Query, UploadFile

from app.db.client import get_supabase
from app.dependencies import get_current_user
from app.services.analysis_service import AnalysisService
from app.services.billing_service import BillingService

logger = structlog.get_logger()
router = APIRouter(prefix="/public", tags=["Public API / CLI"])

_analysis_svc = AnalysisService()
_billing = BillingService()


@router.get("/status")
async def api_status(current_user: dict = Depends(get_current_user)):
    """
    Returns API key info, current plan, and usage for the month.
    Used by the CLI to show `codexfy status`.
    """
    org_id = current_user.get("org_id")
    if not org_id:
        return {"error": "No organization associated with this key"}

    sub = await _billing.get_subscription(UUID(org_id))
    usage = await _billing.get_usage(UUID(org_id))
    plan = sub.get("plans", {}) if sub else {}

    return {
        "org_id": org_id,
        "plan": plan.get("slug", "free"),
        "plan_name": plan.get("name", "Free"),
        "usage": {
            "analyses": usage.get("analyses", 0),
            "chat_msgs": usage.get("chat_msgs", 0),
            "api_calls": usage.get("api_calls", 0),
        },
        "limits": {
            "max_analyses": plan.get("max_analyses", 50),
            "max_chat_msgs": plan.get("max_chat_msgs", 20),
        },
        "auth_type": current_user.get("auth_type", "jwt"),
    }


@router.post("/analyze")
async def public_analyze(
    current_user: dict = Depends(get_current_user),
    title: str = Form("Code Analysis"),
    description: str = Form(""),
    diff_text: str = Form(""),
    file: UploadFile | None = File(None),
    wait: bool = Query(False, description="If true, wait for analysis to complete (sync mode, max 120s)"),
):
    """
    Submit code for AI analysis.

    Usage from CLI:
      curl -X POST https://api.codexfy.dev/api/v1/public/analyze \\
        -H "Authorization: Bearer cg_live_xxx" \\
        -F "title=My PR" \\
        -F "file=@changes.patch" \\
        -F "wait=true"

    Or with npx:
      npx codexfy analyze --diff ./my.patch --wait
    """
    org_id = current_user.get("org_id")
    if not org_id:
        return {"error": "No organization associated"}

    # Check quota
    quota = await _billing.check_quota(UUID(org_id), "analyses")
    if not quota["allowed"]:
        return {
            "error": "quota_exceeded",
            "message": f"Limite de analises atingido ({quota['current']}/{quota['limit']}). Upgrade seu plano.",
            "plan": quota["plan"],
            "current": quota["current"],
            "limit": quota["limit"],
        }

    # Resolve diff
    raw_diff = diff_text.strip()
    if file is not None:
        file_data = await file.read()
        if len(file_data) > 5 * 1024 * 1024:
            return {"error": "file_too_large", "message": "Max 5 MB"}
        raw_diff = file_data.decode("utf-8", errors="replace")

    if not raw_diff:
        return {"error": "no_diff", "message": "Envie diff_text ou file"}

    db = await get_supabase()

    # Find or create upload repo
    upload_repo_resp = (
        await db.table("repositories")
        .select("id")
        .eq("org_id", org_id)
        .eq("platform_id", "__upload__")
        .limit(1)
        .execute()
    )
    if upload_repo_resp.data:
        repo_id = upload_repo_resp.data[0]["id"]  # type: ignore[index]
    else:
        r = await db.table("repositories").insert({
            "org_id": org_id, "platform": "github", "platform_id": "__upload__",
            "full_name": "cli/analysis", "name": "CLI", "url": "",
            "auto_analyze": False, "is_active": True,
        }).execute()
        repo_id = r.data[0]["id"]  # type: ignore[index]

    import hashlib
    uid = hashlib.md5(raw_diff[:200].encode()).hexdigest()[:12]

    mr_resp = await db.table("merge_requests").insert({
        "repo_id": repo_id, "platform_id": f"cli-{uid}",
        "title": title.strip() or "CLI Analysis",
        "description": description.strip() or None,
        "branch": "cli", "target_branch": "main",
        "author_name": "CLI", "author_username": current_user.get("email", "cli"),
        "status": "pending", "platform_status": "open",
        "files_changed": raw_diff.count("\ndiff --git") + (1 if "diff --git" not in raw_diff else 0),
        "additions": raw_diff.count("\n+"), "deletions": raw_diff.count("\n-"),
    }).execute()
    mr_id = UUID(mr_resp.data[0]["id"])  # type: ignore[index]

    analysis_id = await _analysis_svc.trigger_analysis(mr_id)

    # Track usage
    await _billing.increment_usage(UUID(org_id), "analyses")
    await _billing.increment_usage(UUID(org_id), "api_calls")

    # Sync mode: wait for completion
    if wait:
        # Run analysis inline (not background)
        await _analysis_svc.run_upload_analysis(
            analysis_id=analysis_id,
            mr_title=title.strip() or "CLI Analysis",
            mr_description=description.strip(),
            raw_diff=raw_diff,
        )
        detail = await _analysis_svc.get_analysis_detail(analysis_id)
        return {
            "analysis_id": str(analysis_id),
            "status": detail.get("status", "completed") if detail else "failed",
            "ai_score": detail.get("ai_score") if detail else None,
            "score_security": detail.get("score_security") if detail else None,
            "score_performance": detail.get("score_performance") if detail else None,
            "score_readability": detail.get("score_readability") if detail else None,
            "score_business_rules": detail.get("score_business_rules") if detail else None,
            "issues": detail.get("issues", []) if detail else [],
            "rule_results": detail.get("rule_results", []) if detail else [],
        }

    # Async mode: run in background, return ID
    # We need to start the analysis in a background task
    # Since we're not in a FastAPI endpoint with BackgroundTasks easily,
    # use asyncio.create_task
    asyncio.create_task(_analysis_svc.run_upload_analysis(
        analysis_id=analysis_id,
        mr_title=title.strip() or "CLI Analysis",
        mr_description=description.strip(),
        raw_diff=raw_diff,
    ))

    return {
        "analysis_id": str(analysis_id),
        "mr_id": str(mr_id),
        "status": "queued",
        "poll_url": f"/api/v1/public/analyze/{analysis_id}",
        "stream_url": f"/api/v1/analyses/{analysis_id}/stream",
    }


@router.get("/analyze/{analysis_id}")
async def get_public_analysis(
    analysis_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    """
    Poll for analysis result. Used by CLI in async mode.
    Returns the full analysis when completed.
    """
    detail = await _analysis_svc.get_analysis_detail(analysis_id)
    if not detail:
        return {"error": "not_found"}

    return {
        "analysis_id": str(analysis_id),
        "status": detail.get("status"),
        "ai_score": detail.get("ai_score"),
        "score_security": detail.get("score_security"),
        "score_performance": detail.get("score_performance"),
        "score_readability": detail.get("score_readability"),
        "score_business_rules": detail.get("score_business_rules"),
        "issues": detail.get("issues", []),
        "diff_annotations": detail.get("diff_annotations", []),
        "rule_results": detail.get("rule_results", []),
        "error_message": detail.get("error_message"),
    }
