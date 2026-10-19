"""``tern_open``: shows a file, a web page or a terminal in a Tern block beside the chat.

The agent's tools run in the profile's shared gateway, not in the Tern pane that shows the chat, so
the terminal tool's shell has no ``$TERN_PANE``: ``tern open`` and ``tern split`` from it land beside
whatever block Tern has focused, or fail. The pane writes its Tern variables (``TERN_PANE``, its
window and sockets) into its viewer marker (``plugin-data/hermes-tern/viewers/<session>.json``, see
``connections.viewed_by_tern``), and this tool runs Tern's CLI with them, so each block opens beside
the chat that asked for it. A subagent's blocks open beside the chat that delegated it.

A terminal block's ``command`` goes through Hermes' own command approval first, as the terminal tool's
commands do: it runs in a shell the user owns, outside any sandbox.
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

TOOLSET = "hermes-tern"
PLACES = ("right", "down", "tab")
TIMEOUT = 20
# Where Tern.app keeps its CLI, for a gateway started without it on PATH.
APP_CLI = "/Applications/Tern.app/Contents/MacOS/tern"

SCHEMA = {
    "name": "tern_open",
    "description": (
        "Show something beside this chat in Tern, the terminal hermes tern runs in. Give exactly one of: "
        "path, a file or folder for a Tern file block (code, Markdown, images, PDFs and 3D models such as "
        ".glb, .gltf, .stl and .fbx draw natively); url, a web page in a Tern browser over the chat; "
        "terminal: true, a shell block (with command, typed and run in it, after the same approval as "
        "terminal commands). Use this tool, not `tern` from the terminal tool: that shell is not in the "
        "chat's Tern block, so `tern open` and `tern split` there land in the wrong place."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "A file or folder to show (relative to the working directory)."},
            "url": {"type": "string", "description": "An http(s) address to show in a Tern browser."},
            "terminal": {"type": "boolean", "description": "Open a shell block."},
            "command": {"type": "string", "description": "With terminal: a command to type and run in the new shell."},
            "cwd": {"type": "string", "description": "With terminal: where the shell starts (default: the working directory)."},
            "place": {"type": "string", "enum": list(PLACES), "description": "Beside the chat (right, default), below it (down) or in a new tab."},
        },
    },
}

PROMPT = (
    "You are running in Tern (hermes tern). To show the user a file, a 3D model, an image, a web page or "
    "a terminal beside the chat, call tern_open; do not run `tern open` or `tern split` from the terminal "
    "tool, whose shell is not in the chat's Tern block. Open a file the user asked to see instead of telling "
    "them a command to run."
)


class TernError(Exception):
    pass


def _viewer(session_id: str) -> dict[str, str]:
    """The Tern variables of the live ``hermes tern`` pane showing ``session_id``'s conversation (a
    subagent's: its delegator's), else {}."""
    from . import connections, pull_requests

    viewers = connections._dir("viewers")
    for sid in reversed(connections._lineage(pull_requests._delegator(session_id) if session_id else "")):
        with contextlib.suppress(OSError, ValueError, KeyError, TypeError, AttributeError):
            marker = json.loads((viewers / f"{sid}.json").read_text())
            tern = marker.get("tern") or {}
            if connections._alive(marker["pid"]) and tern.get("TERN_PANE"):
                return {k: str(v) for k, v in tern.items() if k.startswith("TERN_") and v}
    return {}


def _session(session_id: str | None) -> str:
    from . import pull_requests

    return pull_requests._session(session_id)


def _cwd() -> str:
    from . import pull_requests

    return pull_requests._cwd() or os.getcwd()


def _find_cli() -> str:
    return shutil.which("tern") or (APP_CLI if os.access(APP_CLI, os.X_OK) else "")


def _cli() -> str:
    found = _find_cli()
    if not found:
        raise TernError("Tern's CLI (`tern`) is not on this machine's PATH.")
    return found


def _tern(env: dict[str, str], *args: str) -> str:
    try:
        done = subprocess.run([_cli(), *args], env={**os.environ, **env}, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired as e:
        raise TernError(f"`tern {args[0]}` did not answer in {TIMEOUT}s.") from e
    except OSError as e:
        raise TernError(f"`tern {args[0]}` did not start: {e}") from e
    if done.returncode != 0:
        raise TernError((done.stderr or done.stdout).strip() or f"`tern {args[0]}` failed ({done.returncode}).")
    return done.stdout


def _blocks(env: dict[str, str]) -> set[int]:
    with contextlib.suppress(TernError, ValueError, TypeError, AttributeError):
        data = json.loads(_tern(env, "ls", "--json"))
        return {b["id"] for s in data["sessions"] for t in s["tabs"] for b in t["blocks"]}
    return set()


def _guard(command: str) -> str | None:
    """Why ``command`` may not run (Hermes' command approval said no), else None. Fails closed."""
    try:
        from tools.approval import check_all_command_guards

        verdict = check_all_command_guards(command, "local")
    except Exception as e:  # noqa: BLE001 - no verdict, no command
        return f"command approval is unavailable ({e})"
    if verdict.get("approved"):
        return None
    return str(verdict.get("message") or "the command was not approved")


def _resolve(path: str, base: str) -> Path:
    target = Path(os.path.expanduser(path))
    target = target if target.is_absolute() else Path(base) / target
    if not target.exists():
        raise TernError(f"{target} does not exist.")
    return target.resolve()


def _open_path(env: dict[str, str], path: Path, place: str) -> dict[str, Any]:
    _tern(env, "open", *(["--tab"] if place == "tab" else ["--split", place]), str(path))
    return {"opened": "file", "path": str(path), "place": place}


def _open_url(env: dict[str, str], url: str) -> dict[str, Any]:
    if not url.startswith(("http://", "https://")):
        raise TernError("url must be an http(s) address.")
    answer = _tern(env, "browser", json.dumps({"op": "open", "owner": env["TERN_PANE"], "url": url}))
    with contextlib.suppress(ValueError):
        answer = json.loads(answer)
    return {"opened": "browser", "url": url, "answer": answer}


def _open_terminal(env: dict[str, str], cwd: Path, place: str, command: str) -> dict[str, Any]:
    if command and (why := _guard(command)):
        raise TernError(f"Not opened: {why}")
    before = _blocks(env)
    launch = ["--cwd", str(cwd)]
    _tern(env, *(["new", "tab", *launch] if place == "tab" else ["split", env["TERN_PANE"], place, *launch]))
    fresh = sorted(_blocks(env) - before)
    result: dict[str, Any] = {"opened": "terminal", "cwd": str(cwd), "place": place}
    if fresh:
        result["block"] = fresh[-1]
    if command:
        if not fresh:
            raise TernError("The terminal opened, but its block was not found, so the command was not run.")
        _tern(env, "run", str(fresh[-1]), command)
        result["command"] = command
    return result


def tern_open(args: dict[str, Any], session_id: str | None = None, **_: Any) -> str:
    from tools.registry import tool_error, tool_result

    path, url, terminal = (args.get("path") or "").strip(), (args.get("url") or "").strip(), bool(args.get("terminal"))
    command = (args.get("command") or "").strip()
    place = args.get("place") or "right"
    if [bool(path), bool(url), terminal].count(True) != 1:
        return tool_error("Give exactly one of path, url or terminal.")
    if place not in PLACES:
        return tool_error(f"place must be one of {', '.join(PLACES)}.")
    if command and not terminal:
        return tool_error("command needs terminal: true.")
    env = _viewer(_session(session_id))
    if not env:
        return tool_error("This conversation is not open in a hermes tern pane, so there is no Tern block to open beside.")
    try:
        base = _cwd()
        if path:
            return tool_result(_open_path(env, _resolve(path, base), place))
        if url:
            return tool_result(_open_url(env, url))
        cwd = _resolve(args.get("cwd") or base, base)
        if not cwd.is_dir():
            raise TernError(f"{cwd} is not a folder.")
        return tool_result(_open_terminal(env, cwd, place, command))
    except TernError as e:
        return tool_error(str(e))


def prompt(info) -> str:
    """The section, for a session a ``hermes tern`` pane shows (its marker is written when the pane
    creates or resumes the session, before the first prompt is built); else nothing."""
    with contextlib.suppress(Exception):
        if _viewer(str(info.get("session_id") or "")):
            return PROMPT
    return ""


def register(ctx) -> None:
    ctx.register_tool(name="tern_open", toolset=TOOLSET, schema=SCHEMA, handler=tern_open, emoji="🪟",
                      check_fn=lambda: bool(_find_cli()), description=SCHEMA["description"])
    ctx.register_system_prompt_section("hermes-tern.tern-open", prompt)
