// Run with: gjs -m tests/test_viewmodel.js  (from the extension directory)
import System from 'system';
import {
    buildClaudeCards,
    buildGeminiCards,
    buildPanelState,
    formatUpdatedAgo,
    severity,
} from '../lib/viewModel.js';

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`ok - ${name}`);
    } catch (e) {
        failures++;
        console.log(`FAIL - ${name}: ${e.message}`);
    }
}
function eq(actual, expected, what = '') {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`);
}

const clone = obj => JSON.parse(JSON.stringify(obj));
const bucket = (used, resets = '2026-10-21T02:00:00Z') => ({
    used_percent: used, remaining_percent: 100 - used, resets_at: resets,
});

const fullData = {
    timestamp: '2026-10-20T20:00:00Z',
    claude: {
        status: 'ok',
        today: { input_tokens: 1000, output_tokens: 500, cache_creation_tokens: 0, cache_read_tokens: 0, total_tokens: 250000, messages: 7 },
        lifetime: { total_tokens: 9000000 },
        oauth_quota: {
            plan_label: 'Max (5x)',
            five_hour: bucket(60),
            seven_day: bucket(90),
            extra_usage: { enabled: false, used_percent: 0, used_dollars: 0, limit_dollars: 0, currency: 'USD' },
        },
    },
    antigravity: {
        status: 'ok',
        today: { steps: 50, conversations: 2 },
        lifetime: { steps: 900 },
        active_sessions: [{ title: 'Refactor' }],
        oauth_quota: {
            gemini: { model_name: 'Gemini 3 Pro', ...bucket(20) },
            third_party_5h: bucket(10),
            third_party_weekly: bucket(5),
            models_list: [
                { id: 'gemini-3-pro', name: 'Gemini 3 Pro' },
                { id: 'claude-sonnet', name: 'Claude Sonnet' },
                { id: 'gpt-oss', name: 'GPT-OSS' },
            ],
        },
    },
};

test('severity uses one scale relative to the warning threshold', () => {
    eq(severity(10, 85), 'green');
    eq(severity(56, 85), 'orange');
    eq(severity(85, 85), 'red');
    eq(severity(null, 85), 'neutral');
    eq(severity(60, 90), 'orange');
    eq(severity(50, 90), 'green');
});

test('claude cards use severity for every quota card', () => {
    const cards = buildClaudeCards(fullData, { warningPercent: 85 });
    eq(cards.map(c => c.title), ['Claude Max (5x)', 'Weekly limit', 'Local Claude Code usage']);
    eq(cards[0].severity, 'orange');
    eq(cards[1].severity, 'red', 'weekly card');
});

test('extra credits card is hidden when extra usage is disabled', () => {
    const cards = buildClaudeCards(fullData);
    eq(cards.some(c => c.title === 'Extra usage credits'), false);
    const enabled = clone(fullData);
    enabled.claude.oauth_quota.extra_usage = { enabled: true, used_percent: 40, used_dollars: 4, limit_dollars: 10, currency: 'EUR' };
    const extra = buildClaudeCards(enabled).find(c => c.title === 'Extra usage credits');
    eq(extra.footer, '4.00 / 10.00 EUR');
});

test('telemetry bar follows the daily token threshold, not a fixed value', () => {
    const withThreshold = buildClaudeCards(fullData, { tokenThreshold: 500000 }).at(-1);
    eq(withThreshold.percent, 50);
    const noThreshold = buildClaudeCards(fullData, { tokenThreshold: 0 }).at(-1);
    eq(noThreshold.percent, null);
});

test('missing quota shows an unavailable card instead of 0%', () => {
    const data = clone(fullData);
    data.claude.oauth_quota = { plan_label: 'Pro' };
    const cards = buildClaudeCards(data);
    eq(cards[0].title, 'Live quota unavailable');
    eq(cards[0].value, '—');
    eq(cards[0].percent, null);
});

test('not-found provider shows a single info card', () => {
    const cards = buildGeminiCards({ antigravity: { status: 'not_found' } });
    eq(cards.length, 1);
    eq(cards[0].title, 'Antigravity not found');
});

test('gemini cards use model names from the data', () => {
    const cards = buildGeminiCards(fullData);
    eq(cards[0].title, 'Gemini 3 Pro');
    eq(cards[1].subtitle, 'Claude Sonnet, GPT-OSS');
});

test('panel hides providers that are not installed and shows --% without quota', () => {
    eq(buildPanelState(fullData).text, 'Claude 60% · AGY 20%');
    const data = clone(fullData);
    data.antigravity = { status: 'not_found' };
    data.claude.oauth_quota = {};
    eq(buildPanelState(data).text, 'Claude --%');
    eq(buildPanelState({ claude: { status: 'not_found' }, antigravity: { status: 'not_found' } }).text, 'AI --');
});

test('panel warning respects the configurable quota threshold', () => {
    eq(buildPanelState(fullData, { warningPercent: 95 }).warning, false);
    eq(buildPanelState(fullData, { warningPercent: 85 }).warning, true);
});

test('panel omits providers hidden in settings or disabled by the collector', () => {
    eq(buildPanelState(fullData, { showAntigravity: false }).text, 'Claude 60%');
    eq(buildPanelState(fullData, { showClaude: false }).text, 'AGY 20%');
    const data = clone(fullData);
    data.claude = { status: 'disabled' };
    eq(buildPanelState(data).text, 'AGY 20%');
});

test('hidden provider quota does not raise the panel warning', () => {
    // Claude's weekly bucket is at 90%, above the 75% default.
    eq(buildPanelState(fullData).warning, true);
    eq(buildPanelState(fullData, { showClaude: false }).warning, false);
});

test('panel color follows quota percentages only, not daily token alerts', () => {
    const data = clone(fullData);
    data.claude.oauth_quota.five_hour = bucket(20);
    data.claude.oauth_quota.seven_day = bucket(30);
    data.claude.today.total_tokens = 18000000;
    eq(buildPanelState(data, { tokenThreshold: 500000 }).warning, false);
    data.claude.oauth_quota.five_hour = bucket(74);
    eq(buildPanelState(data).warning, false);
    data.claude.oauth_quota.five_hour = bucket(76);
    eq(buildPanelState(data).warning, true);
});

test('antigravity activity card without sessions', () => {
    const data = clone(fullData);
    data.antigravity.active_sessions = [];
    const local = buildGeminiCards(data).at(-1);
    eq(local.subtitle, 'No recent conversations');
    eq(buildGeminiCards(fullData).at(-1).subtitle, 'Latest: Refactor');
});

test('updated-ago text', () => {
    const now = new Date('2026-10-20T20:05:30Z');
    eq(formatUpdatedAgo('2026-10-20T20:05:10Z', now), 'Updated just now');
    eq(formatUpdatedAgo('2026-10-20T20:00:00Z', now), 'Updated 5 min ago');
});

if (failures > 0) {
    console.log(`${failures} test(s) failed`);
    System.exit(1);
}
console.log('All view model tests passed');
