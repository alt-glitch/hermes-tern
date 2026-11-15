"""pull_requests.py without Hermes: tools.registry is stubbed, storage goes to a temp dir."""

import json
import sys
import types

import pytest

from hermes_tern_plugin.backend.gateway import pull_requests
from hermes_tern_plugin.backend.shared import sessions


class FakeCtx:
    """What register() gets from Hermes, recorded: the tools and the RPC method by name, the plugin
    settings ``get_config`` reads, and every ``emit_to_session``."""

    def __init__(self):
        self.tools, self.rpc, self.settings, self.told = {}, {}, {}, []
        self.viewed = lambda session_id: True

    def register_tool(self, name, handler, **_):
        self.tools[name] = handler

    def register_rpc(self, name, handler):
        self.rpc[name] = handler

    def register_system_prompt_section(self, *_):
        pass

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def emit_to_session(self, session_id, event, payload):
        self.told.append((session_id, event, payload))
        return self.viewed(session_id)


@pytest.fixture()
def ctx():
    return FakeCtx()


@pytest.fixture()
def prs(tmp_path, monkeypatch, ctx):
    """The module, with each tool replaced by the handler register() gave Hermes for it."""
    registry = types.ModuleType("tools.registry")
    registry.tool_error = lambda message, **extra: json.dumps({"error": message, **extra})
    registry.tool_result = lambda data=None, **kw: json.dumps(data if data is not None else kw)
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.registry", registry)

    lineages = {"tip": ["root", "tip"]}
    monkeypatch.setattr(pull_requests, "data_file", lambda: tmp_path / "pull-requests.json")
    monkeypatch.setattr(sessions, "lineage", lambda sid: lineages.get(sid, [sid]))
    monkeypatch.setattr(pull_requests, "_cwd", lambda: "/work")
    pull_requests.register(ctx)
    module = {k: getattr(pull_requests, k) for k in dir(pull_requests) if not k.startswith("__")}
    return types.SimpleNamespace(**{**module, **ctx.tools, "linked": ctx.rpc[pull_requests.LINKED_METHOD]})


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


def test_the_rpc_method_reads_the_calling_sessions_conversation(prs):
    prs.link_pull_request({"url": "https://github.com/a/b/pull/1"}, session_id="root")

    assert prs.linked({}, session_id="tip") == {"linked": [
        {"url": "https://github.com/a/b/pull/1", "repository": "a/b", "number": 1, "host": "github.com"}], "guides": {}}
    assert prs.linked({}, session_id="other") == {"linked": [], "guides": {}}
    with pytest.raises(ValueError):
        prs.linked({}, session_id=None)


def test_a_review_guide_links_its_pr_is_capped_and_goes_with_an_unlink(prs, ctx):
    stop = {"title": "  The shim  ", "notes": "n", "files": ["a.py:4", "", *[f"f{i}" for i in range(30)]],
            "questions": [f"q{i}" for i in range(9)]}
    out = json.loads(prs.write_review_guide({"url": "https://github.com/A/B/pull/7", "head_sha": "ABC1234",
                                             "summary": "s", "stops": [stop]}, session_id="tip"))

    assert (out["written"], out["stops"], [p["number"] for p in out["linked"]]) == ("a/b#7", 1, [7])
    guide = prs.linked({}, session_id="root")["guides"]["a/b#7"]
    assert (guide["head_sha"], guide["summary"], guide["stops"][0]["title"]) == ("abc1234", "s", "The shim")
    assert (len(guide["stops"][0]["files"]), len(guide["stops"][0]["questions"])) == (prs.MAX_FILES, prs.MAX_QUESTIONS)
    assert [sid for sid, _, _ in ctx.told] == ["root"]
    for bad in ({"stops": []}, {"stops": [{"notes": "no title"}]}, {"stops": [stop], "head_sha": "main"},
                {"stops": [stop] * (prs.MAX_STOPS + 1)}):
        assert "error" in json.loads(prs.write_review_guide({"url": "https://github.com/a/b/pull/7", "summary": "", **bad},
                                                            session_id="tip"))

    prs.unlink_pull_request({"url": "https://github.com/a/b/pull/7"}, session_id="tip")
    assert prs.linked({}, session_id="tip") == {"linked": [], "guides": {}}


def test_a_change_tells_the_panes_of_the_conversation_once(prs, ctx):
    told = ctx.told
    ctx.viewed = lambda session_id: session_id == "tip"  # the pane holds the conversation under its newer id

    prs.link_pull_request({"url": "https://github.com/a/b/pull/1"}, session_id="tip")
    assert told == [("root", "pull_requests.changed", {}), ("tip", "pull_requests.changed", {})]

    told.clear()
    prs.link_pull_request({"url": "https://github.com/a/b/pull/1"}, session_id="tip")
    prs.unlink_pull_request({"url": "https://github.com/a/b/pull/9"}, session_id="tip")
    assert told == []

    prs.unlink_pull_request({"url": "https://github.com/a/b/pull/1"}, session_id="tip")
    assert [sid for sid, _, _ in told] == ["root", "tip"]


# ── Which hosts a link may name (the enterprise token goes only to a host the user listed) ─────

KEY = "plugins.entries.hermes-tern.settings.enterprise_hosts"


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


def test_a_listed_enterprise_host_links(prs, ctx):
    ctx.settings["enterprise_hosts"] = ["GHE.Corp.Example.", "git.corp.example:8443", "user@x.example", "10.0.0.1"]
    link = lambda url: json.loads(prs.link_pull_request({"url": url}, session_id="s1"))

    assert link("https://ghe.corp.example/a/b/pull/1")["host"] == "ghe.corp.example"
    assert link("https://git.corp.example:8443/a/b/pull/2")["url"] == "https://git.corp.example:8443/a/b/pull/2"
    for refused in ("https://git.corp.example/a/b/pull/2", "https://ghe.corp.example:8443/a/b/pull/1",
                    "https://evil.ghe.corp.example/a/b/pull/1"):
        assert "error" in link(refused)


def test_the_setting_may_be_one_string_and_never_retargets_github(prs):
    assert prs.enterprise_hosts("ghe.corp.example, github.com") == ["ghe.corp.example"]
    assert prs.enterprise_hosts({"not": "a list"}) == []
    assert prs.enterprise_hosts(None) == []


def test_a_legacy_link_to_an_unlisted_host_can_still_be_unlinked(prs):
    # Written before hosts were checked: the tool refuses to link it now, but must let it go.
    prs.data_file().write_text(json.dumps({"version": 1, "aliases": {}, "conversations": {"s1": [
        {"host": "github.evil.com", "repository": "a/b", "number": 1, "url": "https://github.evil.com/a/b/pull/1"}]}}))

    out = json.loads(prs.unlink_pull_request({"url": "https://github.evil.com/a/b/pull/1"}, session_id="s1"))

    assert (out["was_linked"], out["linked"]) == (True, [])
    assert "error" in json.loads(prs.unlink_pull_request({"url": "https://user@github.com/a/b/pull/1"}, session_id="s1"))


def test_a_legacy_link_stored_with_a_trailing_dot_is_found_by_its_normalised_host(prs):
    prs.data_file().write_text(json.dumps({"version": 1, "aliases": {}, "conversations": {"s1": [
        {"host": "github.evil.com.", "repository": "a/b", "number": 1, "url": "https://github.evil.com./a/b/pull/1"},
        {"host": "GitHub.com.", "repository": "a/b", "number": 2, "url": "https://GitHub.com./a/b/pull/2"}]}}))

    assert json.loads(prs.unlink_pull_request({"url": "https://github.evil.com./a/b/pull/1"}, session_id="s1"))["was_linked"]
    assert json.loads(prs.link_pull_request({"url": "https://github.com/a/b/pull/2"}, session_id="s1"))["already_linked"]
    assert json.loads(prs.unlink_pull_request({"url": "https://github.com/a/b/pull/2"}, session_id="s1"))["linked"] == []
