"""Pseudonyms for the AI: the worker sees `S001`, never a real name unless the center switched "AI sees names" on.

Even then the identifier in the prompt stays the pseudonym (the name is added next to it), so the answer is always
restored locally: only tokens this run issued are replaced; anything else the model writes stays as text."""

from __future__ import annotations

import re

_TOKEN = re.compile(r"(?<![A-Za-z0-9])S(\d{3,})(?!\d)")


class Pseudonymizer:
    def __init__(self, *, reveal_names: bool) -> None:
        self.reveal_names = reveal_names
        self._token_of: dict[str, str] = {}
        self._name_of: dict[str, str] = {}

    def token(self, key: str, name: str) -> str:
        """Stable pseudonym for one student (`key` = the student's public id) within this run."""
        existing = self._token_of.get(key)
        if existing is not None:
            return existing
        token = f"S{len(self._token_of) + 1:03d}"
        self._token_of[key] = token
        self._name_of[token] = name
        return token

    def label(self, key: str, name: str) -> str:
        """What the prompt shows for the student: the token, plus the name only when the center allows it."""
        token = self.token(key, name)
        return f"{token} ({name})" if self.reveal_names else token

    @property
    def tokens(self) -> frozenset[str]:
        return frozenset(self._name_of)

    def restore(self, text: str) -> str:
        """Put real names back for the tokens issued in this run; unknown tokens are left untouched."""

        def swap(m: re.Match[str]) -> str:
            return self._name_of.get(m.group(0), m.group(0))

        return _TOKEN.sub(swap, text)
