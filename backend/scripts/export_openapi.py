"""Write the OpenAPI document without needing a database: python scripts/export_openapi.py [out.json]."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from nazoratly.config import Settings
from nazoratly.main import create_app


def build() -> dict[str, object]:
    settings = Settings(
        env="dev",
        database_url_app="postgresql://unused/unused",  # type: ignore[arg-type]
        database_url_auth="postgresql://unused/unused",  # type: ignore[arg-type]
        jwt_secret="openapi-export-only-not-a-secret-000000",  # type: ignore[arg-type]  # noqa: S106
    )
    return create_app(settings).openapi()


if __name__ == "__main__":
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "openapi.json")
    out.write_text(json.dumps(build(), indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size} bytes)")
