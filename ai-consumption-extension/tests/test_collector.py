import datetime
import json
import os
import shutil
import sqlite3
import tempfile
import unittest

# Import collector modules
import sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "lib")))
import collector

class TestCollector(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.today_str = datetime.datetime.now().strftime("%Y-%m-%d")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_missing_directories(self):
        non_existent = os.path.join(self.test_dir, "does_not_exist")
        claude_res = collector.collect_claude_metrics(non_existent, {}, self.today_str)
        self.assertEqual(claude_res["status"], "not_found")
        self.assertEqual(claude_res["today"]["total_tokens"], 0)

        ag_res = collector.collect_antigravity_metrics(non_existent, self.today_str)
        self.assertEqual(ag_res["status"], "not_found")
        self.assertEqual(ag_res["today"]["steps"], 0)

    def test_claude_jsonl_and_cache(self):
        claude_dir = os.path.join(self.test_dir, ".claude")
        proj_dir = os.path.join(claude_dir, "projects", "sample-project")
        os.makedirs(proj_dir, exist_ok=True)
        session_file = os.path.join(proj_dir, "session-1.jsonl")

        # Write first line
        msg1 = {
            "type": "assistant",
            "timestamp": f"{self.today_str}T10:00:00Z",
            "message": {
                "model": "claude-sonnet-5-5",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_creation_input_tokens": 200,
                    "cache_read_input_tokens": 300
                }
            }
        }
        with open(session_file, "w", encoding="utf-8") as f:
            f.write(json.dumps(msg1) + "\n")

        cache = {}
        res = collector.collect_claude_metrics(claude_dir, cache, self.today_str)
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["today"]["input_tokens"], 100)
        self.assertEqual(res["today"]["output_tokens"], 50)
        self.assertEqual(res["today"]["cache_creation_tokens"], 200)
        self.assertEqual(res["today"]["cache_read_tokens"], 300)
        self.assertEqual(res["today"]["total_tokens"], 650)
        self.assertEqual(res["today"]["messages"], 1)
        self.assertEqual(res["models"].get("claude-sonnet-5-5"), 150)

        # Re-run with cache (no changes)
        res2 = collector.collect_claude_metrics(claude_dir, cache, self.today_str)
        self.assertEqual(res2["today"]["total_tokens"], 650)
        self.assertEqual(res2["today"]["messages"], 1)

        # Append second line
        msg2 = {
            "type": "assistant",
            "timestamp": f"{self.today_str}T10:15:00Z",
            "message": {
                "model": "claude-sonnet-5-5",
                "usage": {
                    "input_tokens": 50,
                    "output_tokens": 25,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 100
                }
            }
        }
        with open(session_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(msg2) + "\n")

        # Run with cache (incremental update)
        res3 = collector.collect_claude_metrics(claude_dir, cache, self.today_str)
        self.assertEqual(res3["today"]["input_tokens"], 150)
        self.assertEqual(res3["today"]["output_tokens"], 75)
        self.assertEqual(res3["today"]["total_tokens"], 825)
        self.assertEqual(res3["today"]["messages"], 2)

    def test_claude_corrupted_jsonl(self):
        claude_dir = os.path.join(self.test_dir, ".claude")
        proj_dir = os.path.join(claude_dir, "projects", "bad-proj")
        os.makedirs(proj_dir, exist_ok=True)
        session_file = os.path.join(proj_dir, "bad-session.jsonl")

        with open(session_file, "w", encoding="utf-8") as f:
            f.write("Not valid JSON at all\n")
            f.write("\n")
            f.write('{"type": "user", "content": "hi"}\n')
            f.write(json.dumps({
                "type": "assistant",
                "timestamp": f"{self.today_str}T11:00:00Z",
                "message": {
                    "model": "claude-haiku-4-5",
                    "usage": {"input_tokens": 20, "output_tokens": 10, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
                }
            }) + "\n")

        cache = {}
        res = collector.collect_claude_metrics(claude_dir, cache, self.today_str)
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["today"]["total_tokens"], 30)
        self.assertEqual(res["today"]["messages"], 1)

    def test_antigravity_sqlite_parsing(self):
        ag_dir = os.path.join(self.test_dir, "antigravity-cli")
        os.makedirs(ag_dir, exist_ok=True)
        db_path = os.path.join(ag_dir, "conversation_summaries.db")

        con = sqlite3.connect(db_path)
        cur = con.cursor()
        cur.execute("""
            CREATE TABLE conversation_summaries (
                conversation_id text PRIMARY KEY,
                title text,
                workspace_uris text,
                step_count integer,
                last_modified_time datetime,
                not_fully_idle numeric
            )
        """)
        # Insert old record
        cur.execute("""
            INSERT INTO conversation_summaries VALUES 
            ('old-1', 'Old Conversation', '/home/user/projA', 10, '2026-01-01 10:00:00', 0)
        """)
        # Insert today record (idle)
        cur.execute("""
            INSERT INTO conversation_summaries VALUES 
            ('today-1', 'Today Conversation', '/home/user/projB', 25, ?, 0)
        """, (f"{self.today_str} 09:30:00",))
        # Insert today record (active)
        cur.execute("""
            INSERT INTO conversation_summaries VALUES 
            ('today-2', 'Active Conversation', '/home/user/projC', 40, ?, 1)
        """, (f"{self.today_str} 10:00:00",))
        con.commit()
        con.close()

        res = collector.collect_antigravity_metrics(ag_dir, self.today_str)
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["lifetime"]["conversations"], 3)
        self.assertEqual(res["lifetime"]["steps"], 75)
        self.assertEqual(res["today"]["conversations"], 2)
        self.assertEqual(res["today"]["steps"], 65)
        self.assertEqual(res["active_count"], 1)
        self.assertEqual(len(res["active_sessions"]), 3)

if __name__ == "__main__":
    unittest.main()
