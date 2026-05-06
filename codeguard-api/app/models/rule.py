from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class RuleCreate(BaseModel):
    name: str
    description: str | None = None
    severity: str = "warning"
    is_active: bool = True
    prompt_hint: str | None = None
    repo_id: UUID | None = None     # None = org-wide


class RuleUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    severity: str | None = None
    is_active: bool | None = None
    prompt_hint: str | None = None


class RuleBulkUpdate(BaseModel):
    rule_ids: list[UUID]
    is_active: bool


class RuleOut(BaseModel):
    id: UUID
    org_id: UUID
    repo_id: UUID | None
    name: str
    description: str | None
    severity: str
    is_active: bool
    is_builtin: bool
    prompt_hint: str | None
    created_at: datetime
    updated_at: datetime
