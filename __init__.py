"""Hermes for Tern.

``hermes tern [flags]`` runs this plugin's frontend (``frontend/dist/entry.js``) in the terminal, which
draws the chat with Tern's own components over the Tern Surface Protocol and attaches to the profile's
gateway itself (``launcher.py``). In a terminal that does not answer the protocol's handshake it
says so and exits.

In a Tern pane whose last ``hermes tern`` died (a crash, a kill, Tern's daemon restarting), a launch
with no session flag resumes the conversation that pane showed (``panes.py``); ``--new`` starts fresh.
"""

from . import (
    browser_backend, channels, charts, ephemeral_cards, launcher, plan_gateway,
    pull_requests, tern_env, viewers,
)


def register(ctx) -> None:
    ctx.register_cli_command(
        name="tern", help="Chat in Tern's native UI (runs in a Tern pane only)",
        setup_fn=launcher.setup, handler_fn=launcher.run,
        description="Runs the Tern frontend against this profile's gateway. It needs a Tern pane. "
                    "--channel NAME picks a frontend channel; `switch NAME` moves this pane to one live.")
    for alias, channel in channels.aliases().items():
        ctx.register_cli_command(
            name=alias, help=f"hermes tern on frontend channel {channel!r}",
            setup_fn=launcher.setup, handler_fn=lambda args, _c=channel: launcher.run(args, _c),
            description=f"`hermes tern --channel {channel}`; runs in a Tern pane only.")
    ctx.register_auxiliary_task(
        charts.TASK, display_name="Tern job charts",
        description="Writes the rules behind a background process's live chart in `hermes tern`, once per process.")
    ctx.register_auxiliary_task(
        "table_charts", display_name="Tern table charts",
        description="Selects bar, line or no visualization for a settled Markdown table in `hermes tern`.")
    charts.register(ctx)
    pull_requests.register(ctx)
    ephemeral_cards.register(ctx)
    viewers.register(ctx)
    tern_env.register(ctx)
    # Optional downstream gateway methods remain unavailable on older Hermes.
    if callable(getattr(ctx, "register_gateway_method", None)):
        from . import gateway_operations, media_backend

        media_backend.register(ctx)
        gateway_operations.register(ctx)
    browser_backend.register(ctx)
    plan_gateway.register(ctx)
    from . import talk_backend

    talk_backend.register(ctx)
