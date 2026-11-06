"""Synthetic workflow-only fixtures for the real Hermes sessions/messages contract.

Column names/types below come from hermes_state_common.py at runtime pin
22063fc099ec9ad8357d7f8f6e6248a0400680d3. SQLite is real; no model or service is used.
"""

import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import types

import pytest

from hermes_tern_plugin.glide import GlideMemory, MemoryNotReady, SourceError, StateVersionError
from hermes_tern_plugin.glide import memory, source, storage

SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, model_config TEXT,
    parent_session_id TEXT, started_at REAL NOT NULL, end_reason TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT, timestamp REAL NOT NULL,
    _compressed_summary INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, compacted INTEGER NOT NULL DEFAULT 0,
    display_kind TEXT, display_metadata TEXT
);
CREATE INDEX idx_messages_session_id ON messages(session_id, id);
"""


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Glide memory must remain local.")
    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(socket, "getaddrinfo", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)


def make_database(home):
    home.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(home / "state.db")
    db.executescript(SCHEMA)
    return db


@pytest.fixture
def world(tmp_path):
    # '#' and spaces catch hand-built, unquoted SQLite URI regressions.
    home = tmp_path / "profile # memory"
    db = make_database(home)

    def session(sid="owner", *, source="cli", hidden=0, parent=None, config=None, end_reason=None):
        if isinstance(config, dict):
            config = json.dumps(config)
        db.execute("INSERT INTO sessions (id, source, hidden, parent_session_id, model_config, "
                   "started_at, end_reason) VALUES (?, ?, ?, ?, ?, 1.0, ?)",
                   (sid, source, hidden, parent, config, end_reason))
        db.commit()

    def message(text, sid="owner", **changes):
        if isinstance(text, (list, dict)):
            text = "\x00json:" + json.dumps(text)
        values = {"session_id": sid, "role": "user", "content": text, "timestamp": 2.0,
                  "active": 1, "compacted": 0, "_compressed_summary": 0,
                  "display_kind": None, "display_metadata": None, **changes}
        cursor = db.execute(
            f"INSERT INTO messages ({','.join(values)}) VALUES ({','.join('?' for _ in values)})",
            tuple(values.values()))
        db.commit()
        return cursor.lastrowid

    session()
    yield types.SimpleNamespace(home=home, db=db, session=session, message=message,
                                memory=GlideMemory(home))
    db.close()


def payload(world):
    return json.loads(world.memory.state_path.read_text(encoding="utf-8"))["state"]


def reseal(path, state):
    canonical = lambda value: json.dumps(value, ensure_ascii=False, sort_keys=True,
                                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    path.write_bytes(canonical({"sha256": hashlib.sha256(canonical(state)).hexdigest(), "state": state}))


def test_selected_real_schema_and_structured_text(world):
    first = world.message("Correction: Keep changes on feature branches.")
    world.message([{"type": "image_url", "image_url": {"url": "https://example.invalid/image"}},
                   {"type": "text", "text": "Actually, run parser checks before review."}])
    world.message({"type": "text", "text": "No, keep the review draft until checks finish."},
                  display_kind="steer")
    world.session("unselected")
    world.message("Correction: Upload the transcript.", sid="unselected")
    result = world.memory.sync(["owner"])
    assert result.complete and result.corrections == 3
    hit = world.memory.search("branches")[0]
    assert (hit.message_id, hit.session_id, hit.text) == (first, "owner", "Keep changes on feature branches.")
    assert world.memory.search("parser")[0].text == "run parser checks before review."
    assert world.memory.search("draft")[0].text == "keep the review draft until checks finish."
    assert world.memory.search("upload") == []


@pytest.mark.parametrize("session_options,message_options", [
    ({}, {"role": "assistant"}), ({}, {"role": "system"}), ({}, {"role": "tool"}),
    ({}, {"active": 0}), ({}, {"_compressed_summary": 1}),
    ({}, {"display_kind": "hidden"}), ({}, {"display_kind": "internal_notification"}),
    ({}, {"display_kind": "model_switch"}), ({}, {"display_kind": "process_complete"}),
    ({}, {"display_kind": "async_delegation_complete"}),
    ({}, {"display_metadata": '{"model_only":true}'}),
    ({}, {"display_metadata": '{"_queued_prompt":true}'}),
    ({}, {"display_metadata": json.dumps(json.dumps({"model_only": True}))}),
    ({}, {"display_metadata": "{broken"}), ({}, {"display_metadata": "[]"}),
    ({}, {"display_metadata": "x" * (source.MAX_METADATA_BYTES + 1)}),
    ({"source": "tool"}, {}), ({"source": "cron"}, {}), ({"source": "telegram"}, {}),
    ({"hidden": 1}, {}), ({"parent": "owner", "config": {"_delegate_from": "owner"}}, {}),
    ({"parent": "owner"}, {}), ({"config": "{broken"}, {}),
])
def test_non_owner_and_synthetic_rows_are_excluded(world, session_options, message_options):
    world.message("Correction: Keep portable checks.")
    world.session("excluded", **session_options)
    world.message("Correction: Use forbidden workflow.", sid="excluded", **message_options)
    world.memory.sync(["owner", "excluded"])
    assert world.memory.search("forbidden") == []
    assert len(world.memory.search("portable")) == 1


def test_compaction_copies_deduplicate_and_preserve_historical_user_rows(world):
    world.db.execute("UPDATE sessions SET end_reason='compression' WHERE id='owner'")
    world.db.commit()
    world.session("continued", parent="owner")
    world.message("Correction: Keep checks offline.", active=0, compacted=1)
    clone = world.message("Correction: Keep checks offline.", sid="continued")
    result = world.memory.sync(["continued", "owner"], batch_size=1)
    hits = world.memory.search("offline")
    assert result.corrections == 1 and len(hits) == 1
    assert (hits[0].session_id, hits[0].message_id) == ("continued", clone)


def test_malformed_literal_encoded_and_oversized_content_is_ignored(world):
    for value in (
        "\x00json:{broken",
        "\x00json:" + json.dumps("\x00json:" + json.dumps({"type": "text", "text": "Correction: Smuggled rule."})),
        json.dumps({"type": "text", "text": "Correction: Literal JSON is not a rule."}),
        b"\xffCorrection: Invalid encoding.",
        "Correction: " + "x" * source.MAX_CONTENT_BYTES,
        "Correction: " + "portable " * 130 + "except production",
        [{"type": "image_url", "image_url": {"url": "Correction: Image fields are not rules."}}],
        "> Correction: Quoted material is not a rule.",
    ):
        world.message(value)
    result = world.memory.sync(["owner"])
    assert result.complete and result.corrections == 0
    assert world.memory.search("correction") == []


def test_scope_is_explicit_and_replacing_it_removes_old_corrections(world):
    world.message("Correction: Use pytest for parser checks.")
    world.session("selected")
    world.message("Correction: Keep packaging review separate.", sid="selected")
    for invalid in ([], "owner", [""], ["owner "]):
        with pytest.raises(ValueError):
            world.memory.sync(invalid)
    world.memory.sync(["owner"])
    world.memory.sync(["selected"])
    assert world.memory.search("pytest") == []
    assert world.memory.search("packaging")[0].session_id == "selected"
    assert payload(world)["sessions"] == ["selected"]


def test_resume_uses_committed_cursor_without_duplicates(world):
    ids = [world.message(f"Correction: {rule}") for rule in (
        "Keep branch reviews small.", "Keep parser reviews focused.", "Keep release reviews explicit.")]
    world.message("An ordinary request is not a correction.")
    first = world.memory.sync(["owner"], batch_size=1, max_batches=1)
    assert (first.scanned, first.cursor, first.complete) == (1, ids[0], False)
    with pytest.raises(MemoryNotReady):
        world.memory.search("reviews")
    resumed = GlideMemory(world.home)
    second = resumed.sync(["owner"], batch_size=1, max_batches=1)
    assert (second.scanned, second.cursor, second.complete) == (1, ids[1], False)
    final = GlideMemory(world.home).sync(["owner"], batch_size=1)
    assert (final.scanned, final.corrections, final.complete) == (2, 3, True)
    assert len(resumed.search("reviews")) == 3
    assert resumed.sync(["owner"]).scanned == 0


def test_partial_scan_restarts_when_an_old_row_changes(world):
    first = world.message("Correction: Use obsolete parser flags.")
    world.message("Correction: Keep branch checks local.")
    world.memory.sync(["owner"], batch_size=1, max_batches=1)
    world.db.execute("UPDATE messages SET content=? WHERE id=?",
                     ("Correction: Use current parser flags.", first))
    world.db.commit()
    resumed = world.memory.sync(["owner"], batch_size=1, max_batches=1)
    assert resumed.scanned == 1 and resumed.cursor == first and not resumed.complete
    world.memory.sync(["owner"])
    assert world.memory.search("obsolete") == []
    assert world.memory.search("current")[0].message_id == first


@pytest.mark.parametrize("mutation", [
    "UPDATE messages SET content='Correction: Use current parser flags.'",
    "UPDATE messages SET active=0",
    "UPDATE messages SET role='assistant'",
    "DELETE FROM messages",
    "UPDATE sessions SET hidden=1",
    "UPDATE sessions SET source='tool'",
    """UPDATE sessions SET model_config='{"_delegate_from":"worker"}'""",
    "UPDATE messages SET display_metadata='{\"model_only\":true}'",
])
def test_old_edits_deactivation_deletion_and_session_changes_invalidate_memory(world, mutation):
    world.message("Correction: Use obsolete parser flags.")
    world.memory.sync(["owner"])
    world.db.execute(mutation)
    world.db.commit()
    with pytest.raises(MemoryNotReady):
        world.memory.search("obsolete")
    world.memory.sync(["owner"])
    assert world.memory.search("obsolete") == []


def test_editing_an_old_noncorrection_is_discovered(world):
    mid = world.message("Please inspect the parser.")
    world.memory.sync(["owner"])
    world.db.execute("UPDATE messages SET content=? WHERE id=?",
                     ("Correction: Keep parser fixtures deterministic.", mid))
    world.db.commit()
    with pytest.raises(MemoryNotReady):
        world.memory.search("fixtures")
    world.memory.sync(["owner"])
    assert world.memory.search("fixtures")[0].message_id == mid


def test_replaced_source_database_does_not_reuse_an_old_cursor(world, tmp_path):
    world.message("Correction: Use obsolete parser flags.", id=100)
    world.memory.sync(["owner"])
    world.db.close()
    replacement = tmp_path / "replacement"
    db = make_database(replacement)
    db.execute("INSERT INTO sessions (id, source, started_at) VALUES ('owner', 'cli', 1.0)")
    db.execute("INSERT INTO messages (session_id, role, content, timestamp) "
               "VALUES ('owner', 'user', 'Correction: Keep current parser checks.', 2.0)")
    db.commit()
    db.close()
    os.replace(replacement / "state.db", world.home / "state.db")
    with pytest.raises(MemoryNotReady):
        world.memory.search("parser")
    result = world.memory.sync(["owner"])
    assert result.cursor == 1 and result.corrections == 1
    assert world.memory.search("obsolete") == []
    assert world.memory.search("current")[0].message_id == 1


def test_interrupted_atomic_replace_keeps_last_committed_batch(world, monkeypatch):
    for rule in ("Keep branch checks local.", "Keep parser checks local.", "Keep release checks local."):
        world.message("Correction: " + rule)
    world.memory.sync(["owner"], batch_size=1, max_batches=1)
    original = world.memory.state_path.read_bytes()
    real_replace = storage.os.replace

    def interrupted(src, dst):
        if Path(dst) == world.memory.state_path:
            raise OSError("simulated interruption before checkpoint publication")
        return real_replace(src, dst)

    with monkeypatch.context() as patch:
        patch.setattr(storage.os, "replace", interrupted)
        with pytest.raises(OSError):
            world.memory.sync(["owner"], batch_size=1, max_batches=1)
    assert world.memory.state_path.read_bytes() == original
    assert list(world.memory.state_path.parent.glob(".memory-*.tmp")) == []
    result = GlideMemory(world.home).sync(["owner"], batch_size=1)
    assert result.scanned == 2 and result.corrections == 3 and result.complete


def test_corrupt_primary_recovers_from_backup_and_repairs_it(world):
    world.message("Correction: Keep parser checks local.")
    world.message("Correction: Keep release checks local.")
    world.memory.sync(["owner"], batch_size=1, max_batches=1)
    world.memory.sync(["owner"], batch_size=1)
    world.memory.state_path.write_text("{broken", encoding="utf-8")
    with pytest.raises(MemoryNotReady):
        world.memory.search("checks")  # The backup contains only the first batch.
    result = GlideMemory(world.home).sync(["owner"], batch_size=1)
    assert result.recovered and result.scanned == 1 and result.complete
    assert len(world.memory.search("checks")) == 2


def test_both_corrupt_checkpoints_rebuild_without_false_readiness(world):
    world.message("Correction: Keep parser checks local.")
    world.memory.sync(["owner"])
    world.memory.state_path.write_text("{broken", encoding="utf-8")
    world.memory.state_path.with_name("memory.json.bak").write_text("[]", encoding="utf-8")
    with pytest.raises(MemoryNotReady):
        world.memory.search("parser")
    result = world.memory.sync(["owner"])
    assert result.recovered and result.scanned == 1 and result.complete
    assert len(world.memory.search("parser")) == 1


def test_checksum_mismatch_cannot_add_a_correction(world):
    world.message("Correction: Keep parser checks local.")
    world.memory.sync(["owner"])
    envelope = json.loads(world.memory.state_path.read_text(encoding="utf-8"))
    envelope["state"]["records"][0]["text"] = "Publish every unreviewed branch."
    world.memory.state_path.write_text(json.dumps(envelope), encoding="utf-8")
    with pytest.raises(MemoryNotReady):
        world.memory.search("publish")
    assert world.memory.sync(["owner"]).recovered
    assert world.memory.search("publish") == []
    assert len(world.memory.search("local")) == 1


@pytest.mark.parametrize("field,value", [
    ("cursor", True), ("complete", "yes"), ("records", {}), ("sessions", []),
])
def test_invalid_checkpoint_shape_is_rebuilt_even_with_a_matching_checksum(world, field, value):
    world.message("Correction: Keep parser checks local.")
    world.memory.sync(["owner"])
    state = payload(world)
    state[field] = value
    reseal(world.memory.state_path, state)
    with pytest.raises(MemoryNotReady):
        world.memory.search("parser")
    assert world.memory.sync(["owner"]).recovered
    assert len(world.memory.search("parser")) == 1


def test_future_checkpoint_version_is_preserved(world):
    world.message("Correction: Keep parser checks local.")
    world.memory.sync(["owner"])
    state = payload(world)
    state["version"] = 2
    reseal(world.memory.state_path, state)
    before = world.memory.state_path.read_bytes()
    with pytest.raises(StateVersionError):
        world.memory.sync(["owner"])
    with pytest.raises(StateVersionError):
        world.memory.search("parser")
    assert world.memory.state_path.read_bytes() == before


def test_empty_corpus_is_complete_and_empty_queries_return_nothing(world):
    result = world.memory.sync(["owner"])
    assert result.complete and result.cursor == 0 and result.corrections == 0
    assert world.memory.search("parser") == []
    assert world.memory.search("") == []
    assert world.memory.search("!!!") == []
    assert world.memory.context("parser") == ""


def test_bm25_frequency_length_ties_and_top_three(world):
    for rule in ("deploy", "deploy deploy", "deploy alpha beta gamma delta epsilon zeta eta theta",
                 "deploy alpha", "deploy beta", "testing"):
        world.message("Correction: " + rule)
    world.memory.sync(["owner"])
    hits = world.memory.search("deploy")
    assert [hit.text for hit in hits] == ["deploy deploy", "deploy", "deploy alpha"]
    assert hits[0].score > hits[1].score > hits[2].score > 0
    assert world.memory.search("DEPLOY deploy") == hits
    assert [hit.text for hit in world.memory.search("theta")] == [
        "deploy alpha beta gamma delta epsilon zeta eta theta"]
    assert GlideMemory(world.home).search("deploy") == hits
    assert world.memory.search("unrelated") == []


def test_context_budget_counts_framing_and_whole_quoted_entries(world):
    rules = ['Keep "draft" review labels.', "Keep draft branches small.", "Keep draft checks local."]
    for rule in rules:
        world.message("Correction: " + rule)
    world.memory.sync(["owner"])
    context = world.memory.context("draft", max_chars=source.MAX_CORRECTION_CHARS)
    lines = context.splitlines()
    assert len(lines) == 4
    assert {json.loads(line)["correction"] for line in lines[1:]} == set(rules)
    shorter = world.memory.context("draft", max_chars=len(context) - 1)
    assert len(shorter) < len(context) and len(shorter.splitlines()) == 3
    assert world.memory.context("draft", max_chars=10) == ""
    assert world.memory.context("draft", max_chars=0) == ""
    for bad in (-1, memory.MAX_CONTEXT_CHARS + 1, True):
        with pytest.raises(ValueError):
            world.memory.context("draft", max_chars=bad)
    with pytest.raises(ValueError):
        world.memory.search("x" * (memory.MAX_QUERY_CHARS + 1))
    with pytest.raises(ValueError):
        world.memory.sync(["owner"], batch_size=0)
    with pytest.raises(ValueError):
        world.memory.sync(["owner"], max_batches=True)


def test_profile_helper_overrides_environment_and_instances_stay_isolated(world, tmp_path, monkeypatch):
    world.message("Correction: Keep parser checks local.")
    other_home = tmp_path / "another-profile"
    db = make_database(other_home)
    db.execute("INSERT INTO sessions (id, source, started_at) VALUES ('owner', 'cli', 1.0)")
    db.commit()
    db.close()
    helper = types.SimpleNamespace(get_hermes_home=lambda: world.home)
    monkeypatch.setitem(sys.modules, "hermes_constants", helper)
    monkeypatch.setenv("HERMES_HOME", str(other_home))
    first = GlideMemory()
    assert first.state_path == world.home / "glide" / "memory.json"
    assert not first.state_path.exists()  # Construction has no filesystem side effects.
    first.sync(["owner"])
    helper.get_hermes_home = lambda: other_home
    second = GlideMemory()
    second.sync(["owner"])
    assert second.search("parser") == []
    assert len(first.search("parser")) == 1
    assert second.state_path.parent == other_home / "glide"


def test_missing_or_incompatible_source_never_creates_or_repairs_state_db(tmp_path):
    home = tmp_path / "missing"
    instance = GlideMemory(home)
    with pytest.raises(SourceError):
        instance.sync(["owner"])
    assert not (home / "state.db").exists()
    assert not instance.state_path.exists()
    db = sqlite3.connect(home / "state.db")
    db.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY)")
    db.commit()
    db.close()
    before = (home / "state.db").read_bytes()
    with pytest.raises(SourceError):
        instance.sync(["owner"])
    assert (home / "state.db").read_bytes() == before
    assert not instance.state_path.exists()


def test_read_only_source_sees_live_wal_rows_and_rejects_writes(world):
    assert world.db.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
    world.message("Correction: Keep parser checks local.")
    before = (world.home / "state.db").read_bytes()
    wal_before = (world.home / "state.db-wal").read_bytes()
    with source.snapshot(world.home / "state.db", ("owner",)) as view:
        with pytest.raises(sqlite3.OperationalError):
            view.connection.execute("DELETE FROM messages")
    world.memory.sync(["owner"])
    assert len(world.memory.search("parser")) == 1
    assert (world.home / "state.db").read_bytes() == before
    assert (world.home / "state.db-wal").read_bytes() == wal_before


def test_retention_limit_is_reported_and_keeps_newest_unique_corrections(world, monkeypatch):
    monkeypatch.setattr(storage, "MAX_CORRECTIONS", 2)
    monkeypatch.setattr(memory, "MAX_CORRECTIONS", 2)
    for rule in ("Keep obsolete checks.", "Keep parser checks.", "Keep release checks."):
        world.message("Correction: " + rule)
    result = world.memory.sync(["owner"], batch_size=1)
    assert result.limited and result.corrections == 2
    assert world.memory.search("obsolete") == []
    assert {hit.text for hit in world.memory.search("checks")} == {
        "Keep parser checks.", "Keep release checks."}


def test_sync_search_and_context_need_no_network_or_subprocess(world):
    world.message("Correction: Keep parser checks local.")
    assert world.memory.sync(["owner"]).complete
    assert len(world.memory.search("parser")) == 1
    assert "Keep parser checks local." in world.memory.context("parser")
