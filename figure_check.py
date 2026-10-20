"""Checks the figures of a finished reply the way Tern will draw them.

The frontend runs it after a turn whose reply has a ```mermaid or ```svg fence
(frontend/src/figures.ts), in Hermes' own interpreter:

    $HERMES_PYTHON figure_check.py < {"figures": [{"lang": "mermaid", "source": "..."}, ...]}

One JSON line answers: ``{"results": [{"ok": true} | {"ok": false, "error": "...", "line": 3}, ...]}``
in the request's order, or ``{"unavailable": "<why>"}`` when mermaid cannot be checked here.

Tern draws mermaid with merman (merman-render 0.8.0 against Mermaid 12.1.0 in Tern 0.9.5), so the
check is merman's own parser. merman is not a dependency of the plugin: it has wheels for macOS
arm64, Linux x86_64 (glibc 2.35+) and Windows only, and a dependency the platform has no wheel for
would fail Hermes' whole dependency sync. Without it here, the script runs itself again through
Hermes' uv with merman pinned, which uv caches after the first run.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

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
    if found := shutil.which("uv"):
        return found
    tools = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    # A profile's home sits under the root's profiles/; PM's tools live beside the root's.
    for home in (tools, *tools.parents):
        for candidate in sorted((home / "tools").glob("uv-*/uv*"), reverse=True):
            if candidate.name in ("uv", "uv.exe"):
                return str(candidate)
    return None


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


def main() -> None:
    try:
        print(json.dumps(check(sys.stdin.read())))
    except Exception as exc:  # noqa: BLE001 - one JSON line, whatever went wrong
        print(json.dumps({"unavailable": str(exc) or type(exc).__name__}))


if __name__ == "__main__":
    main()
