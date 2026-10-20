"""widget_author.py without Hermes: the auxiliary client and the redactor are stubbed."""

import io
import json
import runpy
import sys
import types
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "widget_author.py"
REQUEST = {"system": "design a widget", "user": "token sk-secret", "schema": {"type": "object"}}


class Unavailable(RuntimeError):
    pass


def _message(content=None, calls=()):
    tool_calls = [types.SimpleNamespace(function=types.SimpleNamespace(name=n, arguments=a)) for n, a in calls]
    return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content=content, tool_calls=tool_calls))])


@pytest.fixture()
def run(monkeypatch, capsys):
    """Runs the script with `reply` as call_llm's behaviour; returns its JSON line and the call's kwargs."""
    seen = {}

    def go(reply):
        def call_llm(**kwargs):
            seen.update(kwargs)
            if isinstance(reply, Exception):
                raise reply
            return reply

        aux = types.ModuleType("agent.auxiliary_client")
        aux.AuxiliaryClientUnavailable, aux.call_llm = Unavailable, call_llm
        redact = types.ModuleType("agent.redact")
        redact.redact_sensitive_text = lambda text, force=False: text.replace("sk-secret", "[redacted]")
        monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
        monkeypatch.setitem(sys.modules, "agent.auxiliary_client", aux)
        monkeypatch.setitem(sys.modules, "agent.redact", redact)
        monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(REQUEST)))
        runpy.run_path(str(SCRIPT), run_name="__main__")
        return json.loads(capsys.readouterr().out.strip().splitlines()[-1]), seen

    return go


def test_answers_with_the_respond_call_and_redacts_the_samples(run):
    reply, kwargs = run(_message(calls=[("respond", json.dumps({"title": "load", "rules": [], "blocks": []}))]))
    assert reply == {"answer": {"title": "load", "rules": [], "blocks": []}}
    assert kwargs["task"] == "job_widget"
    assert kwargs["tools"][0]["function"]["name"] == "respond"
    assert kwargs["tools"][0]["function"]["parameters"] == {"type": "object"}
    assert kwargs["messages"][1]["content"] == "token [redacted]"
    assert kwargs["reasoning_config"] == {"enabled": False}


def test_reads_a_spec_from_the_text_when_the_model_does_not_call(run):
    reply, _ = run(_message(content='Here it is:\n```json\n{"skip": "no numbers"}\n```'))
    assert reply == {"answer": {"skip": "no numbers"}}


def test_says_unavailable_without_a_model_and_reports_errors(run):
    assert run(Unavailable("no provider"))[0] == {"unavailable": True}
    assert run(_message(content="sorry"))[0] == {"error": "ValueError: the model answered without a spec"}
