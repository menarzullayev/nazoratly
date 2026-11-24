"""Idempotency-Key support for POST requests (stored per center + user, 24 h).

Semantics: the first request with a key runs normally and, when it succeeds (2xx), its response is stored.
A retry with the same key and the same body gets the stored response (header `Idempotent-Replayed: true`).
Same key with a different body -> 422. Same key while the first request is still running -> 409.
Failed (non-2xx) attempts release the key so a corrected request can be retried with it.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from nazoratly.db import Database, Session, execute, fetch_one
from nazoratly.errors import Conflict, Unprocessable
from nazoratly.security import decode_access_token

_TTL_SQL = "interval '24 hours'"


class IdempotentRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            key = request.headers.get("Idempotency-Key")
            if request.method != "POST" or key is None:
                return await original(request)
            if not 8 <= len(key) <= 255:
                raise Unprocessable("Idempotency-Key must be 8-255 characters")
            auth = request.headers.get("Authorization", "")
            if not auth.lower().startswith("bearer "):
                return await original(request)  # the endpoint's own auth will answer 401
            claims = decode_access_token(request.app.state.settings, auth[7:].strip())
            if claims.org_id is None:
                return await original(request)
            db: Database = request.app.state.db
            session = Session(
                user_id=claims.user_id,
                org_id=claims.org_id,
                request_id=getattr(request.state, "request_id", None),
            )
            async with db.tx(session) as conn:
                # replay only for someone who is still an active member: authorization precedes any stored response
                active = await fetch_one(
                    conn,
                    "SELECT 1 AS x FROM memberships m JOIN users u ON u.id = m.user_id "
                    "WHERE m.user_id = %s AND m.status = 'active' AND u.status = 'active'",
                    (claims.user_id,),
                )
            if active is None:
                return await original(request)  # the endpoint's own dependencies answer 401/403
            raw = await request.body()
            digest = hashlib.sha256(
                f"{request.method}\n{request.url.path}\n{request.url.query}\n{request.headers.get('X-Branch', '')}\n".encode()
                + raw
            ).digest()

            async with db.tx(session) as conn:
                await execute(conn, f"DELETE FROM idempotency_keys WHERE created_at < now() - {_TTL_SQL}")
                claimed = await fetch_one(
                    conn,
                    "INSERT INTO idempotency_keys (org_id, user_id, key, method, path, request_hash) "
                    "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (org_id, user_id, key) DO NOTHING RETURNING id",
                    (claims.org_id, claims.user_id, key, request.method, request.url.path, digest),
                )
                existing = None
                if claimed is None:
                    existing = await fetch_one(
                        conn,
                        "SELECT request_hash, status_code, response_body FROM idempotency_keys "
                        "WHERE org_id = %s AND user_id = %s AND key = %s",
                        (claims.org_id, claims.user_id, key),
                    )
            if existing is not None:
                if bytes(existing["request_hash"]) != digest:
                    raise Unprocessable("Idempotency-Key was already used with a different request")
                if existing["status_code"] is None:
                    raise Conflict("A request with this Idempotency-Key is still being processed")
                replay = JSONResponse(existing["response_body"], status_code=existing["status_code"])
                replay.headers["Idempotent-Replayed"] = "true"
                return replay
            if claimed is None:  # row vanished between the two statements (expired): just run
                return await original(request)

            async def release() -> None:
                async with db.tx(session) as c:
                    await execute(c, "DELETE FROM idempotency_keys WHERE id = %s", (claimed["id"],))

            try:
                response = await original(request)
            except BaseException:
                await release()
                raise
            if not 200 <= response.status_code < 300:
                await release()
                return response
            payload = json.loads(bytes(response.body)) if getattr(response, "body", b"") else None
            async with db.tx(session) as c:
                await execute(
                    c,
                    "UPDATE idempotency_keys SET status_code = %s, response_body = %s::jsonb, completed_at = now() WHERE id = %s",
                    (
                        response.status_code,
                        json.dumps(payload) if payload is not None else None,
                        claimed["id"],
                    ),
                )
            return response

        return handler
