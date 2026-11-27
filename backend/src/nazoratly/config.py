"""Environment-driven settings (prefix NAZORATLY_). Secrets come only from the environment."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="NAZORATLY_", env_file=".env", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    log_level: str = "INFO"
    log_json: bool = True

    # Two least-privilege database identities (see db/migrations/0005): the API acts as nazoratly_app,
    # login/registration as nazoratly_auth.
    database_url_app: SecretStr
    database_url_auth: SecretStr
    db_pool_min: int = Field(default=2, ge=1)
    db_pool_max: int = Field(default=10, ge=1)
    db_statement_timeout_ms: int = Field(default=15_000, ge=100)

    jwt_secret: SecretStr
    jwt_previous_secrets: list[SecretStr] = Field(default_factory=list)  # verification only (key rotation)
    jwt_issuer: str = "nazoratly"
    jwt_audience: str = "nazoratly-api"
    access_token_ttl_s: int = Field(default=900, ge=60)
    refresh_token_ttl_s: int = Field(default=30 * 24 * 3600, ge=3600)

    cors_origins: list[str] = Field(default_factory=list)
    max_body_bytes: int = Field(default=1_000_000, ge=1_000)

    rate_limit_per_minute: int = Field(default=300, ge=1)  # per client IP, all routes
    auth_rate_limit_per_minute: int = Field(default=20, ge=1)  # per client IP, /v1/auth/*
    login_max_failures: int = Field(default=5, ge=1)  # per identifier within the window
    login_lockout_window_s: int = Field(default=900, ge=60)
    trust_proxy_headers: bool = False  # honour client_ip_header only behind a trusted proxy
    # Header the trusted proxy overwrites with the real client address (Cloudflare: CF-Connecting-IP). It must be a
    # single address: appended lists such as X-Forwarded-For start with a value the client controls.
    client_ip_header: str = "cf-connecting-ip"

    secrets_key: SecretStr | None = None  # Fernet key; needed only to store/use Payme/Click credentials

    tg_relay_target: str | None = None  # Apps Script web app URL that receives relayed Telegram updates
    tg_relay_secret: SecretStr | None = (
        None  # Telegram setWebhook secret_token (also sent to the target as ?s=)
    )

    # The public https address of this server: bot webhooks (/hooks/bot/{id}), the Mini App button and the portal link.
    public_base_url: str | None = None  # e.g. https://nazoratly.bugvector.uz

    # AI assistant (G5): the host-side worker that runs `claude -p`; unset = AI not configured = rule-based reports only.
    ai_worker_url: str | None = None
    ai_worker_token: SecretStr | None = None
    ai_model: str = "haiku"
    ai_timeout_s: float = Field(default=90.0, gt=0)

    # The shared Telegram bot (guardians and teachers of every center without a bot of its own). Optional: without it
    # nothing is sent and the Mini App login answers 404. Register it with `python -m nazoratly.telegram_setup shared`.
    telegram_bot_token: SecretStr | None = None  # also checks the shared bot's Mini App initData signature
    telegram_bot_username: str | None = None  # without @; invitation links while the bot is not registered
    telegram_api_base: str = "https://api.telegram.org"
    teacher_reminder_interval_s: int = Field(
        default=300, ge=0
    )  # reminder loop in the API process; 0 = off (env test: off)

    sentry_dsn: SecretStr | None = None
    otel_exporter_otlp_endpoint: str | None = None
    service_name: str = "nazoratly-api"

    @field_validator("jwt_secret")
    @classmethod
    def _secret_long_enough(cls, v: SecretStr) -> SecretStr:
        if len(v.get_secret_value()) < 32:
            raise ValueError("NAZORATLY_JWT_SECRET must be at least 32 characters")
        return v

    @field_validator(
        "secrets_key",
        "sentry_dsn",
        "otel_exporter_otlp_endpoint",
        "tg_relay_target",
        "tg_relay_secret",
        "public_base_url",
        "ai_worker_url",
        "ai_worker_token",
        "telegram_bot_token",
        "telegram_bot_username",
        mode="before",
    )
    @classmethod
    def _blank_is_unset(cls, v: object) -> object:
        return (
            None if isinstance(v, str) and not v.strip() else v
        )  # docker-compose passes unset variables as ""

    @field_validator("secrets_key")
    @classmethod
    def _valid_fernet_key(cls, v: SecretStr | None) -> SecretStr | None:
        if v is not None:
            from cryptography.fernet import Fernet

            try:
                Fernet(v.get_secret_value().encode())
            except ValueError as e:
                raise ValueError("NAZORATLY_SECRETS_KEY must be a urlsafe-base64 32-byte Fernet key") from e
        return v

    @property
    def panel_origin(self) -> str | None:
        """The origin the staff panel is served from (the origin of `public_base_url`), as a browser writes it in the
        `Origin` header. None = the panel's cookie-session routes are closed and no reset link can be issued."""
        if self.public_base_url is None:
            return None
        parts = urlsplit(self.public_base_url.strip())
        scheme, host = parts.scheme.lower(), (parts.hostname or "").lower()
        local = host in ("localhost", "127.0.0.1", "::1")
        if not host or not (scheme == "https" or (scheme == "http" and local)):
            return None
        netloc = f"[{host}]" if ":" in host else host
        if parts.port is not None and parts.port != (443 if scheme == "https" else 80):
            netloc = f"{netloc}:{parts.port}"
        return f"{scheme}://{netloc}"

    @model_validator(mode="after")
    def _rules(self) -> Settings:
        if self.db_pool_max < self.db_pool_min:
            raise ValueError("db_pool_max must be >= db_pool_min")
        if self.env == "prod" and "*" in self.cors_origins:
            raise ValueError("wildcard CORS is not allowed in prod")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # required values come from the environment
