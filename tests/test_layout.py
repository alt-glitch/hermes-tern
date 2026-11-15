"""The Python half's layout (docs/ARCHITECTURE.md): every module lives under ``backend/`` in the
folder of the process that runs it, and a folder imports only what its row below allows.

- ``backend/launch/``: ``hermes tern``, in the user's shell, before and after the frontend.
- ``backend/gateway/``: what Hermes' gateway loads: tools, plugin RPC, prompt sections, session env.
- ``backend/shared/``: reads both sides need (the session database, the plugin data folder, pids).

``launch`` and ``gateway`` never import each other, so a change to one cannot reach the other
process; ``shared`` imports neither.
"""

from __future__ import annotations

import ast
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
ALLOWED = {"launch": {"launch", "shared"}, "gateway": {"gateway", "shared"}, "shared": {"shared"}}


def _modules() -> list[Path]:
    """The plugin's Python files git tracks: a local venv, worktree or scratch folder is not the plugin."""
    tracked = subprocess.run(["git", "ls-files", "-z", "--", "*.py"], cwd=ROOT, capture_output=True, text=True, check=True)
    skip = {"tests", "frontend", "lab"}
    return [ROOT / f for f in tracked.stdout.split("\0") if f and not skip & set(Path(f).parts)]


def _plugin_imports(path: Path) -> set[str]:
    """The ``backend`` folders ``path`` imports from, by its relative imports."""
    package = path.relative_to(ROOT).parent.parts
    found = set()
    for node in ast.walk(ast.parse(path.read_text(), str(path))):
        if isinstance(node, ast.ImportFrom) and node.level:
            base = package[: len(package) - (node.level - 1)]
            target = (*base, *(node.module.split(".") if node.module else ()))
            names = [] if node.module else [a.name for a in node.names]
            for parts in [target] if node.module else [(*target, n) for n in names]:
                if len(parts) >= 2 and parts[0] == "backend":
                    found.add(parts[1])
    return found


def test_every_module_but_the_entry_points_is_under_a_backend_folder():
    entry_points = {ROOT / "__init__.py", BACKEND / "__init__.py"}
    folders = {("backend", f) for f in ALLOWED}
    outside = [str(p.relative_to(ROOT)) for p in _modules()
               if p not in entry_points and p.relative_to(ROOT).parts[:2] not in folders]
    assert outside == []


def test_each_folder_imports_only_what_it_may():
    wrong = {}
    for folder, allowed in ALLOWED.items():
        for path in (BACKEND / folder).glob("*.py"):
            if bad := _plugin_imports(path) - allowed:
                wrong[str(path.relative_to(ROOT))] = sorted(bad)
    assert BACKEND.is_dir() and wrong == {}
