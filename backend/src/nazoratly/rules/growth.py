"""Growth rules: referral rewards, promo codes, the marketing-credit summary, lead source ROI and internal lead
reminders. Pure functions, mirrored in TypeScript (sheets/src/domain/growth.ts); both are checked against the same cases
in tests/golden/growth.json.

Referral rewards and promo discounts are booked as open credits (the existing credit mechanism); nothing here changes
how tuition is billed and nothing here is ever sent to anybody: reminders are an internal list."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

from nazoratly.rules.entitlements import lesson_credit_amount

_WHOLE = Decimal(1)
_ONE_DECIMAL = Decimal("0.1")

RewardType = Literal["amount", "percent", "free_lesson"]
Condition = Literal["enrolled", "paid"]
PromoKind = Literal["percent", "amount"]
PromoState = Literal["ok", "inactive", "not_started", "expired", "exhausted"]


def _whole(x: Decimal) -> Decimal:
    return x.quantize(_WHOLE, rounding=ROUND_HALF_UP)


# ---- referral -------------------------------------------------------------------------------------------------
def referral_reward_amount(
    *, reward_type: RewardType, reward_value: Decimal, monthly_fee: Decimal, lessons_in_month: int
) -> Decimal:
    """Money value of a referral reward, a whole so'm. amount = the value itself; percent = value % of the referrer's
    monthly fee (half up); free_lesson = value lessons, each worth the usual lesson credit (fee / lessons in month)."""
    if reward_value <= 0:
        return Decimal(0)
    if reward_type == "amount":
        return _whole(reward_value)
    if reward_type == "percent":
        return _whole(max(monthly_fee, Decimal(0)) * reward_value / 100)
    one = lesson_credit_amount(monthly_fee=monthly_fee, lessons_in_month=lessons_in_month)
    return _whole(one * reward_value)


def split_credit(*, amount: Decimal, monthly_fee: Decimal) -> list[Decimal]:
    """A credit is consumed whole by billing (what exceeds the fee is lost), so a reward is split into credits of at
    most one monthly fee: they are used one per month instead of being lost. Without a fee the reward stays one credit."""
    if amount <= 0:
        return []
    if monthly_fee <= 0:
        return [amount]
    chunks: list[Decimal] = []
    left = amount
    while left > 0:
        part = min(left, monthly_fee)
        chunks.append(part)
        left -= part
    return chunks


def referral_condition_met(
    *, condition: Condition, min_paid: Decimal, invited_enrolled: bool, invited_paid: Decimal
) -> bool:
    """enrolled: the invited student has an accepted (active) enrollment. paid: the invited student has paid at least
    min_paid in total (and more than zero)."""
    if condition == "enrolled":
        return invited_enrolled
    return invited_paid > 0 and invited_paid >= min_paid


# ---- promo ----------------------------------------------------------------------------------------------------
def promo_state(
    *, active: bool, valid_from: date, valid_to: date | None, max_uses: int | None, used: int, today: date
) -> PromoState:
    """Can a promo code be redeemed today? Checked in this order."""
    if not active:
        return "inactive"
    if today < valid_from:
        return "not_started"
    if valid_to is not None and today > valid_to:
        return "expired"
    if max_uses is not None and used >= max_uses:
        return "exhausted"
    return "ok"


def promo_discount(*, kind: PromoKind, value: Decimal, fee: Decimal) -> Decimal:
    """The credit a promo gives against the first month: percent of the fee (half up) or a fixed amount, never more
    than the fee itself."""
    fee = max(fee, Decimal(0))
    if value <= 0 or fee == 0:
        return Decimal(0)
    raw = fee * value / 100 if kind == "percent" else value
    return min(_whole(raw), fee)


# ---- marketing credits in accounting ----------------------------------------------------------------------------
@dataclass(frozen=True)
class CreditFact:
    source: str  # referral | promo
    label: str  # campaign name or "Referral"
    amount: Decimal
    status: str  # open | used | cancelled


def growth_credit_summary(credits: list[CreditFact]) -> dict[str, Any]:
    """Per (source, label): how many credits were granted, the money granted, applied against charges, still waiting
    and cancelled. granted = applied + outstanding (cancelled ones are not counted as granted)."""
    groups: dict[tuple[str, str], dict[str, Decimal | int]] = {}
    for c in credits:
        g = groups.setdefault(
            (c.source, c.label),
            {
                "count": 0,
                "granted": Decimal(0),
                "applied": Decimal(0),
                "outstanding": Decimal(0),
                "cancelled": Decimal(0),
            },
        )
        if c.status == "cancelled":
            g["cancelled"] += c.amount
            continue
        g["count"] += 1
        g["granted"] += c.amount
        if c.status == "used":
            g["applied"] += c.amount
        else:
            g["outstanding"] += c.amount
    rows: list[dict[str, Any]] = [{"source": s, "label": lab, **v} for (s, lab), v in sorted(groups.items())]
    totals: dict[str, Any] = {
        "count": 0,
        "granted": Decimal(0),
        "applied": Decimal(0),
        "outstanding": Decimal(0),
        "cancelled": Decimal(0),
    }
    for r in rows:
        for k in totals:
            totals[k] += r[k]
    return {"rows": rows, "totals": totals}


# ---- lead source ROI --------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class SourceLead:
    source: str | None
    created_on: date
    revenue: Decimal  # live payments of the student the lead became, up to the end of the range


@dataclass(frozen=True)
class SourceCost:
    source: str
    month: date  # first day of the month
    amount: Decimal


def _div_round(num: Decimal, den: Decimal, scale: Decimal) -> Decimal:
    return (num / den).quantize(scale, rounding=ROUND_HALF_UP)


def source_roi(
    leads: list[SourceLead], costs: list[SourceCost], *, date_from: date, date_to: date
) -> dict[str, Any]:
    """Per source: leads created in the range, the ones that pay (revenue > 0), the revenue of that cohort, the cost entered
    for the months the range touches, and the ratios. roi = (revenue - cost) / cost in percent, one decimal half up (None
    without cost); cost_per_lead and cost_per_paying are whole so'm (None without leads / paying students).
    Sources are ordered by revenue (desc), then name; leads without a source come last (they have no cost)."""
    first, last = date_from.replace(day=1), date_to.replace(day=1)
    per: dict[str | None, dict[str, Any]] = {}

    def row(src: str | None) -> dict[str, Any]:
        return per.setdefault(src, {"leads": 0, "paying": 0, "revenue": Decimal(0), "cost": Decimal(0)})

    for x in leads:
        if date_from <= x.created_on <= date_to:
            r = row(x.source)
            r["leads"] += 1
            if x.revenue > 0:
                r["paying"] += 1
                r["revenue"] += x.revenue
    for c in costs:
        if first <= c.month <= last:
            row(c.source)["cost"] += c.amount

    def build(src: str | None, r: dict[str, Any]) -> dict[str, Any]:
        cost, revenue = r["cost"], r["revenue"]
        return {
            "source": src,
            "leads": r["leads"],
            "paying": r["paying"],
            "revenue": revenue,
            "cost": cost,
            "roi": _div_round((revenue - cost) * 100, cost, _ONE_DECIMAL) if cost > 0 else None,
            "cost_per_lead": _div_round(cost, Decimal(r["leads"]), _WHOLE)
            if r["leads"] and cost > 0
            else None,
            "cost_per_paying": _div_round(cost, Decimal(r["paying"]), _WHOLE)
            if r["paying"] and cost > 0
            else None,
        }

    ordered = sorted(per.items(), key=lambda kv: (kv[0] is None, -kv[1]["revenue"], kv[0] or ""))
    rows = [build(s, r) for s, r in ordered]
    total = {"leads": 0, "paying": 0, "revenue": Decimal(0), "cost": Decimal(0)}
    for _, r in per.items():
        for k in total:
            total[k] += r[k]
    return {"rows": rows, "total": build(None, total) | {"source": "TOTAL"}}


# ---- internal lead reminders -----------------------------------------------------------------------------------
@dataclass(frozen=True)
class LeadFact:
    id: str
    stage: str
    created_on: date
    last_contact_on: date | None  # newest logged interaction
    next_follow_up_on: date | None


_REASON_ORDER = {"follow_up_due": 0, "after_trial": 1, "silent": 2}


def lead_reminders(leads: list[LeadFact], *, today: date, silence_days: int) -> list[dict[str, Any]]:
    """Which open leads need a person's attention. Internal only: nothing is sent to the lead.

    follow_up_due: the planned follow-up date has come (days = days overdue, 0 = today).
    after_trial: the lead attended a trial and nobody has been in touch for a day.
    silent: a new / contacted / trial-scheduled lead nobody has been in touch with for `silence_days` days.
    A follow-up planned for a later day silences the last two. Order: reason, then days (desc), then id."""
    out: list[dict[str, Any]] = []
    for x in leads:
        if x.stage in ("enrolled", "lost"):
            continue
        if x.next_follow_up_on is not None and x.next_follow_up_on <= today:
            out.append({"id": x.id, "reason": "follow_up_due", "days": (today - x.next_follow_up_on).days})
            continue
        if x.next_follow_up_on is not None:
            continue
        last = max(x.created_on, x.last_contact_on) if x.last_contact_on else x.created_on
        quiet = (today - last).days
        if x.stage == "trial_attended" and quiet >= 1:
            out.append({"id": x.id, "reason": "after_trial", "days": quiet})
        elif x.stage in ("new", "contacted", "trial_scheduled") and quiet >= silence_days:
            out.append({"id": x.id, "reason": "silent", "days": quiet})
    return sorted(out, key=lambda r: (_REASON_ORDER[r["reason"]], -r["days"], r["id"]))
