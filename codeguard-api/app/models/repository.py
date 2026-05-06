from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, field_validator


class RepositoryCreate(BaseModel):
    platform: str
    full_name: str          # "owner/repo"
    access_token: str
    default_branch: str = "main"
    auto_analyze: bool = True
    min_score: int = 75

    @field_validator("platform")
    @classmethod
    def platform_must_be_valid(cls, v: str) -> str:
        if v not in ("github", "gitlab"):
            raise ValueError("platform must be 'github' or 'gitlab'")
        return v


class RepositoryBulkCreate(BaseModel):
    """Send this to add many repos at once (enterprise use case)."""
    repositories: list[RepositoryCreate]


class RepositoryBulkResult(BaseModel):
    succeeded: list["RepositoryOut"]
    failed: list[dict]   # {"full_name": str, "error": str}


class RepositoryUpdate(BaseModel):
    auto_analyze: bool | None = None
    min_score: int | None = None
    access_token: str | None = None
    default_branch: str | None = None


class RepositoryOut(BaseModel):
    id: UUID
    org_id: UUID
    platform: str
    full_name: str
    name: str
    url: str
    default_branch: str
    auto_analyze: bool
    min_score: int
    is_active: bool
    last_synced_at: datetime | None
    created_at: datetime
