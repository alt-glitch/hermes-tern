"""Hermes for Tern.

``hermes tern [flags]`` runs this plugin's frontend (``frontend/dist/entry.js``) in the terminal, which
draws the chat with Tern's own components over the Tern Surface Protocol and attaches to the profile's
gateway itself (``launcher.py``). In a terminal that does not answer the protocol's handshake it
says so and exits.

In a Tern pane whose last ``hermes tern`` died (a crash, a kill, Tern's daemon restarting), a launch
with no session flag resumes the conversation that pane showed (``panes.py``); ``--new`` starts fresh.
"""

from . import charts, connections, launcher, pull_requests, tern_env, viewers


def register(ctx) -> None:
    ctx.register_cli_command(
        name="tern", help="Chat in Tern's native UI (runs in a Tern pane only)",
        setup_fn=launcher.setup, handler_fn=launcher.run,
        description="Runs the Tern frontend against this profile's gateway. It needs a Tern pane.")
    # The chart rules of background processes (frontend/src/processes/widgets, charts.py):
    # its own `auxiliary.tern_charts` config block and model picker entry, and the RPC that runs it.
    ctx.register_auxiliary_task(
        charts.TASK, display_name="Tern job charts",
        description="Writes the rules behind a background process's live chart in `hermes tern`, once per process.")
    charts.register(ctx)
    pull_requests.register(ctx)
    connections.register(ctx)
    viewers.register(ctx)
    tern_env.register(ctx)
