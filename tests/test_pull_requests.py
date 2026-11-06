"""pull_requests.py without Hermes: tools.registry is stubbed, storage goes to a temp dir."""

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture()
def prs(tmp_path, monkeypatch):
    registry = types.ModuleType("tools.registry")
    registry.tool_error = lambda message, **extra: json.dumps({"error": message, **extra})
    registry.tool_result = lambda data=None, **kw: json.dumps(data if data is not None else kw)
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.registry", registry)

    spec = importlib.util.spec_from_file_location("tern_pull_requests", ROOT / "pull_requests.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    lineages = {"tip": ["root", "tip"]}
    monkeypatch.setattr(module, "data_file", lambda: tmp_path / "pull-requests.json")
    monkeypatch.setattr(module, "_lineage", lambda sid: lineages.get(sid, [sid]))
    monkeypatch.setattr(module, "_cwd", lambda: "/work")
    module.lineages = lineages
    return module


def test_parse_target_reads_urls_and_repository_number(prs):
    assert prs.parse_target({"url": "https://github.com/Acme/App/pull/12/files"}) == {
        "host": "github.com", "repository": "acme/app", "number": 12, "url": "https://github.com/acme/app/pull/12"}
    assert prs.parse_target({"repository": "acme/app", "number": 3})["url"] == "https://github.com/acme/app/pull/3"
    for bad in ({"url": "https://gitlab.com/a/b/-/merge_requests/1"}, {"url": "https://github.com/a/b/issues/1"},
                {"repository": "nope", "number": 1}, {"repository": "a/b", "number": 0}, {}):
        with pytest.raises(prs.TargetError):
            prs.parse_target(bad)


def test_link_is_idempotent_and_lists_the_conversation(prs):
    first = json.loads(prs.link_pull_request({"url": "https://github.com/a/b/pull/1"}, session_id="s1"))
    again = json.loads(prs.link_pull_request({"repository": "a/b", "number": 1}, session_id="s1"))
    second = json.loads(prs.link_pull_request({"url": "https://github.com/a/b/pull/2"}, session_id="s1"))

    assert (first["already_linked"], again["already_linked"]) == (False, True)
    assert [p["number"] for p in second["linked"]] == [1, 2]
    assert [p["number"] for p in json.loads(prs.list_pull_requests({}, session_id="s1"))["linked"]] == [1, 2]
    assert json.loads(prs.list_pull_requests({}, session_id="other"))["linked"] == []

    stored = json.loads(prs.data_file().read_text())["conversations"]["s1"][0]
    assert (stored["session_id"], stored["cwd"]) == ("s1", "/work")


def test_links_survive_compression(prs):
    prs.link_pull_request({"url": "https://github.com/a/b/pull/1"}, session_id="root")
    # Compression continued `root` as `tip`: same conversation, new id.
    linked = json.loads(prs.link_pull_request({"url": "https://github.com/a/b/pull/2"}, session_id="tip"))["linked"]

    assert [p["number"] for p in linked] == [1, 2]
    assert json.loads(prs.data_file().read_text())["aliases"] == {"root": "root", "tip": "root"}


def test_unlink_and_errors(prs):
    prs.link_pull_request({"url": "https://github.com/a/b/pull/1"}, session_id="s1")
    out = json.loads(prs.unlink_pull_request({"url": "https://github.com/a/b/pull/1"}, session_id="s1"))

    assert (out["was_linked"], out["linked"]) == (True, [])
    assert "error" in json.loads(prs.link_pull_request({"url": "not a pr"}, session_id="s1"))


def test_a_subagent_links_to_the_conversation_that_delegated_it(prs, monkeypatch):
    # Core's delegate children: `_delegate_from` names the parent (a compression tip here), and a
    # nested child's parent is itself a subagent. A /branch names its parent too, but is its own chat.
    rows = {
        "child": {"parent_session_id": "tip", "model_config": json.dumps({"_delegate_from": "tip"})},
        "grandchild": {"parent_session_id": "child", "model_config": {"_delegate_from": "child"}},
        "tool-run": {"parent_session_id": "root", "source": "tool"},
        "branch": {"parent_session_id": "root", "model_config": {"_branched_from": "root"}},
        "inherited": {"parent_session_id": "root", "model_config": {"_delegate_from": "older"}},
    }
    state = types.ModuleType("hermes_state")
    state.SessionDB = lambda read_only=False: types.SimpleNamespace(get_session=rows.get)
    monkeypatch.setitem(sys.modules, "hermes_state", state)

    prs.link_pull_request({"url": "https://github.com/a/b/pull/1"}, session_id="tip")
    linked = json.loads(prs.link_pull_request({"url": "https://github.com/a/b/pull/2"}, session_id="grandchild"))["linked"]
    prs.link_pull_request({"url": "https://github.com/a/b/pull/3"}, session_id="tool-run")
    prs.link_pull_request({"url": "https://github.com/a/b/pull/4"}, session_id="branch")
    prs.link_pull_request({"url": "https://github.com/a/b/pull/5"}, session_id="inherited")

    assert [p["number"] for p in linked] == [1, 2]
    data = json.loads(prs.data_file().read_text())
    assert [p["number"] for p in data["conversations"]["root"]] == [1, 2, 3]
    assert data["conversations"]["root"][1]["session_id"] == "grandchild"
    assert [p["number"] for p in data["conversations"]["branch"]] == [4]
    assert [p["number"] for p in data["conversations"]["inherited"]] == [5]
    assert data["aliases"]["grandchild"] == "root"
    assert [p["number"] for p in json.loads(prs.list_pull_requests({}, session_id="child"))["linked"]] == [1, 2, 3]


# ── Which hosts a link may name (the enterprise token goes only to a host the user listed) ─────

KEY = "plugins.entries.hermes-tern.settings.enterprise_hosts"


def configure(prs, monkeypatch, **settings):
    """The plugin's settings as ``ctx.get_config`` reads them."""
    ctx = types.SimpleNamespace(get_config=lambda key, default=None: settings.get(key, default))
    monkeypatch.setattr(prs, "_ctx", ctx, raising=False)


@pytest.mark.parametrize("args", [
    {"url": "https://github.evil.com/a/b/pull/1"},
    {"url": "https://github.com.evil.com/a/b/pull/1"},
    {"url": "https://evil.com/github.com/a/b/pull/1"},
    {"url": "evil.com/github.com/a/b/pull/1"},
    {"url": "https://user@github.com/a/b/pull/1"},
    {"url": "https://github.com:8443/a/b/pull/1"},
    {"url": "https://140.82.112.3/a/b/pull/1"},
    {"url": "https://[::1]/a/b/pull/1"},
    {"url": "https://gist.github.com/a/b/pull/1"},
    {"url": "https://github.mycompany.com/a/b/pull/1"},
    {"url": "ftp://github.com/a/b/pull/1"},
    {"url": "https://github.com/../b/pull/1"},
    {"repository": "a/b", "number": 1, "host": "github.evil.com"},
    {"repository": "a/b", "number": 1, "host": "user@github.com"},
    {"repository": "a/b", "number": 1, "host": "github.com:8443"},
    {"repository": "a/b", "number": 1, "host": "127.0.0.1"},
    {"repository": "a/b", "number": 1, "host": "evil.com/github.com"},
    {"repository": "a/b", "number": 1, "host": "github.mycompany.com"},
], ids=lambda a: a.get("url") or f"host={a['host']}")
def test_link_refuses_a_host_the_user_did_not_list(prs, args):
    out = json.loads(prs.link_pull_request(args, session_id="s1"))

    assert "error" in out
    assert json.loads(prs.list_pull_requests({}, session_id="s1"))["linked"] == []


def test_the_refusal_names_the_config_key(prs):
    out = json.loads(prs.link_pull_request({"url": "https://github.evil.com/a/b/pull/1"}, session_id="s1"))

    assert KEY in out["error"] and "github.evil.com" in out["error"]


def test_hosts_are_normalised_before_they_are_compared(prs):
    target = prs.parse_target({"url": "https://GitHub.COM./Acme/App/pull/7"})

    assert (target["host"], target["url"]) == ("github.com", "https://github.com/acme/app/pull/7")
    assert prs.parse_target({"repository": "a/b", "number": 1, "host": "GITHUB.com."})["host"] == "github.com"


def test_a_listed_enterprise_host_links(prs, monkeypatch):
    configure(prs, monkeypatch, enterprise_hosts=["GHE.Corp.Example.", "git.corp.example:8443", "user@x.example", "10.0.0.1"])

    assert prs.enterprise_hosts() == ["ghe.corp.example", "git.corp.example:8443"]
    assert prs.parse_target({"url": "https://ghe.corp.example/a/b/pull/1"})["host"] == "ghe.corp.example"
    assert prs.parse_target({"url": "https://git.corp.example:8443/a/b/pull/2"})["url"] == "https://git.corp.example:8443/a/b/pull/2"
    for refused in ("https://git.corp.example/a/b/pull/2", "https://ghe.corp.example:8443/a/b/pull/1",
                    "https://evil.ghe.corp.example/a/b/pull/1"):
        with pytest.raises(prs.TargetError):
            prs.parse_target({"url": refused})


def test_the_setting_may_be_one_string_and_never_retargets_github(prs, monkeypatch):
    configure(prs, monkeypatch, enterprise_hosts="ghe.corp.example, github.com")
    assert prs.enterprise_hosts() == ["ghe.corp.example"]

    configure(prs, monkeypatch, enterprise_hosts={"not": "a list"})
    assert prs.enterprise_hosts() == []

    monkeypatch.setattr(prs, "_ctx", None, raising=False)
    assert prs.enterprise_hosts() == []


def test_a_legacy_link_to_an_unlisted_host_can_still_be_unlinked(prs):
    # Written before hosts were checked: the tool refuses to link it now, but must let it go.
    prs.data_file().write_text(json.dumps({"version": 1, "aliases": {}, "conversations": {"s1": [
        {"host": "github.evil.com", "repository": "a/b", "number": 1, "url": "https://github.evil.com/a/b/pull/1"}]}}))

    out = json.loads(prs.unlink_pull_request({"url": "https://github.evil.com/a/b/pull/1"}, session_id="s1"))

    assert (out["was_linked"], out["linked"]) == (True, [])
    assert "error" in json.loads(prs.unlink_pull_request({"url": "https://user@github.com/a/b/pull/1"}, session_id="s1"))
