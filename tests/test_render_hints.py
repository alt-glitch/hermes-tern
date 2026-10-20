"""The rendering section reaches only sessions a Tern pane shows, and figure_check.py follows Tern's figure rules."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from hermes_tern_plugin import render_hints

ROOT = Path(__file__).resolve().parents[1]


def test_the_section_is_for_sessions_a_tern_pane_shows(monkeypatch):
    monkeypatch.setattr(render_hints.tern_env, "viewer", lambda sid: {"pid": 1} if sid == "shown" else None)
    text = render_hints.section({"session_id": "shown", "cwd": "/work/repo"})
    assert "```mermaid" in text and "against /work/repo;" in text
    assert render_hints.section({"session_id": "elsewhere", "cwd": "/work/repo"}) == ""
    assert len(render_hints.PROMPT) < 4000


def test_the_skill_ships_with_the_plugin():
    assert render_hints.SKILL.is_file()
    assert render_hints.SKILL.read_text().startswith("---\nname: tern-rendering\n")


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
