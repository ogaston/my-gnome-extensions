import datetime
import json
import os
import shutil
import sqlite3
import stat
import tempfile
import time
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

    def _claude_line(self, msg_id, output_tokens, timestamp=None, request_id="req-1"):
        return json.dumps({
            "type": "assistant",
            "requestId": request_id,
            "timestamp": timestamp or f"{self.today_str}T10:00:00Z",
            "message": {
                "id": msg_id,
                "model": "claude-sonnet-5-5",
                "usage": {"input_tokens": 10, "output_tokens": output_tokens,
                          "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
            }
        }) + "\n"

    def _claude_project(self, name="proj"):
        claude_dir = os.path.join(self.test_dir, ".claude")
        proj_dir = os.path.join(claude_dir, "projects", name)
        os.makedirs(proj_dir, exist_ok=True)
        return claude_dir, proj_dir

    def _use_timezone(self, tz):
        old_tz = os.environ.get("TZ")
        os.environ["TZ"] = tz
        time.tzset()

        def restore():
            if old_tz is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old_tz
            time.tzset()
        self.addCleanup(restore)

    def test_claude_dedup_streamed_lines(self):
        claude_dir, proj_dir = self._claude_project()
        with open(os.path.join(proj_dir, "s.jsonl"), "w", encoding="utf-8") as f:
            for out in (2, 50, 114):
                f.write(self._claude_line("msg-A", out))

        res = collector.collect_claude_metrics(claude_dir, {}, self.today_str, skip_network=True)
        self.assertEqual(res["today"]["messages"], 1)
        self.assertEqual(res["today"]["output_tokens"], 114)
        self.assertEqual(res["today"]["total_tokens"], 124)
        self.assertEqual(res["lifetime"]["total_tokens"], 124)

    def test_claude_dedup_across_incremental_runs(self):
        claude_dir, proj_dir = self._claude_project()
        session_file = os.path.join(proj_dir, "s.jsonl")
        with open(session_file, "w", encoding="utf-8") as f:
            f.write(self._claude_line("msg-A", 2))

        cache = {}
        res = collector.collect_claude_metrics(claude_dir, cache, self.today_str, skip_network=True)
        self.assertEqual(res["today"]["total_tokens"], 12)

        with open(session_file, "a", encoding="utf-8") as f:
            f.write(self._claude_line("msg-A", 114))
            f.write(self._claude_line("msg-B", 5, request_id="req-2"))

        res = collector.collect_claude_metrics(claude_dir, cache, self.today_str, skip_network=True)
        self.assertEqual(res["today"]["messages"], 2)
        self.assertEqual(res["today"]["output_tokens"], 119)
        self.assertEqual(res["lifetime"]["total_tokens"], 139)

        # Unchanged file served from cache keeps the same totals
        res = collector.collect_claude_metrics(claude_dir, cache, self.today_str, skip_network=True)
        self.assertEqual(res["today"]["total_tokens"], 139)
        self.assertEqual(res["lifetime"]["total_tokens"], 139)

    def test_claude_dedup_across_files_today(self):
        claude_dir, proj_dir = self._claude_project()
        for name in ("original.jsonl", "resumed.jsonl"):
            with open(os.path.join(proj_dir, name), "w", encoding="utf-8") as f:
                f.write(self._claude_line("msg-A", 40))

        res = collector.collect_claude_metrics(claude_dir, {}, self.today_str, skip_network=True)
        self.assertEqual(res["today"]["messages"], 1)
        self.assertEqual(res["today"]["total_tokens"], 50)

    def test_claude_partial_line_not_lost(self):
        claude_dir, proj_dir = self._claude_project()
        session_file = os.path.join(proj_dir, "s.jsonl")
        second = self._claude_line("msg-B", 20, request_id="req-2")
        with open(session_file, "w", encoding="utf-8") as f:
            f.write(self._claude_line("msg-A", 10))
            f.write(second[:40])  # writer is mid-line

        cache = {}
        res = collector.collect_claude_metrics(claude_dir, cache, self.today_str, skip_network=True)
        self.assertEqual(res["today"]["messages"], 1)

        with open(session_file, "a", encoding="utf-8") as f:
            f.write(second[40:])

        res = collector.collect_claude_metrics(claude_dir, cache, self.today_str, skip_network=True)
        self.assertEqual(res["today"]["messages"], 2)
        self.assertEqual(res["today"]["total_tokens"], 50)

    def test_claude_today_uses_local_timezone(self):
        self._use_timezone("America/Bogota")  # UTC-5, no DST
        claude_dir, proj_dir = self._claude_project()
        with open(os.path.join(proj_dir, "s.jsonl"), "w", encoding="utf-8") as f:
            # 21:00 local on the 20th -> counts
            f.write(self._claude_line("msg-late", 1, timestamp="2026-10-21T02:00:00.000Z"))
            # 22:00 local on the 19th -> does not count
            f.write(self._claude_line("msg-early", 100, timestamp="2026-10-20T03:00:00.000Z", request_id="req-2"))

        res = collector.collect_claude_metrics(claude_dir, {}, "2026-10-20", skip_network=True)
        self.assertEqual(res["today"]["messages"], 1)
        self.assertEqual(res["today"]["output_tokens"], 1)

    def test_antigravity_today_uses_local_timezone(self):
        self._use_timezone("America/Bogota")
        ag_dir = os.path.join(self.test_dir, "antigravity-cli")
        os.makedirs(ag_dir, exist_ok=True)
        con = sqlite3.connect(os.path.join(ag_dir, "conversation_summaries.db"))
        con.execute("""
            CREATE TABLE conversation_summaries (
                conversation_id text PRIMARY KEY, title text, workspace_uris text,
                step_count integer, last_modified_time datetime, not_fully_idle numeric
            )
        """)
        con.executemany("INSERT INTO conversation_summaries VALUES (?, 't', '', ?, ?, 0)", [
            ("yesterday-evening", 7, "2026-10-20 03:12:00.187888088+00:00"),
            ("today-morning", 5, "2026-10-20 15:27:23.0099021+00:00"),
            ("today-night", 3, "2026-10-21 02:30:00.5+00:00"),
        ])
        con.commit()
        con.close()

        res = collector.collect_antigravity_metrics(ag_dir, "2026-10-20")
        self.assertEqual(res["today"]["conversations"], 2)
        self.assertEqual(res["today"]["steps"], 8)
        self.assertEqual(res["lifetime"]["steps"], 15)

    def test_antigravity_placeholder_year_one_row(self):
        # Antigravity keeps a 0001-01-01 UTC placeholder row; converting it to a
        # negative-offset zone overflows and used to abort the whole DB read.
        self._use_timezone("America/Bogota")
        ag_dir = os.path.join(self.test_dir, "antigravity-cli")
        os.makedirs(ag_dir, exist_ok=True)
        con = sqlite3.connect(os.path.join(ag_dir, "conversation_summaries.db"))
        con.execute("""
            CREATE TABLE conversation_summaries (
                conversation_id text PRIMARY KEY, title text, workspace_uris text,
                step_count integer, last_modified_time datetime, not_fully_idle numeric
            )
        """)
        con.executemany("INSERT INTO conversation_summaries VALUES (?, ?, '', ?, ?, 0)", [
            ("placeholder", "", 0, "0001-01-01 00:00:00+00:00"),
            ("today", "Recent chat", 4, "2026-10-20 15:27:23.0099021+00:00"),
        ])
        con.commit()
        con.close()

        self.assertEqual(collector.to_local_date("0001-01-01 00:00:00+00:00"), "")
        res = collector.collect_antigravity_metrics(ag_dir, "2026-10-20")
        self.assertEqual(res["status"], "ok")
        self.assertEqual(res["today"]["conversations"], 1)
        self.assertEqual(res["today"]["steps"], 4)
        self.assertEqual(res["active_sessions"][0]["title"], "Recent chat")

    def test_disabled_providers_skip_collection(self):
        claude_dir = os.path.join(self.test_dir, ".claude")
        ag_dir = os.path.join(self.test_dir, "antigravity-cli")
        os.makedirs(claude_dir)
        os.makedirs(ag_dir)
        claude_res = collector.collect_claude_metrics(claude_dir, {}, self.today_str, disabled=True)
        ag_res = collector.collect_antigravity_metrics(ag_dir, self.today_str, cache={}, disabled=True)
        self.assertEqual(claude_res["status"], "disabled")
        self.assertEqual(ag_res["status"], "disabled")
        self.assertEqual(ag_res["oauth_quota"], {})

    def test_save_cache_private_and_atomic(self):
        cache_path = os.path.join(self.test_dir, "cache-dir", "cache.json")
        collector.save_cache(cache_path, {"a": 1})
        self.assertEqual(stat.S_IMODE(os.stat(cache_path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(cache_path)).st_mode), 0o700)
        self.assertEqual(collector.load_cache(cache_path), {"a": 1})

        # A symlink planted at the cache path is replaced, never written through
        victim = os.path.join(self.test_dir, "victim.txt")
        with open(victim, "w", encoding="utf-8") as f:
            f.write("keep me")
        os.unlink(cache_path)
        os.symlink(victim, cache_path)
        collector.save_cache(cache_path, {"b": 2})
        self.assertFalse(os.path.islink(cache_path))
        with open(victim, encoding="utf-8") as f:
            self.assertEqual(f.read(), "keep me")
        self.assertEqual(collector.load_cache(cache_path), {"b": 2})
        self.assertEqual(os.listdir(os.path.dirname(cache_path)), ["cache.json"])

    def test_default_cache_path_respects_xdg(self):
        old = os.environ.get("XDG_CACHE_HOME")
        self.addCleanup(lambda: os.environ.__setitem__("XDG_CACHE_HOME", old) if old is not None
                        else os.environ.pop("XDG_CACHE_HOME", None))
        os.environ["XDG_CACHE_HOME"] = self.test_dir
        self.assertEqual(collector.default_cache_path(),
                         os.path.join(self.test_dir, "ai-consumption-monitor", "cache.json"))

    def test_remove_legacy_cache(self):
        legacy = os.path.join(self.test_dir, "legacy.json")
        with open(legacy, "w", encoding="utf-8") as f:
            f.write("{}")
        collector.remove_legacy_cache(legacy)
        self.assertFalse(os.path.exists(legacy))

        target = os.path.join(self.test_dir, "target.json")
        with open(target, "w", encoding="utf-8") as f:
            f.write("{}")
        os.symlink(target, legacy)
        collector.remove_legacy_cache(legacy)
        self.assertTrue(os.path.islink(legacy))
        self.assertTrue(os.path.exists(target))

if __name__ == "__main__":
    unittest.main()
