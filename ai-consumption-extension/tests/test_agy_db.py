# SPDX-License-Identifier: GPL-2.0-or-later
# Run with: python3 -B -m unittest discover -s tests  (from the extension directory)
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

HELPER = os.path.join(os.path.dirname(__file__), "..", "lib", "agy_db.py")


class TestAgyDb(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp.name, "conversation summaries.db")

    def tearDown(self):
        self.tmp.cleanup()

    def run_helper(self, *args):
        return subprocess.run([sys.executable, "-B", HELPER, *args], capture_output=True, text=True)

    def make_db(self, rows):
        con = sqlite3.connect(self.db_path)
        con.execute("""
            CREATE TABLE conversation_summaries (
                conversation_id text PRIMARY KEY, title text, workspace_uris text,
                step_count integer, last_modified_time datetime, not_fully_idle numeric
            )
        """)
        con.executemany("INSERT INTO conversation_summaries VALUES (?, ?, '', ?, ?, ?)", rows)
        con.commit()
        con.close()

    def test_rows_and_recent(self):
        self.make_db([
            ("old", "Old", 10, "2026-01-01 10:00:00", 0),
            ("idle", "Today", 25, "2026-10-20 09:30:00", 0),
            ("active", None, None, "2026-10-20 10:00:00", 1),
        ])
        proc = self.run_helper(self.db_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(sorted(out["rows"]), sorted([
            [10, "2026-01-01 10:00:00"], [25, "2026-10-20 09:30:00"], [0, "2026-10-20 10:00:00"],
        ]))
        self.assertEqual(out["recent"][0], {
            "title": "", "step_count": 0, "last_modified": "2026-10-20 10:00:00", "active": True,
        })
        self.assertEqual([r["title"] for r in out["recent"]], ["", "Today", "Old"])

    def test_opens_read_only(self):
        self.make_db([])
        os.chmod(self.db_path, 0o400)
        proc = self.run_helper(self.db_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), {"rows": [], "recent": []})

    def test_errors_exit_nonzero(self):
        proc = self.run_helper(os.path.join(self.tmp.name, "missing.db"))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("sqlite error", proc.stderr)
        self.assertNotEqual(self.run_helper().returncode, 0)


if __name__ == "__main__":
    unittest.main()
