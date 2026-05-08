"""
Background worker for running MR analyses.

Wraps AnalysisService.run_analysis so it can be dispatched
from FastAPI BackgroundTasks or any future task queue (Celery, etc.).
"""
from uuid import UUID

import structlog

from app.services.analysis_service import AnalysisService

logger = structlog.get_logger()

_svc = AnalysisService()


async def run_analysis_task(analysis_id: UUID) -> None:
    """
    Execute the full analysis pipeline in the background.
    Called by BackgroundTasks after trigger_analysis creates the record.
    """
    logger.info("worker_analysis_start", analysis_id=str(analysis_id))
    try:
        await _svc.run_analysis(analysis_id)
        logger.info("worker_analysis_done", analysis_id=str(analysis_id))
    except Exception as exc:
        logger.error(
            "worker_analysis_unhandled",
            analysis_id=str(analysis_id),
            error=str(exc),
        )


async def run_analysis_batch(analysis_ids: list[UUID]) -> dict:
    """
    Run multiple analyses sequentially. Returns a summary dict.
    Useful for bulk re-analysis or webhook-triggered batch processing.
    """
    results = {"succeeded": [], "failed": []}
    for aid in analysis_ids:
        try:
            await _svc.run_analysis(aid)
            results["succeeded"].append(str(aid))
        except Exception as exc:
            results["failed"].append({"analysis_id": str(aid), "error": str(exc)})
            logger.error("worker_batch_item_failed", analysis_id=str(aid), error=str(exc))
    return results
