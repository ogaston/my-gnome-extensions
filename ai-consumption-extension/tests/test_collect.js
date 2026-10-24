// SPDX-License-Identifier: GPL-2.0-or-later
// Run with: gjs -m tests/test_collect.js  (from the extension directory)
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {
    collectAntigravityMetrics,
    parseQuotaPayloads,
    staleQuota,
    summarizeConversations,
    tierQuotas,
} from '../lib/collect/antigravity.js';
import { defaultCachePath, loadCache, saveCache } from '../lib/collect/cache.js';
import { collectClaudeMetrics, parseUsagePayload } from '../lib/collect/claude.js';
import { toLocalDate, todayString } from '../lib/collect/dates.js';

let failures = 0;
async function test(name, fn) {
    const dir = GLib.dir_make_tmp('ai-consumption-test-XXXXXX');
    try {
        await fn(dir);
        console.log(`ok - ${name}`);
    } catch (e) {
        failures++;
        console.log(`FAIL - ${name}: ${e.message}\n${e.stack}`);
    } finally {
        GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(dir)}`);
    }
}
function eq(actual, expected, what = '') {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`);
}

function withTimezone(tz, fn) {
    const old = GLib.getenv('TZ');
    GLib.setenv('TZ', tz, true);
    const restore = () => (old === null ? GLib.unsetenv('TZ') : GLib.setenv('TZ', old, true));
    return Promise.resolve().then(fn).finally(restore);
}

function writeFile(path, text) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, text);
}
function appendFile(path, text) {
    const stream = Gio.File.new_for_path(path).append_to(Gio.FileCreateFlags.NONE, null);
    stream.write_all(new TextEncoder().encode(text), null);
    stream.close(null);
}

const today = todayString();

function claudeLine(msgId, outputTokens, { timestamp = `${today}T10:00:00Z`, requestId = 'req-1' } = {}) {
    return `${JSON.stringify({
        type: 'assistant',
        requestId,
        timestamp,
        message: {
            id: msgId,
            model: 'claude-sonnet-5-5',
            usage: { input_tokens: 10, output_tokens: outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
    })}\n`;
}

function claudeProject(dir) {
    const claudeDir = `${dir}/.claude`;
    const projDir = `${claudeDir}/projects/proj`;
    GLib.mkdir_with_parents(projDir, 0o755);
    return [claudeDir, projDir];
}

const claude = (claudeDir, cache = {}, day = today) => collectClaudeMetrics(claudeDir, { cache, today: day });

await test('missing directories', async dir => {
    const res = await claude(`${dir}/nope`);
    eq(res.status, 'not_found');
    eq(res.today.total_tokens, 0);
    const ag = await collectAntigravityMetrics(`${dir}/nope`, { cache: {}, today, queryDb: null });
    eq(ag.status, 'not_found');
    eq(ag.today.steps, 0);
});

await test('claude jsonl and incremental cache', async dir => {
    const [claudeDir, projDir] = claudeProject(dir);
    const file = `${projDir}/session-1.jsonl`;
    const line = (ts, usage) => `${JSON.stringify({
        type: 'assistant', timestamp: ts, message: { model: 'claude-sonnet-5-5', usage },
    })}\n`;
    writeFile(file, line(`${today}T10:00:00Z`, {
        input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 300,
    }));

    const cache = {};
    let res = await claude(claudeDir, cache);
    eq(res.status, 'ok');
    eq(res.today, {
        input_tokens: 100, output_tokens: 50, cache_creation_tokens: 200,
        cache_read_tokens: 300, total_tokens: 650, messages: 1,
    });

    res = await claude(claudeDir, cache);
    eq(res.today.total_tokens, 650, 'cached');
    eq(res.today.messages, 1);

    appendFile(file, line(`${today}T10:15:00Z`, {
        input_tokens: 50, output_tokens: 25, cache_creation_input_tokens: 0, cache_read_input_tokens: 100,
    }));
    res = await claude(claudeDir, cache);
    eq(res.today.input_tokens, 150);
    eq(res.today.output_tokens, 75);
    eq(res.today.total_tokens, 825);
    eq(res.today.messages, 2);
});

await test('claude corrupted jsonl', async dir => {
    const [claudeDir, projDir] = claudeProject(dir);
    writeFile(`${projDir}/bad.jsonl`, [
        'Not valid JSON at all',
        '',
        '{"type": "user", "content": "hi"}',
        '{"type": "assistant", "usage": "broken',
        JSON.stringify({
            type: 'assistant',
            timestamp: `${today}T11:00:00Z`,
            message: { model: 'claude-haiku-4-5', usage: { input_tokens: 20, output_tokens: 10 } },
        }),
        '',
    ].join('\n'));
    const res = await claude(claudeDir);
    eq(res.status, 'ok');
    eq(res.today.total_tokens, 30);
    eq(res.today.messages, 1);
});

await test('claude dedups streamed lines', async dir => {
    const [claudeDir, projDir] = claudeProject(dir);
    writeFile(`${projDir}/s.jsonl`, [2, 50, 114].map(out => claudeLine('msg-A', out)).join(''));
    const res = await claude(claudeDir);
    eq(res.today.messages, 1);
    eq(res.today.output_tokens, 114);
    eq(res.today.total_tokens, 124);
    eq(res.lifetime.total_tokens, 124);
});

await test('claude dedups across incremental runs', async dir => {
    const [claudeDir, projDir] = claudeProject(dir);
    const file = `${projDir}/s.jsonl`;
    writeFile(file, claudeLine('msg-A', 2));
    const cache = {};
    let res = await claude(claudeDir, cache);
    eq(res.today.total_tokens, 12);

    appendFile(file, claudeLine('msg-A', 114) + claudeLine('msg-B', 5, { requestId: 'req-2' }));
    res = await claude(claudeDir, cache);
    eq(res.today.messages, 2);
    eq(res.today.output_tokens, 119);
    eq(res.lifetime.total_tokens, 139);

    res = await claude(claudeDir, cache);
    eq(res.today.total_tokens, 139, 'cached today');
    eq(res.lifetime.total_tokens, 139, 'cached lifetime');
});

await test('claude dedups across files today', async dir => {
    const [claudeDir, projDir] = claudeProject(dir);
    for (const name of ['original.jsonl', 'resumed.jsonl'])
        writeFile(`${projDir}/${name}`, claudeLine('msg-A', 40));
    const res = await claude(claudeDir);
    eq(res.today.messages, 1);
    eq(res.today.total_tokens, 50);
});

await test('claude partial line is not lost', async dir => {
    const [claudeDir, projDir] = claudeProject(dir);
    const file = `${projDir}/s.jsonl`;
    const second = claudeLine('msg-B', 20, { requestId: 'req-2' });
    writeFile(file, claudeLine('msg-A', 10) + second.slice(0, 40));
    const cache = {};
    let res = await claude(claudeDir, cache);
    eq(res.today.messages, 1);

    appendFile(file, second.slice(40));
    res = await claude(claudeDir, cache);
    eq(res.today.messages, 2);
    eq(res.today.total_tokens, 50);
});

await test('claude lines larger than a read chunk', async dir => {
    const [claudeDir, projDir] = claudeProject(dir);
    const big = JSON.stringify({ type: 'user', content: 'x'.repeat(3 * 1024 * 1024) });
    writeFile(`${projDir}/s.jsonl`, `${big}\n${claudeLine('msg-A', 7)}`);
    const res = await claude(claudeDir);
    eq(res.today.messages, 1);
    eq(res.today.output_tokens, 7);
});

await test('claude today uses local timezone', dir => withTimezone('America/Bogota', async () => {
    const [claudeDir, projDir] = claudeProject(dir);
    writeFile(`${projDir}/s.jsonl`,
        // 21:00 local on the 20th counts; 22:00 local on the 19th does not.
        claudeLine('msg-late', 1, { timestamp: '2026-10-21T02:00:00.000Z' }) +
        claudeLine('msg-early', 100, { timestamp: '2026-10-20T03:00:00.000Z', requestId: 'req-2' }));
    const res = await claude(claudeDir, {}, '2026-10-20');
    eq(res.today.messages, 1);
    eq(res.today.output_tokens, 1);
}));

await test('claude usage payload', () => {
    const data = parseUsagePayload({
        five_hour: { utilization: 42, resets_at: '2026-10-24T20:00:00Z' },
        seven_day: { utilization: null },
        extra_usage: { is_enabled: true, used_credits: 3.5, monthly_limit: 20, currency: 'EUR' },
    }, 'Max (5x)');
    eq(data.plan_label, 'Max (5x)');
    eq(data.five_hour, { used_percent: 42, remaining_percent: 58, resets_at: '2026-10-24T20:00:00Z' });
    eq(data.seven_day, { used_percent: 0, remaining_percent: 100, resets_at: '' });
    eq(data.extra_usage.enabled, true);
    eq(data.extra_usage.limit_dollars, 20);
    eq(data.extra_usage.currency, 'EUR');
});

await test('antigravity conversation summaries', () => withTimezone('America/Bogota', () => {
    const res = { today: { steps: 0, conversations: 0 }, lifetime: { conversations: 0, steps: 0 } };
    summarizeConversations(res, {
        rows: [
            [7, '2026-10-20 03:12:00.187888088+00:00'], // 22:12 on the 19th locally
            [5, '2026-10-20 15:27:23.0099021+00:00'],
            [3, '2026-10-21 02:30:00.5+00:00'],
            [0, '0001-01-01 00:00:00+00:00'],
        ],
        recent: [{ title: '', step_count: 3, last_modified: '2026-10-21 02:30:00.5+00:00', active: true }],
    }, '2026-10-20');
    eq(res.today, { steps: 8, conversations: 2 });
    eq(res.lifetime, { conversations: 4, steps: 15 });
    eq(res.active_sessions[0].title, 'Conversation');
    eq(toLocalDate('0001-01-01 00:00:00+00:00'), '');
}));

await test('antigravity db errors keep status visible', async dir => {
    writeFile(`${dir}/ag/conversation_summaries.db`, '');
    const res = await collectAntigravityMetrics(`${dir}/ag`, {
        cache: {}, today, queryDb: () => Promise.reject(new Error('locked')),
    });
    eq(res.status, 'db_error: locked');
});

await test('antigravity tier quotas', () => {
    const payload = {
        models: {
            'gemini-3.5-flash-lite': {
                displayName: 'Gemini 3.5 Flash Lite',
                quotaInfo: { remainingFraction: 1, resetTime: '2026-10-25T00:00:00Z' },
            },
            'gemini-3.8-flash-tiered': { quotaInfo: { remainingFraction: 0.75, resetTime: '2026-10-25T00:00:00Z' } },
            'gemini-4-argon-tiered': { quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-30T00:00:00Z' } },
        },
        tieredModelIds: { flash: ['gemini-3.8-flash-tiered'], pro: ['gemini-3.8-flash-tiered'] },
    };
    let quotas = tierQuotas(payload);
    eq(quotas.length, 1);
    eq(quotas[0].model_name, 'Gemini 3.8 Flash');
    eq(quotas[0].used_percent, 25);

    payload.tieredModelIds.pro = ['gemini-4-argon-tiered'];
    quotas = tierQuotas(payload);
    eq(quotas.map(q => q.model_name), ['Gemini 3.8 Flash', 'Gemini 4 Argon']);

    const data = parseQuotaPayloads(payload, {
        groups: [{ buckets: [{ bucketId: '3p-5h', remainingFraction: 0.4, resetTime: 'r' }] }],
    });
    eq(data.gemini_pro.model_name, 'Gemini 4 Argon');
    eq(data.third_party_5h, { used_percent: 60, remaining_percent: 40, resets_at: 'r' });
    eq(data.models_list.map(m => m.id), ['gemini-3.5-flash-lite']);
});

await test('stale antigravity quota', () => {
    const now = 1_000_000;
    const cached = { fetched_ts: now - 30, data: { gemini: { used_percent: 10 } } };
    eq('stale' in staleQuota(cached, now, {}), false);
    cached.fetched_ts = now - 3600;
    const data = staleQuota(cached, now, {});
    eq(data.stale, true);
    eq(typeof data.fetched_at, 'string');
    eq('stale' in cached.data, false, 'cached data untouched');
    eq(staleQuota(null, now, { x: 1 }), { x: 1 });
});

await test('disabled providers skip collection', async dir => {
    GLib.mkdir_with_parents(`${dir}/.claude`, 0o755);
    GLib.mkdir_with_parents(`${dir}/ag`, 0o755);
    const c = await collectClaudeMetrics(`${dir}/.claude`, { cache: {}, today, disabled: true });
    const a = await collectAntigravityMetrics(`${dir}/ag`, { cache: {}, today, disabled: true, queryDb: null });
    eq(c.status, 'disabled');
    eq(a.status, 'disabled');
    eq(a.oauth_quota, {});
});

await test('cache is private, atomic and replaces symlinks', async dir => {
    const path = `${dir}/cache-dir/cache.json`;
    await saveCache(path, { a: 1 });
    const mode = p => Gio.File.new_for_path(p).query_info('unix::mode', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        .get_attribute_uint32('unix::mode') & 0o777;
    eq(mode(path), 0o600, 'file mode');
    eq(mode(`${dir}/cache-dir`), 0o700, 'dir mode');
    eq(await loadCache(path), { a: 1 });

    writeFile(`${dir}/victim.txt`, 'keep me');
    Gio.File.new_for_path(path).delete(null);
    Gio.File.new_for_path(path).make_symbolic_link(`${dir}/victim.txt`, null);
    await saveCache(path, { b: 2 });
    eq(GLib.file_test(path, GLib.FileTest.IS_SYMLINK), false, 'symlink replaced');
    eq(new TextDecoder().decode(GLib.file_get_contents(`${dir}/victim.txt`)[1]), 'keep me');
    eq(await loadCache(path), { b: 2 });
    eq(await loadCache(`${dir}/missing.json`), {});
});

await test('default cache path respects XDG_CACHE_HOME', () => {
    if (!defaultCachePath().startsWith(GLib.get_user_cache_dir())) throw new Error(defaultCachePath());
    eq(defaultCachePath().endsWith('/ai-consumption-monitor/cache.json'), true);
});

if (failures > 0) {
    console.log(`${failures} test(s) failed`);
    System.exit(1);
}
console.log('All collector tests passed');
