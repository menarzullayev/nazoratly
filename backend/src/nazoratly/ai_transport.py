"""How the API reaches the AI: a tiny text-in, text-out transport.

The real implementation talks to the host-side worker (`python -m nazoratly.ai_host_worker`) over HTTP with a bearer
token; the worker runs `claude -p` in tool-less lean mode outside Docker, so no AI credentials ever enter a container.
Tests inject a fake transport: CI never calls the real `claude -p`."""

from __future__ import annotations

from typing import Protocol

import httpx

from nazoratly.config import Settings

MAX_PROMPT_CHARS = 60_000
MAX_REPLY_CHARS = 60_000


class AiUnavailable(Exception):
    """The AI could not answer (not reachable, timeout, error status, unusable body). Never shown to the user as an
    error: the report falls back to the rule-based text."""


class AiTransport(Protocol):
    model: str

    async def complete(self, *, system: str, prompt: str) -> str: ...


class HostWorkerTransport:
    def __init__(
        self,
        *,
        url: str,
        token: str,
        model: str,
        timeout_s: float,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.model = model
        self._url = url.rstrip("/") + "/complete"
        self._token = token
        self._timeout = timeout_s
        self._client = client

    async def complete(self, *, system: str, prompt: str) -> str:
        if len(prompt) > MAX_PROMPT_CHARS:
            raise AiUnavailable("prompt too long")
        body = {"system": system, "prompt": prompt, "model": self.model}
        headers = {"Authorization": f"Bearer {self._token}"}
        try:
            if self._client is not None:
                r = await self._client.post(self._url, json=body, headers=headers, timeout=self._timeout)
            else:
                async with httpx.AsyncClient() as client:
                    r = await client.post(self._url, json=body, headers=headers, timeout=self._timeout)
        except httpx.HTTPError as e:
            raise AiUnavailable(f"worker not reachable: {type(e).__name__}") from e
        if r.status_code != 200:
            raise AiUnavailable(f"worker answered {r.status_code}")
        try:
            data = r.json()
        except ValueError as e:
            raise AiUnavailable("worker answer is not JSON") from e
        text = data.get("text") if isinstance(data, dict) else None
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_REPLY_CHARS:
            raise AiUnavailable("worker answer has no usable text")
        return text


def build_transport(settings: Settings) -> AiTransport | None:
    """None when the worker is not configured (then every report is rule-based)."""
    if not settings.ai_worker_url or settings.ai_worker_token is None:
        return None
    return HostWorkerTransport(
        url=settings.ai_worker_url,
        token=settings.ai_worker_token.get_secret_value(),
        model=settings.ai_model,
        timeout_s=settings.ai_timeout_s,
    )
