from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class OrganizationCreate(BaseModel):
    name: str
    slug: str


class OrganizationUpdate(BaseModel):
    name: str | None = None
    slug: str | None = None


class OrganizationOut(BaseModel):
    id: UUID
    name: str
    slug: str
    created_at: datetime
    updated_at: datetime


class OrgSettingsUpdate(BaseModel):
    auto_analyze: bool | None = None
    min_score_threshold: int | None = None
    notification_email: str | None = None
    slack_webhook_url: str | None = None
    discord_webhook_url: str | None = None
    ai_model: str | None = None


class OrgSettingsOut(BaseModel):
    id: UUID
    org_id: UUID
    auto_analyze: bool
    min_score_threshold: int
    notification_email: str | None
    slack_webhook_url: str | None
    discord_webhook_url: str | None
    ai_model: str | None = None
