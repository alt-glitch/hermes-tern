"""Gateway methods (`glide.detect|sync|enable|recall`) for frontends that draw their own cards.

Optional: Hermes cores without ``register_gateway_method`` skip them, and `/glide` still works.
Every method is bound to the session the caller is attached to.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from . import core, source

NAMESPACE = "glide"


class SessionParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=1)


class SyncParams(SessionParams):
    limit: int = Field(default=source.MAX_SESSIONS, ge=1, le=source.MAX_SESSIONS, strict=True)


class EnableParams(SessionParams):
    on: bool = Field(strict=True)


class RecallParams(SessionParams):
    query: str = Field(min_length=1, max_length=512)


VERBS = {
    "detect": (SessionParams, lambda home, p: core.detect(home)),
    "sync": (SyncParams, lambda home, p: core.sync(home, p.limit, p.session_id)),
    "enable": (EnableParams, lambda home, p: core.set_enabled(home, p.on)),
    "recall": (RecallParams, lambda home, p: {"hits": core.recall(home, p.query)}),
    "skill_router": (SessionParams, lambda home, p: core.skill_router_command(home, p.session_id)),
    "hill_climb": (SessionParams, lambda home, p: core.hill_climb_command(home, p.session_id)),
    "offload": (SessionParams, lambda home, p: core.offload_command(home, p.session_id)),
}


def call(home: Path, verb: str, params: dict):
    """One `glide.<verb>` call with its schema checked; shared by both transports."""
    schema, run = VERBS[verb]
    return run(home, schema.model_validate(params))


def register(ctx) -> None:
    registrar = getattr(ctx, "register_gateway_method", None)
    if not callable(registrar):
        return

    def bind(verb: str):
        def handler(request, params: dict):
            request.assert_attached()
            if params["session_id"] != request.session_id:
                raise PermissionError("not the attached session")
            return call(core._home(), verb, params)
        return handler

    for verb, (schema, _run) in VERBS.items():
        registrar(f"{NAMESPACE}.{verb}", bind(verb), schema=schema)
