"""
Quick Analysis — Upload endpoint.
Accepts a .patch file, .txt raw diff, or .zip archive and runs Claude analysis
without requiring a connected GitHub/GitLab repository.

POST /orgs/{org_id}/upload-analysis
  multipart/form-data:
    file: UploadFile (.patch | .txt | .zip)   — optional if diff_text provided
    diff_text: str                              — optional raw diff pasted inline
    mr_title: str                               — required
    mr_description: str                         — optional
"""
import io
import zipfile
from uuid import UUID

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile

from app.db.client import get_supabase
from app.dependencies import get_current_user
from app.services.analysis_service import AnalysisService

logger = structlog.get_logger()
router = APIRouter(prefix="/orgs/{org_id}", tags=["Quick Analysis"])

_analysis_svc = AnalysisService()

# ── helpers ──────────────────────────────────────────────────────────────────

MAX_FILE_BYTES = 5 * 1024 * 1024  # 5 MB safety cap


def _extract_diff_from_zip(data: bytes) -> str:
    """
    Given a ZIP archive, extract all text files and produce a fake unified diff.
    Files larger than 8 KB are truncated to stay within Claude's token budget.
    """
    parts: list[str] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for name in zf.namelist():
                if name.endswith("/"):
                    continue  # skip directories
                # skip binary / non-text candidates
                ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
                if ext in {"png", "jpg", "jpeg", "gif", "svg", "ico", "woff", "ttf", "eot",
                           "mp3", "mp4", "mov", "pdf", "zip", "tar", "gz", "exe", "dll"}:
                    continue
                try:
                    content = zf.read(name).decode("utf-8", errors="replace")
                except Exception:
                    continue

                # Truncate per-file to avoid token overflow
                if len(content) > 8000:
                    content = content[:8000] + "\n... [truncated for analysis]"

                lines = content.splitlines()
                diff_lines = [f"+{line}" for line in lines]
                parts.append(f"diff --git a/{name} b/{name}\n--- /dev/null\n+++ b/{name}\n" +
                              "\n".join(diff_lines))
    except zipfile.BadZipFile as exc:
        raise HTTPException(status_code=400, detail=f"Arquivo ZIP inválido: {exc}") from exc
    return "\n\n".join(parts)


def _parse_uploaded_file(filename: str, data: bytes) -> str:
    """
    Dispatch to the right parser based on file extension.
    Returns a unified diff string ready for Claude.
    """
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "txt"

    if ext == "zip":
        return _extract_diff_from_zip(data)

    try:
        content = data.decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Não foi possível ler o arquivo: {exc}") from exc

    # If already a diff/patch, return as-is
    if ext in ("patch", "diff") or content.strip().startswith("diff --git"):
        return content

    # Convert source code to unified diff format (new file)
    if len(content) > 8000:
        content = content[:8000] + "\n... [truncado para análise]"
    lines = content.splitlines()
    diff_lines = [f"+{line}" for line in lines]
    return f"diff --git a/{filename} b/{filename}\n--- /dev/null\n+++ b/{filename}\n@@ -0,0 +1,{len(lines)} @@\n" + "\n".join(diff_lines)


# ── endpoint ─────────────────────────────────────────────────────────────────

@router.post("/upload-analysis", status_code=202)
async def upload_quick_analysis(
    org_id: UUID,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
    mr_title: str = Form(..., description="Título do MR ou descrição do que foi alterado"),
    mr_description: str = Form("", description="Descrição opcional"),
    diff_text: str = Form("", description="Diff raw colado diretamente (alternativa ao arquivo)"),
    file: UploadFile | None = File(None, description="Arquivo .patch, .diff, .txt ou .zip"),
):
    """
    Trigger a Claude AI analysis from an uploaded file or pasted diff,
    without requiring a connected Git repository.

    Returns an analysis_id that can be polled at GET /analyses/{analysis_id}.
    """
    # ── 1. Resolve diff text ─────────────────────────────────────────────────
    raw_diff = diff_text.strip()

    if file is not None:
        file_data = await file.read()
        if len(file_data) > MAX_FILE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Arquivo muito grande. Limite: {MAX_FILE_BYTES // (1024*1024)} MB",
            )
        raw_diff = _parse_uploaded_file(file.filename or "upload.txt", file_data)

    if not raw_diff:
        raise HTTPException(
            status_code=400,
            detail="Envie um arquivo ou cole o diff no campo diff_text.",
        )

    # Wrap pasted raw code in unified diff format if needed
    if raw_diff and not raw_diff.strip().startswith("diff --git"):
        code = raw_diff
        if len(code) > 8000:
            code = code[:8000] + "\n... [truncado para análise]"
        code_lines = code.splitlines()
        diff_lines = [f"+{line}" for line in code_lines]
        fname = "uploaded_code.py"
        if file and file.filename:
            fname = file.filename
        raw_diff = (
            f"diff --git a/{fname} b/{fname}\n"
            f"--- /dev/null\n"
            f"+++ b/{fname}\n"
            f"@@ -0,0 +1,{len(code_lines)} @@\n"
            + "\n".join(diff_lines)
        )

    if not mr_title.strip():
        raise HTTPException(status_code=400, detail="mr_title é obrigatório.")

    logger.info(
        "upload_analysis_received",
        org_id=str(org_id),
        filename=file.filename if file else "inline_diff",
        diff_len=len(raw_diff),
    )

    # ── 2. Create a virtual (upload) MR record in the DB ────────────────────
    db = await get_supabase()

    # Find or create a virtual "upload" repository for this org
    upload_repo_resp = (
        await db.table("repositories")
        .select("id")
        .eq("org_id", str(org_id))
        .eq("platform_id", "__upload__")
        .limit(1)
        .execute()
    )
    if upload_repo_resp.data:
        upload_repo_id = upload_repo_resp.data[0]["id"]  # type: ignore[index]
    else:
        repo_resp = await db.table("repositories").insert({
            "org_id": str(org_id),
            "platform": "github",
            "platform_id": "__upload__",
            "full_name": "upload/analise-direta",
            "name": "Upload Direto",
            "url": "",
            "auto_analyze": False,
            "is_active": True,
        }).execute()
        upload_repo_id = repo_resp.data[0]["id"]  # type: ignore[index]

    import hashlib
    import time
    upload_id = hashlib.md5((raw_diff[:200] + str(time.time())).encode()).hexdigest()[:12]

    mr_payload = {
        "repo_id": upload_repo_id,
        "platform_id": f"upload-{upload_id}",
        "title": mr_title.strip(),
        "description": mr_description.strip() or None,
        "branch": "upload",
        "target_branch": "main",
        "author_name": current_user.get("name", "Usuário"),
        "author_username": current_user.get("email", "user"),
        "platform_status": "open",
        "files_changed": raw_diff.count("\ndiff --git") + (1 if "diff --git" not in raw_diff else 0),
        "additions": raw_diff.count("\n+"),
        "deletions": raw_diff.count("\n-"),
        "comments": 0,
        "status": "pending",
    }
    mr_resp = await db.table("merge_requests").insert(mr_payload).execute()

    mr_id = UUID(mr_resp.data[0]["id"])  # type: ignore[index]

    # ── 3. Queue analysis (background) ──────────────────────────────────────
    analysis_id = await _analysis_svc.trigger_analysis(mr_id)
    background_tasks.add_task(
        _analysis_svc.run_upload_analysis,
        analysis_id=analysis_id,
        mr_title=mr_title.strip(),
        mr_description=mr_description.strip(),
        raw_diff=raw_diff,
    )

    return {
        "analysis_id": str(analysis_id),
        "mr_id": str(mr_id),
        "status": "queued",
        "message": "Análise iniciada! Consulte GET /api/v1/analyses/{analysis_id} para o resultado.",
    }
