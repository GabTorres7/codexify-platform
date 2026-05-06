-- CodeGuard AI — Initial Schema
-- Run this in the Supabase SQL Editor (or via psql)

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Organizations ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organizations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    slug        TEXT UNIQUE NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
    email           TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    initials        TEXT,
    color           TEXT DEFAULT '#818cf8',
    role            TEXT DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    hashed_password TEXT,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── API Keys ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       UUID REFERENCES organizations(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    key_hash     TEXT UNIQUE NOT NULL,
    key_prefix   TEXT NOT NULL,
    created_by   UUID REFERENCES users(id),
    last_used_at TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- ── Repositories ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repositories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID REFERENCES organizations(id) ON DELETE CASCADE,
    platform        TEXT NOT NULL CHECK (platform IN ('github', 'gitlab')),
    platform_id     TEXT NOT NULL,
    full_name       TEXT NOT NULL,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,
    default_branch  TEXT DEFAULT 'main',
    access_token    TEXT,
    webhook_secret  TEXT,
    webhook_id      TEXT,
    auto_analyze    BOOLEAN DEFAULT true,
    min_score       INTEGER DEFAULT 75,
    is_active       BOOLEAN DEFAULT true,
    last_synced_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(org_id, platform, platform_id)
);

-- ── Merge Requests ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merge_requests (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id             UUID REFERENCES repositories(id) ON DELETE CASCADE,
    platform_id         TEXT NOT NULL,
    title               TEXT NOT NULL,
    description         TEXT,
    branch              TEXT NOT NULL,
    target_branch       TEXT NOT NULL,
    author_name         TEXT,
    author_username     TEXT,
    author_avatar       TEXT,
    status              TEXT DEFAULT 'pending'
                            CHECK (status IN ('pending','analyzing','approved','issues','merged','closed')),
    platform_status     TEXT,
    ai_score            INTEGER,
    files_changed       INTEGER DEFAULT 0,
    additions           INTEGER DEFAULT 0,
    deletions           INTEGER DEFAULT 0,
    comments            INTEGER DEFAULT 0,
    platform_url        TEXT,
    platform_created_at TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(repo_id, platform_id)
);

-- ── Analyses ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analyses (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mr_id                UUID REFERENCES merge_requests(id) ON DELETE CASCADE,
    status               TEXT DEFAULT 'queued'
                             CHECK (status IN ('queued','running','completed','failed')),
    ai_score             INTEGER,
    score_security       INTEGER,
    score_performance    INTEGER,
    score_readability    INTEGER,
    score_business_rules INTEGER,
    raw_claude_response  JSONB,
    error_message        TEXT,
    started_at           TIMESTAMPTZ,
    completed_at         TIMESTAMPTZ,
    created_at           TIMESTAMPTZ DEFAULT now()
);

-- ── Analysis Issues ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analysis_issues (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_id UUID REFERENCES analyses(id) ON DELETE CASCADE,
    severity    TEXT NOT NULL CHECK (severity IN ('critical','warning','info','suggestion')),
    title       TEXT NOT NULL,
    description TEXT,
    file_path   TEXT,
    line_ref    TEXT,
    suggestion  TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── Analysis Diff Annotations ────────────────────────────────
CREATE TABLE IF NOT EXISTS analysis_diff_annotations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_id UUID REFERENCES analyses(id) ON DELETE CASCADE,
    file_path   TEXT NOT NULL,
    after_line  INTEGER NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('danger','warning','info')),
    text        TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── Analysis Rule Results ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS analysis_rule_results (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_id UUID REFERENCES analyses(id) ON DELETE CASCADE,
    rule_id     UUID,
    rule_name   TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('pass','fail','warn')),
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── Rules ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
    repo_id     UUID REFERENCES repositories(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT,
    severity    TEXT DEFAULT 'warning' CHECK (severity IN ('critical','warning','info')),
    is_active   BOOLEAN DEFAULT true,
    is_builtin  BOOLEAN DEFAULT false,
    prompt_hint TEXT,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ── Org Settings ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS org_settings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    auto_analyze        BOOLEAN DEFAULT true,
    min_score_threshold INTEGER DEFAULT 75,
    notification_email  TEXT,
    slack_webhook_url   TEXT,
    discord_webhook_url TEXT,
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- ── Activity Log ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activity_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
    repo_id     UUID REFERENCES repositories(id),
    mr_id       UUID REFERENCES merge_requests(id),
    event_type  TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_repos_org_id ON repositories(org_id);
CREATE INDEX IF NOT EXISTS idx_mrs_repo_id ON merge_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_mrs_status ON merge_requests(status);
CREATE INDEX IF NOT EXISTS idx_analyses_mr_id ON analyses(mr_id);
CREATE INDEX IF NOT EXISTS idx_issues_analysis_id ON analysis_issues(analysis_id);
CREATE INDEX IF NOT EXISTS idx_annotations_analysis_id ON analysis_diff_annotations(analysis_id);
CREATE INDEX IF NOT EXISTS idx_rule_results_analysis_id ON analysis_rule_results(analysis_id);
CREATE INDEX IF NOT EXISTS idx_rules_org_id ON rules(org_id);
CREATE INDEX IF NOT EXISTS idx_activity_org_id ON activity_log(org_id);
CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log(created_at DESC);
