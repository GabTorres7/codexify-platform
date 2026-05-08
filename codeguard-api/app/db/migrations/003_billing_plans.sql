-- CodeGuard AI — Billing & Plans Schema
-- Run after 002_builtin_rules.sql

-- ── Plans (system-defined) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS plans (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT UNIQUE NOT NULL,         -- 'free', 'starter', 'pro', 'enterprise'
    name        TEXT NOT NULL,
    price_monthly   INTEGER NOT NULL DEFAULT 0,  -- cents (e.g. 2900 = $29.00)
    price_yearly    INTEGER NOT NULL DEFAULT 0,
    max_repos       INTEGER NOT NULL DEFAULT 3,
    max_analyses    INTEGER NOT NULL DEFAULT 50, -- per month
    max_members     INTEGER NOT NULL DEFAULT 3,
    max_chat_msgs   INTEGER NOT NULL DEFAULT 20, -- per month
    features        JSONB DEFAULT '[]',          -- feature flags list
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ── Subscriptions (org → plan) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id             UUID REFERENCES plans(id),
    status              TEXT DEFAULT 'active' CHECK (status IN ('active','canceled','past_due','trialing')),
    stripe_customer_id  TEXT,
    stripe_subscription_id TEXT,
    current_period_start TIMESTAMPTZ,
    current_period_end   TIMESTAMPTZ,
    cancel_at_period_end BOOLEAN DEFAULT false,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- ── Usage tracking (monthly counters) ───────────────────────────
CREATE TABLE IF NOT EXISTS usage_records (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
    month       TEXT NOT NULL,               -- '2026-05'
    analyses    INTEGER DEFAULT 0,
    chat_msgs   INTEGER DEFAULT 0,
    api_calls   INTEGER DEFAULT 0,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    UNIQUE(org_id, month)
);

-- ── Seed default plans ──────────────────────────────────────────
INSERT INTO plans (slug, name, price_monthly, price_yearly, max_repos, max_analyses, max_members, max_chat_msgs, features) VALUES
  ('free',       'Free',       0,      0,       3,    50,    3,   20,  '["upload_analysis","basic_rules"]'),
  ('starter',    'Starter',    2900,   27900,   10,   300,   10,  100, '["upload_analysis","basic_rules","auto_comment","analytics"]'),
  ('pro',        'Pro',        7900,   75900,   50,   2000,  30,  500, '["upload_analysis","basic_rules","auto_comment","analytics","chat","priority_support"]'),
  ('enterprise', 'Enterprise', 19900,  190000,  -1,   -1,    -1,  -1,  '["upload_analysis","basic_rules","auto_comment","analytics","chat","priority_support","sso","custom_rules","api_access","dedicated_support"]')
ON CONFLICT (slug) DO NOTHING;

-- ── Indexes ─────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_subscriptions_org_id ON subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_usage_records_org_month ON usage_records(org_id, month);
