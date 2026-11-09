"""/glide gateway: detection, explicit sync, opt-in per-turn recall. Synthetic sessions only."""

import json
import sqlite3
import types

import pytest

from hermes_tern_plugin.glide import gateway

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("_glide_memory_fixtures", Path(__file__).with_name("test_glide_memory.py"))
_fixtures = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fixtures)
make_database = _fixtures.make_database  # The real sessions/messages contract, defined once.


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "hermes"
    db = make_database(home)
    rows = [("old", "cli", 1.0), ("new", "tui", 2.0), ("cron-job", "cron", 3.0)]
    db.executemany("INSERT INTO sessions (id, source, started_at) VALUES (?, ?, ?)", rows)
    for sid, text in [("old", "Correction: never push to main without running the tests"),
                      ("new", "actually, use pnpm for the frontend, not npm"),
                      ("new", "please write the release notes"),
                      ("cron-job", "no, this cron text is not a local correction")]:
        db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, 2.0)",
                   (sid, text))
    db.commit()
    db.close()
    monkeypatch.setattr(gateway, "_home", lambda: home)
    monkeypatch.setattr(gateway, "_run", lambda argv: None)  # no nvidia-smi / z0int on the test host
    monkeypatch.setattr(gateway.shutil, "which", lambda name: None)
    return home


def test_detect_reports_hardware_and_offers_z0int_without_installing(home):
    found = gateway.detect(home)
    assert found["cpus"] >= 1 and found["runtimes"] == [] and found["gpus"] in ([], ["Apple Silicon (unified memory)"])
    assert found["z0int"]["installed"] is False and "pip install" in found["z0int"]["hint"]
    assert found["memory"] == {"sessions": 0, "corrections": 0, "complete": False, "on": False}


def test_sync_reads_only_local_sessions_newest_first_and_skips_the_caller(home):
    assert gateway.recent_sessions(home, 10) == ["new", "old"]
    assert gateway.recent_sessions(home, 10, exclude="new") == ["old"]
    done = gateway.sync(home, 10)
    assert done["corrections"] == 2 and done["complete"] and not done["on"]


def test_hook_is_silent_until_enabled_then_quotes_matching_corrections(home):
    gateway.sync(home, 10)
    ask = "push the branch to main"
    assert gateway.pre_llm_call(user_message=ask) is None
    gateway.set_enabled(home, True)
    injected = gateway.pre_llm_call(user_message=ask)["context"]
    assert "never push to main without running the tests" in injected and "pnpm" not in injected
    assert gateway.pre_llm_call(user_message="the weather") is None
    gateway.set_enabled(home, False)
    assert gateway.pre_llm_call(user_message=ask) is None


def test_recall_refreshes_the_same_scope_after_new_messages(home):
    gateway.sync(home, 10)
    db = sqlite3.connect(home / "state.db")
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) "
               "VALUES ('old', 'user', 'no, always sign commits with the noreply email', 3.0)")
    db.commit()
    db.close()
    assert gateway.recall(home, "sign the commits")[0]["text"].startswith("always sign commits")


def test_gateway_methods_are_namespaced_schema_checked_and_session_bound(home):
    methods, hooks = {}, []
    ctx = types.SimpleNamespace(register_hook=lambda name, fn: hooks.append(name),
                                register_gateway_method=lambda name, fn, schema: methods.__setitem__(name, (fn, schema)))
    gateway.register(ctx)
    assert hooks == ["pre_llm_call"]
    assert sorted(methods) == [f"hermes-tern.glide.{v}" for v in ("detect", "enable", "recall", "sync")]
    assert all(schema.model_config["extra"] == "forbid" for _, schema in methods.values())
    request = types.SimpleNamespace(session_id="live", assert_attached=lambda: None)
    fn, _ = methods["hermes-tern.glide.enable"]
    assert fn(request, {"session_id": "live", "on": True})["on"] is True
    with pytest.raises(PermissionError):
        fn(request, {"session_id": "other", "on": False})
