"""`/glide` backend: detect local intelligence, build opt-in corrections memory, recall it per turn.

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
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from . import source
from .memory import GlideMemory, MemoryNotReady

NAMESPACE = "hermes-tern.glide"
RUNTIMES = ("ollama", "llama-server", "llama-cli", "lms", "vllm", "mlx_lm.server")
_TIMEOUT = 20
# Function words match every correction under plain BM25; the hook queries content words only.
_STOP = frozenset("""a an and are as at be but by can do for from have how i if in is it its me my of on
or please so that the this to us was we what when with you your""".split())


class SessionParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=1)


class SyncParams(SessionParams):
    limit: int = Field(default=source.MAX_SESSIONS, ge=1, le=source.MAX_SESSIONS, strict=True)


class EnableParams(SessionParams):
    on: bool = Field(strict=True)


class RecallParams(SessionParams):
    query: str = Field(min_length=1, max_length=512)


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
    if not exe:
        return {"installed": False, "hint": "pip install git+https://github.com/kvnloo/z0intelligence"}
    raw = _run([exe, "doctor", "--json"])
    try:
        doctor = json.loads(raw or "")
    except ValueError:
        return {"installed": True, "ok": False, "failed": ["doctor did not answer"]}
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


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", pre_llm_call)
    registrar = getattr(ctx, "register_gateway_method", None)
    if not callable(registrar):
        return

    def attached(request, params: dict) -> Path:
        request.assert_attached()
        if params["session_id"] != request.session_id:
            raise PermissionError("not the attached session")
        return _home()

    registrar(f"{NAMESPACE}.detect", lambda r, p: detect(attached(r, p)), schema=SessionParams)
    registrar(f"{NAMESPACE}.sync",
              lambda r, p: sync(attached(r, p), p.get("limit", source.MAX_SESSIONS), p["session_id"]),
              schema=SyncParams)
    registrar(f"{NAMESPACE}.enable", lambda r, p: set_enabled(attached(r, p), p["on"]), schema=EnableParams)
    registrar(f"{NAMESPACE}.recall", lambda r, p: {"hits": recall(attached(r, p), p["query"])},
              schema=RecallParams)
