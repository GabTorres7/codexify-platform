from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class IssueOut(BaseModel):
    id: UUID
    severity: str
    title: str
    description: str | None
    file_path: str | None
    line_ref: str | None
    suggestion: str | None


class DiffLineOut(BaseModel):
    type: str       # "added" | "removed" | "context"
    num: int
    content: str


class DiffAnnotationOut(BaseModel):
    after_line: int
    type: str       # "danger" | "warning" | "info"
    text: str


class FileDiffOut(BaseModel):
    file: str
    lines: list[DiffLineOut]
    annotations: list[DiffAnnotationOut]


class RuleResultOut(BaseModel):
    rule_id: UUID | None
    rule_name: str
    status: str     # "pass" | "fail" | "warn"
    description: str | None


class AnalysisCategoriesOut(BaseModel):
    security: int
    performance: int
    readability: int
    business_rules: int


class AnalysisOut(BaseModel):
    id: UUID
    mr_id: UUID
    status: str
    ai_score: int | None
    categories: AnalysisCategoriesOut | None
    issues: list[IssueOut]
    diff: list[FileDiffOut]
    rules: list[RuleResultOut]
    error_message: str | None
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime


class AnalysisTriggerOut(BaseModel):
    analysis_id: UUID
    status: str
    message: str


# Full MR detail (merges MR data + latest analysis — matches the frontend data model)
class MergeRequestDetailOut(BaseModel):
    id: UUID
    title: str
    branch: str
    target_branch: str
    author: dict            # {name, initials, color}
    status: str
    ai_score: int | None
    created_at: datetime
    files_changed: int
    additions: int
    deletions: int
    comments: int
    description: str | None
    platform_url: str | None
    files: list[dict]       # [{name, additions, deletions}]
    diff: list[FileDiffOut]
    issues: list[IssueOut]
    analysis_categories: AnalysisCategoriesOut | None
    rules: list[RuleResultOut]
