#!/usr/bin/env python3
"""Reject removed Hermes integrations after the gateway-only upstream sync."""
from __future__ import annotations

import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REMOVED = (
    "connections.py", "widget_author.py", "frontend/src/wire/sqlite.ts",
    "frontend/src/hermes/paths.ts", "frontend/src/hermes/sessionIndex.ts",
    "frontend/src/hermes/activeSessionFile.ts", "frontend/src/hermes/create.ts",
    "frontend/src/watch/child.ts", "frontend/src/agents/liveLog.ts",
)
OLD_IMPORT = re.compile(
    r"(?:from\s*|import\s*\()['\"](?:@tui/|node:sqlite|[^'\"]*(?:hermes/(?:paths|sessionIndex|activeSessionFile|create)|wire/sqlite|watch/child|agents/liveLog)\.js)"
)
OLD_STATE = re.compile(r"\bisCanonical\b|HERMES_TUI_DIR|HERMES_PYTHON_SRC_ROOT")


def check() -> list[str]:
    problems = [f"removed integration restored: {path}" for path in REMOVED if (ROOT / path).exists()]
    for path in (ROOT / "frontend/src").rglob("*"):
        if path.suffix not in {".ts", ".tsx"} or "vendor" in path.parts:
            continue
        text = path.read_text()
        for number, line in enumerate(text.splitlines(), 1):
            if line.startswith(("<<<<<<< ", ">>>>>>> ", "||||||| ")):
                problems.append(f"{path.relative_to(ROOT)}:{number}: merge marker")
            if OLD_IMPORT.search(line) or ("__tests__" not in path.parts and OLD_STATE.search(line)):
                problems.append(f"{path.relative_to(ROOT)}:{number}: removed Hermes integration")
    for path in ROOT.glob("*.py"):
        names: set[str] = set()
        for node in ast.parse(path.read_text(), filename=str(path)).body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if node.name in names:
                    problems.append(f"{path.name}:{node.lineno}: duplicate definition {node.name}")
                names.add(node.name)
    return problems


if __name__ == "__main__":
    errors = check()
    print("\n".join(errors) if errors else "upstream sync: gateway-only integrations; no removed readers or duplicate Python definitions")
    raise SystemExit(bool(errors))
