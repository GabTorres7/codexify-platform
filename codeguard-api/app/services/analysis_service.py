"""
Orchestrates the full MR analysis pipeline:
  1. Fetch diff from git platform
  2. Fetch active rules
  3. Call Claude
  4. Persist results
  5. Update MR status
  6. Log activity
"""
from datetime import UTC, datetime
from uuid import UUID

import structlog

from app.core.exceptions import AIServiceError, GitPlatformError
from app.db.client import get_supabase
from app.services.ai_factory import get_ai_service
from app.services.git_platform_factory import get_git_service
from app.services.rule_service import RuleService

logger = structlog.get_logger()

SCORE_WEIGHTS = {
    "score_security": 0.35,
    "score_performance": 0.20,
    "score_readability": 0.20,
    "score_business_rules": 0.25,
}


def compute_weighted_score(result: dict) -> int:
    total = sum(
        result.get(key, 0) * weight for key, weight in SCORE_WEIGHTS.items()
    )
    return round(total)


class AnalysisService:
    def __init__(self):
        self._ai = get_ai_service()

    async def trigger_analysis(self, mr_id: UUID) -> UUID:
        """
        Create an analysis record in 'queued' status and return its ID.
        The actual work is done in the background worker.
        """
        db = await get_supabase()
        resp = (
            await db.table("analyses")
            .insert({"mr_id": str(mr_id), "status": "queued"})
            .execute()
        )
        analysis_id = UUID(resp.data[0]["id"])  # type: ignore[index]
        # Update MR status to 'analyzing'
        await db.table("merge_requests").update({"status": "analyzing"}).eq(
            "id", str(mr_id)
        ).execute()
        return analysis_id

    async def run_analysis(self, analysis_id: UUID) -> None:
        """
        Execute the full analysis pipeline (runs in background).
        """
        db = await get_supabase()

        # Mark as running
        await db.table("analyses").update(
            {"status": "running", "started_at": datetime.now(UTC).isoformat()}
        ).eq("id", str(analysis_id)).execute()

        try:
            # Load analysis + MR + repo
            analysis_resp = (
                await db.table("analyses")
                .select("*, merge_requests(*, repositories(*))")
                .eq("id", str(analysis_id))
                .single()
                .execute()
            )
            analysis = analysis_resp.data
            mr = analysis["merge_requests"]
            repo = mr["repositories"]

            logger.info(
                "analysis_started",
                analysis_id=str(analysis_id),
                mr_title=mr["title"],
                repo=repo["full_name"],
            )

            # 1. Fetch diff from git platform
            git_svc = get_git_service(repo["platform"], repo["access_token"])

            if repo["platform"] == "github":
                file_diffs = await git_svc.get_pr_diff(repo["full_name"], mr["platform_id"])
            else:
                file_diffs = await git_svc.get_mr_diff(
                    repo["platform_id"], mr["platform_id"]
                )

            files_diff = [
                {"file": f.file, "diff_text": f.diff_text[:8000]}  # token budget guard
                for f in file_diffs
            ]

            # 2. Load active rules
            rule_svc = RuleService(db)
            rules = await rule_svc.get_effective_rules(
                UUID(repo["org_id"]), UUID(repo["id"])
            )

            # 3. Call Claude
            claude_result = await self._ai.analyze_merge_request(
                mr_title=mr["title"],
                mr_description=mr.get("description") or "",
                files_diff=files_diff,
                rules=rules,
            )

            # Ensure ai_score is computed correctly
            ai_score = compute_weighted_score(claude_result)
            claude_result["ai_score"] = ai_score
            claude_result["_files_diff"] = files_diff

            # 4. Persist results
            await self._persist_results(db, analysis_id, mr, repo, claude_result, file_diffs)

            logger.info(
                "analysis_completed",
                analysis_id=str(analysis_id),
                ai_score=ai_score,
            )

        except (GitPlatformError, AIServiceError, Exception) as exc:
            logger.error("analysis_failed", analysis_id=str(analysis_id), error=str(exc))
            await db.table("analyses").update(
                {
                    "status": "failed",
                    "error_message": str(exc),
                    "completed_at": datetime.now(UTC).isoformat(),
                }
            ).eq("id", str(analysis_id)).execute()

            # Revert MR status to 'issues' so it can be retried
            if "mr" in locals():
                await db.table("merge_requests").update({"status": "issues"}).eq(
                    "id", mr["id"]
                ).execute()

    async def _persist_results(
        self,
        db,
        analysis_id: UUID,
        mr: dict,
        repo: dict,
        result: dict,
        file_diffs,
    ) -> None:
        now = datetime.now(UTC).isoformat()
        ai_score = result["ai_score"]
        new_status = "approved" if ai_score >= repo.get("min_score", 75) else "issues"

        # Update analysis record
        await db.table("analyses").update(
            {
                "status": "completed",
                "ai_score": ai_score,
                "score_security": result.get("score_security"),
                "score_performance": result.get("score_performance"),
                "score_readability": result.get("score_readability"),
                "score_business_rules": result.get("score_business_rules"),
                "raw_claude_response": result,
                "completed_at": now,
            }
        ).eq("id", str(analysis_id)).execute()

        # Persist issues
        if result.get("issues"):
            await db.table("analysis_issues").insert(
                [
                    {
                        "analysis_id": str(analysis_id),
                        "severity": i.get("severity", "info"),
                        "title": i.get("title", ""),
                        "description": i.get("description"),
                        "file_path": i.get("file_path"),
                        "line_ref": i.get("line_ref"),
                        "suggestion": i.get("suggestion"),
                    }
                    for i in result["issues"]
                ]
            ).execute()

        # Persist diff annotations
        if result.get("diff_annotations"):
            await db.table("analysis_diff_annotations").insert(
                [
                    {
                        "analysis_id": str(analysis_id),
                        "file_path": a.get("file_path", ""),
                        "after_line": a.get("after_line", 0),
                        "type": a.get("type", "info"),
                        "text": a.get("text", ""),
                    }
                    for a in result["diff_annotations"]
                ]
            ).execute()

        # Persist rule results
        if result.get("rule_results"):
            await db.table("analysis_rule_results").insert(
                [
                    {
                        "analysis_id": str(analysis_id),
                        "rule_name": r.get("rule_name", ""),
                        "status": r.get("status", "warn"),
                        "description": r.get("description"),
                    }
                    for r in result["rule_results"]
                ]
            ).execute()

        # Update MR status and score
        await db.table("merge_requests").update(
            {"status": new_status, "ai_score": ai_score, "updated_at": now}
        ).eq("id", mr["id"]).execute()

        # Log activity
        await db.table("activity_log").insert(
            {
                "org_id": repo["org_id"],
                "repo_id": repo["id"],
                "mr_id": mr["id"],
                "event_type": "analysis_completed",
                "description": (
                    f"MR '{mr['title']}' analisado com score {ai_score} "
                    f"— {'Aprovado' if new_status == 'approved' else 'Problemas encontrados'}"
                ),
            }
        ).execute()

        # Auto-comment on the PR/MR
        await self._post_analysis_comment(repo, mr, result)

    async def _post_analysis_comment(self, repo: dict, mr: dict, result: dict) -> None:
        """Post a summary comment on the GitHub PR / GitLab MR after analysis."""
        try:
            ai_score = result.get("ai_score", 0)
            issues = result.get("issues", [])
            grade = "Excelente" if ai_score >= 90 else "Bom" if ai_score >= 75 else "Regular" if ai_score >= 60 else "Critico"
            emoji = "white_check_mark" if ai_score >= 75 else "warning" if ai_score >= 60 else "x"

            issues_md = ""
            for i in issues[:10]:
                sev = i.get("severity", "info").upper()
                issues_md += f"| {sev} | {i.get('title', '')} | {i.get('file_path', '-')} |\n"

            body = (
                f"## :robot: Codexfy AI — Code Review\n\n"
                f"**Score: {ai_score}/100** :{emoji}: _{grade}_\n\n"
                f"| Categoria | Score |\n|---|---|\n"
                f"| :lock: Seguranca | {result.get('score_security', '-')} |\n"
                f"| :zap: Performance | {result.get('score_performance', '-')} |\n"
                f"| :book: Legibilidade | {result.get('score_readability', '-')} |\n"
                f"| :clipboard: Regras | {result.get('score_business_rules', '-')} |\n\n"
            )
            if issues_md:
                body += f"### Issues ({len(issues)})\n| Severidade | Titulo | Arquivo |\n|---|---|---|\n{issues_md}\n"
            body += "\n---\n_Analise automatica por [Codexfy AI](https://codexfy.dev)_"

            git_svc = get_git_service(repo["platform"], repo["access_token"])
            if repo["platform"] == "github":
                await git_svc.post_pr_comment(repo["full_name"], mr["platform_id"], body)
            else:
                await git_svc.post_mr_comment(repo["platform_id"], mr["platform_id"], body)

            logger.info("auto_comment_posted", repo=repo["full_name"], mr=mr["platform_id"])
        except Exception as exc:
            logger.warning("auto_comment_failed", error=str(exc))

    async def run_upload_analysis(
        self,
        analysis_id: UUID,
        mr_title: str,
        mr_description: str,
        raw_diff: str,
    ) -> None:
        """
        Analyze an uploaded diff (no git platform needed).
        Used by the upload endpoint for .patch / .zip / pasted diffs.
        """
        db = await get_supabase()

        await db.table("analyses").update(
            {"status": "running", "started_at": datetime.now(UTC).isoformat()}
        ).eq("id", str(analysis_id)).execute()

        try:
            # Parse raw diff into file chunks
            files_diff = self._parse_raw_diff(raw_diff)

            logger.info(
                "upload_analysis_started",
                analysis_id=str(analysis_id),
                files=len(files_diff),
            )

            # Load analysis to get mr_id and org
            analysis_resp = (
                await db.table("analyses")
                .select("*, merge_requests(*)")
                .eq("id", str(analysis_id))
                .single()
                .execute()
            )
            mr = analysis_resp.data["merge_requests"]

            # Load org-level rules (no repo-specific rules for uploads)
            # Find the org from the user's merge request
            org_rules: list[dict] = []
            if mr.get("author_username"):
                user_resp = (
                    await db.table("users")
                    .select("org_id")
                    .eq("email", mr["author_username"])
                    .limit(1)
                    .execute()
                )
                if user_resp.data:
                    org_id = user_resp.data[0]["org_id"]  # type: ignore[index]
                    rule_svc = RuleService(db)
                    org_rules = await rule_svc.list_rules(UUID(org_id), active_only=True)

            # Call Claude
            claude_result = await self._ai.analyze_merge_request(
                mr_title=mr_title,
                mr_description=mr_description or "",
                files_diff=files_diff,
                rules=org_rules,
            )

            ai_score = compute_weighted_score(claude_result)
            claude_result["ai_score"] = ai_score
            claude_result["_files_diff"] = files_diff

            # Persist results (using a virtual "repo" dict for compatibility)
            virtual_repo = {"min_score": 75, "org_id": None, "id": None}
            if mr.get("author_username"):
                user_resp2 = (
                    await db.table("users")
                    .select("org_id")
                    .eq("email", mr["author_username"])
                    .limit(1)
                    .execute()
                )
                if user_resp2.data:
                    virtual_repo["org_id"] = user_resp2.data[0]["org_id"]  # type: ignore[index]

            now = datetime.now(UTC).isoformat()
            new_status = "approved" if ai_score >= 75 else "issues"

            # Update analysis record
            await db.table("analyses").update(
                {
                    "status": "completed",
                    "ai_score": ai_score,
                    "score_security": claude_result.get("score_security"),
                    "score_performance": claude_result.get("score_performance"),
                    "score_readability": claude_result.get("score_readability"),
                    "score_business_rules": claude_result.get("score_business_rules"),
                    "raw_claude_response": claude_result,
                    "completed_at": now,
                }
            ).eq("id", str(analysis_id)).execute()

            # Persist issues
            if claude_result.get("issues"):
                await db.table("analysis_issues").insert(
                    [
                        {
                            "analysis_id": str(analysis_id),
                            "severity": i.get("severity", "info"),
                            "title": i.get("title", ""),
                            "description": i.get("description"),
                            "file_path": i.get("file_path"),
                            "line_ref": i.get("line_ref"),
                            "suggestion": i.get("suggestion"),
                        }
                        for i in claude_result["issues"]
                    ]
                ).execute()

            # Persist diff annotations
            if claude_result.get("diff_annotations"):
                await db.table("analysis_diff_annotations").insert(
                    [
                        {
                            "analysis_id": str(analysis_id),
                            "file_path": a.get("file_path", ""),
                            "after_line": a.get("after_line", 0),
                            "type": a.get("type", "info"),
                            "text": a.get("text", ""),
                        }
                        for a in claude_result["diff_annotations"]
                    ]
                ).execute()

            # Persist rule results
            if claude_result.get("rule_results"):
                await db.table("analysis_rule_results").insert(
                    [
                        {
                            "analysis_id": str(analysis_id),
                            "rule_name": r.get("rule_name", ""),
                            "status": r.get("status", "warn"),
                            "description": r.get("description"),
                        }
                        for r in claude_result["rule_results"]
                    ]
                ).execute()

            # Update MR status
            await db.table("merge_requests").update(
                {"status": new_status, "ai_score": ai_score, "updated_at": now}
            ).eq("id", mr["id"]).execute()

            # Log activity if we have an org
            if virtual_repo.get("org_id"):
                await db.table("activity_log").insert(
                    {
                        "org_id": virtual_repo["org_id"],
                        "mr_id": mr["id"],
                        "event_type": "analysis_completed",
                        "description": (
                            f"Upload '{mr_title}' analisado com score {ai_score} "
                            f"— {'Aprovado' if new_status == 'approved' else 'Problemas encontrados'}"
                        ),
                    }
                ).execute()

            logger.info("upload_analysis_completed", analysis_id=str(analysis_id), ai_score=ai_score)

        except Exception as exc:
            logger.error("upload_analysis_failed", analysis_id=str(analysis_id), error=str(exc))
            await db.table("analyses").update(
                {
                    "status": "failed",
                    "error_message": str(exc),
                    "completed_at": datetime.now(UTC).isoformat(),
                }
            ).eq("id", str(analysis_id)).execute()

    @staticmethod
    def _parse_raw_diff(raw_diff: str) -> list[dict]:
        """Parse a unified diff string into [{file, diff_text}] chunks."""
        files: list[dict] = []
        current_file = None
        current_lines: list[str] = []

        for line in raw_diff.splitlines():
            if line.startswith("diff --git"):
                if current_file:
                    files.append({"file": current_file, "diff_text": "\n".join(current_lines)[:8000]})
                parts = line.split(" b/")
                current_file = parts[-1] if len(parts) > 1 else line
                current_lines = [line]
            elif line.startswith("+++ b/"):
                current_file = line[6:]
                current_lines.append(line)
            else:
                current_lines.append(line)

        if current_file:
            files.append({"file": current_file, "diff_text": "\n".join(current_lines)[:8000]})

        # If no diff headers found, treat entire text as single file
        if not files:
            files.append({"file": "uploaded_code", "diff_text": raw_diff[:8000]})

        return files

    async def get_analysis_detail(self, analysis_id: UUID) -> dict | None:
        """Load a complete analysis with all sub-records."""
        db = await get_supabase()

        analysis_resp = (
            await db.table("analyses")
            .select("*")
            .eq("id", str(analysis_id))
            .single()
            .execute()
        )
        if not analysis_resp.data:
            return None

        analysis = analysis_resp.data

        issues_resp = (
            await db.table("analysis_issues")
            .select("*")
            .eq("analysis_id", str(analysis_id))
            .execute()
        )
        annotations_resp = (
            await db.table("analysis_diff_annotations")
            .select("*")
            .eq("analysis_id", str(analysis_id))
            .execute()
        )
        rules_resp = (
            await db.table("analysis_rule_results")
            .select("*")
            .eq("analysis_id", str(analysis_id))
            .execute()
        )

        analysis["issues"] = issues_resp.data or []
        analysis["diff_annotations"] = annotations_resp.data or []
        analysis["rule_results"] = rules_resp.data or []
        return analysis
