"""Checks the figures of a finished reply the way Tern will draw them.

The frontend (frontend/src/figures.ts) calls the plugin RPC method ``plugin.hermes-tern.figures.check``
after a turn whose reply has a ```mermaid or ```svg fence::

    {"session_id": "...", "reply": "<hash of the reply>", "figures": [{"lang": "mermaid", "source": "..."}, ...]}

The first call for a reply answers ``{"claimed": true}``; a second pane showing the same session gets
``{"claimed": false}`` and stays quiet, so the agent is asked once. The check runs in a thread here (a
first run downloads merman, and the gateway serves one connection's requests in order), and its result
goes to the session's viewers as the event ``plugin.hermes-tern.figures.checked``: ``reply`` and
``{"results": [{"ok": true} | {"ok": false, "error": "...", "line": 3}, ...]}`` in the request's order,
or ``{"unavailable": "<why>"}`` when mermaid cannot be checked here.

Tern draws mermaid with merman (merman-render 0.8.0 against Mermaid 12.1.0 in Tern 0.9.5), so the
check is merman's own parser. merman is not a dependency of the plugin: it has wheels for macOS
arm64, Linux x86_64 (glibc 2.35+) and Windows only, and a dependency the platform has no wheel for
would fail Hermes' whole dependency sync. Without it in the gateway's interpreter, this file runs as a
script through Hermes' uv with merman pinned, which uv caches after the first run::

    python figure_check.py < {"figures": [...]}
"""

from __future__ import annotations

import contextlib
import contextvars
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import xml.etree.ElementTree as ET
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from typing import Any

logger = logging.getLogger(__name__)

MERMAN = "merman==0.8.0"
# A first run downloads the 8 MB wheel.
UV_TIMEOUT_S = 120
REEXEC = "HERMES_TERN_FIGURE_CHECK_REEXEC"
SVG_NS = "{http://www.w3.org/2000/svg}"
FORBIDDEN = {"script", "foreignObject", "iframe", "object", "embed"}
# Kinds merman parses that Tern 0.9.5 still does not draw (its figure shows the source), with what to use instead.
UNDRAWN = {"architecture": "Tern does not draw architecture diagrams; use a flowchart with subgraphs or C4Context"}


def _svg(source: str) -> dict:
    """The svg rules Tern's figure follows: a parsable <svg> root with a viewBox, nothing active."""
    if "<!DOCTYPE" in source or "<!ENTITY" in source:
        return {"ok": False, "error": "a DOCTYPE or ENTITY declaration is not allowed"}
    try:
        root = ET.fromstring(source.strip())
    except ET.ParseError as exc:
        return {"ok": False, "error": f"the SVG does not parse: {exc}", "line": exc.position[0]}
    if root.tag not in ("svg", f"{SVG_NS}svg"):
        return {"ok": False, "error": f"the root element is <{root.tag.removeprefix(SVG_NS)}>, not <svg>"}
    if not root.get("viewBox"):
        return {"ok": False, "error": "the <svg> has no viewBox, so Tern cannot size it"}
    for el in root.iter():
        name = el.tag.removeprefix(SVG_NS) if isinstance(el.tag, str) else ""
        if name in FORBIDDEN:
            return {"ok": False, "error": f"<{name}> is not drawn"}
        for attr, value in el.attrib.items():
            if attr.lower().startswith("on"):
                return {"ok": False, "error": f"event handler {attr} is not allowed"}
            if attr.endswith("href") and value.strip().lower().startswith(("http:", "https:", "//")):
                return {"ok": False, "error": f"external {attr} {value!r} is not loaded"}
    return {"ok": True}


def _header(source: str) -> str:
    """The diagram's keyword: its first line outside front matter, `%%` comments and directives."""
    lines = iter(source.splitlines())
    for line in lines:
        line = line.strip()
        if line == "---":
            for inner in lines:
                if inner.strip() == "---":
                    break
            continue
        if line and not line.startswith("%%"):
            return line.split()[0].lower()
    return ""


def _mermaid(checker, source: str) -> dict:
    result = checker.validate(source, None)
    if result.valid:
        kind = _header(source).removesuffix("-beta")
        return {"ok": False, "error": UNDRAWN[kind]} if kind in UNDRAWN else {"ok": True}
    out = {"ok": False, "error": result.error or result.code_name}
    try:
        for diagnostic in json.loads(checker.analyze_json(source, None)).get("diagnostics", []):
            if diagnostic.get("severity") == "error" and (line := (diagnostic.get("span") or {}).get("line")):
                out["line"] = line
                break
    except Exception:  # noqa: BLE001 - the position only sharpens the hint
        pass
    return out


def _uv() -> str | None:
    """Hermes' own uv (published as ``pm.uv_launcher``), else one on PATH."""
    with contextlib.suppress(Exception):
        from pm import uv_launcher

        if found := uv_launcher("uv"):
            return str(found)
    return shutil.which("uv")


def _through_uv(request: str) -> dict:
    uv = _uv()
    if not uv or os.environ.get(REEXEC):
        return {"unavailable": "merman is not installed and uv was not found"}
    try:
        done = subprocess.run(
            [uv, "run", "--quiet", "--no-project", "--with", MERMAN, "python", "-I", __file__],
            input=request, capture_output=True, text=True, timeout=UV_TIMEOUT_S,
            env={**os.environ, REEXEC: "1"}, check=False)
        return json.loads(done.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return {"unavailable": "merman could not be run through uv"}


def check(request: str) -> dict:
    figures = json.loads(request).get("figures") or []
    checker = None
    if any(f.get("lang") == "mermaid" for f in figures):
        try:
            import merman
        except ImportError:
            return _through_uv(request)
        checker = merman.Merman()
    return {"results": [_mermaid(checker, f.get("source", "")) if f.get("lang") == "mermaid" else _svg(f.get("source", ""))
                        for f in figures]}


METHOD = "figures.check"
EVENT = "figures.checked"
# Bounds on what a caller may send (any client this gateway authenticated can call the method).
MAX_FIGURES = 16
MAX_SOURCE_CHARS = 64 * 1024
MAX_REPLY_CHARS = 64
# Replies already claimed, oldest first; enough to cover every pane's last few turns.
MAX_CLAIMS = 512

_claims: OrderedDict[str, None] = OrderedDict()
_claims_lock = threading.Lock()
_pool: ThreadPoolExecutor | None = None


def _executor() -> ThreadPoolExecutor:
    # One check at a time across the gateway: each is a short subprocess once merman is cached.
    global _pool
    with _claims_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tern-figures")
        return _pool


def _figures(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw or len(raw) > MAX_FIGURES:
        raise ValueError(f"figures.check needs 1 to {MAX_FIGURES} figures")
    out = []
    for f in raw:
        lang, source = (f.get("lang"), f.get("source")) if isinstance(f, dict) else (None, None)
        if lang not in ("mermaid", "svg") or not isinstance(source, str) or len(source) > MAX_SOURCE_CHARS:
            raise ValueError("each figure needs lang mermaid or svg and a source")
        out.append({"lang": lang, "source": source})
    return out


def _claim(session_id: str, reply: str) -> bool:
    """True for the first call about this reply of this session."""
    key = hashlib.sha256(f"{session_id}\0{reply}".encode()).hexdigest()
    with _claims_lock:
        if key in _claims:
            return False
        _claims[key] = None
        while len(_claims) > MAX_CLAIMS:
            _claims.popitem(last=False)
    return True


def register(ctx) -> None:
    def check_figures(params: dict, *, session_id: str | None = None, **_: Any) -> dict[str, bool]:
        if not session_id:
            raise ValueError("figures.check needs the session_id whose viewers get the result")
        reply = params.get("reply")
        if not isinstance(reply, str) or not reply or len(reply) > MAX_REPLY_CHARS:
            raise ValueError("figures.check needs the reply's hash")
        request = json.dumps({"figures": _figures(params.get("figures"))})
        if not _claim(session_id, reply):
            return {"claimed": False}

        def run() -> None:
            try:
                answer = check(request)
            except Exception as exc:  # noqa: BLE001 - the pane gets an answer, whatever went wrong
                answer = {"unavailable": str(exc) or type(exc).__name__}
            try:
                ctx.emit_to_session(session_id, EVENT, {"reply": reply, **answer})
            except Exception:  # noqa: BLE001 - the session may be gone
                logger.debug("hermes-tern: figure check for %s not delivered", session_id, exc_info=True)

        _executor().submit(contextvars.copy_context().run, run)
        return {"claimed": True}

    ctx.register_rpc(METHOD, check_figures)


def main() -> None:
    try:
        print(json.dumps(check(sys.stdin.read())))
    except Exception as exc:  # noqa: BLE001 - one JSON line, whatever went wrong
        print(json.dumps({"unavailable": str(exc) or type(exc).__name__}))


if __name__ == "__main__":
    main()
