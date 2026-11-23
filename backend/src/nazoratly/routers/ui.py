"""The built-in pages (QR scanner, import): static files served by the API itself, so they are same-origin with the
API and need no build step, no CORS and no third-party scripts."""

from __future__ import annotations

from functools import cache
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import Response

router = APIRouter(include_in_schema=False)

UI_DIR = Path(__file__).resolve().parent.parent / "ui"
PAGES = {"scan": "scan.html", "import": "import.html"}
STATIC = {
    "common.js": "text/javascript; charset=utf-8",
    "scan.js": "text/javascript; charset=utf-8",
    "import.js": "text/javascript; charset=utf-8",
    "jsQR.js": "text/javascript; charset=utf-8",
    "ui.css": "text/css; charset=utf-8",
}
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


@cache
def _read(name: str) -> bytes:
    return (UI_DIR / name).read_bytes()


@router.get("/ui/static/{name}")
async def static(name: str) -> Response:
    media = STATIC.get(name)
    if media is None:
        return Response(status_code=404)
    return Response(
        _read(name),
        media_type=media,
        headers={"Cache-Control": "public, max-age=300", "Content-Security-Policy": CSP},
    )


@router.get("/ui/{page}")
async def page(page: str) -> Response:
    name = PAGES.get(page)
    if name is None:
        return Response(status_code=404)
    camera = "camera=(self)" if page == "scan" else "camera=()"
    return Response(
        _read(name),
        media_type="text/html; charset=utf-8",
        headers={
            "Content-Security-Policy": CSP,
            "Permissions-Policy": f"{camera}, microphone=(), geolocation=()",
            "Cache-Control": "no-store",
        },
    )
