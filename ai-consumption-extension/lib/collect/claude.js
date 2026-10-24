// SPDX-License-Identifier: GPL-2.0-or-later
import { OAUTH_CACHE_TTL_SECONDS } from './cache.js';
import { isToday, nowSeconds } from './dates.js';
import { buildPath, isDirectory, listDir, readJson, readLinesFrom, statFile } from './files.js';
import { fetchJson } from './http.js';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function emptyResult(status) {
    return {
        status,
        today: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 0,
            messages: 0,
        },
        lifetime: { total_tokens: 0 },
        oauth_quota: {},
    };
}

function capitalize(s) {
    return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

function planLabel(oauth) {
    const tier = oauth.rateLimitTier || '';
    if (tier.includes('20x')) return 'Max (20x)';
    if (tier.includes('5x')) return 'Max (5x)';
    return capitalize(oauth.subscriptionType || 'pro');
}

function quotaWindow(window) {
    const used = Number(window?.utilization || 0);
    return {
        used_percent: used,
        remaining_percent: Math.max(0, 100 - used),
        resets_at: window?.resets_at || '',
    };
}

export function parseUsagePayload(payload, plan) {
    const promo = payload.iguana_necktie || {};
    const extra = payload.extra_usage || {};
    const spend = payload.spend || {};
    return {
        plan_label: plan,
        five_hour: quotaWindow(payload.five_hour),
        seven_day: quotaWindow(payload.seven_day),
        extra_usage: {
            enabled: Boolean(extra.is_enabled || spend.enabled || promo.limit_dollars),
            used_percent: Number(promo.utilization || extra.utilization || spend.percent || 0),
            used_dollars: Number(promo.used_dollars || extra.used_credits || 0),
            limit_dollars: Number(promo.limit_dollars || extra.monthly_limit || 0),
            remaining_dollars: Number(promo.remaining_dollars || 0),
            currency: extra.currency || 'USD',
            resets_at: promo.resets_at || '',
        },
    };
}

// 5-hour, 7-day and extra-usage quota from the endpoint Claude Code itself uses,
// authenticated with the token Claude Code stored in .credentials.json.
async function fetchOAuthQuota(claudeDir, cache, session, cancellable) {
    const now = nowSeconds();
    const cached = cache.claude_oauth;
    if (cached && now - (cached.fetched_ts || 0) < OAUTH_CACHE_TTL_SECONDS) return cached.data || {};

    let oauth;
    try {
        oauth = (await readJson(buildPath(claudeDir, '.credentials.json'), cancellable)).claudeAiOauth || {};
    } catch {
        return cached?.data || {};
    }
    const plan = planLabel(oauth);
    if (!oauth.accessToken) return { plan_label: plan };

    try {
        const payload = await fetchJson(session, {
            url: USAGE_URL,
            headers: {
                'Authorization': `Bearer ${oauth.accessToken}`,
                'anthropic-beta': 'oauth-2025-04-20',
            },
        }, cancellable);
        const data = parseUsagePayload(payload, plan);
        cache.claude_oauth = { fetched_ts: now, data };
        return data;
    } catch {
        return cached?.data || { plan_label: plan };
    }
}

function entryTokens(e) {
    return (e.input_tokens || 0) + (e.output_tokens || 0) + (e.cache_creation || 0) + (e.cache_read || 0);
}

// Usage entry for an assistant line of a Claude Code session log, or null.
export function parseUsageLine(line) {
    line = line.trim();
    if (!line.includes('"usage"')) return null;
    let obj;
    try {
        obj = JSON.parse(line);
    } catch {
        return null;
    }
    const msg = obj?.type === 'assistant' ? obj.message : null;
    const usage = msg?.usage;
    if (!usage) return null;
    return {
        // Claude Code repeats usage on one line per content block.
        key: msg.id ? `${msg.id}:${obj.requestId}` : null,
        timestamp: obj.timestamp || '',
        model: msg.model || 'unknown',
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_creation: usage.cache_creation_input_tokens || 0,
        cache_read: usage.cache_read_input_tokens || 0,
    };
}

// Merges a file's entries from today, keeping the largest usage per message key.
function collectToday(todayByKey, entries, today, path) {
    entries.forEach((e, i) => {
        if (!isToday(e.timestamp, today)) return;
        const key = e.key || `${path}#${i}`;
        const prev = todayByKey.get(key);
        if (!prev || entryTokens(e) > entryTokens(prev)) todayByKey.set(key, e);
    });
}

async function listSessionLogs(projectsDir, cancellable) {
    const paths = [];
    for (const project of await listDir(projectsDir, cancellable)) {
        if (!project.isDir) continue;
        const dir = buildPath(projectsDir, project.name);
        for (const f of await listDir(dir, cancellable)) {
            if (!f.isDir && f.name.endsWith('.jsonl')) paths.push(buildPath(dir, f.name));
        }
    }
    return paths;
}

// Reads one session log, resuming from the cached offset when the file only grew.
async function scanSessionLog(path, cachedInfo, today, cancellable) {
    const { size, mtime } = await statFile(path, cancellable);
    if (cachedInfo && cachedInfo.mtime === mtime && cachedInfo.size === size) return cachedInfo;

    const resume = cachedInfo && size >= (cachedInfo.size || 0);
    let lifetime = resume ? cachedInfo.lifetime_tokens || 0 : 0;
    const todayEntries = resume ? (cachedInfo.today_entries || []).filter(e => isToday(e.timestamp, today)) : [];
    let lastKey = resume ? cachedInfo.last_key ?? null : null;
    let lastTokens = resume ? cachedInfo.last_tokens || 0 : 0;

    const offset = await readLinesFrom(path, resume ? cachedInfo.offset || 0 : 0, line => {
        const e = parseUsageLine(line);
        if (!e) return;
        const tokens = entryTokens(e);
        if (e.key !== null && e.key === lastKey) {
            // Later line of the same streamed message: its usage supersedes the previous one.
            lifetime += tokens - lastTokens;
            if (todayEntries.at(-1)?.key === lastKey) todayEntries.pop();
        } else {
            lifetime += tokens;
        }
        if (isToday(e.timestamp, today)) todayEntries.push(e);
        lastKey = e.key;
        lastTokens = tokens;
    }, cancellable);

    return {
        mtime,
        size,
        offset,
        lifetime_tokens: lifetime,
        today_entries: todayEntries,
        last_key: lastKey,
        last_tokens: lastTokens,
    };
}

// Token totals from Claude Code's session logs plus live quota.
// `session` is a Soup.Session, or null to skip the network.
export async function collectClaudeMetrics(claudeDir, { cache, today, session = null, disabled = false, cancellable = null }) {
    if (disabled) return emptyResult('disabled');
    if (!isDirectory(claudeDir)) return emptyResult('not_found');

    const res = emptyResult('ok');
    const [quota] = await Promise.all([
        session ? fetchOAuthQuota(claudeDir, cache, session, cancellable) : {},
        scanSessionLogs(claudeDir, cache, today, res, cancellable),
    ]);
    res.oauth_quota = quota;
    return res;
}

async function scanSessionLogs(claudeDir, cache, today, res, cancellable) {
    const fileCache = cache.claude_files || {};
    const newFileCache = {};
    // Today's entries across all files, deduplicated by message key (resumed
    // sessions copy history into new files). Lifetime is only deduplicated
    // within a file; cross-file dedup would require caching every key.
    const todayByKey = new Map();

    for (const path of await listSessionLogs(buildPath(claudeDir, 'projects'), cancellable)) {
        let info;
        try {
            info = await scanSessionLog(path, fileCache[path], today, cancellable);
        } catch (e) {
            if (cancellable?.is_cancelled()) throw e;
            continue;
        }
        newFileCache[path] = info;
        res.lifetime.total_tokens += info.lifetime_tokens || 0;
        collectToday(todayByKey, info.today_entries || [], today, path);
    }
    cache.claude_files = newFileCache;

    const t = res.today;
    for (const e of todayByKey.values()) {
        t.input_tokens += e.input_tokens || 0;
        t.output_tokens += e.output_tokens || 0;
        t.cache_creation_tokens += e.cache_creation || 0;
        t.cache_read_tokens += e.cache_read || 0;
        t.messages++;
    }
    t.total_tokens = t.input_tokens + t.output_tokens + t.cache_creation_tokens + t.cache_read_tokens;
}
