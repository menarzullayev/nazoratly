"""Symmetric encryption for provider secrets at rest (Fernet; the key lives only in the environment)."""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken


class SecretsBox:
    def __init__(self, key: str) -> None:
        self._fernet = Fernet(key.encode())

    def encrypt(self, value: str) -> bytes:
        return self._fernet.encrypt(value.encode())

    def decrypt(self, token: bytes) -> str | None:
        try:
            return self._fernet.decrypt(bytes(token)).decode()
        except InvalidToken:
            return None


def generate_key() -> str:
    return Fernet.generate_key().decode()
