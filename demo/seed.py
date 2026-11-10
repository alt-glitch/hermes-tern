"""Seed a Hermes profile with synthetic sessions for a /glide demo. No real data.

    HERMES_HOME=<profile dir> python demo/seed.py

Writes through Hermes' own SessionDB, so the rows match what real chats store.
"""

import os
import time
from pathlib import Path

from hermes_state import SessionDB

SESSIONS = [
    ("cli", [
        ("user", "Set up the frontend build for the dashboard repo."),
        ("assistant", "Running npm install and adding a build script."),
        ("user", "no, use pnpm for the frontend, never npm. The lockfile is pnpm-lock.yaml."),
        ("assistant", "Switched to pnpm."),
    ]),
    ("tui", [
        ("user", "Ship the release branch."),
        ("assistant", "Pushing straight to main."),
        ("user", "Correction: never push to main. Open a PR and wait for CI to pass."),
    ]),
    ("cli", [
        ("user", "Write the migration for the users table."),
        ("assistant", "Here is the migration with tabs for indentation."),
        ("user", "actually, our SQL files use two spaces, not tabs."),
    ]),
    ("desktop", [
        ("user", "Deploy the API."),
        ("assistant", "Deploying to production."),
        ("user", "no, always deploy to staging first and run the smoke tests there."),
    ]),
    ("tui", [
        ("user", "Commit these changes."),
        ("assistant", "Committed."),
        ("user", "actually, sign every commit with my SSH key (git commit -S)."),
    ]),
    ("cron", [  # Not a local chat: glide skips it.
        ("user", "no, this nightly job text is not a correction from you."),
    ]),
]


def main() -> None:
    home = Path(os.environ["HERMES_HOME"])
    db = SessionDB(db_path=home / "state.db")
    start = time.time() - 86_400 * len(SESSIONS)
    try:
        for i, (source, turns) in enumerate(SESSIONS):
            sid = f"glide-demo-{i}"
            db.create_session(sid, source)
            for j, (role, text) in enumerate(turns):
                db.append_message(sid, role, text, timestamp=start + i * 86_400 + j * 60)
    finally:
        db.close()
    print(f"seeded {len(SESSIONS)} synthetic sessions into {home / 'state.db'}")


if __name__ == "__main__":
    main()
