"""The built-in pages: served by the API, locked down by their own CSP, nothing else is reachable."""

from __future__ import annotations

import httpx


async def test_pages_and_assets_are_served_with_a_strict_csp(client: httpx.AsyncClient) -> None:
    for page, camera in (("scan", "camera=(self)"), ("import", "camera=()"), ("calendar", "camera=()")):
        r = await client.get(f"/ui/{page}")
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
        csp = r.headers["content-security-policy"]
        assert "script-src 'self'" in csp and "'unsafe-inline'" not in csp and "frame-ancestors 'none'" in csp
        assert camera in r.headers["permissions-policy"] and r.headers["cache-control"] == "no-store"
        assert (
            r.headers["x-content-type-options"] == "nosniff" and "<script>" not in r.text
        )  # no inline scripts
    for name, kind in (
        ("common.js", "javascript"),
        ("scan.js", "javascript"),
        ("import.js", "javascript"),
        ("calendar.js", "javascript"),
        ("jsQR.js", "javascript"),
        ("ui.css", "css"),
    ):
        r = await client.get(f"/ui/static/{name}")
        assert r.status_code == 200 and kind in r.headers["content-type"] and len(r.content) > 500, name
        assert "script-src 'self'" in r.headers["content-security-policy"]


async def test_nothing_else_is_reachable_through_the_ui_routes(client: httpx.AsyncClient) -> None:
    for path in (
        "/ui/nope",
        "/ui/static/nope.js",
        "/ui/static/jsQR.LICENSE.txt",
        "/ui/static/..%2f..%2fconfig.py",
        "/ui/static/%2e%2e/config.py",
        "/ui/",
    ):
        r = await client.get(path)
        assert r.status_code in (404, 307, 308), (path, r.status_code)
        assert b"jwt_secret" not in r.content


async def test_the_pages_call_only_documented_endpoints(client: httpx.AsyncClient) -> None:
    import re

    text = ""
    for n in ("common.js", "scan.js", "import.js", "calendar.js"):
        text += (await client.get(f"/ui/static/{n}")).text
    called = set(re.findall(r'"(/v1/[a-z/_{}-]+)', text))
    spec = (await client.get("/openapi.json")).json()["paths"]
    for path in called:
        pattern = path.rstrip("/")
        assert (
            any(
                p == pattern or p.startswith(pattern + "/") or p.replace("{entity}", "x").startswith(pattern)
                for p in spec
            )
            or "?" in path
        ), path
