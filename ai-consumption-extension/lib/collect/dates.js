// SPDX-License-Identifier: GPL-2.0-or-later
import GLib from 'gi://GLib';

// Local YYYY-MM-DD for an ISO-8601 timestamp, or '' if it can't be parsed.
// Timestamps without an offset are taken as local time. Antigravity's
// 0001-01-01 UTC placeholder rows fall outside GLib's range in negative-offset
// zones, so they also map to ''.
export function toLocalDate(ts) {
    if (!ts) return '';
    const dt = GLib.DateTime.new_from_iso8601(String(ts).trim(), GLib.TimeZone.new_local());
    return dt?.to_local()?.format('%Y-%m-%d') ?? '';
}

export function isToday(ts, today) {
    return toLocalDate(ts) === today;
}

export function todayString() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d');
}

export function nowSeconds() {
    return GLib.get_real_time() / 1e6;
}
