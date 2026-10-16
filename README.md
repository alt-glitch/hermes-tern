# hermes-tern

Hermes Agent in [Tern](https://stencil.so/tern)'s native UI. A Hermes plugin that adds
`hermes tern`: the chat is described to Tern over its Surface Protocol (TSP), so the
transcript, tool cards, approvals, questions and pickers are drawn by the terminal itself.

```sh
hermes plugins install alt-glitch/hermes-tern
hermes tern                 # in a Tern pane
hermes tern -c              # every `hermes chat` flag works: -m, -q, --image, --resume, --worktree, …
```

Outside Tern (or inside tmux/screen/zellij) the frontend gets no TSP answer and `hermes tern`
starts the regular TUI instead. To open Hermes in Tern's agent pane, set Tern's agent command
(`agent_command` in Tern's settings) to `hermes tern`.

## How it works

- `__init__.py` registers `hermes tern`. It runs `hermes chat --tui <flags>` with
  `HERMES_TUI_DIR` pointing at `frontend/`, so Hermes' own launcher still does profile, cwd,
  resume, worktree, the gateway attach and the exit summary. Exit code 75 (no TSP) reruns
  `hermes chat --tui` without it.
- `frontend/` is the TSP frontend, a TypeScript app on [`@stencil-hq/tern`](https://www.npmjs.com/package/@stencil-hq/tern).
  It talks to the profile's shared Hermes gateway (`hermes-gateway-v1`) through Hermes' own
  gateway client. `frontend/dist/entry.js` is committed, so installing needs no npm step.
- The frontend began as [can1357](https://github.com/can1357)'s `ui-tsp`
  (`can1357/hermes-agent@tern-frontend`) and keeps omp's chat roles (`omp.session`, …), which
  Tern's chat styles, tool folding and Carly integration are written against.

### Compatibility

The bundle inlines Hermes' renderer-free ui-tui modules (gateway client, skins) and
`apps/shared` from the Hermes commit it was built against; the build prints it. At runtime it
runs that client against the installed Hermes, which starts the gateway through
`ui-tui/scripts/gateway_bootstrap.py`. That script and the gateway wire are Hermes internals:
rebuild against a newer Hermes when they change.

## Developing

```sh
cd frontend
HERMES_SRC=~/path/to/hermes-agent npm run setup   # links .hermes-src, installs
npm run check                                     # typecheck + tests
npm run bundle                                    # rebuilds dist/entry.js
```

`lab/fake_model.py --home DIR` writes a disposable `HERMES_HOME` pointed at a loopback model
and serves it: prompts containing "approve", "clarify" or "tool" drive those flows, anything
else streams markdown. Pair it with a headless Tern (`tern serve --control PORT`, then
`tern ctl --control PORT run|type|key|shot …`) to check the UI without credentials.

## License

MIT. See `LICENSE`.
