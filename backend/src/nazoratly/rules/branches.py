"""Multi-branch rules: how a row gets its branch mark, who sees which rows, the per-branch totals, the student move
check, settings/price inheritance, the daily cash close branch and the effective view scope of a staff member. Pure
functions, mirrored in TypeScript (sheets/src/domain/branches.ts); both are checked against the same cases in
tests/golden/branches.json. The database enforces the same rules (stamp_branch() and the branch_scope policies)."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal

StampMode = Literal["context", "parent"]


def stamp_branch(
    *, explicit: int | None, scope: int | None, parent: int | None, default: int, mode: StampMode
) -> int:
    """The branch mark of a new row. An explicit value always wins. Money/context rows (mode "context") prefer the
    session scope (the desk that took the money), then the parent row; rows that follow a parent (mode "parent")
    prefer the parent, then the scope. The center's default branch is the last resort."""
    if explicit is not None:
        return explicit
    order = (scope, parent) if mode == "context" else (parent, scope)
    for candidate in order:
        if candidate is not None:
            return candidate
    return default


def row_visible(*, scope: int | None, branch: int | None, shared: bool = False) -> bool:
    """Whether a staff session with `scope` (None = center-wide) sees a row marked `branch`. A shared row (catalog
    data without a branch) is visible to everybody."""
    if scope is None:
        return True
    if branch is None:
        return shared
    return branch == scope


@dataclass(frozen=True)
class Totals:
    revenue: Decimal
    charges: Decimal
    expenses: Decimal

    @property
    def net(self) -> Decimal:
        return self.revenue - self.expenses

    def plus(self, kind: str, amount: Decimal) -> Totals:
        if kind == "payment":
            return Totals(self.revenue + amount, self.charges, self.expenses)
        if kind == "charge":
            return Totals(self.revenue, self.charges + amount, self.expenses)
        if kind == "expense":
            return Totals(self.revenue, self.charges, self.expenses + amount)
        raise ValueError(f"unknown fact kind {kind!r}")

    def as_dict(self) -> dict[str, str]:
        return {
            "revenue": str(self.revenue),
            "charges": str(self.charges),
            "expenses": str(self.expenses),
            "net": str(self.net),
        }


_ZERO = Totals(Decimal(0), Decimal(0), Decimal(0))


def branch_totals(branches: Sequence[dict[str, Any]], facts: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """Revenue (payments), charges and expenses per branch plus the total. A fact whose branch is missing or not in the
    list is reported as `unassigned` and still counted in the total, so the total always equals the sum of all rows.
    Voided facts are ignored. net = revenue - expenses."""
    per: dict[int, Totals] = {int(b["id"]): _ZERO for b in branches}
    unassigned = _ZERO
    stray = False
    for f in facts:
        if f.get("voided"):
            continue
        amount = Decimal(str(f["amount"]))
        branch = f.get("branch")
        if branch is not None and int(branch) in per:
            per[int(branch)] = per[int(branch)].plus(f["kind"], amount)
        else:
            unassigned = unassigned.plus(f["kind"], amount)
            stray = True
    total = unassigned
    for t in per.values():
        total = Totals(total.revenue + t.revenue, total.charges + t.charges, total.expenses + t.expenses)
    return {
        "rows": [{"branch": int(b["id"]), **per[int(b["id"])].as_dict()} for b in branches],
        "unassigned": unassigned.as_dict() if stray else None,
        "total": total.as_dict(),
    }


def transfer_check(
    *,
    from_branch: int,
    to_branch: int,
    to_status: str,
    enrollment_branches: Sequence[int],
    end_enrollments: bool,
) -> dict[str, Any]:
    """May a student move from `from_branch` to `to_branch`? `enrollment_branches` = the branch of the group of each of
    his active/trial/frozen enrollments. After the move every such enrollment must be in the new branch, so those in
    other branches must be ended (end_enrollments) or the move is refused."""
    if from_branch == to_branch:
        return {"ok": False, "error": "same_branch", "end_count": 0}
    if to_status != "active":
        return {"ok": False, "error": "target_closed", "end_count": 0}
    stale = sum(1 for b in enrollment_branches if b != to_branch)
    if stale and not end_enrollments:
        return {"ok": False, "error": "enrollments_in_old_branch", "end_count": stale}
    return {"ok": True, "error": None, "end_count": stale}


def effective_value(*, override: str | None, base: str | None) -> str | None:
    """Settings and prices: a branch value replaces the center/course value; no branch value inherits. Zero is a real
    override."""
    return base if override is None else override


def cash_close_branch(*, scope: int | None, requested: int | None, active: Sequence[int]) -> dict[str, Any]:
    """Which branch a daily cash close belongs to. Restricted staff: always their own. Center-wide staff: the branch
    they name; with exactly one active branch it is implied; otherwise the branch is required."""
    if scope is not None:
        if requested is not None and requested != scope:
            return {"branch": None, "error": "forbidden_branch"}
        return {"branch": scope, "error": None}
    if requested is not None:
        if requested in active:
            return {"branch": requested, "error": None}
        return {"branch": None, "error": "unknown_branch"}
    if len(active) == 1:
        return {"branch": active[0], "error": None}
    return {"branch": None, "error": "branch_required"}


def resolve_scope(
    *, member_branch: int | None, requested: int | None, known: Sequence[int]
) -> dict[str, Any]:
    """The effective scope of a request: restricted staff (member_branch set) are always scoped to it and may not look
    elsewhere; center-wide staff see the total unless they narrow to a known branch (the X-Branch header)."""
    if member_branch is not None:
        if requested is not None and requested != member_branch:
            return {"scope": None, "error": "forbidden_branch"}
        return {"scope": member_branch, "error": None}
    if requested is None:
        return {"scope": None, "error": None}
    if requested in known:
        return {"scope": requested, "error": None}
    return {"scope": None, "error": "unknown_branch"}
