"""Hash-chained double-entry journal rules: canonical line format, sealing an entry onto the chain, entry validation,
chain and period verification. Pure functions, mirrored in TypeScript (sheets/src/domain/ledger.ts); both are checked
against the same cases in tests/golden/ledger.json (hash values there come from an independent hashlib script).

The chain unit is the journal LINE: `hash = sha256(canonical(prev_hash, line))`. Amounts are exact decimals with two
digits; dates are ISO strings; month keys are `YYYY-MM`.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Any

GENESIS = "0" * 64
FORMAT = "v1"
CENT = Decimal("0.01")
ZERO = Decimal(0)


def money(value: str | int | Decimal) -> Decimal:
    return Decimal(value).quantize(CENT)


def fmt(value: Decimal) -> str:
    return format(value.quantize(CENT), "f")


def escape(text: str) -> str:
    """Field separator safe text: backslash, pipe and line breaks are escaped so a memo can never forge a field."""
    return text.replace("\\", "\\\\").replace("|", "\\p").replace("\n", "\\n").replace("\r", "\\r")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Line:
    seq: int
    entry_no: int
    date: str
    account: str
    debit: Decimal
    credit: Decimal
    source_type: str
    source_key: str
    memo: str
    prev_hash: str = GENESIS
    hash: str = ""


def canonical_line(prev_hash: str, line: Line) -> str:
    return "|".join(
        [
            FORMAT,
            prev_hash,
            str(line.seq),
            str(line.entry_no),
            line.date,
            line.account,
            fmt(line.debit),
            fmt(line.credit),
            escape(line.source_type),
            escape(line.source_key),
            escape(line.memo),
        ]
    )


def line_hash(prev_hash: str, line: Line) -> str:
    return sha256_hex(canonical_line(prev_hash, line))


@dataclass(frozen=True)
class Head:
    seq: int = 0
    entry_no: int = 0
    hash: str = GENESIS


def seal_entry(
    head: Head,
    *,
    date: str,
    memo: str,
    source_type: str,
    source_key: str,
    lines: list[tuple[str, Decimal, Decimal]],
) -> list[Line]:
    """Numbers the lines of a new entry after `head` and chains their hashes. The caller validates first."""
    out: list[Line] = []
    prev = head.hash
    for i, (account, debit, credit) in enumerate(lines, start=1):
        ln = Line(
            seq=head.seq + i,
            entry_no=head.entry_no + 1,
            date=date,
            account=account,
            debit=money(debit),
            credit=money(credit),
            source_type=source_type,
            source_key=source_key,
            memo=memo,
            prev_hash=prev,
        )
        ln = replace(ln, hash=line_hash(prev, ln))
        out.append(ln)
        prev = ln.hash
    return out


def next_head(head: Head, sealed: list[Line]) -> Head:
    last = sealed[-1]
    return Head(seq=last.seq, entry_no=last.entry_no, hash=last.hash)


# ---- entry validation ------------------------------------------------------------------------------------------
def validate_entry(
    lines: list[tuple[str, Decimal, Decimal]],
    accounts: dict[str, bool],
    *,
    date: str,
    closed_months: set[str],
) -> list[str]:
    """Error codes (empty when the entry can be posted): too_few_lines, bad_line, unknown_account, inactive_account,
    unbalanced, closed_period. `accounts` maps a code to whether it is active."""
    errors: list[str] = []
    if len(lines) < 2:
        errors.append("too_few_lines")
    for account, debit, credit in lines:
        if (debit < 0 or credit < 0 or (debit > 0) == (credit > 0)) and "bad_line" not in errors:
            errors.append("bad_line")
        if account not in accounts:
            if "unknown_account" not in errors:
                errors.append("unknown_account")
        elif not accounts[account] and "inactive_account" not in errors:
            errors.append("inactive_account")
    if sum((d for _, d, _ in lines), ZERO) != sum((c for _, _, c in lines), ZERO):
        errors.append("unbalanced")
    if date[:7] in closed_months:
        errors.append("closed_period")
    return errors


def reverse_lines(lines: list[tuple[str, Decimal, Decimal]]) -> list[tuple[str, Decimal, Decimal]]:
    """The exact reversing entry: debit and credit swapped, same order."""
    return [(account, credit, debit) for account, debit, credit in lines]


# ---- verification ------------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class Period:
    month: str  # YYYY-MM
    last_seq: int
    head_hash: str
    total_debit: Decimal
    total_credit: Decimal
    period_hash: str


def period_hash(month: str, last_seq: int, head: str, total_debit: Decimal, total_credit: Decimal) -> str:
    return sha256_hex(f"period|{month}|{last_seq}|{head}|{fmt(total_debit)}|{fmt(total_credit)}|{last_seq}")


def make_period(month: str, lines: list[Line]) -> Period:
    """Close record for `month`: every line with seq up to the last line that exists now (the caller refuses the close
    when a source document of the month is unposted)."""
    last = lines[-1] if lines else None
    seq = last.seq if last else 0
    head = last.hash if last else GENESIS
    td = sum((ln.debit for ln in lines), ZERO)
    tc = sum((ln.credit for ln in lines), ZERO)
    return Period(month, seq, head, td, tc, period_hash(month, seq, head, td, tc))


@dataclass(frozen=True)
class Verdict:
    ok: bool
    broken_seq: int | None
    reason: str | None
    period_issues: list[dict[str, Any]]

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "broken_seq": self.broken_seq,
            "reason": self.reason,
            "period_issues": self.period_issues,
        }


def _chain_problem(lines: list[Line]) -> tuple[int, str] | None:
    prev = GENESIS
    prev_entry = 0
    group: list[Line] = []

    def unbalanced() -> bool:
        return bool(group) and sum((x.debit for x in group), ZERO) != sum((x.credit for x in group), ZERO)

    for i, ln in enumerate(lines, start=1):
        if ln.seq != i:
            return ln.seq, "seq_gap"
        if ln.prev_hash != prev:
            return ln.seq, "prev_mismatch"
        if ln.hash != line_hash(prev, ln):
            return ln.seq, "hash_mismatch"
        if ln.debit < 0 or ln.credit < 0 or (ln.debit > 0) == (ln.credit > 0):
            return ln.seq, "bad_line"
        if ln.entry_no == prev_entry:
            group.append(ln)
        else:
            if ln.entry_no != prev_entry + 1:
                return ln.seq, "entry_order"
            if unbalanced():
                return group[0].seq, "unbalanced_entry"
            group = [ln]
            prev_entry = ln.entry_no
        prev = ln.hash
    if unbalanced():
        return group[0].seq, "unbalanced_entry"
    return None


def verify_chain(lines: list[Line], periods: list[Period]) -> Verdict:
    """Checks the whole journal in stored order. `broken_seq` is the first broken row; period problems are reported
    separately: period_missing (close points past the journal), period_head_mismatch, period_totals_mismatch,
    period_hash_mismatch and late_entry (a line after the close dated inside the closed month)."""
    problem = _chain_problem(lines)
    issues: list[dict[str, Any]] = []
    by_seq = {ln.seq: ln for ln in lines}
    for p in sorted(periods, key=lambda x: x.month):
        if p.period_hash != period_hash(p.month, p.last_seq, p.head_hash, p.total_debit, p.total_credit):
            issues.append({"month": p.month, "reason": "period_hash_mismatch", "seq": None})
            continue
        if p.last_seq == 0:
            head_ok, td, tc = p.head_hash == GENESIS, ZERO, ZERO
        elif p.last_seq not in by_seq:
            issues.append({"month": p.month, "reason": "period_missing", "seq": p.last_seq})
            continue
        else:
            head_ok = by_seq[p.last_seq].hash == p.head_hash
            upto = [ln for ln in lines if ln.seq <= p.last_seq]
            td = sum((ln.debit for ln in upto), ZERO)
            tc = sum((ln.credit for ln in upto), ZERO)
        if not head_ok:
            issues.append({"month": p.month, "reason": "period_head_mismatch", "seq": p.last_seq})
        elif (td, tc) != (p.total_debit, p.total_credit):
            issues.append({"month": p.month, "reason": "period_totals_mismatch", "seq": p.last_seq})
        for ln in lines:
            if ln.seq > p.last_seq and ln.date[:7] == p.month:
                issues.append({"month": p.month, "reason": "late_entry", "seq": ln.seq})
                break
    ok = problem is None and not issues
    return Verdict(ok, problem[0] if problem else None, problem[1] if problem else None, issues)
