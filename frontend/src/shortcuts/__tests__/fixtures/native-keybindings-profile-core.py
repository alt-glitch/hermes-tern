#!/usr/bin/env python3
"""Real pinned config.get full/profile against A's reaped sid on a B connection.

Invokes the registered direct JSON-RPC dispatcher and real config.get handlers;
does not mock the profile resolver or echo request params.
"""
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

PIN = "b3746e35ddd32079697728e2df57a9d78f1e9e32"
source = Path.cwd() / ".hermes-src"
if not (source / "tui_gateway" / "server.py").is_file():
    raise RuntimeError("Missing pinned Hermes source. Run node scripts/hermes-src.mjs.")
if (Path.cwd() / "hermes-src.lock").read_text(encoding="utf-8").strip() != PIN:
    raise RuntimeError("Unexpected Hermes source pin")
actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
if actual != PIN:
    raise RuntimeError(f"Hermes checkout {actual} != pinned {PIN}")

with TemporaryDirectory(prefix="hermes-tern-keybindings-owner-") as directory:
    home = Path(directory) / "launch"
    a = home / "profiles" / "a"
    b = home / "profiles" / "b"
    for root, chord in ((home, "alt+g"), (a, "alt+h"), (b, "alt+y")):
        root.mkdir(parents=True, exist_ok=True)
        (root / "config.yaml").write_text(
            "display:\n  tern_profile_identity: true\n  tern_keybindings:\n"
            f"    app.help: {chord}\n", encoding="utf-8"
        )

    sys.path.insert(0, str(source))
    os.environ["HERMES_HOME"] = str(home)
    with redirect_stdout(sys.stderr):
        from tui_gateway import server
        from tui_gateway.ws_legacy_fallback import _connection_profile_home

    def call(key, params):
        with redirect_stdout(sys.stderr):
            response = server._handle_admitted_request({
                "jsonrpc": "2.0", "id": 7, "method": "config.get",
                "params": {"key": key, **params},
            })
        if not isinstance(response, dict) or "result" not in response:
            raise AssertionError(f"Actual pinned gateway rejected {key}: {response!r}")
        return response["result"]

    def help_chord(result):
        return result["config"]["display"]["tern_keybindings"]["app.help"]

    sid = "reaped-A"
    server._sessions[sid] = {"agent": None, "profile_home": str(a), "session_key": sid}
    server._sessions.pop(sid)
    token = _connection_profile_home.set(str(b))
    try:
        owner = {"session_id": sid, "profile": "a"}
        fallback = {"session_id": sid}
        owner_help = help_chord(call("full", owner))
        fallback_help = help_chord(call("full", fallback))
        own_identity = call("profile", owner)
        fallback_identity = call("profile", fallback)
        # The pinned home field is launch metadata; only display is owner-scoped.
        assert Path(own_identity["home"]).resolve() == home.resolve()
        assert Path(fallback_identity["home"]).resolve() == home.resolve()
        identity_scoped = (
            Path(own_identity["display"]).expanduser().resolve() == a.resolve()
            and Path(fallback_identity["display"]).expanduser().resolve() == b.resolve()
        )
        b_unchanged = help_chord(call("full", {"session_id": sid, "profile": "b"})) == "alt+y"
        assert owner_help == "alt+h" and fallback_help == "alt+y"
        assert identity_scoped and b_unchanged
    finally:
        _connection_profile_home.reset(token)
        server._sessions.pop(sid, None)

    print(json.dumps({
        "pinned": True, "ownerHelp": owner_help, "fallbackHelp": fallback_help,
        "identityScoped": identity_scoped, "bUnchanged": b_unchanged,
    }))
