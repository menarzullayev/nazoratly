"""What one conversation may reach, and the callback data / prompt markers that carry the chosen role.

A center's own bot reaches that center only. The shared bot reaches every center except the ones that moved their people
to their own bot and stopped the shared one. Every button and force-reply marker carries the role (`g`, `t`) and the
conversation's epoch; the epoch grows when the person chooses another role or center, which turns old buttons off."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

MENU = "role:"  # callback data of the role menu: never namespaced
CALLBACK = re.compile(r"^([gt]):(\d{1,9}):(.+)$", re.DOTALL)
MARKER = re.compile(r"#([gt])(\d{1,9}):")


@dataclass(frozen=True)
class Scope:
    only_org: int | None = None  # a center's own bot
    moved: Mapping[int, str] = field(default_factory=dict)  # shared bot: stopped center -> its bot's username

    def allows(self, org_id: int) -> bool:
        if self.only_org is not None:
            return org_id == self.only_org
        return org_id not in self.moved

    def moved_note(self, org_id: int) -> str | None:
        username = self.moved.get(org_id) if self.only_org is None else None
        return (
            None
            if username is None
            else f"Bu markaz o'z botiga o'tgan. Shu botni oching: https://t.me/{username}"
        )


def keyboard(ns: str, epoch: int, rows: list[list[tuple[str, str]]]) -> dict[str, Any]:
    """An inline keyboard of (label, data) rows with the data namespaced for this role and epoch."""
    return {
        "inline_keyboard": [
            [{"text": t, "callback_data": d if d.startswith(MENU) else f"{ns}:{epoch}:{d}"} for t, d in row]
            for row in rows
        ]
    }
