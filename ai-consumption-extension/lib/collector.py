#!/usr/bin/env python3
"""
Metrics Collector for Claude Code and Antigravity / Gemini.
Gathers live OAuth quota percentages (5-hour window, weekly limits, model quotas),
token usage, session activity, and step counts from local data and APIs.
"""

import argparse
import datetime
import glob
import json
import os
import re
import sqlite3
import stat
import tempfile
import urllib.request

OAUTH_CACHE_TTL_SECONDS = 60
LEGACY_CACHE_PATH = "/tmp/ai-consumption-cache.json"


def parse_args():
    parser = argparse.ArgumentParser(description="AI Consumption Collector")
    parser.add_argument("--claude-dir", default="", help="Custom Claude directory")
    parser.add_argument("--antigravity-dir", default="", help="Custom Antigravity directory")
    parser.add_argument("--cache-file", default="", help="Path to cache file for incremental parsing")
    parser.add_argument("--reset-cache", action="store_true", help="Force re-reading all files and APIs")
    parser.add_argument("--skip-network", action="store_true", help="Skip live OAuth quota API requests")
    parser.add_argument("--skip-claude", action="store_true", help="Do not collect Claude Code metrics")
    parser.add_argument("--skip-antigravity", action="store_true", help="Do not collect Antigravity metrics")
    return parser.parse_args()


def to_local_date(ts):
    """Return the local YYYY-MM-DD for an ISO-8601 timestamp ('' if unparseable).

    Timestamps without an offset are assumed to already be in local time.
    """
    if not ts:
        return ""
    s = str(ts).strip().replace(" ", "T", 1)
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # fromisoformat accepts at most 6 fractional digits (Antigravity writes 9).
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    try:
        dt = datetime.datetime.fromisoformat(s)
        if dt.tzinfo is not None:
            dt = dt.astimezone()
    # Antigravity stores placeholder rows dated 0001-01-01 UTC, which overflow
    # when shifted into a negative-offset local zone.
    except (ValueError, OverflowError):
        return ""
    return dt.date().isoformat()


def is_today(ts, today_str):
    return to_local_date(ts) == today_str


def default_cache_path():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "ai-consumption-monitor", "cache.json")


def load_cache(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            cache = json.load(f)
        return cache if isinstance(cache, dict) else {}
    except Exception:
        return {}


def save_cache(path, cache):
    """Write the cache privately (0600) and atomically via rename."""
    cache_dir = os.path.dirname(path) or "."
    os.makedirs(cache_dir, mode=0o700, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=cache_dir, prefix=".cache-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cache, f)
            f.flush()
            os.fsync(f.fileno())
        # os.replace swaps the directory entry, so a planted symlink is replaced, not followed.
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def remove_legacy_cache(path=LEGACY_CACHE_PATH):
    """Delete the old world-readable /tmp cache, only if it is our own regular file."""
    try:
        st = os.lstat(path)
        if stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid():
            os.unlink(path)
    except OSError:
        pass


def is_pid_active(pid, process_filter=None):
    """Check if a process is still running and optionally matches a name."""
    try:
        pid = int(pid)
        if not os.path.exists(f"/proc/{pid}"):
            return False
        if process_filter:
            cmdline_path = f"/proc/{pid}/cmdline"
            if os.path.exists(cmdline_path):
                with open(cmdline_path, "rb") as f:
                    cmdline = f.read().decode("utf-8", errors="ignore").replace("\x00", " ")
                    if process_filter.lower() not in cmdline.lower():
                        return False
        return True
    except (ValueError, OSError):
        return False


def get_claude_active_sessions(claude_dir):
    sessions_dir = os.path.join(claude_dir, "sessions")
    active_sessions = []
    if not os.path.isdir(sessions_dir):
        return active_sessions

    for session_file in glob.glob(os.path.join(sessions_dir, "*.json")):
        try:
            with open(session_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                pid = data.get("pid")
                if pid and is_pid_active(pid, "claude"):
                    active_sessions.append({
                        "pid": pid,
                        "session_id": data.get("sessionId", ""),
                        "name": data.get("name") or os.path.basename(data.get("cwd", "")),
                        "cwd": data.get("cwd", ""),
                        "started_at": data.get("startedAt", ""),
                        "status": data.get("status", "running")
                    })
        except Exception:
            continue
    return active_sessions


def fetch_claude_oauth_quota(claude_dir, cache, force_refresh=False):
    """Fetch 5h, 7d, and extra usage quota from Anthropic OAuth endpoint."""
    now_ts = datetime.datetime.now(datetime.timezone.utc).timestamp()
    cached_oauth = cache.get("claude_oauth")
    if (not force_refresh and cached_oauth and
            (now_ts - cached_oauth.get("fetched_ts", 0)) < OAUTH_CACHE_TTL_SECONDS):
        return cached_oauth.get("data", {})

    cred_path = os.path.join(claude_dir, ".credentials.json")
    if not os.path.exists(cred_path):
        return cached_oauth.get("data", {}) if cached_oauth else {}

    plan_label = "Pro"
    try:
        with open(cred_path, "r", encoding="utf-8") as f:
            cred_root = json.load(f)
        oauth = cred_root.get("claudeAiOauth", {})
        sub_type = oauth.get("subscriptionType", "pro")
        tier = oauth.get("rateLimitTier", "")
        plan_label = "Max (20x)" if "20x" in tier else ("Max (5x)" if "5x" in tier else sub_type.capitalize())
        access_token = oauth.get("accessToken")
        if not access_token:
            return {"plan_label": plan_label}

        req = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/usage",
            headers={
                "Authorization": f"Bearer {access_token}",
                "anthropic-beta": "oauth-2025-04-20",
                "User-Agent": "ai-consumption-monitor/1.0"
            }
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            payload = json.loads(resp.read().decode("utf-8"))

        five_h = payload.get("five_hour") or {}
        seven_d = payload.get("seven_day") or {}
        promo = payload.get("iguana_necktie") or {}
        extra = payload.get("extra_usage") or {}
        spend = payload.get("spend") or {}
        breakdown = (payload.get("seven_day_breakdown") or {}).get("rows", [])

        quota_data = {
            "plan_label": plan_label,
            "five_hour": {
                "used_percent": float(five_h.get("utilization") or 0.0),
                "remaining_percent": max(0.0, 100.0 - float(five_h.get("utilization") or 0.0)),
                "resets_at": five_h.get("resets_at") or ""
            },
            "seven_day": {
                "used_percent": float(seven_d.get("utilization") or 0.0),
                "remaining_percent": max(0.0, 100.0 - float(seven_d.get("utilization") or 0.0)),
                "resets_at": seven_d.get("resets_at") or ""
            },
            "extra_usage": {
                "enabled": bool(extra.get("is_enabled") or spend.get("enabled") or promo.get("limit_dollars")),
                "used_percent": float(promo.get("utilization") or extra.get("utilization") or spend.get("percent") or 0.0),
                "used_dollars": float(promo.get("used_dollars") or extra.get("used_credits") or 0.0),
                "limit_dollars": float(promo.get("limit_dollars") or extra.get("monthly_limit") or 0.0),
                "remaining_dollars": float(promo.get("remaining_dollars") or 0.0),
                "currency": extra.get("currency") or "USD",
                "resets_at": promo.get("resets_at") or ""
            },
            "breakdown": breakdown
        }
        cache["claude_oauth"] = {
            "fetched_ts": now_ts,
            "data": quota_data
        }
        return quota_data
    except Exception:
        return cached_oauth.get("data", {"plan_label": plan_label}) if cached_oauth else {"plan_label": plan_label}


def parse_claude_jsonl(file_path, start_offset=0):
    """Reads newly appended assistant usage metrics from a Claude JSONL file."""
    usage_entries = []
    new_offset = start_offset
    try:
        with open(file_path, "rb") as f:
            if start_offset > 0:
                f.seek(start_offset)
            while True:
                raw = f.readline()
                if not raw.endswith(b"\n"):
                    # EOF, or a line still being written: re-read it on the next run.
                    break
                new_offset += len(raw)
                line_str = raw.decode("utf-8", errors="ignore").strip()
                if not line_str:
                    continue
                try:
                    obj = json.loads(line_str)
                    if obj.get("type") == "assistant" and "message" in obj:
                        msg = obj.get("message", {})
                        usage = msg.get("usage")
                        if usage:
                            msg_id = msg.get("id")
                            usage_entries.append({
                                # Claude Code repeats usage on one line per content block.
                                "key": f"{msg_id}:{obj.get('requestId')}" if msg_id else None,
                                "timestamp": obj.get("timestamp", ""),
                                "model": msg.get("model", "unknown"),
                                "input_tokens": usage.get("input_tokens", 0),
                                "output_tokens": usage.get("output_tokens", 0),
                                "cache_creation": usage.get("cache_creation_input_tokens", 0),
                                "cache_read": usage.get("cache_read_input_tokens", 0)
                            })
                except json.JSONDecodeError:
                    continue
    except Exception:
        pass
    return usage_entries, new_offset


def _entry_tokens(e):
    return (e.get("input_tokens", 0) + e.get("output_tokens", 0) +
            e.get("cache_creation", 0) + e.get("cache_read", 0))


def _collect_today(today_by_key, entries, today_str, file_path):
    """Merge a file's today entries, keeping the largest usage per message key."""
    for i, e in enumerate(entries):
        if not is_today(e.get("timestamp", ""), today_str):
            continue
        k = e.get("key") or (file_path, i)
        prev = today_by_key.get(k)
        if prev is None or _entry_tokens(e) > _entry_tokens(prev):
            today_by_key[k] = e


def collect_claude_metrics(claude_dir, cache, today_str, skip_network=False, force_refresh=False, disabled=False):
    res = {
        "active_sessions": [],
        "active_count": 0,
        "today": {
            "input_tokens": 0,
            "output_tokens": 0,
            "cache_creation_tokens": 0,
            "cache_read_tokens": 0,
            "total_tokens": 0,
            "messages": 0
        },
        "lifetime": {
            "total_tokens": 0,
            "total_sessions": 0
        },
        "models": {},
        "oauth_quota": {},
        "status": "ok"
    }

    if disabled:
        res["status"] = "disabled"
        return res

    if not os.path.isdir(claude_dir):
        res["status"] = "not_found"
        return res

    res["active_sessions"] = get_claude_active_sessions(claude_dir)
    res["active_count"] = len(res["active_sessions"])

    if not skip_network:
        res["oauth_quota"] = fetch_claude_oauth_quota(claude_dir, cache, force_refresh=force_refresh)

    projects_dir = os.path.join(claude_dir, "projects")
    jsonl_files = glob.glob(os.path.join(projects_dir, "*", "*.jsonl"))
    res["lifetime"]["total_sessions"] = len(jsonl_files)

    file_cache = cache.get("claude_files", {})
    new_file_cache = {}
    # Today's entries across all files, deduplicated by message key (resumed
    # sessions copy history into new files). Lifetime is only deduplicated
    # within a file; cross-file dedup would require caching every key.
    today_by_key = {}

    for jf in jsonl_files:
        try:
            st = os.stat(jf)
            cached_info = file_cache.get(jf)

            if (cached_info and
                    cached_info.get("mtime") == st.st_mtime and
                    cached_info.get("size") == st.st_size):
                new_file_cache[jf] = cached_info
                res["lifetime"]["total_tokens"] += cached_info.get("lifetime_tokens", 0)
                _collect_today(today_by_key, cached_info.get("today_entries", []), today_str, jf)
                continue

            start_offset = 0
            lifetime = 0
            today_entries = []
            last_key = None
            last_tokens = 0
            if cached_info and st.st_size >= cached_info.get("size", 0):
                start_offset = cached_info.get("offset", 0)
                lifetime = cached_info.get("lifetime_tokens", 0)
                today_entries = [e for e in cached_info.get("today_entries", [])
                                 if is_today(e.get("timestamp", ""), today_str)]
                last_key = cached_info.get("last_key")
                last_tokens = cached_info.get("last_tokens", 0)

            entries, new_offset = parse_claude_jsonl(jf, start_offset)

            for e in entries:
                tot = _entry_tokens(e)
                if e["key"] is not None and e["key"] == last_key:
                    # Later line of the same streamed message: its usage supersedes the previous one.
                    lifetime += tot - last_tokens
                    if today_entries and today_entries[-1].get("key") == last_key:
                        today_entries.pop()
                else:
                    lifetime += tot
                if is_today(e.get("timestamp", ""), today_str):
                    today_entries.append(e)
                last_key, last_tokens = e["key"], tot

            res["lifetime"]["total_tokens"] += lifetime
            _collect_today(today_by_key, today_entries, today_str, jf)

            new_file_cache[jf] = {
                "mtime": st.st_mtime,
                "size": st.st_size,
                "offset": new_offset,
                "lifetime_tokens": lifetime,
                "today_entries": today_entries,
                "last_key": last_key,
                "last_tokens": last_tokens
            }
        except Exception:
            continue

    for entry in today_by_key.values():
        res["today"]["input_tokens"] += entry.get("input_tokens", 0)
        res["today"]["output_tokens"] += entry.get("output_tokens", 0)
        res["today"]["cache_creation_tokens"] += entry.get("cache_creation", 0)
        res["today"]["cache_read_tokens"] += entry.get("cache_read", 0)
        res["today"]["messages"] += 1
        m = entry.get("model", "unknown")
        res["models"][m] = res["models"].get(m, 0) + entry.get("input_tokens", 0) + entry.get("output_tokens", 0)

    cache["claude_files"] = new_file_cache
    res["today"]["total_tokens"] = (
        res["today"]["input_tokens"] +
        res["today"]["output_tokens"] +
        res["today"]["cache_creation_tokens"] +
        res["today"]["cache_read_tokens"]
    )
    return res


def get_antigravity_access_token(ag_dir):
    """Retrieve Antigravity OAuth access token from libsecret keyring or local file."""
    try:
        import gi
        gi.require_version("Secret", "1")
        from gi.repository import Secret
        service = Secret.Service.get_sync(Secret.ServiceFlags.LOAD_COLLECTIONS, None)
        for coll in service.get_collections():
            for item in coll.get_items():
                attrs = item.get_attributes()
                if attrs.get("service") == "gemini" and attrs.get("username") == "antigravity":
                    item.load_secret_sync(None)
                    secret_text = item.get_secret().get_text()
                    if secret_text:
                        tok_obj = json.loads(secret_text)
                        tok = tok_obj.get("token", {}).get("access_token") or tok_obj.get("access_token")
                        if tok:
                            return tok
    except Exception:
        pass

    tok_file = os.path.join(ag_dir, "antigravity-oauth-token")
    if os.path.exists(tok_file):
        try:
            with open(tok_file, "r", encoding="utf-8") as f:
                tok_obj = json.load(f)
            return tok_obj.get("token", {}).get("access_token") or tok_obj.get("access_token")
        except Exception:
            pass
    return None


def fetch_antigravity_oauth_quota(ag_dir, cache, force_refresh=False):
    """Fetch Gemini and 3P model quotas from Antigravity backend."""
    now_ts = datetime.datetime.now(datetime.timezone.utc).timestamp()
    cached_ag = cache.get("antigravity_oauth")
    if (not force_refresh and cached_ag and
            (now_ts - cached_ag.get("fetched_ts", 0)) < OAUTH_CACHE_TTL_SECONDS):
        return cached_ag.get("data", {})

    access_token = get_antigravity_access_token(ag_dir)
    if not access_token:
        return cached_ag.get("data", {}) if cached_ag else {}

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "User-Agent": "antigravity/1.4.3 linux/amd64"
    }

    result = {
        "gemini": {
            "model_name": "Gemini 2.5 & 3.1 Pro",
            "used_percent": 0.0,
            "remaining_percent": 100.0,
            "resets_at": ""
        },
        "third_party_5h": {
            "used_percent": 0.0,
            "remaining_percent": 100.0,
            "resets_at": ""
        },
        "third_party_weekly": {
            "used_percent": 0.0,
            "remaining_percent": 100.0,
            "resets_at": ""
        },
        "models_list": []
    }

    try:
        req_models = urllib.request.Request(
            "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
            data=b"{}",
            headers=headers,
            method="POST"
        )
        with urllib.request.urlopen(req_models, timeout=8) as resp:
            models_payload = json.loads(resp.read().decode("utf-8"))

        models_map = models_payload.get("models", {})
        for key, m in models_map.items():
            q = m.get("quotaInfo") or {}
            rem = q.get("remainingFraction")
            if rem is None:
                continue
            rem_pct = round(float(rem) * 100.0, 1)
            used_pct = round(max(0.0, 100.0 - rem_pct), 1)
            reset_time = q.get("resetTime", "")
            disp = m.get("displayName")
            if disp:
                result["models_list"].append({
                    "id": key,
                    "name": disp,
                    "used_percent": used_pct,
                    "remaining_percent": rem_pct,
                    "resets_at": reset_time
                })
            if key.startswith("gemini-") and reset_time:
                result["gemini"] = {
                    "model_name": disp or "Gemini 3.8 Flash",
                    "used_percent": used_pct,
                    "remaining_percent": rem_pct,
                    "resets_at": reset_time
                }

        req_quota = urllib.request.Request(
            "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
            data=b"{}",
            headers=headers,
            method="POST"
        )
        with urllib.request.urlopen(req_quota, timeout=8) as resp:
            quota_payload = json.loads(resp.read().decode("utf-8"))

        for group in quota_payload.get("groups", []):
            for bucket in group.get("buckets", []):
                bid = bucket.get("bucketId", "")
                rem = float(bucket.get("remainingFraction", 1.0))
                rem_pct = round(rem * 100.0, 1)
                used_pct = round(max(0.0, 100.0 - rem_pct), 1)
                entry = {
                    "used_percent": used_pct,
                    "remaining_percent": rem_pct,
                    "resets_at": bucket.get("resetTime", "")
                }
                if bid == "3p-5h":
                    result["third_party_5h"] = entry
                elif bid == "3p-weekly":
                    result["third_party_weekly"] = entry

        cache["antigravity_oauth"] = {
            "fetched_ts": now_ts,
            "data": result
        }
        return result
    except Exception:
        return cached_ag.get("data", {}) if cached_ag else result


def collect_antigravity_metrics(ag_dir, today_str, cache=None, skip_network=False, force_refresh=False,
                                disabled=False):
    res = {
        "active_sessions": [],
        "active_count": 0,
        "today": {
            "steps": 0,
            "conversations": 0
        },
        "lifetime": {
            "conversations": 0,
            "steps": 0
        },
        "quota": {
            "status": "healthy",
            "last_checked": "",
            "details": "Quota ok"
        },
        "oauth_quota": {},
        "status": "ok"
    }

    if disabled:
        res["status"] = "disabled"
        return res

    if not os.path.isdir(ag_dir):
        res["status"] = "not_found"
        return res

    if not skip_network and cache is not None:
        res["oauth_quota"] = fetch_antigravity_oauth_quota(ag_dir, cache, force_refresh=force_refresh)

    db_path = os.path.join(ag_dir, "conversation_summaries.db")
    if os.path.exists(db_path):
        try:
            con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            cur = con.cursor()

            cur.execute("SELECT count(*), coalesce(sum(step_count), 0) FROM conversation_summaries")
            row = cur.fetchone()
            if row:
                res["lifetime"]["conversations"] = row[0]
                res["lifetime"]["steps"] = row[1]

            # Timestamps are stored in UTC, so "today" is filtered by local date in Python.
            cur.execute("SELECT step_count, last_modified_time FROM conversation_summaries")
            for steps, lmt in cur.fetchall():
                if is_today(lmt, today_str):
                    res["today"]["conversations"] += 1
                    res["today"]["steps"] += steps or 0

            cur.execute("""
                SELECT conversation_id, title, workspace_uris, step_count, last_modified_time, not_fully_idle
                FROM conversation_summaries
                ORDER BY last_modified_time DESC
                LIMIT 5
            """)
            recent_rows = cur.fetchall()
            for r in recent_rows:
                cid, title, ws, steps, lmt, not_idle = r
                is_active = bool(not_idle)
                ws_name = ""
                if ws:
                    try:
                        parsed_ws = json.loads(ws)
                        if isinstance(parsed_ws, list) and parsed_ws:
                            ws_name = os.path.basename(parsed_ws[0].rstrip("/"))
                        else:
                            ws_name = os.path.basename(str(ws).rstrip("/"))
                    except Exception:
                        ws_clean = ws.strip('[]"\'')
                        ws_name = os.path.basename(ws_clean.rstrip("/"))
                res["active_sessions"].append({
                    "conversation_id": cid,
                    "title": title or "Conversation",
                    "workspace": ws_name,
                    "step_count": steps,
                    "last_modified": str(lmt),
                    "active": is_active
                })
                if is_active:
                    res["active_count"] += 1
            con.close()
        except Exception as e:
            res["status"] = f"db_error: {str(e)}"

    if res["oauth_quota"].get("gemini"):
        res["quota"]["status"] = "healthy"
        res["quota"]["details"] = "All Systems Operational"
        res["quota"]["last_checked"] = datetime.datetime.now().strftime("%H:%M:%S")
    else:
        logs_dir = os.path.join(ag_dir, "log")
        if os.path.isdir(logs_dir):
            log_files = sorted(glob.glob(os.path.join(logs_dir, "*.log")), key=os.path.getmtime, reverse=True)
            if log_files:
                latest_log = log_files[0]
                try:
                    with open(latest_log, "r", errors="ignore") as f:
                        lines = f.readlines()[-200:]
                        for line in reversed(lines):
                            if "quota_manager.go:" in line:
                                if "Failed" in line or "Unknown Error" in line:
                                    res["quota"]["status"] = "warning"
                                    res["quota"]["details"] = "Quota refresh issue"
                                    res["quota"]["last_checked"] = line[:15]
                                    break
                                elif "doRefreshQuota: starting reload" in line:
                                    res["quota"]["status"] = "healthy"
                                    res["quota"]["details"] = "Refreshed successfully"
                                    res["quota"]["last_checked"] = line[:15]
                                    break
                except Exception:
                    pass

    return res


def main():
    args = parse_args()
    home = os.path.expanduser("~")
    claude_dir = args.claude_dir if args.claude_dir else os.path.join(home, ".claude")
    ag_dir = args.antigravity_dir if args.antigravity_dir else os.path.join(home, ".gemini", "antigravity-cli")
    cache_path = args.cache_file if args.cache_file else default_cache_path()
    remove_legacy_cache()

    cache = {} if args.reset_cache else load_cache(cache_path)

    today_str = datetime.datetime.now().strftime("%Y-%m-%d")

    claude_data = collect_claude_metrics(
        claude_dir, cache, today_str,
        skip_network=args.skip_network,
        force_refresh=args.reset_cache,
        disabled=args.skip_claude
    )
    ag_data = collect_antigravity_metrics(
        ag_dir, today_str, cache=cache,
        skip_network=args.skip_network,
        force_refresh=args.reset_cache,
        disabled=args.skip_antigravity
    )

    try:
        save_cache(cache_path, cache)
    except Exception:
        pass

    total_active = claude_data["active_count"] + ag_data["active_count"]
    warning_reasons = []
    if ag_data["quota"]["status"] == "warning":
        warning_reasons.append("Antigravity quota refresh warning")

    output = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "claude": claude_data,
        "antigravity": ag_data,
        "summary": {
            "total_active_sessions": total_active,
            "warning": len(warning_reasons) > 0,
            "warning_reasons": warning_reasons
        }
    }

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
