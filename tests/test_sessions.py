"""sessions.py and processes.py: the plugin's session reads and its process check. ``hermes_state`` is
a fake module whose database answers from dicts."""

import os
import sys
import types

import pytest

from hermes_tern_plugin import processes, sessions

DEAD = 2**22 + 12345  # no such process


@pytest.fixture()
def db(monkeypatch):
    fake = types.SimpleNamespace(
        rows={"root": {"id": "root"}, "tip": {"id": "tip", "parent_session_id": "root"}},
        lineages={"tip": ["root", "tip"]}, closed=0)
    fake.get_session = fake.rows.get
    fake.get_compression_lineage = lambda sid: fake.lineages.get(sid, [])
    fake.close = lambda: setattr(fake, "closed", fake.closed + 1)
    state = types.ModuleType("hermes_state")
    state.SessionDB = lambda read_only: fake if read_only else pytest.fail("the plugin opened state.db for writing")
    monkeypatch.setitem(sys.modules, "hermes_state", state)
    return fake


def test_lineage_is_root_first_and_a_session_alone_is_its_own(db):
    assert sessions.lineage("tip") == ["root", "tip"]
    assert sessions.lineage("lone") == ["lone"]
    assert sessions.lineage("") == []
    assert db.closed == 2


def test_row_reads_the_stored_session_and_closes_the_database(db):
    assert sessions.row("tip")["parent_session_id"] == "root"
    assert sessions.row("gone") is None
    assert db.closed == 2


def test_without_a_readable_database_reads_answer_as_if_nothing_was_stored(monkeypatch):
    monkeypatch.setitem(sys.modules, "hermes_state", None)  # the import fails
    assert sessions.lineage("tip") == ["tip"]
    assert sessions.row("tip") is None
    assert sessions.delegator("child") == "child"


def test_running_knows_this_process_and_refuses_what_is_no_pid():
    assert processes.running(os.getpid()) and processes.running(str(os.getpid()))
    assert not any(processes.running(pid) for pid in (DEAD, 0, -1, None, "x"))
