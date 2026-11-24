"""Online payment callbacks (called by Payme and Click, not by browsers) + the center's provider settings.

Each center is its own merchant: Payme/Click are given  {API_BASE}/pay/payme/{center_id}  and
{API_BASE}/pay/click/{center_id}.  The account a payer pays into is a STUDENT: Payme `account.student` /
Click `merchant_trans_id` = the student's id (UUID). A performed transaction creates a normal payment that is
allocated to the oldest open charges (same FIFO logic as a cash payment).

Protocol references: Payme Merchant API (JSON-RPC 2.0, Basic auth, amounts in tiyin, states 1/2/-1/-2, 12 h timeout);
Click SHOP API (Prepare action=0 / Complete action=1, MD5 sign_string, errors 0/-1..-9).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from base64 import b64decode
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any, Literal
from urllib.parse import parse_qs

import httpx
import structlog
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import Field, StringConstraints

from nazoratly.accounting import post_payment, void_source
from nazoratly.db import Conn, Database, Session, execute, fetch_all, fetch_one
from nazoratly.deps import DB, Paging, Principal, require
from nazoratly.errors import ApiError, Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.money import revoke_unearned_early
from nazoratly.routers.finance import allocate_fifo
from nazoratly.schemas import Dec2, Model, Out, Page, make_page
from nazoratly.secrets_box import SecretsBox

log = structlog.get_logger("pay")
callbacks = APIRouter(prefix="/pay", tags=["payment provider callbacks"])
settings_router = APIRouter(prefix="/v1", tags=["payment providers"], route_class=IdempotentRoute)

Provider = Literal["payme", "click"]
PAYME_TIMEOUT = timedelta(hours=12)
TIYIN = Decimal(100)
MIN_TIYIN, MAX_TIYIN = 100, 100_000_000_000  # 1 so'm .. 1 billion so'm


def _box(request: Request) -> SecretsBox | None:
    box: SecretsBox | None = getattr(request.app.state, "secrets_box", None)
    return box


@dataclass(frozen=True)
class Creds:
    org_id: int
    merchant_ref: str
    secret: str


async def _load_creds(
    db: Database, box: SecretsBox | None, org_public: uuid.UUID, provider: str
) -> Creds | None:
    if box is None:
        return None
    async with db.auth_tx() as conn:
        row = await fetch_one(
            conn,
            "SELECT o.id, a.merchant_ref, a.secret_ciphertext FROM organizations o "
            "JOIN payment_provider_accounts a ON a.org_id = o.id "
            "WHERE o.public_id = %s AND o.status = 'active' AND o.deleted_at IS NULL AND a.provider = %s AND a.status = 'active'",
            (org_public, provider),
        )
    if row is None:
        return None
    secret = box.decrypt(row["secret_ciphertext"])
    return None if secret is None else Creds(row["id"], row["merchant_ref"], secret)


def _ms(dt: datetime | None) -> int:
    return 0 if dt is None else int(dt.timestamp() * 1000)


async def _find_student(conn: Conn, raw: Any) -> int | None:
    try:
        public = uuid.UUID(str(raw))
    except ValueError:
        return None
    row = await fetch_one(
        conn, "SELECT id FROM students WHERE public_id = %s AND deleted_at IS NULL", (public,)
    )
    return None if row is None else int(row["id"])


async def _perform(conn: Conn, org_id: int, tx: dict[str, Any]) -> None:
    """Create the payment of a created transaction, allocate it, and mark the transaction performed."""
    pay = await fetch_one(
        conn,
        "INSERT INTO payments (org_id, student_id, amount, method, paid_at, external_ref, note) "
        "VALUES (%s, %s, %s, %s, now(), %s, %s) RETURNING id",
        (
            org_id,
            tx["student_id"],
            tx["amount"],
            tx["provider"],
            tx["provider_trans_id"],
            f"Online payment via {tx['provider']}",
        ),
    )
    assert pay is not None
    await allocate_fifo(conn, org_id, pay["id"])
    await post_payment(conn, org_id, None, pay["id"])
    await execute(
        conn,
        "UPDATE online_transactions SET state = 2, payment_id = %s, performed_at = now() WHERE id = %s",
        (pay["id"], tx["id"]),
    )


async def _cancel(conn: Conn, tx: dict[str, Any], reason: int | None) -> int:
    """Cancel a created (-> -1) or performed (-> -2, the payment is voided and its allocations released) transaction."""
    new_state = -2 if tx["state"] == 2 else -1
    if tx["state"] == 2 and tx["payment_id"] is not None:
        released = await fetch_all(
            conn,
            "DELETE FROM payment_allocations WHERE payment_id = %s RETURNING charge_id",
            (tx["payment_id"],),
        )
        await revoke_unearned_early(conn, [r["charge_id"] for r in released])
        await execute(
            conn,
            "UPDATE payments SET voided_at = now(), void_reason = %s WHERE id = %s AND voided_at IS NULL",
            (f"{tx['provider']} cancellation, reason {reason}", tx["payment_id"]),
        )
        org = await fetch_one(conn, "SELECT app_org_id() AS org_id")
        assert org is not None
        await void_source(conn, int(org["org_id"]), None, "payment", str(tx["payment_id"]))
    await execute(
        conn,
        "UPDATE online_transactions SET state = %s, reason = %s, cancelled_at = now() WHERE id = %s",
        (new_state, reason, tx["id"]),
    )
    return new_state


_TX_COLS = "id, public_id, student_id, amount, state, reason, payment_id, provider, provider_trans_id, provider_time, created_at, performed_at, cancelled_at"


# ======================================================== Payme ===================================================
_PAYME_MSG = {
    -32504: (
        "Недостаточно привилегий для выполнения метода",
        "Usulni bajarish uchun huquqlar yetarli emas",
        "Insufficient privileges",
    ),
    -32700: ("Ошибка разбора JSON", "JSON xatosi", "JSON parse error"),
    -32600: ("Неверный запрос", "Noto'g'ri so'rov", "Invalid request"),
    -32601: ("Метод не найден", "Metod topilmadi", "Method not found"),
    -32400: ("Внутренняя ошибка", "Ichki xatolik", "Internal error"),
    -31001: ("Неверная сумма", "Noto'g'ri summa", "Invalid amount"),
    -31003: ("Транзакция не найдена", "Tranzaksiya topilmadi", "Transaction not found"),
    -31007: (
        "Невозможно отменить транзакцию",
        "Tranzaksiyani bekor qilib bo'lmaydi",
        "Cannot cancel the transaction",
    ),
    -31008: ("Невозможно выполнить операцию", "Amalni bajarib bo'lmaydi", "Operation not possible"),
    -31050: ("Студент не найден", "Talaba topilmadi", "Student not found"),
}


_PAYME_METHODS = {
    "CheckPerformTransaction",
    "CreateTransaction",
    "PerformTransaction",
    "CancelTransaction",
    "CheckTransaction",
    "GetStatement",
}


class RpcError(Exception):
    def __init__(self, code: int, data: str | None = None) -> None:
        super().__init__(code)
        self.code, self.data = code, data


def _rpc_err(rid: Any, code: int, data: str | None = None) -> JSONResponse:
    ru, uz, en = _PAYME_MSG[code]
    return JSONResponse(
        {"error": {"code": code, "message": {"ru": ru, "uz": uz, "en": en}, "data": data}, "id": rid}
    )


def _rpc_ok(rid: Any, result: dict[str, Any]) -> JSONResponse:
    return JSONResponse({"result": result, "id": rid})


def _check_amount(raw: Any) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int) or not MIN_TIYIN <= raw <= MAX_TIYIN:
        raise RpcError(-31001)
    return raw


async def _payme_check(conn: Conn, params: dict[str, Any]) -> tuple[int, int]:
    tiyin = _check_amount(params.get("amount"))
    account = params.get("account")
    sid = await _find_student(conn, account.get("student")) if isinstance(account, dict) else None
    if sid is None:
        raise RpcError(-31050, "student")
    return sid, tiyin


def _payme_tx_result(tx: dict[str, Any]) -> dict[str, Any]:
    return {
        "create_time": _ms(tx["created_at"]),
        "perform_time": _ms(tx["performed_at"]),
        "cancel_time": _ms(tx["cancelled_at"]),
        "transaction": str(tx["public_id"]),
        "state": tx["state"],
        "reason": tx["reason"],
    }


async def _payme_method(conn: Conn, creds: Creds, method: str, p: dict[str, Any]) -> dict[str, Any]:
    now = datetime.now(UTC)
    if method not in _PAYME_METHODS:
        raise RpcError(-32601, method)
    if method == "CheckPerformTransaction":
        await _payme_check(conn, p)
        return {"allow": True}

    if method == "GetStatement":
        f, t = p.get("from"), p.get("to")
        if not (isinstance(f, int) and isinstance(t, int)):
            raise RpcError(-32600)
        rows = await fetch_all(
            conn,
            f"SELECT {_TX_COLS}, (SELECT public_id FROM students s WHERE s.org_id = t.org_id AND s.id = t.student_id) AS student_public "
            "FROM online_transactions t WHERE provider = 'payme' AND created_at >= to_timestamp(%s / 1000.0) "
            "AND created_at <= to_timestamp(%s / 1000.0) ORDER BY created_at, id",
            (f, t),
        )
        return {
            "transactions": [
                {
                    "id": r["provider_trans_id"],
                    "time": _ms(r["provider_time"] or r["created_at"]),
                    "amount": int(r["amount"] * TIYIN),
                    "account": {"student": str(r["student_public"])},
                    "create_time": _ms(r["created_at"]),
                    "perform_time": _ms(r["performed_at"]),
                    "cancel_time": _ms(r["cancelled_at"]),
                    "transaction": str(r["public_id"]),
                    "state": r["state"],
                    "reason": r["reason"],
                }
                for r in rows
            ]
        }

    trans_id = p.get("id")
    if not isinstance(trans_id, str) or not 1 <= len(trans_id) <= 64:
        raise RpcError(-32600)
    tx = await fetch_one(
        conn,
        f"SELECT {_TX_COLS} FROM online_transactions WHERE provider = 'payme' AND provider_trans_id = %s FOR UPDATE",
        (trans_id,),
    )

    if method == "CreateTransaction":
        if tx is not None:
            if tx["state"] != 1:
                raise RpcError(-31008)
            if now - tx["created_at"] > PAYME_TIMEOUT:
                await _cancel(conn, tx, 4)
                raise _Committed(-31008)
            return {"create_time": _ms(tx["created_at"]), "transaction": str(tx["public_id"]), "state": 1}
        sid, tiyin = await _payme_check(conn, p)
        t = p.get("time")
        provider_time = datetime.fromtimestamp(t / 1000, UTC) if isinstance(t, int) and t > 0 else None
        row = await fetch_one(
            conn,
            "INSERT INTO online_transactions (org_id, provider, provider_trans_id, student_id, amount, state, provider_time) "
            f"VALUES (%s, 'payme', %s, %s, %s, 1, %s) RETURNING {_TX_COLS}",
            (creds.org_id, trans_id, sid, Decimal(tiyin) / TIYIN, provider_time),
        )
        assert row is not None
        return {"create_time": _ms(row["created_at"]), "transaction": str(row["public_id"]), "state": 1}

    if tx is None:
        raise RpcError(-31003)

    if method == "PerformTransaction":
        if tx["state"] == 2:
            return {"transaction": str(tx["public_id"]), "perform_time": _ms(tx["performed_at"]), "state": 2}
        if tx["state"] != 1:
            raise RpcError(-31008)
        if now - tx["created_at"] > PAYME_TIMEOUT:
            await _cancel(conn, tx, 4)
            raise _Committed(-31008)
        await _perform(conn, creds.org_id, tx)
        done = await fetch_one(
            conn, "SELECT performed_at FROM online_transactions WHERE id = %s", (tx["id"],)
        )
        assert done is not None
        return {"transaction": str(tx["public_id"]), "perform_time": _ms(done["performed_at"]), "state": 2}

    if method == "CancelTransaction":
        reason = p.get("reason")
        if tx["state"] in (-1, -2):
            return {
                "transaction": str(tx["public_id"]),
                "cancel_time": _ms(tx["cancelled_at"]),
                "state": tx["state"],
            }
        state = await _cancel(conn, tx, reason if isinstance(reason, int) else None)
        done = await fetch_one(
            conn, "SELECT cancelled_at FROM online_transactions WHERE id = %s", (tx["id"],)
        )
        assert done is not None
        return {"transaction": str(tx["public_id"]), "cancel_time": _ms(done["cancelled_at"]), "state": state}

    if method == "CheckTransaction":
        return _payme_tx_result(tx)
    raise RpcError(-32601, method)


class _Committed(RpcError):
    """An error that must be reported to Payme AFTER the state change (timeout cancellation) was committed."""


@callbacks.post(
    "/payme/{center_id}", summary="Payme Merchant API endpoint (JSON-RPC 2.0)", include_in_schema=True
)
async def payme_endpoint(center_id: uuid.UUID, request: Request, db: DB) -> JSONResponse:
    raw = await request.body()
    try:
        payload = json.loads(raw)
    except ValueError:
        return _rpc_err(None, -32700)
    rid = payload.get("id") if isinstance(payload, dict) else None
    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("method"), str)
        or not isinstance(payload.get("params", {}), dict)
    ):
        return _rpc_err(rid, -32600)

    creds = await _load_creds(db, _box(request), center_id, "payme")
    auth = request.headers.get("authorization", "")
    ok = False
    if creds is not None and auth.lower().startswith("basic "):
        try:
            login, _, password = b64decode(auth[6:].strip(), validate=True).decode().partition(":")
            ok = login == "Paycom" and hmac.compare_digest(password.encode(), creds.secret.encode())
        except (ValueError, UnicodeDecodeError):
            ok = False
    if creds is None or not ok:
        return _rpc_err(rid, -32504)

    committed: RpcError | None = None
    try:
        async with db.tx(
            Session(user_id=None, org_id=creds.org_id, request_id=getattr(request.state, "request_id", None))
        ) as conn:
            try:
                result = await _payme_method(conn, creds, payload["method"], payload.get("params", {}))
            except _Committed as exc:
                committed = exc
    except RpcError as exc:
        return _rpc_err(rid, exc.code, exc.data)
    except Exception as exc:
        log.error("payme_internal_error", error=type(exc).__name__)
        return _rpc_err(rid, -32400)
    if committed is not None:
        return _rpc_err(rid, committed.code, committed.data)
    return _rpc_ok(rid, result)


# ======================================================== Click ===================================================
CLICK_ERRORS = {
    0: "Success",
    -1: "SIGN CHECK FAILED!",
    -2: "Incorrect parameter amount",
    -3: "Action not found",
    -4: "Already paid",
    -5: "User does not exist",
    -6: "Transaction does not exist",
    -7: "Failed to update user",
    -8: "Error in request from click",
    -9: "Transaction cancelled",
}


def _click_err(code: int, **extra: Any) -> JSONResponse:
    return JSONResponse({**extra, "error": code, "error_note": CLICK_ERRORS[code]})


def _click_sign(secret: str, f: dict[str, str], action: str) -> str:
    parts = [f["click_trans_id"], f["service_id"], secret, f["merchant_trans_id"]]
    if action == "1":
        parts.append(f.get("merchant_prepare_id", ""))
    parts += [f["amount"], f["action"], f["sign_time"]]
    return hashlib.md5("".join(parts).encode(), usedforsecurity=False).hexdigest()


_CLICK_FIELDS = (
    "click_trans_id",
    "service_id",
    "merchant_trans_id",
    "amount",
    "action",
    "sign_time",
    "sign_string",
)


@callbacks.post("/click/{center_id}", summary="Click SHOP API endpoint (Prepare action=0, Complete action=1)")
async def click_endpoint(center_id: uuid.UUID, request: Request, db: DB) -> JSONResponse:
    form = {
        k: v[0]
        for k, v in parse_qs(
            (await request.body()).decode("utf-8", "replace"), keep_blank_values=True
        ).items()
    }
    creds = await _load_creds(db, _box(request), center_id, "click")
    if creds is None or any(k not in form for k in _CLICK_FIELDS) or form["action"] not in ("0", "1"):
        return _click_err(-8 if creds is None or form.get("action") in ("0", "1") else -3)
    if form["action"] == "1" and "merchant_prepare_id" not in form:
        return _click_err(-8)
    if not hmac.compare_digest(_click_sign(creds.secret, form, form["action"]), form["sign_string"].lower()):
        return _click_err(-1)
    if form["service_id"] != creds.merchant_ref:
        return _click_err(-8)
    common = {"click_trans_id": form["click_trans_id"], "merchant_trans_id": form["merchant_trans_id"]}
    try:
        amount = Decimal(form["amount"])
        if amount <= 0 or amount != amount.quantize(Decimal("0.01")) or amount >= Decimal(10**12):
            raise InvalidOperation
    except InvalidOperation:
        return _click_err(-2, **common)
    try:
        async with db.tx(
            Session(user_id=None, org_id=creds.org_id, request_id=getattr(request.state, "request_id", None))
        ) as conn:
            if form["action"] == "0":
                return await _click_prepare(conn, creds, form, amount, common)
            return await _click_complete(conn, creds, form, amount, common)
    except Exception as exc:
        log.error("click_internal_error", error=type(exc).__name__)
        return _click_err(-7, **common)


async def _click_prepare(
    conn: Conn, creds: Creds, f: dict[str, str], amount: Decimal, common: dict[str, str]
) -> JSONResponse:
    sid = await _find_student(conn, f["merchant_trans_id"])
    if sid is None:
        return _click_err(-5, **common)
    tx = await fetch_one(
        conn,
        f"SELECT {_TX_COLS} FROM online_transactions WHERE provider = 'click' AND provider_trans_id = %s FOR UPDATE",
        (f["click_trans_id"],),
    )
    if tx is None:
        tx = await fetch_one(
            conn,
            "INSERT INTO online_transactions (org_id, provider, provider_trans_id, student_id, amount, state, provider_data) "
            f"VALUES (%s, 'click', %s, %s, %s, 1, %s::jsonb) RETURNING {_TX_COLS}",
            (
                creds.org_id,
                f["click_trans_id"],
                sid,
                amount,
                json.dumps({"click_paydoc_id": f.get("click_paydoc_id")}),
            ),
        )
    elif tx["state"] == 2:
        return _click_err(-4, **common)
    elif tx["state"] < 0:
        return _click_err(-9, **common)
    elif tx["amount"] != amount or tx["student_id"] != sid:
        return _click_err(-2, **common)
    assert tx is not None
    return JSONResponse(
        {**common, "merchant_prepare_id": tx["id"], "error": 0, "error_note": CLICK_ERRORS[0]}
    )


async def _click_complete(
    conn: Conn, creds: Creds, f: dict[str, str], amount: Decimal, common: dict[str, str]
) -> JSONResponse:
    try:
        prepare_id = int(f["merchant_prepare_id"])
    except ValueError:
        return _click_err(-6, **common)
    tx = await fetch_one(
        conn,
        f"SELECT {_TX_COLS} FROM online_transactions WHERE provider = 'click' AND provider_trans_id = %s AND id = %s FOR UPDATE",
        (f["click_trans_id"], prepare_id),
    )
    if tx is None:
        return _click_err(-6, **common)
    student = await _find_student(conn, f["merchant_trans_id"])
    if student is None or student != tx["student_id"]:
        return _click_err(-5, **common)
    if tx["state"] == 2:
        return _click_err(-4, **common)
    if tx["state"] < 0:
        return _click_err(-9, **common)
    if tx["amount"] != amount:
        return _click_err(-2, **common)
    try:
        click_error = int(f.get("error", "0"))
    except ValueError:
        click_error = -8
    if click_error < 0:  # Click reports that the card debit failed: cancel our side
        await _cancel(conn, tx, None)
        return _click_err(-9, **common)
    await _perform(conn, creds.org_id, tx)
    return JSONResponse(
        {**common, "merchant_confirm_id": tx["id"], "error": 0, "error_note": CLICK_ERRORS[0]}
    )


# ================================================= center settings & ledger =======================================
class ProviderIn(Model):
    merchant_ref: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] = (
        Field(description="Payme: merchant id (Paycom). Click: service_id")
    )
    secret: Annotated[str, StringConstraints(min_length=8, max_length=200)] = Field(
        description="Payme: the KEY (password for Basic auth). Click: SECRET_KEY. Stored encrypted, never returned"
    )
    status: Literal["active", "disabled"] = "active"
    merchant_user_id: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] | None
    ) = Field(
        default=None,
        description="Click only: merchant_user_id, needed to reverse (refund) payments from nazoratly",
    )


class ProviderOut(Out):
    provider: str
    merchant_ref: str
    status: str
    callback_url: str
    reversal_enabled: bool = False


class OnlineTxOut(Out):
    id: uuid.UUID
    provider: str
    provider_trans_id: str
    student_id: uuid.UUID
    amount: Dec2
    state: int
    reason: int | None
    payment_id: uuid.UUID | None
    created_at: datetime
    performed_at: datetime | None
    cancelled_at: datetime | None


def _callback_url(request: Request, provider: str, org_public: uuid.UUID) -> str:
    return f"{str(request.base_url).rstrip('/')}/pay/{provider}/{org_public}"


@settings_router.put(
    "/payment-providers/{provider}",
    response_model=ProviderOut,
    summary="Connect or update Payme / Click for this center",
)
async def put_provider(
    provider: Provider,
    body: ProviderIn,
    request: Request,
    p: Annotated[Principal, Depends(require("org:manage"))],
    db: DB,
) -> ProviderOut:
    box = _box(request)
    if box is None:
        raise ApiError(
            "Provider secrets cannot be stored: NAZORATLY_SECRETS_KEY is not configured on the server"
        )
    async with db.tx(p.session()) as conn:
        await execute(
            conn,
            "INSERT INTO payment_provider_accounts (org_id, provider, merchant_ref, secret_ciphertext, status, merchant_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (org_id, provider) DO UPDATE SET merchant_ref = EXCLUDED.merchant_ref, "
            "secret_ciphertext = EXCLUDED.secret_ciphertext, status = EXCLUDED.status, merchant_user_id = EXCLUDED.merchant_user_id",
            (
                p.org_id,
                provider,
                body.merchant_ref,
                box.encrypt(body.secret),
                body.status,
                body.merchant_user_id,
            ),
        )
        org = await fetch_one(conn, "SELECT public_id FROM organizations WHERE id = %s", (p.org_id,))
    assert org is not None
    return ProviderOut(
        provider=provider,
        merchant_ref=body.merchant_ref,
        status=body.status,
        callback_url=_callback_url(request, provider, org["public_id"]),
        reversal_enabled=body.merchant_user_id is not None,
    )


@settings_router.get("/payment-providers", response_model=list[ProviderOut])
async def list_providers(
    request: Request, p: Annotated[Principal, Depends(require("org:read", "finance:read"))], db: DB
) -> list[ProviderOut]:
    async with db.tx(p.session()) as conn:
        org = await fetch_one(conn, "SELECT public_id FROM organizations WHERE id = %s", (p.org_id,))
        rows = await fetch_all(
            conn,
            "SELECT provider, merchant_ref, status, (merchant_user_id IS NOT NULL) AS reversal_enabled "
            "FROM payment_provider_accounts ORDER BY provider",
        )
    assert org is not None
    return [
        ProviderOut(**r, callback_url=_callback_url(request, r["provider"], org["public_id"])) for r in rows
    ]


CLICK_API_BASE = "https://api.click.uz"


class ReverseOut(Out):
    id: uuid.UUID
    state: int
    click_error_code: int
    click_error_note: str


@settings_router.post(
    "/online-transactions/{transaction_id}/reverse",
    response_model=ReverseOut,
    summary="Refund a Click payment (Click merchant API payment/reversal), then void it here",
)
async def reverse_click_payment(
    transaction_id: uuid.UUID,
    request: Request,
    p: Annotated[Principal, Depends(require("finance:write"))],
    db: DB,
) -> ReverseOut:
    """Payme refunds start in the Payme cabinet (Payme then calls CancelTransaction); Click refunds start here.
    Click rules: only a completed card payment of the current reporting month (previous month: first day only)."""
    box = _box(request)
    if box is None:
        raise ApiError("NAZORATLY_SECRETS_KEY is not configured on the server")
    async with db.tx(p.session()) as conn:
        tx = await fetch_one(
            conn,
            f"SELECT {_TX_COLS}, provider_data FROM online_transactions WHERE public_id = %s FOR UPDATE",
            (transaction_id,),
        )
        if tx is None:
            raise NotFound("transaction not found")
        if tx["provider"] != "click":
            raise Conflict(
                "Only Click transactions are reversed from here; Payme refunds start in the Payme cabinet"
            )
        if tx["state"] != 2:
            raise Conflict("Only a performed transaction can be reversed")
        acct = await fetch_one(
            conn,
            "SELECT merchant_ref, secret_ciphertext, merchant_user_id FROM payment_provider_accounts "
            "WHERE provider = 'click' AND status = 'active'",
        )
        if acct is None or acct["merchant_user_id"] is None:
            raise Conflict("Click merchant_user_id is not configured (PUT /v1/payment-providers/click)")
        secret = box.decrypt(acct["secret_ciphertext"])
        paydoc = (tx["provider_data"] or {}).get("click_paydoc_id")
        if secret is None or not paydoc:
            raise Conflict("Click payment id (click_paydoc_id) is unknown for this transaction")
        ts = str(int(time.time()))
        digest = hashlib.sha1((ts + secret).encode(), usedforsecurity=False).hexdigest()
        base = getattr(request.app.state, "click_api_base", CLICK_API_BASE)
        transport = getattr(request.app.state, "outbound_transport", None)
        try:
            async with httpx.AsyncClient(transport=transport, timeout=15) as http:
                resp = await http.delete(
                    f"{base}/v2/merchant/payment/reversal/{acct['merchant_ref']}/{paydoc}",
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        "Auth": f"{acct['merchant_user_id']}:{digest}:{ts}",
                    },
                )
            data = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise ApiError(
                f"Click did not answer ({type(exc).__name__}); nothing was changed",
                headers={"Retry-After": "30"},
            ) from exc
        code = int(data.get("error_code", -1))
        if code != 0:
            raise Unprocessable(
                f"Click refused the reversal: {data.get('error_note', '')}",
                details={"click_error_code": code},
            )
        await _cancel(conn, tx, 5)
        return ReverseOut(
            id=transaction_id,
            state=-2,
            click_error_code=code,
            click_error_note=str(data.get("error_note", "")),
        )


@settings_router.get(
    "/online-transactions", response_model=Page[OnlineTxOut], summary="Payme/Click transaction ledger"
)
async def list_online_transactions(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    pg: Paging,
    provider: Provider | None = None,
) -> Page[OnlineTxOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            "SELECT t.public_id AS id, t.provider, t.provider_trans_id, s.public_id AS student_id, t.amount, t.state, t.reason,"
            " pay.public_id AS payment_id, t.created_at, t.performed_at, t.cancelled_at FROM online_transactions t "
            "JOIN students s ON s.org_id = t.org_id AND s.id = t.student_id LEFT JOIN payments pay ON pay.org_id = t.org_id AND pay.id = t.payment_id "
            "WHERE (%s::text IS NULL OR t.provider = %s) ORDER BY t.created_at DESC, t.id DESC LIMIT %s OFFSET %s",
            (provider, provider, pg.limit + 1, pg.offset),
        )
    return make_page(rows, pg.limit, pg.offset, OnlineTxOut)


_ = (Conflict,)
