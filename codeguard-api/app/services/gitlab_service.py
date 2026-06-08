from dataclasses import dataclass

import httpx
import structlog

from app.core.exceptions import GitPlatformError
from app.services.github_service import FileDiff, MRData

logger = structlog.get_logger()

GITLAB_API = "https://gitlab.com/api/v4"


class GitLabService:
    """Integrates with GitLab REST API to fetch MRs and diffs."""

    def __init__(self, access_token: str, gitlab_url: str = GITLAB_API):
        self._base = gitlab_url
        self._headers = {
            "PRIVATE-TOKEN": access_token,
            "Content-Type": "application/json",
        }

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(headers=self._headers, timeout=30.0)

    async def list_user_repos(self) -> list[dict]:
        """Fetch all projects accessible by the authenticated user."""
        all_repos = []
        page = 1
        async with self._client() as client:
            while True:
                resp = await client.get(
                    f"{self._base}/projects",
                    params={"membership": "true", "per_page": 100, "order_by": "updated_at", "page": page},
                )
                if resp.status_code == 401:
                    raise GitPlatformError("gitlab", "Token inválido")
                if not resp.is_success:
                    raise GitPlatformError("gitlab", f"Erro ao buscar projetos: {resp.status_code}")
                projects = resp.json()
                if not projects:
                    break
                for p in projects:
                    all_repos.append({
                        "full_name": p.get("path_with_namespace", ""),
                        "description": p.get("description") or "",
                        "language": "",
                        "private": p.get("visibility") == "private",
                        "default_branch": p.get("default_branch", "main"),
                        "stars": p.get("star_count", 0),
                        "updated_at": p.get("last_activity_at", ""),
                    })
                if len(projects) < 100:
                    break
                page += 1
        return all_repos

    async def validate_token(self, full_name: str) -> dict:
        """Validate token and return basic project info."""
        encoded = full_name.replace("/", "%2F")
        async with self._client() as client:
            resp = await client.get(f"{self._base}/projects/{encoded}")
            if resp.status_code == 401:
                raise GitPlatformError("gitlab", "Invalid access token")
            if resp.status_code == 404:
                raise GitPlatformError("gitlab", f"Project '{full_name}' not found")
            if not resp.is_success:
                raise GitPlatformError("gitlab", f"Unexpected error: {resp.status_code}")
            return resp.json()

    async def list_open_mrs(self, project_id: str) -> list[MRData]:
        """Fetch all open merge requests for a project."""
        async with self._client() as client:
            resp = await client.get(
                f"{self._base}/projects/{project_id}/merge_requests",
                params={"state": "opened", "per_page": 100},
            )
            if not resp.is_success:
                raise GitPlatformError("gitlab", f"Failed to list MRs: {resp.status_code}")

            return [self._map_mr(mr) for mr in resp.json()]

    async def get_mr_diff(self, project_id: str, mr_iid: str) -> list[FileDiff]:
        """Fetch file changes with diffs for a merge request."""
        async with self._client() as client:
            resp = await client.get(
                f"{self._base}/projects/{project_id}/merge_requests/{mr_iid}/diffs",
                params={"per_page": 100},
            )
            if not resp.is_success:
                raise GitPlatformError("gitlab", f"Failed to get MR diff: {resp.status_code}")

            return [
                FileDiff(
                    file=f["new_path"],
                    diff_text=f.get("diff", ""),
                    additions=f.get("diff", "").count("\n+"),
                    deletions=f.get("diff", "").count("\n-"),
                )
                for f in resp.json()
                if f.get("diff")
            ]

    async def register_webhook(
        self, project_id: str, callback_url: str, secret: str
    ) -> str:
        """Register a project webhook on GitLab. Returns webhook ID."""
        async with self._client() as client:
            resp = await client.post(
                f"{self._base}/projects/{project_id}/hooks",
                json={
                    "url": callback_url,
                    "merge_requests_events": True,
                    "token": secret,
                    "push_events": False,
                },
            )
            if not resp.is_success:
                raise GitPlatformError(
                    "gitlab", f"Failed to register webhook: {resp.status_code} {resp.text}"
                )
            return str(resp.json()["id"])

    async def post_mr_comment(self, project_id: str, mr_iid: str, body: str) -> dict:
        """Post a note (comment) on a GitLab merge request."""
        async with self._client() as client:
            resp = await client.post(
                f"{self._base}/projects/{project_id}/merge_requests/{mr_iid}/notes",
                json={"body": body},
            )
            if not resp.is_success:
                raise GitPlatformError("gitlab", f"Failed to post comment: {resp.status_code}")
            return resp.json()

    async def delete_webhook(self, project_id: str, webhook_id: str) -> None:
        async with self._client() as client:
            await client.delete(
                f"{self._base}/projects/{project_id}/hooks/{webhook_id}"
            )

    def _map_mr(self, mr: dict) -> MRData:
        author = mr.get("author", {})
        return MRData(
            platform_id=str(mr["iid"]),
            title=mr["title"],
            description=mr.get("description"),
            branch=mr["source_branch"],
            target_branch=mr["target_branch"],
            author_name=author.get("name", ""),
            author_username=author.get("username", ""),
            author_avatar=author.get("avatar_url"),
            platform_status=mr["state"],
            files_changed=mr.get("changes_count", 0),
            additions=0,
            deletions=0,
            comments=mr.get("user_notes_count", 0),
            platform_url=mr["web_url"],
            platform_created_at=mr["created_at"],
        )
