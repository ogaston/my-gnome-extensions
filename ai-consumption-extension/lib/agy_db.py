#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
"""Print Antigravity's conversation summaries as JSON.

Usage: agy_db.py PATH_TO_conversation_summaries.db

GJS has no SQLite binding and the sqlite3 CLI is not installed by default, so
the extension runs this read-only query out of process. Date filtering and all
other processing happen in lib/collect/antigravity.js.
"""

import json
import sqlite3
import sys
import urllib.parse


def read_summaries(db_path):
    uri = "file:" + urllib.parse.quote(db_path) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    try:
        rows = con.execute(
            "SELECT step_count, last_modified_time FROM conversation_summaries"
        ).fetchall()
        recent = con.execute("""
            SELECT title, step_count, last_modified_time, not_fully_idle
            FROM conversation_summaries
            ORDER BY last_modified_time DESC
            LIMIT 5
        """).fetchall()
    finally:
        con.close()
    return {
        "rows": [[steps or 0, "" if modified is None else str(modified)] for steps, modified in rows],
        "recent": [
            {
                "title": title or "",
                "step_count": steps or 0,
                "last_modified": "" if modified is None else str(modified),
                "active": bool(not_idle),
            }
            for title, steps, modified, not_idle in recent
        ],
    }


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: agy_db.py DB_PATH")
    try:
        summaries = read_summaries(sys.argv[1])
    except sqlite3.Error as e:
        sys.exit(f"sqlite error: {e}")
    json.dump(summaries, sys.stdout)


if __name__ == "__main__":
    main()
