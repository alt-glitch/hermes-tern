"""`/glide`: detect local intelligence, build opt-in corrections memory, recall it per turn.

Every z0intelligence call goes through its CLI's JSON output, so z0int stays optional.
Nothing here downloads, installs or uploads. Memory stays under <profile>/glide/.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
from importlib.util import find_spec
from pathlib import Path

from . import source
from .memory import GlideMemory, MemoryNotReady

RUNTIMES = ("ollama", "llama-server", "llama-cli", "lms", "vllm", "mlx_lm.server")
_TIMEOUT = 20
# Function words match every correction under plain BM25; the hook queries content words only.
_STOP = frozenset("""a an and are as at be but by can do for from have how i if in is it its me my of on
or please so that the this to us was we what when with you your""".split())


def _home() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home())


def _flag(home: Path) -> Path:
    return home / "glide" / "enabled.json"


def enabled(home: Path | None = None) -> bool:
    try:
        return json.loads(_flag(home or _home()).read_text()).get("on") is True
    except (OSError, ValueError, AttributeError):
        return False


def _run(argv: list[str]) -> str | None:
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=_TIMEOUT, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def _ram_gib() -> float | None:
    try:
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30, 1)
    except (ValueError, OSError, AttributeError):
        out = _run(["sysctl", "-n", "hw.memsize"])  # macOS
        return round(int(out) / 2**30, 1) if out and out.strip().isdigit() else None


def _gpus() -> list[str]:
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
    if out:
        return [f"{name.strip()} ({int(mib) // 1024} GiB)" for name, mib in
                (line.rsplit(",", 1) for line in out.strip().splitlines() if "," in line)]
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        return ["Apple Silicon (unified memory)"]
    return []


def _z0int() -> dict:
    exe = shutil.which("z0int")
    argv = [exe] if exe else [sys.executable, "-m", "z0int"] if find_spec("z0int") else None
    if not argv:
        return {"installed": False, "hint": "pip install git+https://github.com/kvnloo/z0intelligence"}
    raw = _run([*argv, "doctor", "--json"])
    try:
        doctor = json.loads(raw or "")
    except ValueError:
        return {"installed": True, "ok": False, "failed": [], "unchecked": True}
    failed = [c["id"] for c in doctor.get("checks", []) if c.get("required") and not c.get("ok")]
    return {"installed": True, "ok": bool(doctor.get("ok")), "failed": failed}


def recent_sessions(home: Path, limit: int, exclude: str = "") -> list[str]:
    """Newest local sessions, one tip per compression lineage (children replace parents)."""
    path = home / "state.db"
    if not path.exists():
        return []
    sources = sorted(source.LOCAL_SOURCES)
    marks = ",".join("?" for _ in sources)
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        rows = con.execute(
            f"""SELECT s.id FROM sessions s
                WHERE s.source IN ({marks}) AND s.id != ?
                  AND NOT EXISTS (SELECT 1 FROM sessions c WHERE c.parent_session_id = s.id)
                  AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'user')
                ORDER BY s.started_at DESC LIMIT ?""", (*sources, exclude, limit)).fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]


def _state(home: Path) -> dict | None:
    memory = GlideMemory(home)
    if not memory.state_path.exists():
        return None
    with memory._store.locked():  # Same package: the store's own validated, locked read.
        state, _recovered = memory._store.load()
    return state


def status(home: Path) -> dict:
    state = _state(home) or {}
    return {"sessions": len(state.get("sessions", [])), "corrections": len(state.get("records", [])),
            "complete": bool(state.get("complete")), "on": enabled(home)}


def detect(home: Path) -> dict:
    return {
        "os": f"{platform.system()} {platform.machine()}",
        "cpus": os.cpu_count() or 0,
        "ram_gib": _ram_gib(),
        "gpus": _gpus(),
        "runtimes": [name for name in RUNTIMES if shutil.which(name)],
        "z0int": _z0int(),
        "memory": status(home),
    }


def sync(home: Path, limit: int, exclude: str = "") -> dict:
    ids = recent_sessions(home, limit, exclude)
    if not ids:
        return {**status(home), "scanned": 0}
    result = GlideMemory(home).sync(ids)
    return {**status(home), "scanned": result.scanned}


def set_enabled(home: Path, on: bool) -> dict:
    flag = _flag(home)
    flag.parent.mkdir(parents=True, exist_ok=True)
    tmp = flag.with_suffix(".tmp")
    tmp.write_text(json.dumps({"on": on}))
    os.replace(tmp, flag)
    return status(home)


def recall(home: Path, query: str) -> list[dict]:
    memory = GlideMemory(home)
    try:
        hits = memory.search(query)
    except MemoryNotReady:
        state = _state(home)
        if not state:
            raise
        memory.sync(state["sessions"])  # Sessions grew since the last sync; refresh the same scope.
        hits = memory.search(query)
    return [{"text": h.text, "session_id": h.session_id, "score": round(h.score, 2)} for h in hits]


def pre_llm_call(user_message=None, **_kwargs):
    """Opt-in: quote the user's top three matching past corrections into this turn."""
    home = _home()
    if not enabled(home) or not isinstance(user_message, str) or not user_message.strip():
        return None
    try:
        words = [w for w in source.tokens(user_message) if w not in _STOP]
        query = " ".join(words)[: source.MAX_CORRECTION_CHARS // 2]
        hits = recall(home, query) if query.strip() else []
    except Exception:  # noqa: BLE001 - memory is advisory; a turn never fails on it.
        return None
    if not hits:
        return None
    lines = "\n".join(f"- {h['text']}" for h in hits)
    return {"context": "Your past corrections that match this request (quoted history; "
                       f"current instructions take precedence):\n{lines}"}


USAGE = """/glide            show this machine and your memory
/glide build      read your last 100 local sessions and keep the corrections you gave
/glide on | off   quote up to three matching corrections into each turn
/glide recall <words>   show what would be quoted
/glide setup      guided first run: build, show what was kept, self-test recall"""


def _rows(m: dict) -> str:
    return (f"Sessions read: {m['sessions']} · corrections kept: {m['corrections']} · "
            f"quoted into turns: {'on' if m['on'] else 'off'}")


def command(raw_args: str = "", session_id: str | None = None) -> str:
    """The `/glide` slash command, for every Hermes frontend (CLI, TUI, desktop, gateway)."""
    home = _home()
    verb, _, rest = (raw_args or "").strip().partition(" ")
    verb = verb.lower()
    if verb in ("help", "-h", "--help"):
        return USAGE
    if verb == "build":
        m = sync(home, source.MAX_SESSIONS, session_id or "")
        return f"Memory up to date ({m['scanned']} new messages read). {_rows(m)}" + (
            "" if m["on"] else "\nTurn it on with /glide on.")
    if verb in ("on", "off"):
        m = status(home)
        if verb == "on" and not m["complete"]:
            return "Build your memory first: /glide build"
        return f"Glide memory is {verb}. {_rows(set_enabled(home, verb == 'on'))}"
    if verb == "setup":
        from . import onboarding

        return onboarding.render(onboarding.run(home, exclude=session_id or ""))
    if verb == "recall":
        if not rest.strip():
            return "Usage: /glide recall <words>"
        try:
            hits = recall(home, rest.strip()[:512])
        except MemoryNotReady:
            return "Build your memory first: /glide build"
        return "\n".join(f"- ({h['score']}) {h['text']}" for h in hits) or "No matching correction."
    if verb:
        return USAGE
    found = detect(home)
    z0 = found["z0int"]
    if not z0["installed"]:
        z0_line = f"optional, not installed ({z0['hint']})"
    elif z0.get("unchecked"):
        z0_line = "installed (run `z0int doctor` for details)"
    else:
        z0_line = "ready" if z0.get("ok") else "needs " + ", ".join(z0.get("failed") or ["attention"])
    ram = "unknown" if found["ram_gib"] is None else f"{found['ram_gib']} GiB"
    return "\n".join([
        f"This machine: {found['os']}, {found['cpus']} CPU threads, {ram} RAM",
        f"GPU: {', '.join(found['gpus']) or 'none found'}",
        f"Local runtimes: {', '.join(found['runtimes']) or 'none on PATH'}",
        f"z0intelligence: {z0_line}",
        _rows(found["memory"]),
        "",
        USAGE,
    ])


def _setup_cli(parser) -> None:
    from . import onboarding

    sub = parser.add_subparsers(dest="glide_command", required=True)
    onboarding.setup_cli(sub.add_parser("onboard", help="build, review and self-test the memory"))


def _cli(args) -> int:
    from . import onboarding

    return onboarding.cli(args)


def register(ctx) -> None:
    from . import gateway, onboarding

    ctx.register_hook("pre_llm_call", pre_llm_call)
    if callable(getattr(ctx, "register_cli_command", None)):  # `hermes glide onboard`
        ctx.register_cli_command("glide", "Glide corrections memory", _setup_cli, _cli,
                                 description="Glide: guided onboarding for the corrections memory")
    if callable(getattr(ctx, "register_skill", None)):  # The model's half of onboarding.
        ctx.register_skill("onboarding", Path(__file__).with_name("skills") / "onboarding" / "SKILL.md",
                           description="Use when the user installs or sets up Glide, or asks what it remembers.")
    gateway.register(ctx)  # Card-drawing frontends (Tern); a no-op on cores without gateway methods.
    ctx.register_command("glide", command, description="Local corrections memory: build, on, off, recall",
                         args_hint="[build|on|off|recall <words>]")
