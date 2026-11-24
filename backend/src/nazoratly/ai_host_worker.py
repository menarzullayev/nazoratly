"""Host-side AI worker: `python -m nazoratly.ai_host_worker` (run on the host, NOT in Docker).

Takes text, returns text. For every request it runs `claude -p` in tool-less lean mode (no tools, no MCP servers, no slash
commands, no session persistence, no user/project settings), so the model can only write text. The claude credentials
live on the host only; the API container reaches this worker over HTTP with a bearer token.

Environment (prefix NAZORATLY_AI_):
  WORKER_TOKEN   required, shared secret with the API (NAZORATLY_AI_WORKER_TOKEN there too)
  WORKER_HOST    bind address, default 127.0.0.1 (set 0.0.0.0 only behind a host firewall: the API container needs to reach it)
  WORKER_PORT    default 8765
  CLAUDE_CMD     the command that starts claude, default `claude` (e.g. `python ~/.claude-accounts/claude_as.py pro`)
  MODELS         comma separated models a request may ask for, default `haiku,sonnet` (Haiku is the default per the pro agent guide)
  TIMEOUT_S      per request, default 120

Requests are served one at a time (the subscription is shared). Tests never start this server or run claude: they call
`build_command`, `handle_request` and `parse_claude_output` with a fake runner."""

from __future__ import annotations

import hmac
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MAX_BODY_BYTES = 200_000
MAX_TEXT_CHARS = 60_000
DEFAULT_MODEL = "haiku"

# (command, stdin bytes, timeout seconds) -> (return code, stdout, stderr)
Runner = Callable[[list[str], bytes, float], tuple[int, bytes, bytes]]


@dataclass(frozen=True)
class WorkerConfig:
    token: str
    claude_cmd: tuple[str, ...] = ("claude",)
    models: frozenset[str] = frozenset({"haiku", "sonnet"})
    timeout_s: float = 120.0


def config_from_env(env: dict[str, str] | None = None) -> WorkerConfig:
    e = dict(os.environ) if env is None else env
    token = e.get("NAZORATLY_AI_WORKER_TOKEN", "").strip()
    if len(token) < 16:
        raise SystemExit("NAZORATLY_AI_WORKER_TOKEN must be set (at least 16 characters)")
    cmd = shlex.split(e.get("NAZORATLY_AI_CLAUDE_CMD", "claude").strip() or "claude", posix=os.name != "nt")
    models = frozenset(
        m.strip() for m in e.get("NAZORATLY_AI_MODELS", "haiku,sonnet").split(",") if m.strip()
    )
    return WorkerConfig(
        token=token,
        claude_cmd=tuple(cmd),
        models=models or frozenset({DEFAULT_MODEL}),
        timeout_s=float(e.get("NAZORATLY_AI_TIMEOUT_S", "120")),
    )


def build_command(claude_cmd: tuple[str, ...], *, model: str, system_file: str, mcp_file: str) -> list[str]:
    """The lean, tool-less invocation. Prompt goes through stdin; system prompt and the empty MCP config through files
    (Windows command lines are short and quoting JSON through cmd.exe is fragile)."""
    resolved = shutil.which(claude_cmd[0]) or claude_cmd[0]
    return [
        resolved,
        *claude_cmd[1:],
        "-p",
        "--model", model,
        "--tools", "",
        "--strict-mcp-config",
        "--mcp-config", mcp_file,
        "--disable-slash-commands",
        "--no-session-persistence",
        "--setting-sources", "",
        "--output-format", "json",
        "--system-prompt-file", system_file,
    ]  # fmt: skip


def parse_claude_output(stdout: bytes) -> str:
    """The text of the answer from `--output-format json`; raises ValueError when claude reported an error."""
    data = json.loads(stdout.decode("utf-8", errors="replace"))
    if isinstance(data, list):  # some versions print the event list; the last `result` event holds the answer
        data = next((d for d in reversed(data) if isinstance(d, dict) and d.get("type") == "result"), {})
    if not isinstance(data, dict) or data.get("is_error") or not isinstance(data.get("result"), str):
        raise ValueError("claude returned no result")
    text: str = data["result"]
    if not text.strip():
        raise ValueError("claude returned an empty result")
    return text


def subprocess_runner(cmd: list[str], stdin: bytes, timeout_s: float) -> tuple[int, bytes, bytes]:
    p = subprocess.run(cmd, input=stdin, capture_output=True, timeout=timeout_s, check=False)  # noqa: S603
    return p.returncode, p.stdout, p.stderr


def run_claude(cfg: WorkerConfig, *, system: str, prompt: str, model: str, runner: Runner) -> str:
    with tempfile.TemporaryDirectory(prefix="nazoratly-ai-") as tmp:
        system_file = Path(tmp, "system.txt")
        system_file.write_text(system, encoding="utf-8")
        mcp_file = Path(tmp, "mcp.json")
        mcp_file.write_text('{"mcpServers":{}}', encoding="utf-8")
        cmd = build_command(cfg.claude_cmd, model=model, system_file=str(system_file), mcp_file=str(mcp_file))
        code, out, _err = runner(cmd, prompt.encode("utf-8"), cfg.timeout_s)
    if code != 0:
        raise RuntimeError(f"claude exited with {code}")
    return parse_claude_output(out)


_LOCK = threading.Lock()  # one claude run at a time


def handle_request(
    cfg: WorkerConfig, *, method: str, path: str, authorization: str | None, body: bytes, runner: Runner
) -> tuple[int, dict[str, Any]]:
    """Pure request handler (the HTTP server only adapts it). Returns (status, JSON body)."""
    if method == "GET" and path == "/health":
        return 200, {"ok": True}
    if method != "POST" or path != "/complete":
        return 404, {"error": "not found"}
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme != "Bearer" or not hmac.compare_digest(supplied.strip().encode(), cfg.token.encode()):
        return 401, {"error": "unauthorized"}
    if len(body) > MAX_BODY_BYTES:
        return 413, {"error": "body too large"}
    try:
        req = json.loads(body)
    except ValueError:
        return 400, {"error": "body is not JSON"}
    if not isinstance(req, dict):
        return 400, {"error": "body must be an object"}
    system, prompt = req.get("system", ""), req.get("prompt")
    model = req.get("model") or DEFAULT_MODEL
    if not isinstance(system, str) or not isinstance(prompt, str) or not prompt.strip():
        return 400, {"error": "system and prompt must be text"}
    if len(system) > MAX_TEXT_CHARS or len(prompt) > MAX_TEXT_CHARS:
        return 413, {"error": "text too large"}
    if model not in cfg.models:
        return 400, {"error": "model not allowed"}
    with _LOCK:
        try:
            text = run_claude(cfg, system=system, prompt=prompt, model=model, runner=runner)
        except subprocess.TimeoutExpired:
            return 504, {"error": "claude timed out"}
        except (RuntimeError, ValueError, OSError) as e:
            return 502, {"error": f"claude failed: {type(e).__name__}"}
    return 200, {"text": text, "model": model}


def make_server(
    cfg: WorkerConfig, host: str, port: int, runner: Runner = subprocess_runner
) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def _serve(self, method: str) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if 0 < length <= MAX_BODY_BYTES + 1 else b""
            status, payload = handle_request(
                cfg,
                method=method,
                path=self.path,
                authorization=self.headers.get("Authorization"),
                body=body if length <= MAX_BODY_BYTES else b"x" * (MAX_BODY_BYTES + 1),
                runner=runner,
            )
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            self._serve("GET")

        def do_POST(self) -> None:
            self._serve("POST")

        def log_message(self, format: str, *args: Any) -> None:  # never log bodies; keep it quiet
            sys.stderr.write(
                f"ai-worker {self.command} {self.path.split('?')[0]} -> {args[1] if len(args) > 1 else ''}\n"
            )

    return ThreadingHTTPServer((host, port), Handler)


def main() -> None:
    cfg = config_from_env()
    host = os.environ.get("NAZORATLY_AI_WORKER_HOST", "127.0.0.1")
    port = int(os.environ.get("NAZORATLY_AI_WORKER_PORT", "8765"))
    server = make_server(cfg, host, port)
    sys.stderr.write(f"nazoratly AI worker on {host}:{port}, models {sorted(cfg.models)}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
