---
name: onboarding
description: Use when the user installs or sets up Glide, or asks what it remembers.
---

# Glide onboarding

Glide's setup is split on purpose. **Code does every step with a factual answer**; you do the parts
that need judgment. You never write Glide's memory, never edit `<profile>/glide/`, and never turn
quoting on without the user saying so.

## 1. Run the scripted part (code)

```
hermes glide onboard --json
```

(In a chat without a terminal, `/glide setup` prints the same steps as text.)

It returns `{"ok", "on", "steps": [...]}`, each step `{"id", "ok", "detail"}`, in this order:

| step | what code checked |
|---|---|
| `history` | the profile has local sessions with the user's messages |
| `build` | it read them and kept the corrections (`"no, …"`, `"actually, …"`, `"correction: …"`) |
| `corrections` | how many were kept; `preview` lists up to 20 as `{n, text}` |
| `recall` | each of the first three kept corrections is found again by its own words |
| `quoting` | whether corrections are quoted into turns now |

The receipt is also saved to `<profile>/glide/onboarding.json`. Report a failed step's `detail`
exactly as given; don't guess past it. If `history` failed, the user just needs to use Hermes for a
while first. If `recall` failed, tell them it is a Glide bug and quote the probe.

## 2. Review what was kept (you)

Read the `preview` list and tell the user, briefly:

- which corrections look like **lasting preferences** ("use pnpm, not npm") and which look like
  **one-off fixes** tied to a single task ("no, the second file");
- any that contain **something private** (a name, address, token-looking string, client detail),
  since Glide will quote matching ones back into future turns;
- **two or three test phrases** drawn from the user's own work that should match a lasting
  preference.

Run `/glide recall <phrase>` (or ask the user to) for each test phrase and show what would be
quoted. That output comes from code; describe it, don't paraphrase it into something it isn't.

## 3. Let the user decide (user)

Quoting stays off until the user turns it on: `/glide on`, or `hermes glide onboard --enable`
(which turns it on only if every check passed). If they're unsure, leave it off; `/glide off`
undoes it at any time.
