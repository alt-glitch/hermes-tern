"""The session's pull requests: ``link_pull_request``, ``unlink_pull_request`` and
``list_pull_requests``, after T3 Code's tools of the same purpose.

The agent links each PR it opens or works on; ``hermes tern`` shows them beside the chat. Links live
in ``<HERMES_HOME>/plugin-data/hermes-tern/pull-requests.json`` under the conversation's root
session, so a compressed conversation (whose session id changes) keeps them:

    {"version": 1,
     "conversations": {ROOT: [{"host", "repository", "number", "url", "linked_at", "session_id", "cwd"}]},
     "aliases": {SESSION_ID: ROOT}}

Nothing here calls GitHub: a link is the URL's host, repository and number. The frontend reads the
rest from the GitHub API.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

PLUGIN = "hermes-tern"
TOOLSET = "hermes-tern"
FILE = "pull-requests.json"

# T3 Code's parseChangeRequestUrl (packages/shared/src/changeRequestUrl.ts) for GitHub.
_PATH = re.compile(r"^/([^/]+/[^/]+)/pull/(\d+)(?:/|$)")
_REPO = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

PROMPT = """<pull_request_linking>
Use link_pull_request to register every pull request you create or work on in this session. Call it with the full PR URL right after you create a PR or start work on an existing PR. For a stack, call it for every layer, not only the current branch or the top PR. This applies when you create or update PRs through gh, gh stack, another CLI, or the API: those operations do not register the PR. Linking an already-linked PR is safe. The linked PRs show beside the chat in hermes tern. Before you finish PR work, call list_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs that are mentioned only as background. If a link call fails, report the failure instead of saying the PR is linked.
</pull_request_linking>"""

_TARGET = {
    "url": {
        "type": "string",
        "description": "The pull request's web URL, e.g. https://github.com/owner/repo/pull/123. "
                       "Preferred; the host, repository and number are read from it.",
    },
    "repository": {"type": "string", "description": "owner/repo; with number, when url is omitted."},
    "number": {"type": "integer", "minimum": 1, "description": "The PR number; with repository, when url is omitted."},
    "host": {"type": "string", "description": "The GitHub host for repository + number. Default github.com."},
}

LINK_SCHEMA = {
    "name": "link_pull_request",
    "description": (
        "Register every GitHub pull request you open or work on in this session, including each layer of a "
        "stack, right after creating it. hermes tern shows linked pull requests (state, checks, reviews) beside "
        "the chat. Pass the URL, or repository plus number. Linking an already-linked PR succeeds with "
        "already_linked=true."),
    "parameters": {"type": "object", "properties": _TARGET, "additionalProperties": False},
}

UNLINK_SCHEMA = {
    "name": "unlink_pull_request",
    "description": "Remove a pull request linked by mistake from this session's list. Pass the URL, or repository plus number.",
    "parameters": {"type": "object", "properties": _TARGET, "additionalProperties": False},
}

LIST_SCHEMA = {
    "name": "list_pull_requests",
    "description": "List the GitHub pull requests linked to this session (link_pull_request), oldest first.",
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}


class TargetError(ValueError):
    pass


def parse_target(args: dict[str, Any]) -> dict[str, Any]:
    """``{host, repository, number, url}`` from a PR URL, or from repository + number (+ host)."""
    url = str(args.get("url") or "").strip()
    if url:
        from urllib.parse import urlparse

        parsed = urlparse(url if "://" in url else f"https://{url}")
        host = (parsed.hostname or "").lower()
        match = _PATH.match(parsed.path or "")
        if not match or not _is_github(host):
            raise TargetError("This is not a GitHub pull request URL. Pass repository and number instead.")
        repository, number = match.group(1).lower(), int(match.group(2))
    else:
        repository = str(args.get("repository") or "").strip().lower()
        number = args.get("number")
        host = str(args.get("host") or "github.com").strip().lower()
        if not repository or not isinstance(number, int) or isinstance(number, bool) or number < 1:
            raise TargetError("Pass the PR url, or repository (owner/repo) and number.")
        if not _REPO.match(repository):
            raise TargetError(f"repository must be owner/repo, not {repository!r}.")
        if not _is_github(host):
            raise TargetError(f"{host} is not a GitHub host.")
    return {"host": host, "repository": repository, "number": number,
            "url": f"https://{host}/{repository}/pull/{number}"}


def _is_github(host: str) -> bool:
    # github.com, a subdomain of it, or a GitHub Enterprise host with a `github` label.
    return host == "github.com" or host.endswith(".github.com") or "github" in host.split(".")


def _key(link: dict[str, Any]) -> str:
    return f"{link['host']}/{link['repository']}#{link['number']}"


# ── Storage ────────────────────────────────────────────────────────────────────────────────────


def data_file() -> Path:
    from plugins.plugin_storage import plugin_data_dir

    return plugin_data_dir(PLUGIN) / FILE


def _lineage(session_id: str) -> list[str]:
    """The conversation's session ids, root first: compression gives a conversation a new id."""
    if not session_id:
        return []
    with contextlib.suppress(Exception):
        from hermes_state import SessionDB

        ids = SessionDB(read_only=True).get_compression_lineage(session_id)
        if ids:
            return [str(i) for i in ids]
    return [session_id]


@contextlib.contextmanager
def _locked(path: Path):
    lock = path.with_suffix(".lock")
    with open(lock, "a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _read(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data.setdefault("version", 1)
    data.setdefault("conversations", {})
    data.setdefault("aliases", {})
    return data


def _write(path: Path, data: dict[str, Any]) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".pull-requests.", suffix=".json")
    try:
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle, indent=1)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _conversation(data: dict[str, Any], session_id: str) -> str:
    """The root the session's links live under; records every id of its lineage as an alias."""
    lineage = _lineage(session_id)
    aliases = data["aliases"]
    root = next((aliases[i] for i in lineage if i in aliases), lineage[0] if lineage else "")
    for i in lineage:
        aliases[i] = root
    return root


def _cwd() -> str:
    with contextlib.suppress(Exception):
        from agent.runtime_cwd import resolve_agent_cwd

        return str(resolve_agent_cwd())
    return ""


def _public(links: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: link[k] for k in ("url", "repository", "number", "host")} for link in links]


# ── Handlers ───────────────────────────────────────────────────────────────────────────────────


def _session(session_id: str | None) -> str:
    sid = str(session_id or "")
    if not sid:
        with contextlib.suppress(Exception):
            from gateway.session_context import get_session_env

            sid = str(get_session_env("HERMES_SESSION_ID", "") or "")
    return sid


def link_pull_request(args: dict[str, Any], session_id: str | None = None) -> str:
    from tools.registry import tool_error, tool_result

    try:
        target = parse_target(args or {})
    except TargetError as error:
        return tool_error(str(error))
    sid = _session(session_id)
    if not sid:
        return tool_error("No session to link the pull request to.")
    path = data_file()
    with _locked(path):
        data = _read(path)
        root = _conversation(data, sid)
        links = data["conversations"].setdefault(root, [])
        already = any(_key(link) == _key(target) for link in links)
        if not already:
            links.append({**target, "linked_at": time.time(), "session_id": sid, "cwd": _cwd()})
        _write(path, data)
    return tool_result({**target, "already_linked": already, "linked": _public(links)})


def unlink_pull_request(args: dict[str, Any], session_id: str | None = None) -> str:
    from tools.registry import tool_error, tool_result

    try:
        target = parse_target(args or {})
    except TargetError as error:
        return tool_error(str(error))
    sid = _session(session_id)
    path = data_file()
    with _locked(path):
        data = _read(path)
        root = _conversation(data, sid)
        links = data["conversations"].get(root, [])
        kept = [link for link in links if _key(link) != _key(target)]
        was = len(kept) != len(links)
        if was:
            data["conversations"][root] = kept
        _write(path, data)
    return tool_result({**target, "was_linked": was, "linked": _public(kept)})


def list_pull_requests(_args: dict[str, Any], session_id: str | None = None) -> str:
    from tools.registry import tool_result

    sid = _session(session_id)
    path = data_file()
    with _locked(path):
        data = _read(path)
        links = data["conversations"].get(_conversation(data, sid), []) if sid else []
    return tool_result({"linked": _public(links)})


def register(ctx) -> None:
    for name, schema, handler in (
        ("link_pull_request", LINK_SCHEMA, link_pull_request),
        ("unlink_pull_request", UNLINK_SCHEMA, unlink_pull_request),
        ("list_pull_requests", LIST_SCHEMA, list_pull_requests),
    ):
        ctx.register_tool(name=name, toolset=TOOLSET, schema=schema, handler=handler, emoji="🔗",
                          description=schema["description"])
    ctx.register_system_prompt_section("hermes-tern.pull-requests", PROMPT)
