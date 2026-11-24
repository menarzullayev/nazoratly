"""Growth: referral rewards, promo codes, marketing credits in accounting, lead source ROI and internal lead reminders.

Rewards and promo discounts are booked as open credits in the existing credit mechanism (`absence_entitlements`, kind
`credit`, source `referral` / `promo`); the next monthly billing run consumes them like any other credit. Charge generation
is not touched here. Nothing in this module sends anything to a lead, student or guardian: reminders are a list for staff."""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field, StringConstraints, model_validator

from nazoratly.accounting import org_today
from nazoratly.db import Conn, execute, fetch_all, fetch_one, resolve
from nazoratly.deps import DB, Principal, require
from nazoratly.errors import Conflict, NotFound, Unprocessable
from nazoratly.idempotency import IdempotentRoute
from nazoratly.routers.finance import month_start
from nazoratly.routers.settings import load_settings
from nazoratly.rules.growth import (
    CreditFact,
    LeadFact,
    SourceCost,
    SourceLead,
    growth_credit_summary,
    lead_reminders,
    promo_discount,
    promo_state,
    referral_condition_met,
    referral_reward_amount,
    source_roi,
    split_credit,
)
from nazoratly.schemas import Dec2, Model, Money, Out, PositiveMoney

router = APIRouter(prefix="/v1", tags=["growth"], route_class=IdempotentRoute)

RewardType = Literal["amount", "percent", "free_lesson"]
Condition = Literal["enrolled", "paid"]
Note = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
CREDIT_VALID_DAYS = (
    365  # a growth credit is informational-expiring: billing consumes it whenever the next charge comes
)

_FEE = "round(COALESCE(e.monthly_fee_override, g.monthly_fee) * (1 - e.discount_percent / 100), 2)"


class NoActiveProgram(Conflict):
    code = "no_active_referral_program"


class AlreadyReferred(Conflict):
    code = "already_referred"


class AlreadyRedeemed(Conflict):
    code = "promo_already_redeemed"


class PromoUnavailable(Conflict):
    code = "promo_unavailable"


async def _org_tz(conn: Conn, org_id: int) -> str:
    row = await fetch_one(conn, "SELECT timezone FROM organizations WHERE id = %s", (org_id,))
    assert row is not None
    return str(row["timezone"])


# ---- referral program (the center's rule) ----------------------------------------------------------------------
class ProgramIn(Model):
    reward_type: RewardType
    reward_value: PositiveMoney
    condition: Condition = "paid"
    min_paid: Money = Decimal(0)
    active: bool = True

    @model_validator(mode="after")
    def _shape(self) -> ProgramIn:
        if self.reward_type == "percent" and self.reward_value > 1000:
            raise ValueError("a percent reward cannot exceed 1000")
        if self.reward_type == "free_lesson" and (
            self.reward_value > 100 or self.reward_value != self.reward_value.to_integral_value()
        ):
            raise ValueError("a free-lesson reward is a whole number of lessons (1-100)")
        return self


class ProgramOut(Out):
    reward_type: RewardType
    reward_value: Dec2
    condition: Condition
    min_paid: Dec2
    active: bool


_PROGRAM_SQL = "SELECT reward_type, reward_value, condition, min_paid, active FROM referral_programs"


@router.get(
    "/referral-program",
    response_model=ProgramOut | None,
    summary="The center's referral rule (null when not set)",
)
async def get_program(p: Annotated[Principal, Depends(require("finance:read"))], db: DB) -> ProgramOut | None:
    async with db.tx(p.session()) as conn:
        row = await fetch_one(conn, _PROGRAM_SQL)
    return ProgramOut.model_validate(row) if row else None


@router.put(
    "/referral-program",
    response_model=ProgramOut,
    summary="Set the referral rule (reward type, value, condition)",
)
async def put_program(
    body: ProgramIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> ProgramOut:
    async with db.tx(p.session()) as conn:
        await execute(
            conn,
            "INSERT INTO referral_programs (org_id, reward_type, reward_value, condition, min_paid, active) "
            "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (org_id) DO UPDATE SET reward_type = EXCLUDED.reward_type, "
            "reward_value = EXCLUDED.reward_value, condition = EXCLUDED.condition, min_paid = EXCLUDED.min_paid, active = EXCLUDED.active",
            (p.org_id, body.reward_type, body.reward_value, body.condition, body.min_paid, body.active),
        )
        row = await fetch_one(conn, _PROGRAM_SQL)
    assert row is not None
    return ProgramOut.model_validate(row)


# ---- referrals --------------------------------------------------------------------------------------------------
class ReferralIn(Model):
    referrer_student_id: uuid.UUID
    invited_student_id: uuid.UUID
    note: Note | None = None


class ReferralOut(Out):
    id: uuid.UUID
    referrer_student_id: uuid.UUID
    referrer_name: str
    invited_student_id: uuid.UUID
    invited_name: str
    status: Literal["pending", "rewarded", "cancelled"]
    reward_type: RewardType
    reward_value: Dec2
    condition: Condition
    min_paid: Dec2
    reward_amount: Dec2 | None
    invited_on: date
    rewarded_on: date | None
    note: str | None
    condition_met: bool = Field(description="the condition holds right now for the invited student")
    credits_total: Dec2 = Field(
        description="money of the credits this referral produced (cancelled ones excluded)"
    )
    created_at: datetime


_REFERRAL_SQL = (
    "SELECT r.id AS iid, r.public_id AS id, rs.public_id AS referrer_student_id, rs.full_name AS referrer_name, "
    "ins.public_id AS invited_student_id, ins.full_name AS invited_name, r.status, r.reward_type, r.reward_value, "
    "r.condition, r.min_paid, r.reward_amount, r.invited_on, r.rewarded_on, r.note, r.created_at, "
    "EXISTS (SELECT 1 FROM enrollments e WHERE e.org_id = r.org_id AND e.student_id = r.invited_student_id "
    "        AND e.status IN ('active', 'frozen')) AS invited_enrolled, "
    "COALESCE((SELECT sum(py.amount) FROM payments py WHERE py.org_id = r.org_id AND py.student_id = r.invited_student_id "
    "          AND py.voided_at IS NULL AND NOT py.is_demo), 0) AS invited_paid, "
    "COALESCE((SELECT sum(ae.amount) FROM absence_entitlements ae WHERE ae.org_id = r.org_id AND ae.referral_id = r.id "
    "          AND ae.status <> 'cancelled'), 0) AS credits_total "
    "FROM referrals r JOIN students rs ON rs.org_id = r.org_id AND rs.id = r.referrer_student_id "
    "JOIN students ins ON ins.org_id = r.org_id AND ins.id = r.invited_student_id"
)


def _referral_out(row: dict[str, Any]) -> ReferralOut:
    met = referral_condition_met(
        condition=row["condition"],
        min_paid=row["min_paid"],
        invited_enrolled=bool(row["invited_enrolled"]),
        invited_paid=row["invited_paid"],
    )
    return ReferralOut.model_validate({**row, "condition_met": met})


@router.post(
    "/referrals", response_model=ReferralOut, status_code=201, summary="Record that a student invited another"
)
async def create_referral(
    body: ReferralIn, p: Annotated[Principal, Depends(require("finance:write", "students:write"))], db: DB
) -> ReferralOut:
    if body.referrer_student_id == body.invited_student_id:
        raise Unprocessable("a student cannot invite themselves")
    async with db.tx(p.session()) as conn:
        program = await fetch_one(conn, _PROGRAM_SQL + " WHERE active")
        if program is None:
            raise NoActiveProgram("The center has no active referral program: set the rule first")
        referrer = await resolve(conn, "students", body.referrer_student_id, what="referrer student")
        invited = await resolve(conn, "students", body.invited_student_id, what="invited student")
        if await fetch_one(conn, "SELECT 1 AS x FROM referrals WHERE invited_student_id = %s", (invited,)):
            raise AlreadyReferred("This student was already invited by someone")
        row = await fetch_one(
            conn,
            "INSERT INTO referrals (org_id, referrer_student_id, invited_student_id, reward_type, reward_value, condition, "
            "min_paid, invited_on, note, created_by_user_id) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                referrer,
                invited,
                program["reward_type"],
                program["reward_value"],
                program["condition"],
                program["min_paid"],
                await org_today(conn),
                body.note,
                p.user_id,
            ),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_REFERRAL_SQL} WHERE r.id = %s", (row["id"],))
    assert out is not None
    return _referral_out(out)


@router.get("/referrals", response_model=list[ReferralOut], summary="Referrals, newest first")
async def list_referrals(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    status: Literal["pending", "rewarded", "cancelled"] | None = None,
    student_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[ReferralOut]:
    where, params = [], []  # type: list[str], list[Any]
    if status:
        where.append("r.status = %s")
        params.append(status)
    if student_id:
        where.append("(rs.public_id = %s OR ins.public_id = %s)")
        params += [student_id, student_id]
    clause = f" WHERE {' AND '.join(where)}" if where else ""
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(conn, f"{_REFERRAL_SQL}{clause} ORDER BY r.id DESC LIMIT %s", (*params, limit))
    return [_referral_out(r) for r in rows]


class BookedItem(Out):
    referral_id: uuid.UUID
    referrer_name: str
    amount: Dec2
    credits: int


class SkippedItem(Out):
    referral_id: uuid.UUID
    referrer_name: str
    reason: Literal["condition_not_met", "referrer_has_no_active_enrollment", "reward_is_zero"]


class BookOut(Out):
    rewarded: list[BookedItem]
    skipped: list[SkippedItem]
    total: Dec2


@router.post(
    "/referrals/book",
    response_model=BookOut,
    summary="Pay the rewards of pending referrals whose condition holds (credits for the referrer; safe to repeat)",
)
async def book_rewards(p: Annotated[Principal, Depends(require("finance:write"))], db: DB) -> BookOut:
    rewarded: list[BookedItem] = []
    skipped: list[SkippedItem] = []
    total = Decimal(0)
    async with db.tx(p.session()) as conn:
        today = await org_today(conn)
        first = month_start(today)
        pending = await fetch_all(conn, f"{_REFERRAL_SQL} WHERE r.status = 'pending' ORDER BY r.id")
        for r in pending:
            # the row lock makes a concurrent run wait; the status re-check makes a repeat a no-op
            locked = await fetch_one(
                conn, "SELECT status FROM referrals WHERE id = %s FOR UPDATE", (r["iid"],)
            )
            if locked is None or locked["status"] != "pending":
                continue
            if not referral_condition_met(
                condition=r["condition"],
                min_paid=r["min_paid"],
                invited_enrolled=bool(r["invited_enrolled"]),
                invited_paid=r["invited_paid"],
            ):
                skipped.append(
                    SkippedItem(
                        referral_id=r["id"], referrer_name=r["referrer_name"], reason="condition_not_met"
                    )
                )
                continue
            referrer = await fetch_one(
                conn, "SELECT id FROM students WHERE public_id = %s", (r["referrer_student_id"],)
            )
            assert referrer is not None
            enr = await fetch_one(
                conn,
                f"SELECT e.group_id, {_FEE} AS fee FROM enrollments e JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id "
                "WHERE e.student_id = %s AND e.status = 'active' AND g.billing_mode = 'monthly' ORDER BY fee DESC, e.id LIMIT 1",
                (referrer["id"],),
            )
            fee = Decimal(enr["fee"]) if enr else Decimal(0)
            if enr is None and r["reward_type"] != "amount":
                skipped.append(
                    SkippedItem(
                        referral_id=r["id"],
                        referrer_name=r["referrer_name"],
                        reason="referrer_has_no_active_enrollment",
                    )
                )
                continue
            lessons = 0
            if enr is not None:
                n = await fetch_one(
                    conn,
                    "SELECT count(*) AS n FROM lessons WHERE group_id = %s AND status <> 'cancelled' AND kind = 'regular' "
                    "AND date_trunc('month', lesson_date) = %s",
                    (enr["group_id"], first),
                )
                assert n is not None
                lessons = int(n["n"])
            amount = referral_reward_amount(
                reward_type=r["reward_type"],
                reward_value=r["reward_value"],
                monthly_fee=fee,
                lessons_in_month=lessons,
            )
            chunks = split_credit(amount=amount, monthly_fee=fee)
            if not chunks:
                skipped.append(
                    SkippedItem(
                        referral_id=r["id"], referrer_name=r["referrer_name"], reason="reward_is_zero"
                    )
                )
                continue
            for chunk in chunks:
                await execute(
                    conn,
                    "INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source, referral_id, note) "
                    "VALUES (%s, %s, 'credit', %s, %s, 'referral', %s, %s)",
                    (
                        p.org_id,
                        referrer["id"],
                        chunk,
                        today + timedelta(days=CREDIT_VALID_DAYS),
                        r["iid"],
                        f"Referral: {r['invited_name']}",
                    ),
                )
            await execute(
                conn,
                "UPDATE referrals SET status = 'rewarded', reward_amount = %s, rewarded_on = %s WHERE id = %s",
                (amount, today, r["iid"]),
            )
            total += amount
            rewarded.append(
                BookedItem(
                    referral_id=r["id"], referrer_name=r["referrer_name"], amount=amount, credits=len(chunks)
                )
            )
    return BookOut(rewarded=rewarded, skipped=skipped, total=total)


@router.post(
    "/referrals/{referral_id}/cancel",
    response_model=ReferralOut,
    summary="Cancel a referral (its unused credits are cancelled too)",
)
async def cancel_referral(
    referral_id: uuid.UUID, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> ReferralOut:
    async with db.tx(p.session()) as conn:
        rid = await resolve(conn, "referrals", referral_id, what="referral")
        cur = await fetch_one(conn, "SELECT status FROM referrals WHERE id = %s FOR UPDATE", (rid,))
        assert cur is not None
        if cur["status"] == "cancelled":
            raise Conflict("The referral is already cancelled")
        await execute(
            conn,
            "UPDATE absence_entitlements SET status = 'cancelled' WHERE referral_id = %s AND status = 'open'",
            (rid,),
        )
        await execute(conn, "UPDATE referrals SET status = 'cancelled' WHERE id = %s", (rid,))
        out = await fetch_one(conn, f"{_REFERRAL_SQL} WHERE r.id = %s", (rid,))
    assert out is not None
    return _referral_out(out)


# ---- promo campaigns --------------------------------------------------------------------------------------------
Code = Annotated[
    str, StringConstraints(strip_whitespace=True, to_upper=True, pattern=r"^[A-Za-z0-9_-]{3,32}$")
]


class CampaignIn(Model):
    code: Code
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    kind: Literal["percent", "amount"]
    value: PositiveMoney
    valid_from: date
    valid_to: date | None = None
    max_uses: Annotated[int, Field(ge=1, le=100000)] | None = None

    @model_validator(mode="after")
    def _shape(self) -> CampaignIn:
        if self.kind == "percent" and self.value > 100:
            raise ValueError("a percent promo cannot exceed 100")
        if self.valid_to is not None and self.valid_to < self.valid_from:
            raise ValueError("valid_to cannot be before valid_from")
        return self


class CampaignPatch(Model):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)] | None = None
    active: bool | None = None
    valid_to: date | None = None
    max_uses: Annotated[int, Field(ge=1, le=100000)] | None = None


class CampaignOut(Out):
    id: uuid.UUID
    code: str
    name: str
    kind: Literal["percent", "amount"]
    value: Dec2
    valid_from: date
    valid_to: date | None
    max_uses: int | None
    active: bool
    used: int
    state: Literal["ok", "inactive", "not_started", "expired", "exhausted"]
    created_at: datetime


_CAMPAIGN_SQL = (
    "SELECT c.id AS iid, c.public_id AS id, c.code, c.name, c.kind, c.value, c.valid_from, c.valid_to, c.max_uses, c.active, "
    "c.created_at, (SELECT count(*) FROM promo_redemptions pr WHERE pr.campaign_id = c.id)::int AS used FROM promo_campaigns c"
)


def _campaign_out(row: dict[str, Any], today: date) -> CampaignOut:
    state = promo_state(
        active=row["active"],
        valid_from=row["valid_from"],
        valid_to=row["valid_to"],
        max_uses=row["max_uses"],
        used=row["used"],
        today=today,
    )
    return CampaignOut.model_validate({**row, "state": state})


@router.post(
    "/promo-campaigns", response_model=CampaignOut, status_code=201, summary="Create a promo code / campaign"
)
async def create_campaign(
    body: CampaignIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> CampaignOut:
    async with db.tx(p.session()) as conn:
        if await fetch_one(conn, "SELECT 1 AS x FROM promo_campaigns WHERE code = %s", (body.code,)):
            raise Conflict("A promo code with this code already exists", details={"code": body.code})
        row = await fetch_one(
            conn,
            "INSERT INTO promo_campaigns (org_id, code, name, kind, value, valid_from, valid_to, max_uses, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (
                p.org_id,
                body.code,
                body.name,
                body.kind,
                body.value,
                body.valid_from,
                body.valid_to,
                body.max_uses,
                p.user_id,
            ),
        )
        assert row is not None
        out = await fetch_one(conn, f"{_CAMPAIGN_SQL} WHERE c.id = %s", (row["id"],))
        today = await org_today(conn)
    assert out is not None
    return _campaign_out(out, today)


@router.get(
    "/promo-campaigns",
    response_model=list[CampaignOut],
    summary="Promo campaigns with their use and state today",
)
async def list_campaigns(
    p: Annotated[Principal, Depends(require("finance:read"))], db: DB
) -> list[CampaignOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(conn, f"{_CAMPAIGN_SQL} ORDER BY c.valid_from DESC, c.id DESC LIMIT 500")
        today = await org_today(conn)
    return [_campaign_out(r, today) for r in rows]


@router.patch(
    "/promo-campaigns/{campaign_id}",
    response_model=CampaignOut,
    summary="Rename, switch off or extend a campaign",
)
async def patch_campaign(
    campaign_id: uuid.UUID,
    body: CampaignPatch,
    p: Annotated[Principal, Depends(require("finance:write"))],
    db: DB,
) -> CampaignOut:
    changes = body.model_dump(exclude_unset=True)
    async with db.tx(p.session()) as conn:
        cid = await resolve(conn, "promo_campaigns", campaign_id, what="promo campaign")
        cur = await fetch_one(conn, f"{_CAMPAIGN_SQL} WHERE c.id = %s FOR UPDATE OF c", (cid,))
        assert cur is not None
        if changes.get("name") is None:
            changes.pop("name", None)
        if changes.get("active") is None:
            changes.pop("active", None)
        valid_to = changes.get("valid_to", cur["valid_to"])
        if valid_to is not None and valid_to < cur["valid_from"]:
            raise Unprocessable("valid_to cannot be before valid_from")
        max_uses = changes.get("max_uses", cur["max_uses"])
        if max_uses is not None and max_uses < cur["used"]:
            raise Unprocessable("max_uses cannot be below the number of redemptions already made")
        for column, value in changes.items():  # column names come from the model above, never from the client
            await execute(conn, f"UPDATE promo_campaigns SET {column} = %s WHERE id = %s", (value, cid))
        out = await fetch_one(conn, f"{_CAMPAIGN_SQL} WHERE c.id = %s", (cid,))
        today = await org_today(conn)
    assert out is not None
    return _campaign_out(out, today)


class RedeemIn(Model):
    code: Code
    student_id: uuid.UUID
    enrollment_id: uuid.UUID = Field(description="the enrollment (monthly group) the discount is for")


class RedemptionOut(Out):
    id: uuid.UUID
    code: str
    campaign_name: str
    student_id: uuid.UUID
    fee: Dec2
    amount: Dec2
    redeemed_on: date
    applies: Literal["next_billing_run"] = Field(
        default="next_billing_run", description="the credit is taken off the student's next monthly charge"
    )


@router.post(
    "/promo/redeem",
    response_model=RedemptionOut,
    status_code=201,
    summary="Apply a promo code for a student: a credit (at most one month's fee) for the next monthly charge",
)
async def redeem(
    body: RedeemIn, p: Annotated[Principal, Depends(require("finance:write"))], db: DB
) -> RedemptionOut:
    async with db.tx(p.session()) as conn:
        today = await org_today(conn)
        camp = await fetch_one(conn, f"{_CAMPAIGN_SQL} WHERE c.code = %s FOR UPDATE OF c", (body.code,))
        if camp is None:
            raise NotFound("promo code not found")
        state = promo_state(
            active=camp["active"],
            valid_from=camp["valid_from"],
            valid_to=camp["valid_to"],
            max_uses=camp["max_uses"],
            used=camp["used"],
            today=today,
        )
        if state != "ok":
            raise PromoUnavailable(f"The promo code is not available ({state})", details={"state": state})
        sid = await resolve(conn, "students", body.student_id, what="student")
        eid = await resolve(conn, "enrollments", body.enrollment_id, what="enrollment")
        enr = await fetch_one(
            conn,
            f"SELECT e.student_id, e.status, g.billing_mode, {_FEE} AS fee FROM enrollments e "
            "JOIN study_groups g ON g.org_id = e.org_id AND g.id = e.group_id WHERE e.id = %s",
            (eid,),
        )
        assert enr is not None
        if enr["student_id"] != sid:
            raise Unprocessable("the enrollment does not belong to this student")
        if enr["status"] not in ("trial", "active"):
            raise Conflict("A promo applies to a trial or active enrollment")
        if enr["billing_mode"] != "monthly":
            raise Unprocessable("A promo applies to a monthly-billed group")
        fee = Decimal(enr["fee"])
        amount = promo_discount(kind=camp["kind"], value=camp["value"], fee=fee)
        if amount <= 0:
            raise Unprocessable("The fee is zero: there is nothing to discount")
        if await fetch_one(
            conn,
            "SELECT 1 AS x FROM promo_redemptions WHERE campaign_id = %s AND student_id = %s",
            (camp["iid"], sid),
        ):
            raise AlreadyRedeemed("This student already used this promo code")
        red = await fetch_one(
            conn,
            "INSERT INTO promo_redemptions (org_id, campaign_id, student_id, enrollment_id, fee, amount, redeemed_on, created_by_user_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id, public_id",
            (p.org_id, camp["iid"], sid, eid, fee, amount, today, p.user_id),
        )
        assert red is not None
        await execute(
            conn,
            "INSERT INTO absence_entitlements (org_id, student_id, kind, amount, expires_on, source, promo_redemption_id, note) "
            "VALUES (%s, %s, 'credit', %s, %s, 'promo', %s, %s)",
            (
                p.org_id,
                sid,
                amount,
                today + timedelta(days=CREDIT_VALID_DAYS),
                red["id"],
                f"Promo {camp['code']}",
            ),
        )
    return RedemptionOut(
        id=red["public_id"],
        code=camp["code"],
        campaign_name=camp["name"],
        student_id=body.student_id,
        fee=fee,
        amount=amount,
        redeemed_on=today,
    )


# ---- marketing credits in accounting ----------------------------------------------------------------------------
class CreditRow(Out):
    source: Literal["referral", "promo"]
    label: str
    count: int
    granted: Dec2
    applied: Dec2
    outstanding: Dec2
    cancelled: Dec2


class CreditTotals(Out):
    count: int
    granted: Dec2
    applied: Dec2
    outstanding: Dec2
    cancelled: Dec2


class GrowthCreditsOut(Out):
    rows: list[CreditRow]
    totals: CreditTotals


@router.get(
    "/accounting/growth-credits",
    response_model=GrowthCreditsOut,
    summary="Referral rewards and promo discounts, separate from tuition: granted, applied to charges, still waiting",
)
async def growth_credits(
    p: Annotated[Principal, Depends(require("accounting:read"))],
    db: DB,
    date_from: date | None = None,
    date_to: date | None = None,
) -> GrowthCreditsOut:
    if date_from and date_to and date_to < date_from:
        raise Unprocessable("date_to cannot be before date_from")
    async with db.tx(p.session()) as conn:
        tz = await _org_tz(conn, p.org_id)
        rows = await fetch_all(
            conn,
            "SELECT ae.source, CASE WHEN ae.source = 'promo' THEN pc.code || ' - ' || pc.name ELSE 'Referral' END AS label, "
            "ae.amount, ae.status FROM absence_entitlements ae "
            "LEFT JOIN promo_redemptions pr ON pr.org_id = ae.org_id AND pr.id = ae.promo_redemption_id "
            "LEFT JOIN promo_campaigns pc ON pc.org_id = pr.org_id AND pc.id = pr.campaign_id "
            "WHERE ae.source <> 'absence' "
            "AND (%(f)s::date IS NULL OR (ae.created_at AT TIME ZONE %(tz)s)::date >= %(f)s) "
            "AND (%(t)s::date IS NULL OR (ae.created_at AT TIME ZONE %(tz)s)::date <= %(t)s)",
            {"f": date_from, "t": date_to, "tz": tz},
        )
    report = growth_credit_summary(
        [CreditFact(r["source"], r["label"], r["amount"], r["status"]) for r in rows]
    )
    return GrowthCreditsOut.model_validate(report)


# ---- lead source costs and ROI ----------------------------------------------------------------------------------
class CostIn(Model):
    amount: Money
    note: Note | None = None


class CostOut(Out):
    source_id: uuid.UUID
    source: str
    month: date
    amount: Dec2
    note: str | None


@router.put(
    "/lead-sources/{source_id}/costs/{month}",
    response_model=CostOut,
    summary="Set what a source cost in a month (month = first day, e.g. 2026-11-01); repeat to correct",
)
async def put_cost(
    source_id: uuid.UUID,
    month: date,
    body: CostIn,
    p: Annotated[Principal, Depends(require("finance:write"))],
    db: DB,
) -> CostOut:
    if month != month.replace(day=1):
        raise Unprocessable("month must be the first day of a month, e.g. 2026-11-01")
    async with db.tx(p.session()) as conn:
        sid = await resolve(conn, "lead_sources", source_id, what="lead source")
        await execute(
            conn,
            "INSERT INTO lead_source_costs (org_id, source_id, month, amount, note, created_by_user_id) VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (org_id, source_id, month) DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note",
            (p.org_id, sid, month, body.amount, body.note, p.user_id),
        )
        row = await fetch_one(
            conn,
            "SELECT s.public_id AS source_id, s.name AS source, c.month, c.amount, c.note FROM lead_source_costs c "
            "JOIN lead_sources s ON s.org_id = c.org_id AND s.id = c.source_id WHERE c.source_id = %s AND c.month = %s",
            (sid, month),
        )
    assert row is not None
    return CostOut.model_validate(row)


@router.get(
    "/lead-source-costs", response_model=list[CostOut], summary="Entered source costs, newest month first"
)
async def list_costs(
    p: Annotated[Principal, Depends(require("finance:read"))],
    db: DB,
    month_from: date | None = None,
    month_to: date | None = None,
) -> list[CostOut]:
    async with db.tx(p.session()) as conn:
        rows = await fetch_all(
            conn,
            "SELECT s.public_id AS source_id, s.name AS source, c.month, c.amount, c.note FROM lead_source_costs c "
            "JOIN lead_sources s ON s.org_id = c.org_id AND s.id = c.source_id "
            "WHERE (%(f)s::date IS NULL OR c.month >= %(f)s) AND (%(t)s::date IS NULL OR c.month <= %(t)s) "
            "ORDER BY c.month DESC, lower(s.name) LIMIT 1000",
            {"f": month_from, "t": month_to},
        )
    return [CostOut.model_validate(r) for r in rows]


class RoiRow(Out):
    source: str | None
    leads: int
    paying: int
    revenue: Dec2
    cost: Dec2
    roi: float | None = Field(
        description="(revenue - cost) / cost in percent, one decimal; null without a cost"
    )
    cost_per_lead: Dec2 | None
    cost_per_paying: Dec2 | None


class RoiOut(Out):
    rows: list[RoiRow]
    total: RoiRow


@router.get(
    "/reports/source-roi",
    response_model=RoiOut,
    summary="Per lead source: leads created in the range, paying students, their revenue versus the cost entered",
)
async def source_roi_report(
    p: Annotated[Principal, Depends(require("reports:read"))], db: DB, date_from: date, date_to: date
) -> RoiOut:
    if date_to < date_from or (date_to - date_from).days > 1830:
        raise Unprocessable("date range must be 0-1830 days")
    async with db.tx(p.session()) as conn:
        tz = await _org_tz(conn, p.org_id)
        leads = await fetch_all(
            conn,
            "SELECT src.name AS source, (l.created_at AT TIME ZONE %(tz)s)::date AS created_on, "
            "COALESCE((SELECT sum(py.amount) FROM payments py WHERE py.org_id = l.org_id AND py.student_id = l.student_id "
            "          AND py.voided_at IS NULL AND NOT py.is_demo AND (py.paid_at AT TIME ZONE %(tz)s)::date <= %(t)s), 0) AS revenue "
            "FROM leads l LEFT JOIN lead_sources src ON src.org_id = l.org_id AND src.id = l.source_id "
            "WHERE l.deleted_at IS NULL AND (l.created_at AT TIME ZONE %(tz)s)::date BETWEEN %(f)s AND %(t)s",
            {"tz": tz, "f": date_from, "t": date_to},
        )
        costs = await fetch_all(
            conn,
            "SELECT s.name AS source, c.month, c.amount FROM lead_source_costs c JOIN lead_sources s ON s.org_id = c.org_id AND s.id = c.source_id "
            "WHERE c.month BETWEEN date_trunc('month', %(f)s::date)::date AND date_trunc('month', %(t)s::date)::date",
            {"f": date_from, "t": date_to},
        )
    report = source_roi(
        [SourceLead(r["source"], r["created_on"], r["revenue"]) for r in leads],
        [SourceCost(r["source"], r["month"], r["amount"]) for r in costs],
        date_from=date_from,
        date_to=date_to,
    )
    return RoiOut.model_validate(report)


# ---- internal lead reminders ------------------------------------------------------------------------------------
class ReminderOut(Out):
    lead_id: uuid.UUID
    full_name: str
    phone: str | None
    source: str | None
    stage: str
    reason: Literal["follow_up_due", "after_trial", "silent"]
    days: int
    next_follow_up_on: date | None
    last_contact_on: date | None


@router.get(
    "/leads/reminders",
    response_model=list[ReminderOut],
    summary="Open leads that need a staff follow-up (internal list: nothing is sent to the lead)",
)
async def lead_reminder_list(
    p: Annotated[Principal, Depends(require("students:read"))], db: DB
) -> list[ReminderOut]:
    async with db.tx(p.session()) as conn:
        today = await org_today(conn)
        cfg = await load_settings(conn, p.org_id)
        tz = await _org_tz(conn, p.org_id)
        rows = await fetch_all(
            conn,
            "SELECT l.id AS iid, l.public_id, l.full_name, l.phone, src.name AS source, l.stage, l.next_follow_up_on, "
            "(l.created_at AT TIME ZONE %s)::date AS created_on, "
            "(SELECT max(i.happened_on) FROM lead_interactions i WHERE i.lead_id = l.id) AS last_contact_on "
            "FROM leads l LEFT JOIN lead_sources src ON src.org_id = l.org_id AND src.id = l.source_id "
            "WHERE l.deleted_at IS NULL AND l.stage NOT IN ('enrolled', 'lost')",
            (tz,),
        )
    by_id = {str(r["iid"]): r for r in rows}
    due = lead_reminders(
        [
            LeadFact(str(r["iid"]), r["stage"], r["created_on"], r["last_contact_on"], r["next_follow_up_on"])
            for r in rows
        ],
        today=today,
        silence_days=cfg.lead_reminder_days,
    )
    out: list[ReminderOut] = []
    for d in due:
        r = by_id[d["id"]]
        out.append(
            ReminderOut(
                lead_id=r["public_id"],
                full_name=r["full_name"],
                phone=r["phone"],
                source=r["source"],
                stage=r["stage"],
                reason=d["reason"],
                days=d["days"],
                next_follow_up_on=r["next_follow_up_on"],
                last_contact_on=r["last_contact_on"],
            )
        )
    return out
