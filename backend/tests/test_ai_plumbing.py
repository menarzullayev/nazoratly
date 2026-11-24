"""The AI plumbing without a database: pseudonyms, the HTTP transport (httpx mock), the host worker's command line and
request handler (a fake runner). Nothing here starts the worker or runs the real `claude -p`."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from nazoratly.ai_host_worker import (
    WorkerConfig,
    build_command,
    config_from_env,
    handle_request,
    parse_claude_output,
    run_claude,
)
from nazoratly.ai_privacy import Pseudonymizer
from nazoratly.ai_transport import AiUnavailable, HostWorkerTransport, build_transport
from nazoratly.config import Settings

TOKEN = "t" * 32


# ---- pseudonyms ---------------------------------------------------------------------------------------------------
def test_tokens_are_stable_numbered_and_restored_locally() -> None:
    p = Pseudonymizer(reveal_names=False)
    a = p.token("id-a", "Ali Valiyev")
    b = p.token("id-b", "Bobur Karimov")
    assert (a, b) == ("S001", "S002")
    assert p.token("id-a", "Ali Valiyev") == "S001"
    assert (
        p.restore("S001 qarzdor, S002 yo'q. S001ning onasi")
        == "Ali Valiyev qarzdor, Bobur Karimov yo'q. Ali Valiyevning onasi"
    )


def test_unknown_tokens_and_lookalikes_are_not_replaced() -> None:
    p = Pseudonymizer(reveal_names=False)
    p.token("id-a", "Ali")
    assert p.restore("S009 va XS001 va S0011") == "S009 va XS001 va S0011"
    assert p.restore("S001") == "Ali"


def test_labels_hide_names_unless_the_center_allows_them() -> None:
    hidden = Pseudonymizer(reveal_names=False)
    shown = Pseudonymizer(reveal_names=True)
    assert hidden.label("k", "Ali Valiyev") == "S001"
    assert shown.label("k", "Ali Valiyev") == "S001 (Ali Valiyev)"


def test_a_name_that_looks_like_a_token_is_not_replaced_twice() -> None:
    p = Pseudonymizer(reveal_names=False)
    p.token("a", "S002")
    p.token("b", "Bobur")
    assert p.restore("S001 S002") == "S002 Bobur"


# ---- transport ----------------------------------------------------------------------------------------------------
def _transport(handler: Any, *, timeout: float = 5.0) -> HostWorkerTransport:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return HostWorkerTransport(
        url="http://host.docker.internal:8765/", token=TOKEN, model="haiku", timeout_s=timeout, client=client
    )


async def test_transport_posts_system_prompt_model_and_the_bearer_token() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"text": "salom", "model": "haiku"})

    assert await _transport(handler).complete(system="SYS", prompt="P") == "salom"
    assert seen["url"] == "http://host.docker.internal:8765/complete"
    assert seen["auth"] == f"Bearer {TOKEN}"
    assert seen["body"] == {"system": "SYS", "prompt": "P", "model": "haiku"}


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(500, json={"error": "x"}),
        httpx.Response(401, json={"error": "unauthorized"}),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json={"text": "   "}),
        httpx.Response(200, json={"text": 5}),
        httpx.Response(200, json=["list"]),
    ],
)
async def test_transport_turns_every_bad_answer_into_unavailable(response: httpx.Response) -> None:
    with pytest.raises(AiUnavailable):
        await _transport(lambda _r: response).complete(system="", prompt="P")


async def test_transport_turns_network_errors_and_timeouts_into_unavailable() -> None:
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    for handler in (boom, slow):
        with pytest.raises(AiUnavailable):
            await _transport(handler).complete(system="", prompt="P")


async def test_transport_refuses_an_oversized_prompt_without_calling_the_worker() -> None:
    def never(_r: httpx.Request) -> httpx.Response:
        raise AssertionError("must not be called")

    with pytest.raises(AiUnavailable):
        await _transport(never).complete(system="", prompt="x" * 70_000)


def test_build_transport_needs_both_url_and_token(settings: Settings) -> None:
    assert build_transport(settings) is None
    one = settings.model_copy(update={"ai_worker_url": "http://h:1"})
    assert build_transport(one) is None
    both = one.model_copy(update={"ai_worker_token": SecretStr(TOKEN)})
    t = build_transport(both)
    assert t is not None and t.model == "haiku"


# ---- host worker: command line ------------------------------------------------------------------------------------
def test_the_command_is_tool_less_and_lean() -> None:
    cmd = build_command(("claude",), model="haiku", system_file="s.txt", mcp_file="m.json")
    assert cmd[1:3] == ["-p", "--model"] or "-p" in cmd
    joined = " ".join(cmd)
    for flag in ("--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"):
        assert flag in cmd, flag
    assert cmd[cmd.index("--tools") + 1] == ""  # no tools at all
    assert cmd[cmd.index("--setting-sources") + 1] == ""  # no user or project settings, hooks or memory
    assert cmd[cmd.index("--mcp-config") + 1] == "m.json"
    assert cmd[cmd.index("--model") + 1] == "haiku"
    assert cmd[cmd.index("--system-prompt-file") + 1] == "s.txt"
    for forbidden in (
        "--dangerously-skip-permissions",
        "--allowedTools",
        "--allow-dangerously-skip-permissions",
        "bypassPermissions",
    ):
        assert forbidden not in joined


def test_a_launcher_prefix_is_kept_in_front() -> None:
    cmd = build_command(("python", "launcher.py", "pro"), model="haiku", system_file="s", mcp_file="m")
    assert cmd[1:3] == ["launcher.py", "pro"]


def test_the_worker_needs_a_token_and_reads_its_settings() -> None:
    with pytest.raises(SystemExit):
        config_from_env({})
    with pytest.raises(SystemExit):
        config_from_env({"NAZORATLY_AI_WORKER_TOKEN": "short"})
    cfg = config_from_env(
        {
            "NAZORATLY_AI_WORKER_TOKEN": TOKEN,
            "NAZORATLY_AI_CLAUDE_CMD": "claude --foo",
            "NAZORATLY_AI_MODELS": "haiku",
        }
    )
    assert cfg.claude_cmd == ("claude", "--foo") and cfg.models == frozenset({"haiku"})


# ---- host worker: output and requests -----------------------------------------------------------------------------
def test_parse_claude_output() -> None:
    assert (
        parse_claude_output(json.dumps({"type": "result", "is_error": False, "result": "matn"}).encode())
        == "matn"
    )
    events = [{"type": "system"}, {"type": "result", "is_error": False, "result": "oxirgi"}]
    assert parse_claude_output(json.dumps(events).encode()) == "oxirgi"
    for bad in (
        {"is_error": True, "result": "x"},
        {"result": "   "},
        {"result": 3},
        {},
    ):
        with pytest.raises(ValueError):
            parse_claude_output(json.dumps(bad).encode())
    with pytest.raises(ValueError):
        parse_claude_output(b"not json")


class FakeRunner:
    def __init__(self, stdout: bytes | None = None, code: int = 0, exc: Exception | None = None) -> None:
        self.calls: list[tuple[list[str], bytes, float, str, str]] = []
        self._stdout = (
            stdout if stdout is not None else json.dumps({"is_error": False, "result": "javob"}).encode()
        )
        self._code = code
        self._exc = exc

    def __call__(self, cmd: list[str], stdin: bytes, timeout_s: float) -> tuple[int, bytes, bytes]:
        system = Path(cmd[cmd.index("--system-prompt-file") + 1]).read_text(encoding="utf-8")
        mcp = Path(cmd[cmd.index("--mcp-config") + 1]).read_text(encoding="utf-8")
        self.calls.append((cmd, stdin, timeout_s, system, mcp))
        if self._exc:
            raise self._exc
        return self._code, self._stdout, b""


CFG = WorkerConfig(token=TOKEN, claude_cmd=("claude",), models=frozenset({"haiku", "sonnet"}), timeout_s=7.0)


def _post(
    runner: FakeRunner, body: Any, auth: str | None = f"Bearer {TOKEN}", path: str = "/complete"
) -> tuple[int, dict[str, Any]]:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return handle_request(CFG, method="POST", path=path, authorization=auth, body=raw, runner=runner)


def test_a_request_runs_the_fake_claude_with_prompt_on_stdin_and_system_in_a_file() -> None:
    runner = FakeRunner()
    status, out = _post(runner, {"system": "SIST", "prompt": "SAVOL", "model": "haiku"})
    assert (status, out) == (200, {"text": "javob", "model": "haiku"})
    cmd, stdin, timeout, system, mcp = runner.calls[0]
    assert stdin == b"SAVOL" and system == "SIST" and json.loads(mcp) == {"mcpServers": {}} and timeout == 7.0
    assert "SAVOL" not in " ".join(cmd) and "SIST" not in " ".join(cmd)  # never on the command line


def test_default_model_is_haiku() -> None:
    runner = FakeRunner()
    assert _post(runner, {"prompt": "x"})[1]["model"] == "haiku"
    assert runner.calls[0][0][runner.calls[0][0].index("--model") + 1] == "haiku"


@pytest.mark.parametrize(
    ("body", "auth", "path", "status"),
    [
        ({"prompt": "x"}, None, "/complete", 401),
        ({"prompt": "x"}, "Bearer wrong", "/complete", 401),
        ({"prompt": "x"}, TOKEN, "/complete", 401),  # not a Bearer header
        ({"prompt": "x"}, f"Bearer {TOKEN}", "/other", 404),
        (b"not json", f"Bearer {TOKEN}", "/complete", 400),
        ([1], f"Bearer {TOKEN}", "/complete", 400),
        ({"prompt": ""}, f"Bearer {TOKEN}", "/complete", 400),
        ({"prompt": 5}, f"Bearer {TOKEN}", "/complete", 400),
        ({"system": 5, "prompt": "x"}, f"Bearer {TOKEN}", "/complete", 400),
        ({"prompt": "x", "model": "opus"}, f"Bearer {TOKEN}", "/complete", 400),  # not on the allow list
        ({"prompt": "x" * 70_000}, f"Bearer {TOKEN}", "/complete", 413),
    ],
)
def test_bad_requests_never_reach_claude(body: Any, auth: str | None, path: str, status: int) -> None:
    runner = FakeRunner()
    got, _ = _post(runner, body, auth, path)
    assert got == status
    assert runner.calls == []


def test_an_oversized_body_is_refused() -> None:
    runner = FakeRunner()
    assert _post(runner, b"x" * 300_000)[0] == 413 or _post(runner, b"x" * 300_000)[0] == 401
    assert runner.calls == []


def test_claude_failures_become_gateway_errors_not_crashes() -> None:
    for runner, status in (
        (FakeRunner(code=1), 502),
        (FakeRunner(stdout=b"garbage"), 502),
        (FakeRunner(stdout=json.dumps({"is_error": True, "result": "x"}).encode()), 502),
        (FakeRunner(exc=subprocess.TimeoutExpired("claude", 7)), 504),
        (FakeRunner(exc=FileNotFoundError("claude")), 502),
    ):
        assert _post(runner, {"prompt": "x"})[0] == status


def test_health_needs_no_token_and_reveals_nothing() -> None:
    status, body = handle_request(
        CFG, method="GET", path="/health", authorization=None, body=b"", runner=FakeRunner()
    )
    assert (status, body) == (200, {"ok": True})


def test_run_claude_leaves_no_temp_files_behind() -> None:
    runner = FakeRunner()
    run_claude(CFG, system="s", prompt="p", model="haiku", runner=runner)
    assert not Path(runner.calls[0][0][runner.calls[0][0].index("--system-prompt-file") + 1]).exists()
