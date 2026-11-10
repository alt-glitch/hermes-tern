"""Glide onboarding: the scripted, deterministic half.

Code does every step whose answer is a fact: is there history to learn from, build the memory, list
what was kept, prove recall finds each kept correction, and (only when asked) turn quoting on. The
judgment calls (which corrections are durable preferences, which look private, what to test with)
belong to the model, through the bundled `glide:onboarding` skill, which drives this module and
never writes memory itself.

Each run is idempotent and leaves a receipt at <profile>/glide/onboarding.json.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

from . import core, source

PROBES = 3
PREVIEW = 20


def _local_sessions(home: Path) -> int | None:
    path = home / "state.db"
    if not path.exists():
        return None
    sources = sorted(source.LOCAL_SOURCES)
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        (count,) = con.execute(
            f"""SELECT COUNT(DISTINCT s.id) FROM sessions s JOIN messages m ON m.session_id = s.id
                WHERE m.role = 'user' AND s.source IN ({",".join("?" for _ in sources)})""",
            sources).fetchone()
    finally:
        con.close()
    return count


def _kept(home: Path) -> list[dict]:
    state = core._state(home) or {}
    return [{"n": i + 1, "text": r.get("text", ""), "session_id": r.get("session_id", "")}
            for i, r in enumerate(state.get("records", []))]


def _probe(home: Path, record: dict) -> dict:
    """Recall a kept correction by its own content words; it must come back among the quoted three."""
    words = [w for w in source.tokens(record["text"]) if w not in core._STOP]
    query = " ".join(words)[:512]
    hits = core.recall(home, query) if query else []
    return {"text": record["text"], "query": query, "ok": any(h["text"] == record["text"] for h in hits)}


def run(home: Path, *, enable: bool = False, limit: int = source.MAX_SESSIONS, exclude: str = "") -> dict:
    steps: list[dict] = []

    def step(sid: str, ok: bool, detail: str, **extra) -> bool:
        steps.append({"id": sid, "ok": ok, "detail": detail, **extra})
        return ok

    sessions = _local_sessions(home)
    ready = step("history", bool(sessions),
                 "no state.db in this profile" if sessions is None else f"{sessions} local sessions with your messages",
                 sessions=sessions or 0)
    kept: list[dict] = []
    if ready:
        built = core.sync(home, limit, exclude)
        kept = _kept(home)
        ready = step("build", built["complete"], f"read {built['scanned']} messages, kept {len(kept)} corrections",
                     corrections=len(kept))
    if ready:
        ready = step("corrections", bool(kept), f"{len(kept)} kept" if kept else
                     "no corrections found yet (\"no, …\", \"actually, …\", \"correction: …\")",
                     preview=kept[:PREVIEW])
    if ready:
        probes = [_probe(home, r) for r in kept[:PROBES]]
        ready = step("recall", all(p["ok"] for p in probes),
                     f"{sum(p['ok'] for p in probes)}/{len(probes)} kept corrections found by their own words", probes=probes)
    if ready and enable:
        core.set_enabled(home, True)
    on = core.enabled(home)
    step("quoting", on, "on: matching corrections are quoted into each turn" if on else
         ("ready: turn it on with /glide on (or hermes glide onboard --enable)" if ready else "off"))

    receipt = {"ok": ready, "on": on, "at": int(time.time()), "steps": steps}
    path = home / "glide" / "onboarding.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(receipt, indent=1))
    os.replace(tmp, path)
    return receipt


def render(receipt: dict) -> str:
    lines = [f"{'✓' if s['ok'] else '·'} {s['id']}: {s['detail']}" for s in receipt["steps"]]
    for s in receipt["steps"]:
        if s["id"] == "corrections" and s.get("preview"):
            lines += ["", "Kept corrections:"] + [f"  {r['n']}. {r['text']}" for r in s["preview"]]
    return "\n".join(lines)


def setup_cli(parser) -> None:
    parser.add_argument("--enable", action="store_true", help="turn quoting on when every check passes")
    parser.add_argument("--json", action="store_true", help="print the receipt as JSON (for the onboarding skill)")
    parser.add_argument("--limit", type=int, default=source.MAX_SESSIONS, help="newest local sessions to read")


def cli(args) -> int:
    receipt = run(core._home(), enable=args.enable, limit=max(1, min(args.limit, source.MAX_SESSIONS)))
    print(json.dumps(receipt, indent=1) if args.json else render(receipt))
    return 0 if receipt["ok"] else 1
