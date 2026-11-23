"""Black-box load test against a running API (no auth needed: health, ready, and a rejected-anonymous route).

    uv run python scripts/loadtest.py http://127.0.0.1:8000 --requests 2000 --concurrency 50

Prints throughput and latency percentiles and exits non-zero on 5xx or when p95 exceeds --p95-ms.
Point it at your own deployment only. The built-in rate limiter will answer 429 above its per-IP limit,
which is reported separately (that is expected behaviour, not a failure).
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import sys
import time
from collections import Counter

import httpx

PATHS = ("/health", "/ready", "/v1/me")


async def run(base: str, total: int, conc: int) -> tuple[Counter[int], list[float], float]:
    codes: Counter[int] = Counter()
    lat: list[float] = []
    sem = asyncio.Semaphore(conc)
    async with httpx.AsyncClient(base_url=base, timeout=15) as c:

        async def one(i: int) -> None:
            async with sem:
                t0 = time.perf_counter()
                try:
                    r = await c.get(PATHS[i % len(PATHS)])
                    codes[r.status_code] += 1
                except httpx.HTTPError:
                    codes[0] += 1
                lat.append(time.perf_counter() - t0)

        t0 = time.perf_counter()
        await asyncio.gather(*(one(i) for i in range(total)))
        return codes, lat, time.perf_counter() - t0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("base_url")
    ap.add_argument("--requests", type=int, default=1000)
    ap.add_argument("--concurrency", type=int, default=50)
    ap.add_argument("--p95-ms", type=float, default=1500)
    a = ap.parse_args()
    codes, lat, wall = asyncio.run(run(a.base_url.rstrip("/"), a.requests, a.concurrency))
    lat.sort()
    p95 = lat[int(len(lat) * 0.95)] * 1000
    print(f"requests={a.requests} concurrency={a.concurrency} wall={wall:.2f}s rps={a.requests / wall:.0f}")
    print(
        f"p50={statistics.median(lat) * 1000:.0f}ms p95={p95:.0f}ms p99={lat[int(len(lat) * 0.99)] * 1000:.0f}ms"
    )
    print("status codes:", dict(sorted(codes.items())))
    bad = sum(n for c, n in codes.items() if c == 0 or c >= 500)
    if bad or p95 > a.p95_ms:
        print(f"FAILED: {bad} errors/5xx, p95={p95:.0f}ms (limit {a.p95_ms:.0f}ms)")
        return 1
    print("PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
