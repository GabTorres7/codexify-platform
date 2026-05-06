from uuid import UUID

from fastapi import APIRouter, Depends

from app.core.exceptions import NotFoundError
from app.db.client import get_supabase
from app.dependencies import get_current_user
from app.services.analysis_service import AnalysisService

router = APIRouter(prefix="/analyses", tags=["Analyses"])

_analysis_svc = AnalysisService()


@router.get("/{analysis_id}")
async def get_analysis(
    analysis_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    """Get a complete analysis result including issues, diff annotations, and rule results."""
    result = await _analysis_svc.get_analysis_detail(analysis_id)
    if not result:
        raise NotFoundError("Analysis", str(analysis_id))
    return result


@router.get("/{analysis_id}/issues")
async def get_analysis_issues(
    analysis_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    resp = (
        await db.table("analysis_issues")
        .select("*")
        .eq("analysis_id", str(analysis_id))
        .order("severity")
        .execute()
    )
    return resp.data or []


@router.get("/{analysis_id}/annotations")
async def get_analysis_annotations(
    analysis_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    resp = (
        await db.table("analysis_diff_annotations")
        .select("*")
        .eq("analysis_id", str(analysis_id))
        .execute()
    )
    return resp.data or []


@router.get("/{analysis_id}/rules")
async def get_analysis_rule_results(
    analysis_id: UUID,
    current_user: dict = Depends(get_current_user),
):
    db = await get_supabase()
    resp = (
        await db.table("analysis_rule_results")
        .select("*")
        .eq("analysis_id", str(analysis_id))
        .execute()
    )
    return resp.data or []
