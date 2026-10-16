"""A loopback OpenAI-compatible model for driving `hermes tern` without credentials.

    python lab/fake_model.py --home DIR [--port N]

Writes a disposable HERMES_HOME at DIR (config pointing at this server, the plugin enabled,
first-run prompts answered) and then serves until killed. What the model does is picked by
the user's prompt, so one home covers every flow:

    "approve"   -> a terminal call Hermes flags as dangerous (approval sheet)
    "clarify"   -> a clarify call with choices (clarify sheet)
    "tool"      -> a harmless terminal call (tool card)
    anything else -> a streamed markdown reply
"""

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]

REPLY = """Here is **markdown** from the fake model.

- a list item
- another one

```python
print("hello from hermes tern")
```
"""


def _calls(prompt: str, target: Path) -> list[dict] | None:
    words = prompt.lower()
    if "approve" in words:
        return [_call("terminal", {"command": f"rm -rf -- {target}"})]
    if "clarify" in words:
        return [_call("clarify", {"questions": [{"question": "Which colour?", "choices": ["red", "green", "blue"]}]})]
    if "tool" in words:
        return [_call("terminal", {"command": "echo tool-ok && ls"})]
    return None


def _call(name: str, arguments: dict) -> dict:
    return {"id": f"call-{name}", "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}


class Server(ThreadingHTTPServer):
    target: Path


class Model(BaseHTTPRequestHandler):
    server: Server

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self._json({"data": [{"id": "fake-model", "object": "model"}]})

    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        messages = request.get("messages", [])
        prompt = next((m.get("content") for m in reversed(messages) if m.get("role") == "user"), "") or ""
        if isinstance(prompt, list):
            prompt = " ".join(p.get("text", "") for p in prompt if isinstance(p, dict))
        answered = bool(messages) and messages[-1].get("role") == "tool"
        calls = None if answered else _calls(prompt, self.server.target)
        content = "Done: the tool returned." if answered else (None if calls else REPLY)
        if request.get("stream"):
            self._stream(content, calls)
        else:
            message = {"role": "assistant", "content": content, **({"tool_calls": calls} if calls else {})}
            self._json({"id": "fake", "object": "chat.completion", "created": 1, "model": "fake-model",
                        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if calls else "stop"}],
                        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})

    def _stream(self, content: str | None, calls: list[dict] | None):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        deltas = []
        if calls:
            deltas.append({"role": "assistant", "tool_calls": [{**c, "index": i} for i, c in enumerate(calls)]})
        else:
            # A few chunks so the transcript visibly streams.
            text = content or ""
            step = max(1, len(text) // 6)
            deltas += [{"role": "assistant", "content": text[i:i + step]} for i in range(0, len(text), step)]
        for delta in deltas:
            self._chunk(delta, None)
        self._chunk({}, "tool_calls" if calls else "stop")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _chunk(self, delta: dict, finish: str | None):
        frame = {"id": "fake", "object": "chat.completion.chunk", "created": 1, "model": "fake-model",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        self.wfile.write(f"data: {json.dumps(frame)}\n\n".encode())

    def _json(self, body: dict):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def write_home(home: Path, base_url: str) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    plugins = home / "plugins"
    plugins.mkdir(exist_ok=True)
    link = plugins / "hermes-tern"
    if not link.exists():
        link.symlink_to(PLUGIN, target_is_directory=True)
    # JSON is YAML: no PyYAML needed here.
    (home / "config.yaml").write_text(json.dumps({
        "model": {"provider": "custom", "default": "fake-model", "base_url": base_url},
        "approvals": {"mode": "manual", "timeout": 300},
        "auxiliary": {"title_generation": {"enabled": False}},
        "plugins": {"enabled": ["hermes-tern"], "disabled": []},
        "telemetry": {"shared_metrics": {"enabled": False, "send": False, "offer_version": 2}},
    }, indent=2))
    (home / ".env").write_text("OPENAI_API_KEY=loopback-only\n")
    target = home / "approve-target"
    target.mkdir(exist_ok=True)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--home", required=True, type=Path)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = Server(("127.0.0.1", args.port), Model)
    base_url = f"http://127.0.0.1:{server.server_port}/v1"
    server.target = write_home(args.home.resolve(), base_url)
    print(f"fake model at {base_url}; HERMES_HOME={args.home.resolve()}", flush=True)
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    server.serve_forever()


if __name__ == "__main__":
    main()
