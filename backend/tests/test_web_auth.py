"""The staff panel's cookie sessions, the password reset and what /v1/me tells the panel.

Covers the design's mandatory negative tests 1, 2, 3, 5 and 12 (the browser ones are in panel/e2e)."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from http.cookies import SimpleCookie
from typing import Any

import httpx
import psycopg
import pytest
import pytest_asyncio

from nazoratly.config import Settings
from nazoratly.password_reset import ResetLinkError, issue_link
from nazoratly.routers import auth as auth_router
from nazoratly.security import sha256
from tests.conftest import Tenant, make_tenant
from tests.helpers import ok

ORIGIN = "https://panel.example.test"
COOKIE = "__Secure-nz_refresh"
OWN = {"Origin": ORIGIN}
BAD_ORIGINS = [
    None,
    "https://evil.example.com",
    "https://other.example.test",  # a sibling subdomain: "same-site" to the browser, refused here
    "https://panel.example.test.evil.com",
    "http://panel.example.test",
    "https://panel.example.test:8443",
    "https://panel.example.test/",
    "null",
]


@pytest.fixture(scope="module")
def panel_settings(settings: Any) -> Settings:
    return settings.model_copy(update={"public_base_url": f"{ORIGIN}/"})  # type: ignore[no-any-return]


@pytest_asyncio.fixture(scope="module", loop_scope="session")
async def panel(panel_settings: Settings) -> AsyncIterator[Any]:
    from nazoratly.main import create_app

    app = create_app(panel_settings)
    async with app.router.lifespan_context(app):
        yield app


@pytest_asyncio.fixture(loop_scope="session")
async def web(panel: Any) -> AsyncIterator[httpx.AsyncClient]:
    """No cookie jar tricks: every test passes the cookie explicitly."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=panel), base_url=ORIGIN) as c:
        yield c


def set_cookie(r: httpx.Response) -> Any:
    headers = [h for h in r.headers.get_list("set-cookie") if h.startswith(COOKIE)]
    assert len(headers) == 1, r.headers
    jar: SimpleCookie = SimpleCookie()
    jar.load(headers[0])
    return jar[COOKIE]


async def call(
    web: httpx.AsyncClient,
    path: str,
    body: Any = None,
    cookie: str | None = None,
    origin: str | None = ORIGIN,
) -> httpx.Response:
    web.cookies.clear()
    headers = {} if origin is None else {"Origin": origin}
    if cookie is not None:
        headers["Cookie"] = f"{COOKIE}={cookie}"
    return await web.post(f"/v1/auth/web/{path}", json=body if body is not None else {}, headers=headers)


def registration(label: str = "web") -> dict[str, str]:
    return {
        "full_name": "Owner Web",
        "center_name": f"Center {label} {uuid.uuid4().hex[:6]}",
        "email": f"{label}-{uuid.uuid4().hex[:10]}@example.com",
        "password": "correct-horse-battery",
    }


async def signed_up(web: httpx.AsyncClient) -> tuple[dict[str, str], str, dict[str, Any]]:
    who = registration()
    r = await call(web, "register", who)
    assert r.status_code == 201, r.text
    return who, set_cookie(r).value, r.json()


@pytest.mark.parametrize("origin", BAD_ORIGINS)
@pytest.mark.parametrize("path", ["login", "register", "refresh", "logout"])
async def test_every_web_route_demands_the_panel_origin(
    web: httpx.AsyncClient, path: str, origin: str | None
) -> None:
    who, cookie, _ = await signed_up(web)
    body: dict[str, Any] = {
        "login": {"identifier": who["email"], "password": who["password"]},
        "register": registration("bad"),
    }.get(path, {})
    r = await call(web, path, body, cookie=cookie, origin=origin)
    assert r.status_code == 403, (origin, r.text)
    assert "set-cookie" not in r.headers
    # nothing happened: the session the attacker aimed at still works
    assert (await call(web, "refresh", cookie=cookie)).status_code == 200


async def test_two_origin_headers_are_refused(web: httpx.AsyncClient) -> None:
    who = registration()
    r = await web.post("/v1/auth/web/register", json=who, headers=[("Origin", ORIGIN), ("Origin", ORIGIN)])
    assert r.status_code == 403


async def test_web_routes_are_closed_without_a_configured_origin(client: httpx.AsyncClient) -> None:
    for path, body in (
        ("login", {"identifier": "a@b.co", "password": "x"}),
        ("register", registration()),
        ("refresh", {}),
        ("logout", {}),
    ):
        r = await client.post(f"/v1/auth/web/{path}", json=body, headers=OWN)
        assert r.status_code == 403, (path, r.text)


@pytest.mark.parametrize(
    ("public", "origin"),
    [
        ("https://Nazoratly.Example.uz/app/", "https://nazoratly.example.uz"),
        ("https://example.uz:443", "https://example.uz"),
        ("https://example.uz:8443/x", "https://example.uz:8443"),
        ("http://localhost:8013", "http://localhost:8013"),
        ("http://127.0.0.1:80", "http://127.0.0.1"),
        ("http://example.uz", None),  # a Secure cookie cannot live on plain http
        ("ftp://example.uz", None),
        ("example.uz", None),
        (None, None),
        ("  ", None),
    ],
)
def test_panel_origin(settings: Any, public: str | None, origin: str | None) -> None:
    value = Settings.model_validate({**settings.model_dump(), "public_base_url": public})
    assert value.panel_origin == origin


async def test_cookie_attributes_and_no_refresh_token_in_the_body(
    web: httpx.AsyncClient, panel_settings: Settings
) -> None:
    who = registration()
    responses = [await call(web, "register", who)]
    responses.append(await call(web, "login", {"identifier": who["email"], "password": who["password"]}))
    responses.append(await call(web, "refresh", cookie=set_cookie(responses[-1]).value))
    for r in responses:
        assert r.status_code in (200, 201), r.text
        morsel = set_cookie(r)
        raw = r.headers["set-cookie"]
        assert morsel["path"] == "/v1/auth/web" and morsel["samesite"] == "strict"
        assert morsel["httponly"] and morsel["secure"] and not morsel["domain"] and "Domain" not in raw
        assert int(morsel["max-age"]) == panel_settings.refresh_token_ttl_s
        data = r.json()
        assert set(data) == {"access_token", "token_type", "expires_in", "user", "org", "organizations"}
        assert data["user"]["email"] == who["email"] and data["org"]["role"] == "owner"
        assert morsel.value not in r.text and "nzr_" not in r.text
        assert r.headers["cache-control"] == "no-store"


async def test_refresh_token_is_not_logged(
    web: httpx.AsyncClient, caplog: pytest.LogCaptureFixture, capfd: pytest.CaptureFixture[str]
) -> None:
    with caplog.at_level(logging.DEBUG):
        _, cookie, _ = await signed_up(web)
        r = await call(web, "refresh", cookie=cookie)
        newer = set_cookie(r).value
        await call(web, "refresh", cookie=cookie)  # reuse: the failure path logs too
        await call(web, "logout", cookie=newer)
    captured = capfd.readouterr()
    everything = caplog.text + captured.out + captured.err
    assert cookie not in everything and newer not in everything


async def test_rotation_reuse_kills_the_family(web: httpx.AsyncClient) -> None:
    _, first, _ = await signed_up(web)
    second = set_cookie(await call(web, "refresh", cookie=first)).value
    assert second != first
    reused = await call(web, "refresh", cookie=first)
    assert reused.status_code == 401
    assert set_cookie(reused)["max-age"] == "0"  # the dead cookie is cleared
    assert (await call(web, "refresh", cookie=second)).status_code == 401


async def test_refresh_without_cookie_and_logout(web: httpx.AsyncClient) -> None:
    assert (await call(web, "refresh")).status_code == 401
    _, cookie, _ = await signed_up(web)
    out = await call(web, "logout", cookie=cookie)
    assert out.status_code == 200 and set_cookie(out)["max-age"] == "0"
    assert (await call(web, "refresh", cookie=cookie)).status_code == 401
    assert (await call(web, "logout")).status_code == 200  # already signed out


async def test_json_routes_ignore_the_cookie(web: httpx.AsyncClient) -> None:
    _, cookie, data = await signed_up(web)
    headers = {**OWN, "Cookie": f"{COOKIE}={cookie}"}
    assert (await web.post("/v1/auth/refresh", json={}, headers=headers)).status_code == 422
    assert (await web.post("/v1/auth/logout", json={}, headers=headers)).status_code == 422
    assert (await web.get("/v1/me", headers=headers)).status_code == 401  # a cookie is not a bearer token
    assert (await web.get("/v1/students", headers=headers)).status_code == 401
    assert (await call(web, "refresh", cookie=cookie)).status_code == 200  # none of that used the session


@pytest.mark.parametrize("path", ["refresh", "logout"])
async def test_two_cookies_of_the_name_are_refused(web: httpx.AsyncClient, path: str) -> None:
    _, cookie, _ = await signed_up(web)
    for header in (
        [("Cookie", f"{COOKIE}={cookie}; {COOKIE}=nzr_planted-by-a-neighbour-site")],
        [("Cookie", f"{COOKIE}={cookie}"), ("Cookie", f"{COOKIE}={cookie}")],
    ):
        web.cookies.clear()
        r = await web.post(f"/v1/auth/web/{path}", json={}, headers=[("Origin", ORIGIN), *header])
        assert r.status_code == 401, r.text
        assert "set-cookie" not in r.headers
    assert (await call(web, "refresh", cookie=cookie)).status_code == 200


async def test_web_login_shares_the_lockout_with_json_login(web: httpx.AsyncClient) -> None:
    who, _, _ = await signed_up(web)
    wrong = {"identifier": who["email"], "password": "wrong-password-x"}
    for i in range(5):
        r = await (call(web, "login", wrong) if i % 2 else web.post("/v1/auth/login", json=wrong))
        assert r.status_code == 401
    right = {"identifier": who["email"], "password": who["password"]}
    assert (await call(web, "login", right)).status_code == 429
    assert (await web.post("/v1/auth/login", json=right)).status_code == 429


async def test_switching_centers_and_refusing_a_foreign_one_keeps_the_session(web: httpx.AsyncClient) -> None:
    who, cookie, data = await signed_up(web)
    other = (await call(web, "register", registration("other"))).json()
    refused = await call(web, "refresh", {"org_id": other["org"]["id"]}, cookie=cookie)
    assert refused.status_code == 401 and "set-cookie" not in refused.headers
    r = await call(web, "refresh", {"org_id": data["org"]["id"]}, cookie=cookie)
    assert r.status_code == 200 and r.json()["org"]["id"] == data["org"]["id"]


async def test_password_change_clears_the_cookie(web: httpx.AsyncClient) -> None:
    who, cookie, data = await signed_up(web)
    r = await web.post(
        "/v1/auth/password",
        json={"current_password": who["password"], "new_password": "another-long-password"},
        headers={"Authorization": f"Bearer {data['access_token']}"},
    )
    assert r.status_code == 200 and set_cookie(r)["max-age"] == "0"
    assert (await call(web, "refresh", cookie=cookie)).status_code == 401


# ---- /v1/me ------------------------------------------------------------------------------------------------------
async def test_me_lists_permissions_and_the_branch_restriction(
    tenant: Tenant, client: httpx.AsyncClient
) -> None:
    mine = await ok(await tenant.get("/v1/me"))
    assert "org:manage" in mine["permissions"] and mine["branch_id"] is None
    branch = await ok(await tenant.post("/v1/branches", {"name": "Chilonzor"}), 201)
    email = f"teach-{uuid.uuid4().hex[:8]}@example.com"
    await ok(
        await tenant.post(
            "/v1/staff",
            {
                "full_name": "T",
                "email": email,
                "role": "teacher",
                "branch_id": branch["id"],
                "initial_password": "teacher-password-1",
            },
        ),
        201,
    )
    login = await ok(
        await client.post("/v1/auth/login", json={"identifier": email, "password": "teacher-password-1"})
    )
    me = await ok(await client.get("/v1/me", headers={"Authorization": f"Bearer {login['access_token']}"}))
    assert me["branch_id"] == branch["id"]
    assert me["permissions"] == sorted(
        ["org:read", "academics:read", "attendance:read", "attendance:write", "results:read", "results:write"]
    )


# ---- password reset ----------------------------------------------------------------------------------------------
async def reset_code(panel: Any, panel_settings: Settings, email: str, **kw: Any) -> str:
    link = await issue_link(panel.state.db, panel_settings, identifier=email, operator="tester", **kw)
    prefix = f"{ORIGIN}/app/reset#code="
    assert link.startswith(
        prefix
    )  # the code is in the fragment: never sent to a server as part of the address
    return link.removeprefix(prefix)


@pytest_asyncio.fixture(autouse=True, loop_scope="session")
async def _forget_reset_failures(super_dsn: str) -> None:
    """The reset route counts failures per client address, and every test comes from the same one."""
    with psycopg.connect(super_dsn, autocommit=True) as c:
        c.execute("DELETE FROM login_attempts WHERE identifier LIKE 'reset:%'")


async def test_reset_changes_the_password_and_ends_every_session(
    web: httpx.AsyncClient, panel: Any, panel_settings: Settings, super_dsn: str
) -> None:
    who, cookie, _ = await signed_up(web)
    json_login = (
        await web.post("/v1/auth/login", json={"identifier": who["email"], "password": who["password"]})
    ).json()
    for _ in range(5):  # lock the account out first: a reset must lift the lockout
        await web.post("/v1/auth/login", json={"identifier": who["email"], "password": "wrong-password-x"})
    assert (
        await web.post("/v1/auth/login", json={"identifier": who["email"], "password": who["password"]})
    ).status_code == 429
    code = await reset_code(panel, panel_settings, who["email"].upper())
    r = await web.post("/v1/auth/reset", json={"code": code, "new_password": "a-brand-new-password"})
    assert r.status_code == 200, r.text
    assert (await call(web, "refresh", cookie=cookie)).status_code == 401
    assert (
        await web.post("/v1/auth/refresh", json={"refresh_token": json_login["refresh_token"]})
    ).status_code == 401
    assert (
        await web.post("/v1/auth/login", json={"identifier": who["email"], "password": who["password"]})
    ).status_code == 401
    assert (
        await web.post(
            "/v1/auth/login", json={"identifier": who["email"], "password": "a-brand-new-password"}
        )
    ).status_code == 200
    with psycopg.connect(super_dsn) as c:  # the record: who issued it and when it was used, never the code
        row = c.execute(
            "SELECT issued_by, used_at IS NOT NULL, expires_at - created_at <= interval '31 minutes' "
            "FROM password_reset_codes WHERE code_hash = %s",
            (sha256(code),),
        ).fetchone()
    assert row == ("tester", True, True)


async def test_wrong_used_expired_and_replaced_codes_get_one_answer(
    web: httpx.AsyncClient, panel: Any, panel_settings: Settings, super_dsn: str
) -> None:
    who, _, _ = await signed_up(web)
    used = await reset_code(panel, panel_settings, who["email"])
    assert (
        await web.post("/v1/auth/reset", json={"code": used, "new_password": "first-new-password"})
    ).status_code == 200
    replaced = await reset_code(panel, panel_settings, who["email"])
    expired = await reset_code(panel, panel_settings, who["email"])  # this one cancels `replaced`
    with psycopg.connect(super_dsn, autocommit=True) as c:
        c.execute(
            "UPDATE password_reset_codes SET expires_at = now() - interval '1 second' WHERE code_hash = %s",
            (sha256(expired),),
        )
    answers = []
    for code in ("nzp_" + "x" * 43, used, replaced, expired):
        r = await web.post("/v1/auth/reset", json={"code": code, "new_password": "second-new-password"})
        answers.append((r.status_code, r.json()["error"]["code"], r.json()["error"]["message"]))
    assert len(set(answers)) == 1 and answers[0][:2] == (422, "invalid_reset_code"), answers
    assert (
        await web.post("/v1/auth/login", json={"identifier": who["email"], "password": "first-new-password"})
    ).status_code == 200


async def test_reset_attempts_are_limited(
    web: httpx.AsyncClient, panel: Any, panel_settings: Settings
) -> None:
    who, _, _ = await signed_up(web)
    for _ in range(10):
        r = await web.post(
            "/v1/auth/reset", json={"code": "nzp_" + uuid.uuid4().hex, "new_password": "whatever-password"}
        )
        assert r.status_code == 422
    good = await reset_code(panel, panel_settings, who["email"])
    r = await web.post("/v1/auth/reset", json={"code": good, "new_password": "whatever-password"})
    assert r.status_code == 429 and r.headers["retry-after"]


async def test_a_blocked_address_costs_no_password_hash(
    web: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    hashed: list[str] = []
    real = auth_router.hash_password

    async def counting(password: str) -> str:
        hashed.append(password)
        return await real(password)

    monkeypatch.setattr(auth_router, "hash_password", counting)

    def attempt() -> Any:
        return web.post(
            "/v1/auth/reset", json={"code": "nzp_" + uuid.uuid4().hex, "new_password": "whatever-password"}
        )

    for _ in range(10):
        assert (await attempt()).status_code == 422
    assert len(hashed) == 10  # an address within the limit pays the same for every code
    for _ in range(3):
        r = await attempt()
        assert (r.status_code, r.json()["error"]["code"]) == (429, "rate_limited")
    assert len(hashed) == 10


async def test_one_code_works_once_even_when_used_twice_at_the_same_time(
    web: httpx.AsyncClient, panel: Any, panel_settings: Settings
) -> None:
    who, _, _ = await signed_up(web)
    code = await reset_code(panel, panel_settings, who["email"])
    results = await asyncio.gather(
        *(
            web.post("/v1/auth/reset", json={"code": code, "new_password": f"racing-password-{i}"})
            for i in range(2)
        )
    )
    assert sorted(r.status_code for r in results) == [200, 422]


async def test_reset_code_is_not_logged(
    web: httpx.AsyncClient,
    panel: Any,
    panel_settings: Settings,
    caplog: pytest.LogCaptureFixture,
    capfd: pytest.CaptureFixture[str],
) -> None:
    who, _, _ = await signed_up(web)
    with caplog.at_level(logging.DEBUG):
        code = await reset_code(panel, panel_settings, who["email"])
        await web.post("/v1/auth/reset", json={"code": code, "new_password": "yet-another-password"})
        await web.post("/v1/auth/reset", json={"code": code, "new_password": "yet-another-password"})
        await web.post(
            "/v1/auth/reset", json={"code": code, "new_password": "short"}
        )  # the validation error path
    captured = capfd.readouterr()
    assert code not in caplog.text + captured.out + captured.err


async def test_no_http_route_issues_a_reset_link(panel: Any) -> None:
    posts = [p for p, ops in panel.openapi()["paths"].items() if "reset" in p]
    assert posts == ["/v1/auth/reset"]


async def test_the_operator_command_refuses_what_it_cannot_do(
    panel: Any, panel_settings: Settings, settings: Any
) -> None:
    t_email = f"nobody-{uuid.uuid4().hex}@example.com"
    for kw, cfg in (
        ({}, panel_settings),
        ({"operator": "  "}, panel_settings),
        ({"ttl_minutes": 61}, panel_settings),
        ({}, settings),  # no public address: the link would lead nowhere
    ):
        args: dict[str, Any] = {"identifier": t_email, "operator": "tester", **kw}
        with pytest.raises(ResetLinkError):
            await issue_link(panel.state.db, cfg, **args)


async def test_app_role_cannot_read_reset_codes(pg_server: dict[str, Any]) -> None:
    with psycopg.connect(pg_server["app"]) as c, pytest.raises(psycopg.errors.InsufficientPrivilege):
        c.execute("SELECT * FROM password_reset_codes")


async def test_two_tenants_helper_is_independent(client: httpx.AsyncClient) -> None:
    a, b = await make_tenant(client, "w1"), await make_tenant(client, "w2")
    assert a.org_id != b.org_id
