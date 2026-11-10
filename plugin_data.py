"""The plugin's own data folder, ``<HERMES_HOME>/plugin-data/hermes-tern/`` (Hermes' ``plugin_data_dir``)."""

from __future__ import annotations

from pathlib import Path

PLUGIN = "hermes-tern"


def folder(name: str) -> Path:
    """The subfolder ``name`` of the plugin's data folder, created when missing."""
    from plugins.plugin_storage import plugin_data_dir

    path = plugin_data_dir(PLUGIN) / name
    path.mkdir(parents=True, exist_ok=True)
    return path
