from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, Query

from app.core.exceptions import NotFoundError
from app.db.client import get_supabase
from app.dependencies import get_current_user
from app.models.analysis import AnalysisTriggerOut, MergeRequestDetailOut
from app.models.merge_request import MergeRequestListOut, MergeRequestOut
from app.services.analysis_service import AnalysisService

router = APIRouter(prefix="/orgs/{org_id}/repos/{repo_id}/mrs", tags=["Merge Requests"])

_analysis_svc = AnalysisService()


@router.get("", response_model=MergeRequestListOut)
async def list_merge_requests(
    org_id: UUID,
    repo_id: UUID,
    status: str | None = Query(None),
    author: str | None = Query(None),
    min_score: int | None = Query(None),
    max_score: int | None = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    query = (
        db.table("merge_requests")
        .select("*", count="exact")
        .eq("repo_id", str(repo_id))
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
    )
    if status:
        query = query.eq("status", status)
    if author:
        query = query.ilike("author_username", f"%{author}%")
    if min_score is not None:
        query = query.gte("ai_score", min_score)
    if max_score is not None:
        query = query.lte("ai_score", max_score)

    resp = await query.execute()
    return MergeRequestListOut(total=resp.count or 0, items=resp.data or [])


@router.get("/{mr_id}", response_model=MergeRequestDetailOut)
async def get_merge_request(
    org_id: UUID,
    repo_id: UUID,
    mr_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    """Get full MR detail including latest analysis (matches frontend data model)."""
    db = await get_supabase()

    mr_resp = (
        await db.table("merge_requests")
        .select("*")
        .eq("id", str(mr_id))
        .eq("repo_id", str(repo_id))
        .execute()
    )
    if not mr_resp.data:
        raise NotFoundError("Merge request", str(mr_id))

    mr = mr_resp.data[0]  # type: ignore[index]

    # Load the latest completed analysis
    analysis_resp = (
        await db.table("analyses")
        .select("*")
        .eq("mr_id", str(mr_id))
        .eq("status", "completed")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    diff: list = []
    issues: list = []
    rules: list = []
    categories = None

    if analysis_resp.data:
        analysis = analysis_resp.data[0]  # type: ignore[index]
        analysis_id = analysis["id"]

        issues_resp = (
            await db.table("analysis_issues")
            .select("*")
            .eq("analysis_id", analysis_id)
            .execute()
        )
        annotations_resp = (
            await db.table("analysis_diff_annotations")
            .select("*")
            .eq("analysis_id", analysis_id)
            .execute()
        )
        rules_resp = (
            await db.table("analysis_rule_results")
            .select("*")
            .eq("analysis_id", analysis_id)
            .execute()
        )

        issues = issues_resp.data or []

        # Group annotations by file
        annotations_by_file: dict[str, list] = {}
        for ann in annotations_resp.data or []:
            annotations_by_file.setdefault(ann["file_path"], []).append(
                {"after_line": ann["after_line"], "type": ann["type"], "text": ann["text"]}
            )

        # Build diff list (files + their annotations)
        for file_path, anns in annotations_by_file.items():
            diff.append({"file": file_path, "lines": [], "annotations": anns})

        rules = [
            {
                "rule_id": r.get("rule_id"),
                "rule_name": r["rule_name"],
                "status": r["status"],
                "description": r.get("description"),
            }
            for r in (rules_resp.data or [])
        ]

        if analysis.get("score_security") is not None:
            categories = {
                "security": analysis["score_security"],
                "performance": analysis["score_performance"],
                "readability": analysis["score_readability"],
                "business_rules": analysis["score_business_rules"],
            }

    # Build author dict (matching the frontend model)
    initials = "".join(
        w[0].upper()
        for w in (mr.get("author_name") or mr.get("author_username") or "U U").split()[:2]
    )
    author = {
        "name": mr.get("author_name") or mr.get("author_username", "Unknown"),
        "initials": initials,
        "color": "#818cf8",
    }

    return MergeRequestDetailOut(
        id=mr["id"],
        title=mr["title"],
        branch=mr["branch"],
        target_branch=mr["target_branch"],
        author=author,
        status=mr["status"],
        ai_score=mr.get("ai_score"),
        created_at=mr["created_at"],
        files_changed=mr["files_changed"],
        additions=mr["additions"],
        deletions=mr["deletions"],
        comments=mr["comments"],
        description=mr.get("description"),
        platform_url=mr.get("platform_url"),
        files=[],
        diff=diff,
        issues=issues,
        analysis_categories=categories,
        rules=rules,
    )


@router.post("/{mr_id}/analyze", response_model=AnalysisTriggerOut, status_code=202)
async def trigger_analysis(
    org_id: UUID,
    repo_id: UUID,
    mr_id: UUID,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """Trigger (or re-trigger) AI analysis for a merge request."""
    db = await get_supabase()
    mr_resp = (
        await db.table("merge_requests")
        .select("id")
        .eq("id", str(mr_id))
        .eq("repo_id", str(repo_id))
        .execute()
    )
    if not mr_resp.data:
        raise NotFoundError("Merge request", str(mr_id))

    analysis_id = await _analysis_svc.trigger_analysis(mr_id)
    background_tasks.add_task(_analysis_svc.run_analysis, analysis_id)

    return AnalysisTriggerOut(
        analysis_id=analysis_id,
        status="queued",
        message="Analysis started — poll GET /analyses/{analysis_id} for results",
    )


@router.get("/{mr_id}/diff")
async def get_mr_diff(
    org_id: UUID,
    repo_id: UUID,
    mr_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    """Fetch the raw diff data for a merge request from the git platform."""
    db = await get_supabase()

    mr_resp = (
        await db.table("merge_requests")
        .select("*, repositories(*)")
        .eq("id", str(mr_id))
        .eq("repo_id", str(repo_id))
        .single()
        .execute()
    )
    if not mr_resp.data:
        raise NotFoundError("Merge request", str(mr_id))

    mr = mr_resp.data
    repo = mr["repositories"]

    from app.services.git_platform_factory import get_git_service

    git_svc = get_git_service(repo["platform"], repo["access_token"])

    if repo["platform"] == "github":
        file_diffs = await git_svc.get_pr_diff(repo["full_name"], mr["platform_id"])
    else:
        file_diffs = await git_svc.get_mr_diff(repo["platform_id"], mr["platform_id"])

    return [
        {
            "file": f.file,
            "diff_text": f.diff_text,
            "additions": f.additions,
            "deletions": f.deletions,
        }
        for f in file_diffs
    ]


@router.get("/{mr_id}/analyses", response_model=list[dict])
async def list_analyses_for_mr(
    org_id: UUID,
    repo_id: UUID,
    mr_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    """List all historical analysis runs for a merge request."""
    db = await get_supabase()
    resp = (
        await db.table("analyses")
        .select("id, status, ai_score, started_at, completed_at, created_at")
        .eq("mr_id", str(mr_id))
        .order("created_at", desc=True)
        .execute()
    )
    return resp.data or []
