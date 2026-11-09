"""Guided onboarding: code owns the facts (build, kept list, recall self-test, quoting) and leaves a receipt."""

import json
import types

from glide_plugin import core, onboarding

from test_core import home  # noqa: F401  (synthetic profile with two local corrections and one cron line)


def _steps(receipt):
    return {s["id"]: s for s in receipt["steps"]}


def test_onboard_builds_lists_and_self_tests_recall_but_leaves_quoting_off(home):
    receipt = onboarding.run(home)
    steps = _steps(receipt)
    assert receipt["ok"] and not receipt["on"] and not core.enabled(home)
    assert steps["history"]["sessions"] == 2  # the cron session is not the user's local history
    assert steps["build"]["corrections"] == 2
    assert {r["text"] for r in steps["corrections"]["preview"]} == {
        "never push to main without running the tests", "use pnpm for the frontend, not npm"}
    assert [p["ok"] for p in steps["recall"]["probes"]] == [True, True]
    assert "/glide on" in steps["quoting"]["detail"]
    assert json.loads((home / "glide" / "onboarding.json").read_text()) == receipt


def test_enable_turns_quoting_on_only_after_every_check_passes(home):
    assert onboarding.run(home, enable=True)["on"] and core.enabled(home)
    assert onboarding.run(home, enable=True)["ok"]  # idempotent: a rerun rebuilds and stays on


def test_an_empty_profile_stops_at_history_and_never_enables(tmp_path):
    empty = tmp_path / "empty"
    empty.mkdir()
    receipt = onboarding.run(empty, enable=True)
    assert not receipt["ok"] and not receipt["on"]
    assert [s["id"] for s in receipt["steps"]] == ["history", "quoting"]
    assert "no state.db" in receipt["steps"][0]["detail"]


def test_slash_setup_skips_the_session_that_ran_it(home):
    text = core.command("setup", session_id="new")
    assert "✓ build: read" in text and "kept 1 corrections" in text
    assert "never push to main" in text and "pnpm" not in text


def test_cli_prints_json_for_the_skill_and_exits_nonzero_when_not_ready(home, tmp_path, monkeypatch, capsys):
    args = types.SimpleNamespace(enable=False, json=True, limit=10)
    assert onboarding.cli(args) == 0
    assert json.loads(capsys.readouterr().out)["ok"]
    monkeypatch.setattr(core, "_home", lambda: tmp_path / "nowhere")
    (tmp_path / "nowhere").mkdir()
    assert onboarding.cli(args) == 1


def test_register_adds_the_cli_command_and_the_onboarding_skill_when_the_host_supports_them(home):
    clis, skills = [], []
    ctx = types.SimpleNamespace(register_hook=lambda *a: None, register_command=lambda *a, **k: None,
                                register_cli_command=lambda name, *a, **k: clis.append(name),
                                register_skill=lambda name, path, **k: skills.append((name, path.exists())))
    core.register(ctx)
    assert clis == ["glide"] and skills == [("onboarding", True)]
