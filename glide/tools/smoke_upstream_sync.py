#!/usr/bin/env python3
"""Exercise the installed Hermes CLI with an isolated profile and the built plugin."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / ".hermes-agent"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="tern-sync-smoke-") as temporary:
        home = Path(temporary)
        profile = home / "profile"
        plugin = profile / "plugins/hermes-tern"
        plugin.mkdir(parents=True)
        for source in ROOT.glob("*.py"):
            shutil.copy2(source, plugin / source.name)
        shutil.copy2(ROOT / "plugin.yaml", plugin / "plugin.yaml")
        (plugin / "frontend/dist").mkdir(parents=True)
        shutil.copy2(ROOT / "frontend/dist/entry.js", plugin / "frontend/dist/entry.js")
        shutil.copy2(ROOT / "frontend/package.json", plugin / "frontend/package.json")
        (profile / "config.yaml").write_text("plugins:\n  enabled: [hermes-tern]\n")
        registry = home / "channels.json"
        registry.write_text(json.dumps({"version": 1, "channels": {"smoke": {"dir": str(plugin), "alias": "tern-smoke"}}}))
        environment = {
            "HOME": str(home), "HERMES_HOME": str(profile),
            "HERMES_BUNDLED_PLUGINS": str(home / "empty-plugins"),
            "HERMES_TERN_CHANNELS": str(registry),
            "PATH": os.pathsep.join([str(CORE / ".venv/bin"), os.environ["PATH"]]),
            "PYTHONPATH": str(CORE), "TERM": "dumb", "NO_COLOR": "1",
        }
        command = [str(CORE / ".venv/bin/python"), "-m", "hermes_cli.main"]

        def run(arguments: list[str]) -> subprocess.CompletedProcess:
            result = subprocess.run(command + arguments, input="", text=True, capture_output=True,
                                    env=environment, cwd=home, timeout=30)
            print(f"hermes {' '.join(arguments)}: exit {result.returncode}")
            return result

        help_result = run(["tern", "--help"])
        assert help_result.returncode == 0, help_result.stderr
        for option in ("--channel", "channels", "switch"):
            assert option in help_result.stdout, help_result.stdout
        listed = run(["tern", "channels"])
        assert listed.returncode == 0, listed.stderr
        assert "smoke" in listed.stdout and str(registry) in listed.stdout, listed.stdout
        alias = run(["tern-smoke", "--help"])
        assert alias.returncode == 0 and "--channel" in alias.stdout, alias.stderr
        launch = run(["tern", "--channel", "smoke"])
        assert launch.returncode == 1, launch.stdout + launch.stderr
        assert "this terminal did not answer the Tern Surface Protocol" in launch.stderr, launch.stderr
        assert "starting the regular TUI" not in launch.stdout + launch.stderr
        print("smoke: channel help, registry, alias, and real Node NO_TSP path passed")


if __name__ == "__main__":
    main()
