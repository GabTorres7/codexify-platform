from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr


class UserCreate(BaseModel):
    email: EmailStr
    name: str
    password: str
    role: str = "member"


class UserInvite(BaseModel):
    email: EmailStr
    name: str
    role: str = "member"


class UserOut(BaseModel):
    id: UUID
    org_id: UUID | None
    email: str
    name: str
    initials: str | None
    color: str
    role: str
    is_active: bool
    created_at: datetime


class TokenOut(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class APIKeyCreate(BaseModel):
    name: str
    expires_at: datetime | None = None


class APIKeyOut(BaseModel):
    id: UUID
    name: str
    key_prefix: str
    created_at: datetime
    expires_at: datetime | None


class APIKeyCreatedOut(APIKeyOut):
    """Returned once at creation — includes the plain key."""
    plain_key: str
