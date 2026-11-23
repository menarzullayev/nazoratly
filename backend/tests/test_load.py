"""Load / concurrency tests against the real app + PostgreSQL (in-process ASGI, so this measures the app and
the database, not the network). Thresholds are deliberately loose: they catch regressions such as pool
exhaustion, deadlocks and lost updates, not micro-performance."""

from __future__ import annotations

import asyncio
import statistics
import time
from decimal import Decimal

import httpx

from tests.conftest import Tenant, make_tenant
from tests.helpers import mk_student


def _pct(values: list[float], p: float) -> float:
    s = sorted(values)
    return s[min(len(s) - 1, int(len(s) * p))]


async def _timed(coro: object) -> tuple[int, float]:
    t0 = time.perf_counter()
    r = await coro  # type: ignore[misc]
    return r.status_code, time.perf_counter() - t0


async def test_concurrent_reads_stay_fast_and_error_free(tenant: Tenant) -> None:
    for i in range(30):
        await mk_student(tenant, f"Load Student {i}")
    n, conc = 600, 60
    sem = asyncio.Semaphore(conc)

    async def one() -> tuple[int, float]:
        async with sem:
            return await _timed(tenant.get("/v1/students", params={"limit": 20}))

    t0 = time.perf_counter()
    res = await asyncio.gather(*(one() for _ in range(n)))
    wall = time.perf_counter() - t0
    codes = [c for c, _ in res]
    lat = [d for _, d in res]
    rps = n / wall
    print(
        f"\nreads: n={n} conc={conc} rps={rps:.0f} p50={statistics.median(lat) * 1000:.0f}ms "
        f"p95={_pct(lat, 0.95) * 1000:.0f}ms p99={_pct(lat, 0.99) * 1000:.0f}ms"
    )
    assert codes.count(200) == n, {c: codes.count(c) for c in set(codes)}
    assert _pct(lat, 0.95) < 2.0
    assert rps > 50


async def test_mixed_tenants_under_load_do_not_leak(client: httpx.AsyncClient) -> None:
    tenants = [await make_tenant(client, f"mix{i}") for i in range(4)]
    for i, t in enumerate(tenants):
        for j in range(5):
            await mk_student(t, f"T{i}-S{j}")

    async def check(t: Tenant, i: int) -> bool:
        r = await t.get("/v1/students", params={"limit": 100})
        names = [x["full_name"] for x in r.json()["items"]]
        return r.status_code == 200 and len(names) == 5 and all(n.startswith(f"T{i}-") for n in names)

    results = await asyncio.gather(*(check(t, i) for _ in range(40) for i, t in enumerate(tenants)))
    assert all(results)


async def test_concurrent_registrations(client: httpx.AsyncClient) -> None:
    res = await asyncio.gather(*(make_tenant(client, f"reg{i}") for i in range(25)))
    assert len({t.org_id for t in res}) == 25


async def test_concurrent_writes_create_exactly_n_rows(tenant: Tenant) -> None:
    n = 120
    sem = asyncio.Semaphore(30)

    async def create(i: int) -> int:
        async with sem:
            r = await tenant.post("/v1/students", {"full_name": f"Concurrent {i:04d}"})
            return r.status_code

    codes = await asyncio.gather(*(create(i) for i in range(n)))
    assert codes.count(201) == n, {c: codes.count(c) for c in set(codes)}
    found: set[str] = set()
    offset = 0
    while True:
        page = (
            await tenant.get("/v1/students", params={"limit": 100, "offset": offset, "q": "Concurrent"})
        ).json()
        found |= {x["full_name"] for x in page["items"]}
        if len(page["items"]) < 100:
            break
        offset += 100
    assert len(found) == n


async def test_idempotency_key_under_concurrent_replay(tenant: Tenant) -> None:
    key = "load-idem-key-0001"
    body = {"full_name": "Idempotent Student"}
    res = await asyncio.gather(
        *(tenant.post("/v1/students", body, headers={"Idempotency-Key": key}) for _ in range(20))
    )
    ok = [r for r in res if r.status_code in (200, 201)]
    assert ok, [r.status_code for r in res]
    ids = {r.json()["id"] for r in ok}
    assert len(ids) == 1  # one resource no matter how many parallel retries
    names = [
        x["full_name"] for x in (await tenant.get("/v1/students", params={"q": "Idempotent"})).json()["items"]
    ]
    assert names.count("Idempotent Student") == 1


async def test_pool_survives_burst_beyond_pool_size(tenant: Tenant) -> None:
    # pool max is 20; fire 200 simultaneous requests and require that none fail with 5xx
    res = await asyncio.gather(*(tenant.get("/v1/me") for _ in range(200)))
    bad = [r.status_code for r in res if r.status_code >= 500]
    assert not bad, bad
    assert Decimal(len(res)) == 200
