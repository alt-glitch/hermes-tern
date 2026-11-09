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


def register(ctx) -> None:
    registrar = getattr(ctx, "register_gateway_method", None)
    if not callable(registrar):
        return

    def attached(request, params: dict) -> Path:
        request.assert_attached()
        if params["session_id"] != request.session_id:
            raise PermissionError("not the attached session")
        return core._home()

    registrar(f"{NAMESPACE}.detect", lambda r, p: core.detect(attached(r, p)), schema=SessionParams)
    registrar(f"{NAMESPACE}.sync",
              lambda r, p: core.sync(attached(r, p), p.get("limit", source.MAX_SESSIONS), p["session_id"]),
              schema=SyncParams)
    registrar(f"{NAMESPACE}.enable", lambda r, p: core.set_enabled(attached(r, p), p["on"]), schema=EnableParams)
    registrar(f"{NAMESPACE}.recall", lambda r, p: {"hits": core.recall(attached(r, p), p["query"])},
              schema=RecallParams)
