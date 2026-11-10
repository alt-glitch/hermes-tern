"""Glide: a local corrections memory for Hermes. Importing it performs no I/O."""

from .memory import GlideMemory, Match, MemoryNotReady, SyncResult
from .source import SourceError
from .storage import StateVersionError

__all__ = ["GlideMemory", "Match", "MemoryNotReady", "SourceError", "StateVersionError", "SyncResult", "register"]


def register(ctx) -> None:
    from . import core

    core.register(ctx)
