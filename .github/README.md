# Glide

**Stop repeating yourself to Hermes.** Glide keeps the corrections you give your agent and quotes the
matching ones back into each new turn, locally, with no model calls and no network.

Glide is two things in one repo:

| Part | Install | What you get |
| --- | --- | --- |
| Corrections memory, in [`glide/`](../glide/README.md) | `hermes plugins install kvnloo/glide#glide` | `/glide build`, `/glide on`, `/glide recall` in any Hermes chat: CLI, TUI, desktop or gateway |
| A Tern frontend, at the repo root | `hermes plugins install kvnloo/glide` | Hermes drawn natively in [Tern](https://stencil.so/tern), with `/glide` as cards plus the features in [FORK.md](../FORK.md) |

The Tern frontend is a fork of [alt-glitch/hermes-tern](https://github.com/alt-glitch/hermes-tern),
the community plugin. Code meant for upstream is kept in upstream's layout and sent back as pull
requests; code only Glide needs lives in [`glide/`](../glide). Upstream's own README is
[README.md](../README.md), unchanged, and [FORK.md](../FORK.md) lists everything the fork adds.

MIT licensed.
