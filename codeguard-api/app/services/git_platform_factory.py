from app.services.github_service import GitHubService
from app.services.gitlab_service import GitLabService


def get_git_service(platform: str, access_token: str):
    """Return the appropriate git platform service instance."""
    if platform == "github":
        return GitHubService(access_token)
    if platform == "gitlab":
        return GitLabService(access_token)
    raise ValueError(f"Unsupported platform: {platform}")
