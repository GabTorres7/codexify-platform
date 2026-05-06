from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class MergeRequestOut(BaseModel):
    id: UUID
    repo_id: UUID
    platform_id: str
    title: str
    description: str | None
    branch: str
    target_branch: str
    author_name: str | None
    author_username: str | None
    author_avatar: str | None
    status: str
    ai_score: int | None
    files_changed: int
    additions: int
    deletions: int
    comments: int
    platform_url: str | None
    platform_created_at: datetime | None
    created_at: datetime
    updated_at: datetime


class MergeRequestListOut(BaseModel):
    total: int
    items: list[MergeRequestOut]
