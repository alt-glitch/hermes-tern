"""charts.py without Hermes: ``ctx.llm`` and the redactor are stubbed."""

import sys
import threading
import types

import pytest

from hermes_tern_plugin import charts

PARAMS = {"job": "j1", "system": "design a widget", "user": "token sk-secret"}


class AuxiliaryClientUnavailable(RuntimeError):
    pass


class Llm:
    """``ctx.llm`` with ``reply`` as complete_structured's behaviour: a result or an exception."""

    def __init__(self, reply):
        self.reply, self.calls = reply, []

    def complete_structured(self, **kwargs):
        self.calls.append(kwargs)
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


def result(parsed=None, text=""):
    return types.SimpleNamespace(parsed=parsed, text=text)


class Ctx:
    def __init__(self, llm):
        self.llm, self.rpc, self.events, self.done = llm, {}, [], threading.Event()

    def register_rpc(self, name, handler):
        self.rpc[name] = handler

    def emit_to_session(self, session_id, event, payload):
        self.events.append((session_id, event, payload))
        self.done.set()
        return True


@pytest.fixture(autouse=True)
def redact(monkeypatch):
    module = types.ModuleType("agent.redact")
    module.redact_sensitive_text = lambda text, force=False: text.replace("sk-secret", "[redacted]") if force else text
    monkeypatch.setitem(sys.modules, "agent", types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.redact", module)


def call(reply, params=PARAMS, session_id="s1"):
    """Calls the RPC; its immediate answer, the event it sent, and the llm call's kwargs."""
    llm = Llm(reply)
    ctx = Ctx(llm)
    charts.register(ctx)
    answer = ctx.rpc["charts.author"](dict(params), session_id=session_id)
    assert ctx.done.wait(5)
    ((sid, event, payload),) = ctx.events
    assert (sid, event) == (session_id, "charts.authored")
    return answer, payload, (llm.calls[0] if llm.calls else None)


def test_answers_at_once_then_sends_the_spec_to_the_session():
    answer, payload, kwargs = call(result(parsed={"title": "load", "rules": [], "blocks": []}))
    assert answer == {"job": "j1"}
    assert payload == {"job": "j1", "answer": {"title": "load", "rules": [], "blocks": []}}
    assert kwargs["task"] == "tern_charts"
    assert kwargs["system_prompt"] == "design a widget"
    # JSON mode, no schema pasted into the prompt: small models answer with the schema itself.
    assert kwargs["json_mode"] is True and "json_schema" not in kwargs
    assert kwargs["input"] == [{"type": "text", "text": "token [redacted]"}]


def test_text_that_is_not_json_comes_back_rejected_with_the_text():
    _, payload, _ = call(result(text="Sure! Here is a chart."))
    assert payload == {"job": "j1", "rejected": {"answer": "Sure! Here is a chart.",
                                                  "errors": ["the answer is not one JSON object"]}}


def test_no_auxiliary_model_says_so_and_other_failures_are_errors():
    assert call(AuxiliaryClientUnavailable("no provider"))[1] == {"job": "j1", "unavailable": True}
    assert call(TimeoutError("slow"))[1] == {"job": "j1", "error": "TimeoutError: slow"}


@pytest.mark.parametrize("params, session_id", [
    (PARAMS, None),
    ({**PARAMS, "job": ""}, "s1"),
    ({**PARAMS, "job": "x" * 65}, "s1"),
    ({**PARAMS, "user": ""}, "s1"),
    ({**PARAMS, "system": 3}, "s1"),
    ({**PARAMS, "user": "x" * (charts.MAX_TEXT_CHARS + 1)}, "s1"),
])
def test_bad_params_fail_the_call_before_any_model_request(params, session_id):
    llm = Llm(result(parsed={}))
    ctx = Ctx(llm)
    charts.register(ctx)
    with pytest.raises(ValueError):
        ctx.rpc["charts.author"](dict(params), session_id=session_id)
    assert not llm.calls and not ctx.events


def test_a_full_queue_refuses_and_a_request_that_waited_too_long_skips_the_model(monkeypatch):
    llm = Llm(result(parsed={}))
    ctx = Ctx(llm)
    charts.register(ctx)
    monkeypatch.setattr(charts, "_pending", charts.MAX_PENDING)
    with pytest.raises(RuntimeError):
        ctx.rpc["charts.author"](dict(PARAMS), session_id="s1")
    monkeypatch.setattr(charts, "_pending", 0)

    clock = iter([0.0, charts.DEADLINE_S])  # admitted at 0, started at the deadline
    monkeypatch.setattr(charts.time, "monotonic", lambda: next(clock))
    ctx.rpc["charts.author"](dict(PARAMS), session_id="s1")
    assert ctx.done.wait(5)
    assert ctx.events[0][2] == {"job": "j1", "error": "the request waited too long for a free model slot"}
    assert not llm.calls and charts._pending == 0


def test_the_model_call_gets_what_is_left_of_the_deadline(monkeypatch):
    clock = iter([0.0, 30.0])
    monkeypatch.setattr(charts.time, "monotonic", lambda: next(clock))
    _, _, kwargs = call(result(parsed={}))
    assert kwargs["timeout"] == min(charts.TIMEOUT_S, charts.DEADLINE_S - 30)
