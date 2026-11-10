"""Writes the spec of a background process's live chart with Hermes' auxiliary model.

The frontend (``frontend/src/processes/widgets/author.ts``) calls ``plugin.hermes-tern.charts.author``
on its gateway connection, once per process that has run for a while with output::

    {"session_id": "...", "job": "<id>", "system": "...", "user": "..."}

The call answers at once with ``{"job": "<id>"}``: the gateway serves one connection's requests in
order, and a model call can take a minute, which would hold up the pane's prompts. The model call
runs in a thread here. Its reply goes to the viewers of that session as the event
``plugin.hermes-tern.charts.authored``, with ``job`` and one of:

- ``answer``: the spec (a JSON object; the frontend validates it against the spec schema and the
  process's output, and asks once more with the errors when it does not fit);
- ``rejected``: ``{"answer", "errors"}``, when the model's text is not one JSON object (the frontend
  asks once more with the errors);
- ``unavailable``: no auxiliary model is configured;
- ``error``: anything else (the frontend counts it as one failed attempt).

The request is JSON mode (``json_mode=True``) without ``json_schema``: ``complete_structured`` pastes a
schema into the prompt, and small open models then answer with the schema itself (Llama 3.1 8B,
Gemma 3 12B and Qwen3 14B did, every time, retry included). The system prompt documents the spec
with examples instead.

The user text (the command and samples of its output) is redacted before it is sent. The task is
``tern_charts``, so ``auxiliary.tern_charts`` in config.yaml picks its model; without it, Hermes'
auxiliary chain does (the main model first).
"""

from __future__ import annotations

import contextvars
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

logger = logging.getLogger(__name__)

TASK = "tern_charts"
METHOD = "charts.author"
EVENT = "charts.authored"
MAX_TOKENS = 3000
TIMEOUT_S = 90
# Model calls at once, across the gateway's panes; more wait their turn, up to MAX_PENDING in all.
WORKERS = 2
MAX_PENDING = 8
# The pane stops waiting after 120 s (author.ts REQUEST_TIMEOUT_MS), queue time included: a call
# that waited too long in the queue is answered at once instead of spending a model request.
DEADLINE_S = 110
MIN_CALL_S = 20
# Bounds on what a caller may send (any client this gateway authenticated can call the method).
MAX_JOB_CHARS = 64
MAX_TEXT_CHARS = 64 * 1024

INSTRUCTIONS = "Write the widget spec for this background process, as one JSON object."

_pool: ThreadPoolExecutor | None = None
_pool_lock = threading.Lock()
_pending = 0


def _executor() -> ThreadPoolExecutor:
    global _pool
    with _pool_lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="tern-charts")
        return _pool


def _text(params: dict, key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_TEXT_CHARS:
        raise ValueError(f"{key} must be a non-empty string of at most {MAX_TEXT_CHARS} characters")
    return value


def _unavailable(error: BaseException) -> bool:
    """Whether ``error`` is Hermes' "no auxiliary model" refusal. Matched by class name: the class lives
    in a private module (``agent.auxiliary_unavailable``)."""
    return any(cls.__name__ == "AuxiliaryClientUnavailable" for cls in type(error).__mro__)


def write_spec(llm: Any, system: str, user: str, timeout: float = TIMEOUT_S) -> dict[str, Any]:
    """One model request; the reply as the event carries it (without ``job``)."""
    from agent.redact import redact_sensitive_text

    try:
        result = llm.complete_structured(
            task=TASK, system_prompt=system, instructions=INSTRUCTIONS,
            input=[{"type": "text", "text": redact_sensitive_text(user, force=True)}],
            json_mode=True, max_tokens=MAX_TOKENS, timeout=timeout, purpose="job chart spec")
    except Exception as error:  # noqa: BLE001 - each failure is one of the reply's kinds
        if _unavailable(error):
            return {"unavailable": True}
        return {"error": f"{type(error).__name__}: {error}"}
    if result.parsed is None:
        return {"rejected": {"answer": result.text or "", "errors": ["the answer is not one JSON object"]}}
    return {"answer": result.parsed}


def register(ctx) -> None:
    def author(params: dict, *, session_id: str | None = None, **_: Any) -> dict[str, str]:
        if not session_id:
            raise ValueError("charts.author needs the session_id whose viewers get the reply")
        job = params.get("job")
        if not isinstance(job, str) or not job or len(job) > MAX_JOB_CHARS:
            raise ValueError(f"job must be a non-empty string of at most {MAX_JOB_CHARS} characters")
        system, user = _text(params, "system"), _text(params, "user")

        global _pending
        with _pool_lock:
            if _pending >= MAX_PENDING:
                raise RuntimeError(f"{MAX_PENDING} chart requests are already waiting; try again later")
            _pending += 1
        admitted = time.monotonic()

        def run() -> None:
            global _pending
            try:
                left = DEADLINE_S - (time.monotonic() - admitted)
                if left < MIN_CALL_S:
                    reply = {"error": "the request waited too long for a free model slot"}
                else:
                    reply = write_spec(ctx.llm, system, user, timeout=min(TIMEOUT_S, left))
            except Exception as error:  # noqa: BLE001 - the pane must hear back either way
                reply = {"error": f"{type(error).__name__}: {error}"}
            finally:
                with _pool_lock:
                    _pending -= 1
            try:
                ctx.emit_to_session(session_id, EVENT, {"job": job, **reply})
            except Exception:  # noqa: BLE001 - the session went away; nobody waits
                logger.debug("hermes-tern: chart reply for %s not delivered", session_id, exc_info=True)

        # The thread keeps the call's context: the owning profile's scope (config, the session's authority).
        _executor().submit(contextvars.copy_context().run, run)
        return {"job": job}

    ctx.register_rpc(METHOD, author)
