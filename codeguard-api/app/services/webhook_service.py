import hashlib
import hmac

import structlog

from app.config import get_settings

logger = structlog.get_logger()
settings = get_settings()


def verify_github_signature(payload_body: bytes, signature_header: str, secret: str) -> bool:
    """Verify GitHub webhook HMAC-SHA256 signature."""
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), payload_body, hashlib.sha256).hexdigest()
    received = signature_header[len("sha256="):]
    return hmac.compare_digest(expected, received)


def verify_gitlab_token(token_header: str, secret: str) -> bool:
    """Verify GitLab webhook token (plain string comparison)."""
    return hmac.compare_digest(token_header or "", secret)


def is_github_pr_event(event_type: str, payload: dict) -> bool:
    """Return True if this GitHub event should trigger analysis."""
    if event_type != "pull_request":
        return False
    action = payload.get("action", "")
    return action in ("opened", "reopened", "synchronize")


def is_gitlab_mr_event(payload: dict) -> bool:
    """Return True if this GitLab event should trigger analysis."""
    obj_kind = payload.get("object_kind", "")
    if obj_kind != "merge_request":
        return False
    action = payload.get("object_attributes", {}).get("action", "")
    return action in ("open", "reopen", "update")
