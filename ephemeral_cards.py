"""Teaches the agent to emit ephemeral-ui cards that ``hermes tern`` draws inline.

The frontend (frontend/src/eui) draws a closed ```` ```ephemeral-ui ```` fence holding one
card.v0 document as a live card from kvnloo/ephemeral-ui, pinned in
frontend/src/vendor/ephemeral-ui/PIN.json. Kinds and their default apps are read from that pin,
so this prompt and the renderer list the same 50 kinds. Other clients show the fence as code.
"""

from __future__ import annotations

import json
from pathlib import Path

VENDOR = Path(__file__).resolve().parent / "frontend" / "src" / "vendor" / "ephemeral-ui"


def kinds() -> dict[str, str]:
    """Each pinned kind and the first catalog app that lists it."""
    try:
        pinned = json.loads((VENDOR / "PIN.json").read_text())["kinds"]
        apps = json.loads((VENDOR / "data" / "apps.json").read_text())
    except (OSError, ValueError, KeyError):
        return {}
    apps = apps["apps"] if isinstance(apps, dict) else apps
    first: dict[str, str] = {}
    for app in apps:
        for kind in app.get("kinds", []):
            first.setdefault(kind, app["id"])
    return {k: first.get(k, "github") for k in pinned}


def prompt() -> str:
    table = kinds()
    if not table:
        return ""
    listing = ", ".join(f"{k}({a})" for k, a in table.items())
    return f"""<ephemeral_ui_cards>
In hermes tern, a fenced block with info string ephemeral-ui holding one JSON object draws a live, clickable card from the ephemeral-ui kit inline in your answer, for example:
```ephemeral-ui
{{"kind": "merge", "app": "github"}}
```
Use one when the user asks for a card, a board, a visual, or a demo of an app flow, or when a card shows the state better than prose (a PR merge, CI run, deploy, inbox, kanban, trace). Required: "kind" (one of the kinds below) and "app" (a lowercase catalog app id such as github, linear, slack, stripe, gmail, figma, notion, vercel, spotify; the default app is in parentheses). Optional: "title". Nothing else in the object is read: the card draws the kit's own synthetic demo content for that kind and app, not your data, so never present a card's numbers or names as real, and keep the real facts in your prose. Put each card in its own fence, at most a few per answer, and write a short sentence around them. Kinds: {listing}.
</ephemeral_ui_cards>"""


def register(ctx) -> None:
    text = prompt()
    if text:
        ctx.register_system_prompt_section("hermes-tern.ephemeral-ui", text)
