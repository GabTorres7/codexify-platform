from functools import lru_cache
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # Application
    app_name: str = "CodeGuard API"
    app_env: str = "development"
    debug: bool = True
    secret_key: str = "change-me"
    allowed_origins: list[str] = ["http://localhost:3000", "http://localhost:5500"]

    @field_validator("allowed_origins", mode="before")
    @classmethod
    def parse_origins(cls, v):
        if isinstance(v, str):
            v = v.strip()
            # Handle JSON array format: ["url1","url2"]
            if v.startswith("["):
                import json
                try:
                    return json.loads(v)
                except json.JSONDecodeError:
                    pass
            return [o.strip() for o in v.split(",") if o.strip()]
        return v

    # Supabase
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""
    database_url: str = ""

    # Claude AI
    anthropic_api_key: str = ""
    claude_model: str = "claude-sonnet-4-6"
    claude_max_tokens: int = 4096

    # JWT
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 30

    # API Keys
    api_key_prefix: str = "cg_live_"

    # Git Platforms
    github_webhook_secret: str = "change-me"
    gitlab_webhook_secret: str = "change-me"

    # Public URL (used when registering webhooks on git platforms)
    public_api_url: str = "https://localhost:8000"

    # Stripe (optional — billing works without it using free plan switching)
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    stripe_publishable_key: str = ""

    # Notifications
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    default_from_email: str = "codeguard@yourdomain.com"


@lru_cache
def get_settings() -> Settings:
    return Settings()
