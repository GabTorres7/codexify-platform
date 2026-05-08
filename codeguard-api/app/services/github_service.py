from dataclasses import dataclass

import httpx
import structlog

from app.core.exceptions import GitPlatformError

logger = structlog.get_logger()

GITHUB_API = "https://api.github.com"


@dataclass
class FileDiff:
    file: str
    diff_text: str
    additions: int
    deletions: int


@dataclass
class MRData:
    platform_id: str
    title: str
    description: str | None
    branch: str
    target_branch: str
    author_name: str
    author_username: str
    author_avatar: str | None
    platform_status: str
    files_changed: int
    additions: int
    deletions: int
    comments: int
    platform_url: str
    platform_created_at: str


class GitHubService:
    """Integrates with GitHub REST API to fetch PRs and diffs."""

    def __init__(self, access_token: str):
        self._headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(headers=self._headers, timeout=30.0)

    async def validate_token(self, full_name: str) -> dict:
        """
        Validate access token and return basic repo info.
        Raises GitPlatformError if token is invalid or repo not found.
        """
        async with self._client() as client:
            resp = await client.get(f"{GITHUB_API}/repos/{full_name}")
            if resp.status_code == 401:
                raise GitPlatformError("github", "Invalid access token")
            if resp.status_code == 404:
                raise GitPlatformError("github", f"Repository '{full_name}' not found")
            if not resp.is_success:
                raise GitPlatformError("github", f"Unexpected error: {resp.status_code}")
            return resp.json()

    async def list_open_prs(self, full_name: str) -> list[MRData]:
        """Fetch all open pull requests for a repository."""
        async with self._client() as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{full_name}/pulls",
                params={"state": "open", "per_page": 100},
            )
            if not resp.is_success:
                raise GitPlatformError("github", f"Failed to list PRs: {resp.status_code}")

            prs = resp.json()
            return [self._map_pr(pr) for pr in prs]

    async def get_pr_diff(self, full_name: str, pr_number: str) -> list[FileDiff]:
        """Fetch the unified diff for a pull request, split by file."""
        async with self._client() as client:
            # Get files list with patch info
            resp = await client.get(
                f"{GITHUB_API}/repos/{full_name}/pulls/{pr_number}/files",
                params={"per_page": 100},
            )
            if not resp.is_success:
                raise GitPlatformError("github", f"Failed to get PR files: {resp.status_code}")

            files = resp.json()
            return [
                FileDiff(
                    file=f["filename"],
                    diff_text=f.get("patch", ""),
                    additions=f.get("additions", 0),
                    deletions=f.get("deletions", 0),
                )
                for f in files
                if f.get("patch")  # skip binary files
            ]

    async def register_webhook(
        self, full_name: str, callback_url: str, secret: str
    ) -> str:
        """Register a webhook on GitHub. Returns the webhook ID."""
        async with self._client() as client:
            resp = await client.post(
                f"{GITHUB_API}/repos/{full_name}/hooks",
                json={
                    "name": "web",
                    "active": True,
                    "events": ["pull_request"],
                    "config": {
                        "url": callback_url,
                        "content_type": "json",
                        "secret": secret,
                    },
                },
            )
            if not resp.is_success:
                raise GitPlatformError(
                    "github", f"Failed to register webhook: {resp.status_code} {resp.text}"
                )
            return str(resp.json()["id"])

    async def post_pr_comment(self, full_name: str, pr_number: str, body: str) -> dict:
        """Post a comment on a GitHub pull request."""
        async with self._client() as client:
            resp = await client.post(
                f"{GITHUB_API}/repos/{full_name}/issues/{pr_number}/comments",
                json={"body": body},
            )
            if not resp.is_success:
                raise GitPlatformError("github", f"Failed to post comment: {resp.status_code}")
            return resp.json()

    async def delete_webhook(self, full_name: str, webhook_id: str) -> None:
        async with self._client() as client:
            await client.delete(
                f"{GITHUB_API}/repos/{full_name}/hooks/{webhook_id}"
            )

    def _map_pr(self, pr: dict) -> MRData:
        return MRData(
            platform_id=str(pr["number"]),
            title=pr["title"],
            description=pr.get("body"),
            branch=pr["head"]["ref"],
            target_branch=pr["base"]["ref"],
            author_name=pr["user"]["login"],
            author_username=pr["user"]["login"],
            author_avatar=pr["user"].get("avatar_url"),
            platform_status=pr["state"],
            files_changed=pr.get("changed_files", 0),
            additions=pr.get("additions", 0),
            deletions=pr.get("deletions", 0),
            comments=pr.get("comments", 0),
            platform_url=pr["html_url"],
            platform_created_at=pr["created_at"],
        )
