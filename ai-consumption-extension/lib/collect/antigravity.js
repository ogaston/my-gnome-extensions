// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';

import { OAUTH_CACHE_TTL_SECONDS } from './cache.js';
import { isToday, nowSeconds } from './dates.js';
import { buildPath, isDirectory, readJson } from './files.js';
import { fetchJson } from './http.js';

const API_BASE = 'https://daily-cloudcode-pa.googleapis.com/v1internal';
// The backend answers 403 to requests that don't carry the Antigravity CLI's user agent.
const CLIENT_USER_AGENT = 'antigravity/1.4.6 linux/amd64';
// After this long without a successful fetch, cached quota is flagged as stale.
const STALE_QUOTA_GRACE_SECONDS = 15 * 60;

function emptyResult(status) {
    return {
        status,
        active_sessions: [],
        today: { steps: 0, conversations: 0 },
        lifetime: { conversations: 0, steps: 0 },
        oauth_quota: {},
    };
}

const emptyBucket = () => ({ used_percent: 0, remaining_percent: 100, resets_at: '' });

function bucketFromFraction(remainingFraction, resetsAt) {
    const remaining = Math.round(Number(remainingFraction) * 1000) / 10;
    return {
        used_percent: Math.round(Math.max(0, 100 - remaining) * 10) / 10,
        remaining_percent: remaining,
        resets_at: resetsAt || '',
    };
}

async function tokenFromKeyring(cancellable) {
    // libsecret is optional; without it the token file is used.
    const { default: Secret } = await import('gi://Secret');
    Gio._promisify(Secret.Service, 'get');
    Gio._promisify(Secret.Service.prototype, 'search');

    const schema = Secret.Schema.new('org.freedesktop.Secret.Generic', Secret.SchemaFlags.DONT_MATCH_NAME, {
        service: Secret.SchemaAttributeType.STRING,
        username: Secret.SchemaAttributeType.STRING,
    });
    const service = await Secret.Service.get(Secret.ServiceFlags.NONE, cancellable);
    // No UNLOCK flag: a locked keyring is skipped instead of prompting from the panel.
    const items = await service.search(schema, { service: 'gemini', username: 'antigravity' },
        Secret.SearchFlags.LOAD_SECRETS, cancellable);
    for (const item of items) {
        const text = item.get_secret()?.get_text();
        if (!text) continue;
        const tok = JSON.parse(text);
        const accessToken = tok.token?.access_token || tok.access_token;
        if (accessToken) return accessToken;
    }
    return null;
}

// Antigravity keeps its OAuth token in the keyring, or in a file when no keyring is available.
async function getAccessToken(agDir, cancellable) {
    try {
        const token = await tokenFromKeyring(cancellable);
        if (token) return token;
    } catch (e) {
        if (cancellable?.is_cancelled()) throw e;
    }
    try {
        const tok = await readJson(buildPath(agDir, 'antigravity-oauth-token'), cancellable);
        return tok.token?.access_token || tok.access_token || null;
    } catch {
        return null;
    }
}

// Display name for a tiered model; tiered entries usually ship without one.
export function tieredModelName(modelId, model) {
    if (model.displayName) return model.displayName;
    const base = modelId.replace(/-tiered$/, '');
    const words = base.split('-');
    if (words[0] === 'gemini') {
        return ['Gemini', ...words.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())].join(' ');
    }
    return base;
}

// Quota buckets for Antigravity's own Gemini tiers ("flash", then "pro").
// The plan decides which model backs each tier; when both point at the same
// model only one bucket is returned.
export function tierQuotas(modelsPayload) {
    const models = modelsPayload.models || {};
    const tiers = modelsPayload.tieredModelIds || {};
    const quotas = [];
    const seen = new Set();
    for (const tier of ['flash', 'pro']) {
        for (const modelId of tiers[tier] || []) {
            const model = models[modelId] || {};
            const q = model.quotaInfo || {};
            if (seen.has(modelId) || q.remainingFraction === undefined || q.remainingFraction === null ||
                !q.resetTime)
                continue;
            seen.add(modelId);
            quotas.push({
                model_id: modelId,
                model_name: tieredModelName(modelId, model),
                ...bucketFromFraction(q.remainingFraction, q.resetTime),
            });
            break;
        }
    }
    return quotas;
}

// Last good quota when a live fetch fails (usually an expired sign-in). A brief
// outage keeps showing the cached numbers; past the grace period the data is
// flagged so the UI stops presenting it as current.
export function staleQuota(cached, now, fallback) {
    if (!cached) return fallback;
    const data = { ...(cached.data || {}) };
    const fetchedTs = cached.fetched_ts || 0;
    if (now - fetchedTs > STALE_QUOTA_GRACE_SECONDS) {
        data.stale = true;
        data.fetched_at = new Date(fetchedTs * 1000).toISOString();
    }
    return data;
}

export function parseQuotaPayloads(modelsPayload, quotaPayload) {
    const result = {
        gemini: { model_name: 'Gemini', ...emptyBucket() },
        third_party_5h: emptyBucket(),
        third_party_weekly: emptyBucket(),
        models_list: [],
    };
    const tiers = tierQuotas(modelsPayload);
    if (tiers.length > 0) result.gemini = tiers[0];
    if (tiers.length > 1) result.gemini_pro = tiers[1];

    for (const [id, model] of Object.entries(modelsPayload.models || {})) {
        const q = model.quotaInfo || {};
        if (q.remainingFraction === undefined || q.remainingFraction === null) continue;
        const bucket = bucketFromFraction(q.remainingFraction, q.resetTime);
        if (model.displayName) result.models_list.push({ id, name: model.displayName, ...bucket });
        if (tiers.length === 0 && id.startsWith('gemini-') && q.resetTime)
            result.gemini = { model_name: model.displayName || 'Gemini', ...bucket };
    }

    for (const group of quotaPayload.groups || []) {
        for (const b of group.buckets || []) {
            const bucket = bucketFromFraction(b.remainingFraction ?? 1, b.resetTime);
            if (b.bucketId === '3p-5h') result.third_party_5h = bucket;
            else if (b.bucketId === '3p-weekly') result.third_party_weekly = bucket;
        }
    }
    return result;
}

// Gemini and third-party model quotas from the backend the Antigravity CLI uses.
async function fetchOAuthQuota(agDir, cache, session, cancellable) {
    const now = nowSeconds();
    const cached = cache.antigravity_oauth;
    if (cached && now - (cached.fetched_ts || 0) < OAUTH_CACHE_TTL_SECONDS) return cached.data || {};

    const token = await getAccessToken(agDir, cancellable);
    if (!token) return staleQuota(cached, now, {});

    const request = path => ({
        method: 'POST',
        url: `${API_BASE}:${path}`,
        headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': CLIENT_USER_AGENT },
        body: {},
    });
    try {
        const [modelsPayload, quotaPayload] = await Promise.all([
            fetchJson(session, request('fetchAvailableModels'), cancellable),
            fetchJson(session, request('retrieveUserQuotaSummary'), cancellable),
        ]);
        const data = parseQuotaPayloads(modelsPayload, quotaPayload);
        cache.antigravity_oauth = { fetched_ts: now, data };
        return data;
    } catch (e) {
        if (cancellable?.is_cancelled()) throw e;
        return staleQuota(cached, now, {});
    }
}

// Fills step and conversation counts from the conversation_summaries rows
// returned by agy_db.py.
export function summarizeConversations(res, db, today) {
    for (const [steps, modified] of db.rows) {
        res.lifetime.conversations++;
        res.lifetime.steps += steps;
        if (isToday(modified, today)) {
            res.today.conversations++;
            res.today.steps += steps;
        }
    }
    res.active_sessions = db.recent.map(r => ({
        title: r.title || 'Conversation',
        step_count: r.step_count,
        last_modified: r.last_modified,
        active: r.active,
    }));
}

// Antigravity activity from its conversation database plus live quota.
// `queryDb(path)` resolves to agy_db.py's output; `session` is a
// Soup.Session, or null to skip the network.
export async function collectAntigravityMetrics(agDir, {
    cache, today, queryDb, session = null, disabled = false, cancellable = null,
}) {
    if (disabled) return emptyResult('disabled');
    if (!isDirectory(agDir)) return emptyResult('not_found');

    const res = emptyResult('ok');
    const readDb = async () => {
        const dbPath = buildPath(agDir, 'conversation_summaries.db');
        if (!Gio.File.new_for_path(dbPath).query_exists(null)) return;
        try {
            summarizeConversations(res, await queryDb(dbPath), today);
        } catch (e) {
            if (cancellable?.is_cancelled()) throw e;
            res.status = `db_error: ${e.message}`;
        }
    };
    const [quota] = await Promise.all([
        session ? fetchOAuthQuota(agDir, cache, session, cancellable) : {},
        readDb(),
    ]);
    res.oauth_quota = quota;
    return res;
}
