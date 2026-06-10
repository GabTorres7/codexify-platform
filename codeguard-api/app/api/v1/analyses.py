import asyncio
import json
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.core.exceptions import NotFoundError
from app.db.client import get_supabase
from app.dependencies import get_current_user
from app.services.analysis_service import AnalysisService

logger = structlog.get_logger()
router = APIRouter(prefix="/analyses", tags=["Analyses"])

_analysis_svc = AnalysisService()


# ── SSE — real-time progress ────────────────────────────────────────────────

@router.get("/{analysis_id}/stream")
async def stream_analysis_progress(analysis_id: UUID):
    """
    Server-Sent Events endpoint.
    The frontend opens an EventSource to this URL and receives status updates
    as the analysis progresses: queued → running → completed | failed.
    """

    async def event_generator():
        last_progress = -1
        last_status = None
        max_polls = 180  # ~3 minutes max
        for _ in range(max_polls):
            try:
                db = await get_supabase()
                resp = (
                    await db.table("analyses")
                    .select("status, ai_score, error_message, started_at, completed_at, progress, progress_label")
                    .eq("id", str(analysis_id))
                    .single()
                    .execute()
                )
                if not resp.data:
                    yield f"data: {json.dumps({'status': 'not_found'})}\n\n"
                    return

                row = resp.data
                status = row["status"]
                progress = row.get("progress") or 0
                progress_label = row.get("progress_label") or ""

                if status == "queued" and progress == 0:
                    progress = 5
                    progress_label = progress_label or "Na fila..."
                elif status == "completed":
                    progress = 100
                    progress_label = "Análise concluída!"
                elif status == "failed":
                    progress = 100
                    progress_label = "Falha na análise"

                if progress != last_progress or status != last_status:
                    payload = {
                        "status": status,
                        "ai_score": row.get("ai_score"),
                        "error_message": row.get("error_message"),
                        "started_at": row.get("started_at"),
                        "completed_at": row.get("completed_at"),
                        "progress": progress,
                        "progress_label": progress_label,
                    }
                    yield f"data: {json.dumps(payload)}\n\n"
                    last_progress = progress
                    last_status = status

                if status in ("completed", "failed"):
                    return

            except Exception as exc:
                logger.warning("sse_poll_error", error=str(exc))

            await asyncio.sleep(1)

        yield f"data: {json.dumps({'status': 'timeout'})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Chat with MR ────────────────────────────────────────────────────────────

@router.post("/{analysis_id}/chat")
async def chat_with_analysis(
    analysis_id: UUID,
    body: dict,
    current_user: dict = Depends(get_current_user),
):
    """
    Ask a follow-up question about a specific analysis/MR.
    Body: { "question": "gere um teste para este método" }
    Returns: { "answer": "..." }
    """
    from app.config import get_settings

    question = body.get("question", "").strip()
    if not question:
        return {"error": "Envie uma pergunta no campo 'question'."}

    # Load the analysis with all context
    detail = await _analysis_svc.get_analysis_detail(analysis_id)
    if not detail:
        raise NotFoundError("Analysis", str(analysis_id))

    # Load the MR info
    db = await get_supabase()
    mr_resp = (
        await db.table("merge_requests")
        .select("title, description, branch, target_branch")
        .eq("id", detail["mr_id"])
        .single()
        .execute()
    )
    mr = mr_resp.data or {}

    # Build context from analysis
    issues_text = "\n".join(
        f"- [{i['severity']}] {i['title']}: {i.get('description','')}"
        for i in detail.get("issues", [])
    )
    annotations_text = "\n".join(
        f"- {a['file_path']}:{a['after_line']} [{a['type']}] {a['text']}"
        for a in detail.get("diff_annotations", [])
    )

    context = f"""## MR: {mr.get('title', 'N/A')}
Branch: {mr.get('branch', '')} → {mr.get('target_branch', '')}
Description: {mr.get('description') or 'N/A'}
AI Score: {detail.get('ai_score', 'N/A')}
Security: {detail.get('score_security')}, Performance: {detail.get('score_performance')}, Readability: {detail.get('score_readability')}, Business Rules: {detail.get('score_business_rules')}

## Issues Found:
{issues_text or 'None'}

## Diff Annotations:
{annotations_text or 'None'}

## Raw AI Response (summary):
{json.dumps(detail.get('raw_claude_response', {}), indent=2)[:3000]}"""

    settings = get_settings()
    system_msg = "You are CodeGuard AI assistant. Answer questions about code reviews and merge requests. Respond in the same language as the user's question. Be concise and actionable."
    user_msg = f"Context of the analyzed MR:\n{context}\n\n---\n\nUser question: {question}"

    try:
        if settings.ai_provider.lower() == "openai":
            from openai import AsyncOpenAI
            client = AsyncOpenAI(api_key=settings.openai_api_key)
            response = await client.chat.completions.create(
                model=settings.openai_model,
                max_tokens=2048,
                messages=[
                    {"role": "system", "content": system_msg},
                    {"role": "user", "content": user_msg},
                ],
            )
            answer = response.choices[0].message.content or ""
        else:
            import anthropic
            client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
            response = await client.messages.create(
                model=settings.claude_model,
                max_tokens=2048,
                system=system_msg,
                messages=[{"role": "user", "content": user_msg}],
            )
            answer = response.content[0].text
    except Exception as exc:
        logger.error("chat_error", error=str(exc))
        answer = f"Erro ao consultar IA: {exc}"

    return {"answer": answer, "analysis_id": str(analysis_id)}


# ── Standard CRUD endpoints ────────────────────────────────────────────────

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
