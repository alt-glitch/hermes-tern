"""Writes the spec of a background process's live chart with Hermes' auxiliary model.

The frontend runs it once per process that has run for a while with output
(frontend/src/processes/widgets/author.ts), in Hermes' own interpreter:

    $HERMES_PYTHON widget_author.py < request.json

The request is ``{"system", "user", "schema"}``. The user message (the command and samples of its
output) is redacted before it is sent. One JSON line answers: ``{"answer": <object>}``,
``{"unavailable": true}`` when no auxiliary model is configured, or ``{"error": "..."}``.

The task is ``tern_charts``, so ``auxiliary.tern_charts`` in config.yaml picks its model; without
it, Hermes' auxiliary chain does (the main model first).
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

TOOL = "respond"
MAX_TOKENS = 3000
TIMEOUT_S = 90


def _answer(message) -> object:
    """The `respond` call's arguments, else a JSON object in the text."""
    for call in getattr(message, "tool_calls", None) or []:
        fn = getattr(call, "function", None)
        if getattr(fn, "name", "") == TOOL:
            args = getattr(fn, "arguments", "")
            return json.loads(args) if isinstance(args, str) else args
    text = getattr(message, "content", "") or ""
    if isinstance(text, list):
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError("the model answered without a spec")
    return json.loads(match.group(0))


def _activate() -> None:
    """Hermes' dependencies on the path. HERMES_PYTHON is PM's store Python on a source install,
    which owns no packages: boot the committed generation first, as ui-tui's own helper scripts do.
    An install without PM (a plain venv) already has them."""
    try:
        from pm.environments import activate_dependencies
    except ImportError:
        return
    activate_dependencies(Path(os.environ.get("HERMES_PYTHON_SRC_ROOT") or "."))


def main() -> dict:
    request = json.load(sys.stdin)
    _activate()
    from agent.auxiliary_client import AuxiliaryClientUnavailable, call_llm
    from agent.redact import redact_sensitive_text

    tools = [{"type": "function", "function": {
        "name": TOOL, "description": "Install the widget spec for this job.", "parameters": request["schema"]}}]
    messages = [{"role": "system", "content": request["system"]},
                {"role": "user", "content": redact_sensitive_text(request["user"], force=True)}]
    try:
        # Spec writing is formatting work: no reasoning, the provider's default temperature.
        response = call_llm(task="tern_charts", messages=messages, tools=tools, max_tokens=MAX_TOKENS,
                            temperature=None, timeout=TIMEOUT_S, reasoning_config={"enabled": False})
    except AuxiliaryClientUnavailable:
        return {"unavailable": True}
    return {"answer": _answer(response.choices[0].message)}


if __name__ == "__main__":
    try:
        reply = main()
    except Exception as error:  # the frontend counts it as one failed attempt
        reply = {"error": f"{type(error).__name__}: {error}"}
    print(json.dumps(reply), flush=True)
