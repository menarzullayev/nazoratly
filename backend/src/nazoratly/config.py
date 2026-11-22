"""Environment-driven settings (prefix NAZORATLY_). Secrets come only from the environment."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

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
    trust_proxy_headers: bool = False  # honour X-Forwarded-For only behind a trusted proxy

    secrets_key: SecretStr | None = None  # Fernet key; needed only to store/use Payme/Click credentials

    sentry_dsn: SecretStr | None = None
    otel_exporter_otlp_endpoint: str | None = None
    service_name: str = "nazoratly-api"

    @field_validator("jwt_secret")
    @classmethod
    def _secret_long_enough(cls, v: SecretStr) -> SecretStr:
        if len(v.get_secret_value()) < 32:
            raise ValueError("NAZORATLY_JWT_SECRET must be at least 32 characters")
        return v

    @field_validator("secrets_key", "sentry_dsn", "otel_exporter_otlp_endpoint", mode="before")
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
