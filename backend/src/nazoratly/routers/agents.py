"""AI-agent control plane (Model B): agent clients and tokens, drafts awaiting human approval, outbox, audit log.

An agent can only read restricted views and propose drafts (see db/migrations/0004-0005). Everything here is the
HUMAN side: issuing/revoking agent tokens, reviewing the tool-call log, approving or rejecting drafts.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, StringConstraints

from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import Conflict, NotFound
from nazoratly.idempotency import IdempotentRoute
from nazoratly.schemas import LongText, Model, Name, Out, Page, make_page
from nazoratly.security import new_opaque_token, sha256

router = APIRouter(prefix="/v1", tags=["agents & audit"], route_class=IdempotentRoute)

Scope = Literal["read", "draft"]


# ---- agent clients -------------------------------------------------------------------------------------------
class AgentIn(Model):
    name: Name
    scopes: Annotated[list[Scope], Field(min_length=1, max_length=2)] = ["read"]
    expires_in_days: Annotated[int, Field(ge=1, le=730)] | None = Field(
        default=90, description="null = never expires"
    )


class AgentOut(Out):
    id: uuid.UUID
    name: str
    scopes: list[str]
    status: str
    expires_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime
    revoked_at: datetime | None


class AgentCreated(AgentOut):
    token: str = Field(description="shown ONCE; only its SHA-256 is stored")


_AGENT_SQL = "SELECT public_id AS id, name, scopes, status, expires_at, last_used_at, created_at, revoked_at FROM agent_clients"


@router.post(
    "/agents", response_model=AgentCreated, status_code=201, summary="Create an agent client and its token"
)
async def create_agent(
    body: AgentIn, p: Annotated[Principal, Depends(require("agent:manage"))], db: DB
) -> AgentCreated:
    token = new_opaque_token("nzt")
    expires = datetime.now(UTC) + timedelta(days=body.expires_in_days) if body.expires_in_days else None
    async with db.tx(p.session()) as conn:
        row = await fetch_one(
            conn,
            "INSERT INTO agent_clients (org_id, user_id, name, token_hash, scopes, expires_at) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (p.org_id, p.user_id, body.name, sha256(token), body.scopes, expires),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_AGENT_SQL} WHERE id = %s", (row["id"],))
    assert out is not None
    return AgentCreated(**AgentOut.model_validate(out).model_dump(), token=token)


@router.get("/agents", response_model=list[AgentOut])
async def list_agents(p: Annotated[Principal, Depends(require("agent:manage"))], db: DB) -> list[AgentOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(conn, f"{_AGENT_SQL} ORDER BY created_at DESC, id DESC")
    return [AgentOut.model_validate(r) for r in rows]


@router.post(
    "/agents/{agent_id}/revoke", response_model=AgentOut, summary="Revoke an agent token (irreversible)"
)
async def revoke_agent(
    agent_id: uuid.UUID, p: Annotated[Principal, Depends(require("agent:manage"))], db: DB
) -> AgentOut:
    async with db.tx(p.session()) as conn:
        aid = await resolve(conn, "agent_clients", agent_id, what="agent")
        cur = await fetch_one(conn, "SELECT status FROM agent_clients WHERE id = %s FOR UPDATE", (aid,))
        assert cur is not None
        if cur["status"] == "revoked":
            raise Conflict("Agent is already revoked")
        await execute(
            conn, "UPDATE agent_clients SET status = 'revoked', revoked_at = now() WHERE id = %s", (aid,)
        )
        out = await fetch_one(conn, f"{_AGENT_SQL} WHERE id = %s", (aid,))
    assert out is not None
    return AgentOut.model_validate(out)


class ToolCallOut(Out):
    id: int
    tool_name: str
    tier: str
    args: dict[str, Any]
    outcome: str
    rows_returned: int | None
    error: str | None
    created_at: datetime


@router.get(
    "/agents/{agent_id}/calls",
    response_model=Page[ToolCallOut],
    summary="What this agent did (append-only log)",
)
async def agent_calls(
    agent_id: uuid.UUID, p: Annotated[Principal, Depends(require("agent:manage"))], db: DB, pg: Paging
) -> Page[ToolCallOut]:
    async with db.tx(p.session()) as conn:
        aid = await resolve(conn, "agent_clients", agent_id, what="agent")
        rows = await fetch_all(
            conn,
            "SELECT id, tool_name, tier, args, outcome, rows_returned, error, created_at FROM agent_tool_calls "
            "WHERE agent_client_id = %s ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s",
            (aid, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, ToolCallOut)


# ---- drafts --------------------------------------------------------------------------------------------------
DraftStatus = Literal["pending", "approved", "rejected", "expired", "executed"]


class DraftOut(Out):
    id: uuid.UUID
    agent_id: uuid.UUID
    agent_name: str
    kind: str
    student_id: uuid.UUID
    student_name: str
    guardian_id: uuid.UUID
    guardian_name: str
    summary: str
    body: str
    status: str
    expires_at: datetime
    decided_at: datetime | None
    created_at: datetime


class ApproveIn(Model):
    channel: Literal["telegram", "sms"] | None = Field(
        default=None, description="defaults to telegram when the guardian has a chat, else sms"
    )


_DRAFT_SQL = (
    "SELECT d.public_id AS id, a.public_id AS agent_id, a.name AS agent_name, d.kind, s.public_id AS student_id, s.full_name AS student_name,"
    " g.public_id AS guardian_id, g.full_name AS guardian_name, d.summary, d.body, d.status, d.expires_at, d.decided_at, d.created_at "
    "FROM agent_drafts d JOIN agent_clients a ON a.org_id = d.org_id AND a.id = d.agent_client_id "
    "JOIN students s ON s.org_id = d.org_id AND s.id = d.student_id JOIN guardians g ON g.org_id = d.org_id AND g.id = d.guardian_id"
)


async def _expire_stale(conn: Conn) -> None:
    await execute(
        conn, "UPDATE agent_drafts SET status = 'expired' WHERE status = 'pending' AND expires_at < now()"
    )


@router.get("/agent-drafts", response_model=Page[DraftOut], summary="Drafts proposed by agents")
async def list_drafts(
    p: Annotated[Principal, Depends(require("agent:manage"))],
    db: DB,
    pg: Paging,
    status: DraftStatus | None = "pending",
) -> Page[DraftOut]:
    async with db.tx(p.session()) as conn:
        await _expire_stale(conn)
        rows = await fetch_all(
            conn,
            f"{_DRAFT_SQL} WHERE (%s::text IS NULL OR d.status = %s) ORDER BY d.created_at DESC, d.id DESC LIMIT %s OFFSET %s",
            (status, status, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, DraftOut)


async def _locked_pending_draft(conn: Conn, draft_public: uuid.UUID) -> int:
    did = await resolve(conn, "agent_drafts", draft_public, what="draft")
    cur = await fetch_one(
        conn, "SELECT status, expires_at FROM agent_drafts WHERE id = %s FOR UPDATE", (did,)
    )
    assert cur is not None
    if cur["status"] == "pending" and cur["expires_at"] < datetime.now(UTC):
        await execute(conn, "UPDATE agent_drafts SET status = 'expired' WHERE id = %s", (did,))
        cur["status"] = "expired"
    if cur["status"] != "pending":
        raise Conflict(f"Draft is already {cur['status']}")
    return did


@router.post(
    "/agent-drafts/{draft_id}/approve", response_model=DraftOut, summary="Approve a draft: queues the message"
)
async def approve_draft(
    draft_id: uuid.UUID, body: ApproveIn, p: Annotated[Principal, Depends(require("agent:manage"))], db: DB
) -> DraftOut:
    async with db.tx(p.session()) as conn:
        did = await _locked_pending_draft(conn, draft_id)
        d = await fetch_one(
            conn,
            "SELECT d.public_id, d.student_id, d.guardian_id, d.body, g.telegram_chat_id, g.phone FROM agent_drafts d "
            "JOIN guardians g ON g.org_id = d.org_id AND g.id = d.guardian_id WHERE d.id = %s",
            (did,),
        )
        assert d is not None
        channel = body.channel or ("telegram" if d["telegram_chat_id"] is not None else "sms")
        if channel == "telegram" and d["telegram_chat_id"] is None:
            raise Conflict("Guardian has no Telegram chat; choose sms")
        if channel == "sms" and d["phone"] is None:
            raise Conflict("Guardian has no phone number; choose telegram")
        await execute(
            conn,
            "UPDATE agent_drafts SET status = 'approved', decided_by_user_id = %s, decided_at = now() WHERE id = %s",
            (p.user_id, did),
        )
        # the database re-checks guardian link + active notifications consent + approved draft when queuing
        await execute(
            conn,
            "INSERT INTO outbox_messages (org_id, draft_id, student_id, guardian_id, channel, body, idempotency_key) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (p.org_id, did, d["student_id"], d["guardian_id"], channel, d["body"], f"draft-{d['public_id']}"),
        )
        out = await fetch_one(conn, f"{_DRAFT_SQL} WHERE d.id = %s", (did,))
    assert out is not None
    return DraftOut.model_validate(out)


@router.post("/agent-drafts/{draft_id}/reject", response_model=DraftOut)
async def reject_draft(
    draft_id: uuid.UUID, p: Annotated[Principal, Depends(require("agent:manage"))], db: DB
) -> DraftOut:
    async with db.tx(p.session()) as conn:
        did = await _locked_pending_draft(conn, draft_id)
        await execute(
            conn,
            "UPDATE agent_drafts SET status = 'rejected', decided_by_user_id = %s, decided_at = now() WHERE id = %s",
            (p.user_id, did),
        )
        out = await fetch_one(conn, f"{_DRAFT_SQL} WHERE d.id = %s", (did,))
    assert out is not None
    return DraftOut.model_validate(out)


# ---- outbox --------------------------------------------------------------------------------------------------
OutboxStatus = Literal["queued", "sending", "sent", "failed", "cancelled"]


class OutboxIn(Model):
    student_id: uuid.UUID
    guardian_id: uuid.UUID
    channel: Literal["telegram", "sms"]
    body: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4096)]
    send_after: datetime | None = None
    client_ref: Annotated[str, StringConstraints(min_length=8, max_length=100)] | None = Field(
        default=None, description="your own unique reference; retries with the same value never queue twice"
    )


class OutboxOut(Out):
    id: uuid.UUID
    draft_id: uuid.UUID | None
    student_id: uuid.UUID
    student_name: str
    guardian_id: uuid.UUID
    guardian_name: str
    channel: str
    body: str
    status: str
    attempts: int
    last_error: str | None
    send_after: datetime
    sent_at: datetime | None
    created_at: datetime


_OUT_SQL = (
    "SELECT o.public_id AS id, d.public_id AS draft_id, s.public_id AS student_id, s.full_name AS student_name, g.public_id AS guardian_id,"
    " g.full_name AS guardian_name, o.channel, o.body, o.status, o.attempts, o.last_error, o.send_after, o.sent_at, o.created_at "
    "FROM outbox_messages o JOIN students s ON s.org_id = o.org_id AND s.id = o.student_id "
    "JOIN guardians g ON g.org_id = o.org_id AND g.id = o.guardian_id LEFT JOIN agent_drafts d ON d.org_id = o.org_id AND d.id = o.draft_id"
)


@router.post(
    "/outbox",
    response_model=OutboxOut,
    status_code=201,
    summary="Queue a message to a guardian (needs notifications consent)",
)
async def queue_message(
    body: OutboxIn, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> OutboxOut:
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "students", body.student_id, what="student")
        gid = await resolve(conn, "guardians", body.guardian_id, what="guardian")
        key = f"manual-{body.client_ref or uuid.uuid4().hex}"
        row = await fetch_one(
            conn,
            "INSERT INTO outbox_messages (org_id, student_id, guardian_id, channel, body, send_after, idempotency_key) "
            "VALUES (%s, %s, %s, %s, %s, COALESCE(%s, now()), %s) RETURNING id",
            (p.org_id, sid, gid, body.channel, body.body, body.send_after, key),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_OUT_SQL} WHERE o.id = %s", (row["id"],))
    assert out is not None
    return OutboxOut.model_validate(out)


@router.get("/outbox", response_model=Page[OutboxOut])
async def list_outbox(
    p: Annotated[Principal, Depends(require("students:read"))],
    db: DB,
    pg: Paging,
    status: OutboxStatus | None = None,
) -> Page[OutboxOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            f"{_OUT_SQL} WHERE (%s::text IS NULL OR o.status = %s) ORDER BY o.created_at DESC, o.id DESC LIMIT %s OFFSET %s",
            (status, status, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, OutboxOut)


@router.post("/outbox/{message_id}/cancel", response_model=OutboxOut)
async def cancel_message(
    message_id: uuid.UUID, p: Annotated[Principal, Depends(require("students:write"))], db: DB
) -> OutboxOut:
    async with db.tx(p.session()) as conn:
        oid = await resolve(conn, "outbox_messages", message_id, what="message")
        cur = await fetch_one(conn, "SELECT status FROM outbox_messages WHERE id = %s FOR UPDATE", (oid,))
        assert cur is not None
        if cur["status"] != "queued":
            raise Conflict(f"Message is {cur['status']}; only queued messages can be cancelled")
        await execute(conn, "UPDATE outbox_messages SET status = 'cancelled' WHERE id = %s", (oid,))
        out = await fetch_one(conn, f"{_OUT_SQL} WHERE o.id = %s", (oid,))
    assert out is not None
    return OutboxOut.model_validate(out)


# ---- audit ---------------------------------------------------------------------------------------------------
AUDITABLE = {
    "students", "guardians", "teachers", "study_groups", "enrollments", "lessons", "charges", "payments",
    "expenses", "teacher_payrolls", "agent_clients", "agent_drafts", "outbox_messages", "memberships", "data_consents",
}  # fmt: skip


class AuditOut(Out):
    id: int
    created_at: datetime
    actor_type: str
    actor_user_id: uuid.UUID | None
    agent_id: uuid.UUID | None
    action: str
    entity_type: str
    entity_id: uuid.UUID | None
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    request_id: str | None


def _clean(data: dict[str, Any] | None) -> dict[str, Any] | None:
    if data is None:
        return None
    return {k: v for k, v in data.items() if k not in ("id", "org_id")}


@router.get("/audit", response_model=Page[AuditOut], summary="Who changed what (append-only)")
async def audit_log(
    p: Annotated[Principal, Depends(require("audit:read"))],
    db: DB,
    pg: Paging,
    entity_type: Annotated[str | None, Query(max_length=50)] = None,
    entity_id: uuid.UUID | None = None,
    actor_user_id: uuid.UUID | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> Page[AuditOut]:
    if entity_id is not None and entity_type is None:
        raise NotFound("entity_type is required with entity_id")
    where: list[str] = []
    params: list[Any] = []
    async with db.tx(p.session()) as conn:
        if entity_type is not None:
            if entity_type not in AUDITABLE:
                raise NotFound("unknown entity_type")
            where.append("a.entity_type = %s")
            params.append(entity_type)
            if entity_id is not None:
                where.append("a.entity_id = %s")
                params.append(await resolve(conn, entity_type, entity_id, what="entity"))
        if actor_user_id is not None:
            where.append("u.public_id = %s")
            params.append(actor_user_id)
        if date_from:
            where.append("a.created_at >= %s")
            params.append(date_from)
        if date_to:
            where.append("a.created_at < %s")
            params.append(date_to)
        rows = await fetch_all(
            conn,
            "SELECT a.id, a.created_at, a.actor_type, u.public_id AS actor_user_id, ag.public_id AS agent_id, a.action, a.entity_type,"
            " COALESCE(a.after_data->>'public_id', a.before_data->>'public_id')::uuid AS entity_id, a.before_data, a.after_data, a.request_id "
            "FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id "
            "LEFT JOIN agent_clients ag ON ag.org_id = a.org_id AND ag.id = a.agent_client_id "
            f"WHERE {' AND '.join(where) or 'TRUE'} ORDER BY a.created_at DESC, a.id DESC LIMIT %s OFFSET %s",
            (*params, pg.limit + 1, pg.offset),
        )
    items = [
        AuditOut(
            id=r["id"],
            created_at=r["created_at"],
            actor_type=r["actor_type"],
            actor_user_id=r["actor_user_id"],
            agent_id=r["agent_id"],
            action=r["action"],
            entity_type=r["entity_type"],
            entity_id=r["entity_id"],
            before=_clean(r["before_data"]),
            after=_clean(r["after_data"]),
            request_id=r["request_id"],
        )
        for r in rows[: pg.limit]
    ]
    return Page[AuditOut](items=items, limit=pg.limit, offset=pg.offset, has_more=len(rows) > pg.limit)


_ = LongText
