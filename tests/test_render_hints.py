"""The rendering section reaches only sessions the Tern frontend created, and figure_check.py follows Tern's figure rules."""

from __future__ import annotations

import importlib.util
import json
import threading
from pathlib import Path

import pytest

from hermes_tern_plugin import figure_check, render_hints

ROOT = Path(__file__).resolve().parents[1]


def test_the_section_is_for_sessions_the_tern_frontend_created():
    text = render_hints.section({"session_id": "s1", "client": "hermes-tern", "cwd": "/work/repo"})
    assert "```mermaid" in text and "against /work/repo;" in text
    for client in ("", "desktop", "hermes-tern-other"):
        assert render_hints.section({"session_id": "s1", "client": client, "cwd": "/work/repo"}) == ""
    assert len(render_hints.PROMPT) < 4000


@pytest.fixture(scope="module")
def check():
    spec = importlib.util.spec_from_file_location("figure_check", ROOT / "figure_check.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return lambda *figs: json.loads(json.dumps(module.check(json.dumps({"figures": list(figs)}))))


def svg(source):
    return {"lang": "svg", "source": source}


def test_svg_figures_follow_terns_rules(check):
    ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="3" fill="var(--accent)"/></svg>'
    results = check(svg(ok), svg('<svg width="10"/>'), svg('<svg viewBox="0 0 1 1"><script>x()</script></svg>'),
                    svg('<svg viewBox="0 0 1 1"><rect>'), svg('<!DOCTYPE x [<!ENTITY a "b">]><svg viewBox="0 0 1 1"/>'),
                    svg('<svg viewBox="0 0 1 1"><image href="https://example.com/a.png"/></svg>'))["results"]
    assert [r["ok"] for r in results] == [True, False, False, False, False, False]
    assert "viewBox" in results[1]["error"] and "script" in results[2]["error"]


def test_mermaid_is_checked_by_merman(check):
    pytest.importorskip("merman")
    results = check({"lang": "mermaid", "source": "flowchart LR\n  A[Start --> B\n"},
                    {"lang": "mermaid", "source": "flowchart LR\n  A --> B"},
                    {"lang": "mermaid", "source": "%% infra\narchitecture-beta\n  service api(server)[API]"})["results"]
    assert results[0]["ok"] is False and results[0]["line"] == 2
    assert results[1] == {"ok": True}
    assert results[2]["ok"] is False and "C4Context" in results[2]["error"]


class Ctx:
    def __init__(self):
        self.rpc, self.events, self.done = {}, [], threading.Event()

    def register_rpc(self, name, handler):
        self.rpc[name] = handler

    def emit_to_session(self, session_id, event, payload):
        self.events.append((session_id, event, payload))
        self.done.set()


def test_one_pane_claims_a_reply_and_the_result_reaches_the_session():
    ctx = Ctx()
    figure_check.register(ctx)
    params = {"reply": "r-claim", "figures": [svg('<svg width="10"/>')]}
    assert ctx.rpc["figures.check"](dict(params), session_id="s1") == {"claimed": True}
    assert ctx.rpc["figures.check"](dict(params), session_id="s1") == {"claimed": False}
    assert ctx.done.wait(5)
    ((sid, event, payload),) = ctx.events
    assert (sid, event, payload["reply"]) == ("s1", "figures.checked", "r-claim")
    assert payload["results"][0]["ok"] is False and "viewBox" in payload["results"][0]["error"]


@pytest.mark.parametrize("params, session_id", [
    ({"reply": "r-no-session", "figures": [svg("<svg/>")]}, None),
    ({"figures": [svg("<svg/>")]}, "s1"),
    ({"reply": "r-no-figures", "figures": []}, "s1"),
    ({"reply": "r-html", "figures": [{"lang": "html", "source": "<p/>"}]}, "s1"),
])
def test_bad_params_fail_the_call_and_claim_nothing(params, session_id):
    ctx = Ctx()
    figure_check.register(ctx)
    with pytest.raises(ValueError):
        ctx.rpc["figures.check"](dict(params), session_id=session_id)
    assert ctx.rpc["figures.check"]({"reply": params.get("reply", "r-no-reply"), "figures": [svg("<svg/>")]},
                                    session_id=session_id or "s1") == {"claimed": True}
