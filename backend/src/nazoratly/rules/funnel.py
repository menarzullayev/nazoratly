"""Lead funnel report. Pure function, mirrored in TypeScript (sheets/src/domain/funnel.ts); both are checked against
the same cases in tests/golden/funnel.json."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

STAGES = ("new", "contacted", "trial_scheduled", "trial_attended", "enrolled", "lost")


@dataclass(frozen=True)
class LeadFact:
    stage: str
    source: str | None
    created_on: date


def _pct(part: int, whole: int) -> float:
    if whole == 0:
        return 0.0
    return float((Decimal(part) * 100 / Decimal(whole)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))


def funnel_report(leads: list[LeadFact], *, date_from: date, date_to: date) -> dict[str, Any]:
    """Counts by current stage and per source for leads created in the range (inclusive).

    conversion = enrolled / leads of that source (percent, one decimal, half up).
    trial_to_enrolled = enrolled / (trial_scheduled + trial_attended + enrolled) (percent): of the leads that reached a
    trial, how many enrolled. Sources are ordered by lead count (desc), then name; leads without a source come last.
    """
    inside = [x for x in leads if date_from <= x.created_on <= date_to]
    stages = dict.fromkeys(STAGES, 0)
    per_source: dict[str | None, list[int]] = {}
    for x in inside:
        stages[x.stage] += 1
        counts = per_source.setdefault(x.source, [0, 0])
        counts[0] += 1
        counts[1] += 1 if x.stage == "enrolled" else 0
    ordered = sorted(per_source.items(), key=lambda kv: (kv[0] is None, -kv[1][0], kv[0] or ""))
    by_source = [
        {"source": s, "leads": c[0], "enrolled": c[1], "conversion": _pct(c[1], c[0])} for s, c in ordered
    ]
    reached_trial = stages["trial_scheduled"] + stages["trial_attended"] + stages["enrolled"]
    return {
        "stages": stages,
        "by_source": by_source,
        "trial_to_enrolled": _pct(stages["enrolled"], reached_trial),
    }
