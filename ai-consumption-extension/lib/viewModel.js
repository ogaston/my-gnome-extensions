// Pure presentation logic shared by the shell menu, the panel label and the
// GTK simulator. No St/Gtk imports so it can be unit-tested with plain gjs.

let _ = s => s;

export function setGettext(gettextFn) {
    _ = gettextFn;
}

// Sequential %s substitution (String.prototype.format only exists inside the shell).
function fmt(str, ...args) {
    let i = 0;
    return str.replace(/%s/g, () => String(args[i++]));
}

export const DEFAULT_WARNING_PERCENT = 85;

export function formatTokens(count) {
    if (!count || count <= 0) return '0';
    if (count >= 1000000000) return (count / 1000000000).toFixed(2) + 'B';
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
}

export function formatResetTime(isoStr, now = new Date()) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return null;
    const timePart = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) {
        return fmt(_('Resets today at %s'), timePart);
    }
    const dayName = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return fmt(_('Resets %s at %s'), dayName, timePart);
}

export function formatUpdatedAgo(isoStr, now = new Date()) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    const minutes = Math.floor((now - d) / 60000);
    if (minutes < 1) return _('Updated just now');
    if (minutes < 60) return fmt(_('Updated %s min ago'), minutes);
    return fmt(_('Updated at %s'), d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
}

// One scale for every quota: red at the warning threshold, orange from ~2/3 of it.
export function severity(percent, warningPercent = DEFAULT_WARNING_PERCENT) {
    if (percent === null || percent === undefined) return 'neutral';
    if (percent >= warningPercent) return 'red';
    if (percent >= warningPercent * 0.65) return 'orange';
    return 'green';
}

function hasQuota(bucket) {
    return Boolean(bucket) && typeof bucket.used_percent === 'number';
}

function quotaCard({ icon, title, subtitle, bucket, warningPercent }) {
    const pct = Math.round(bucket.used_percent);
    return {
        icon,
        title,
        subtitle,
        value: `${pct}%`,
        severity: severity(pct, warningPercent),
        percent: pct,
        footer: formatResetTime(bucket.resets_at),
    };
}

function infoCard(icon, title, subtitle) {
    return { icon, title, subtitle, value: '—', severity: 'neutral', percent: null, footer: null };
}

function thresholdPercent(value, threshold) {
    return threshold > 0 ? Math.min(100, Math.round((value / threshold) * 100)) : null;
}

export function buildClaudeCards(data, opts = {}) {
    const warningPercent = opts.warningPercent ?? DEFAULT_WARNING_PERCENT;
    const claude = data?.claude || {};
    if (claude.status === 'not_found') {
        return [infoCard('claude', _('Claude Code not found'), _('No data in the Claude directory'))];
    }

    const cards = [];
    const quota = claude.oauth_quota || {};
    if (hasQuota(quota.five_hour)) {
        const left = Math.round(quota.five_hour.remaining_percent ?? 100 - quota.five_hour.used_percent);
        cards.push(quotaCard({
            icon: 'claude',
            title: fmt(_('Claude %s'), quota.plan_label || 'Pro'),
            subtitle: fmt(_('5-hour session · %s% left'), left),
            bucket: quota.five_hour,
            warningPercent,
        }));
    }
    if (hasQuota(quota.seven_day)) {
        const left = Math.round(quota.seven_day.remaining_percent ?? 100 - quota.seven_day.used_percent);
        cards.push(quotaCard({
            icon: 'claude',
            title: _('Weekly limit'),
            subtitle: fmt(_('7-day window · %s% left'), left),
            bucket: quota.seven_day,
            warningPercent,
        }));
    }
    if (cards.length === 0) {
        cards.push(infoCard('claude', _('Live quota unavailable'),
            _('Sign in with Claude Code to see session limits')));
    }

    const extra = quota.extra_usage;
    if (extra?.enabled) {
        const pct = Math.round(extra.used_percent || 0);
        const currency = extra.currency || 'USD';
        const used = (extra.used_dollars || 0).toFixed(2);
        cards.push({
            icon: null,
            title: _('Extra usage credits'),
            subtitle: _('Pay-as-you-go and promotional credits'),
            value: `${pct}%`,
            severity: severity(pct, warningPercent),
            percent: pct,
            footer: extra.limit_dollars > 0
                ? `${used} / ${extra.limit_dollars.toFixed(2)} ${currency}`
                : `${used} ${currency}`,
        });
    }

    const today = claude.today || {};
    const tokens = today.total_tokens || 0;
    const threshold = opts.tokenThreshold ?? 0;
    const barPct = thresholdPercent(tokens, threshold);
    cards.push({
        icon: null,
        title: _('Local Claude Code usage'),
        subtitle: fmt(_('In %s · Out %s · Cache %s'),
            formatTokens(today.input_tokens || 0),
            formatTokens(today.output_tokens || 0),
            formatTokens((today.cache_creation_tokens || 0) + (today.cache_read_tokens || 0))),
        value: fmt(_('%s tok'), formatTokens(tokens)),
        severity: barPct === null ? 'neutral' : severity(barPct, 100),
        percent: barPct,
        footer: barPct === null ? null : fmt(_('Daily alert at %s tokens'), formatTokens(threshold)),
        stats: [
            { label: _('Messages today'), value: String(today.messages || 0) },
            { label: _('Lifetime tokens'), value: formatTokens(claude.lifetime?.total_tokens || 0) },
        ],
        highlight: true,
    });
    return cards;
}

function thirdPartyModelNames(modelsList) {
    const names = (modelsList || [])
        .filter(m => m?.name && !String(m.id || '').startsWith('gemini-'))
        .map(m => m.name);
    if (names.length === 0) return _('Claude and GPT models');
    const shown = names.slice(0, 3).join(', ');
    return names.length > 3 ? fmt(_('%s +%s more'), shown, names.length - 3) : shown;
}

export function buildGeminiCards(data, opts = {}) {
    const warningPercent = opts.warningPercent ?? DEFAULT_WARNING_PERCENT;
    const ag = data?.antigravity || {};
    if (ag.status === 'not_found') {
        return [infoCard('gemini', _('Antigravity not found'), _('No data in the Antigravity directory'))];
    }

    const cards = [];
    const quota = ag.oauth_quota || {};
    if (hasQuota(quota.gemini) && quota.gemini.resets_at) {
        const left = Math.round(quota.gemini.remaining_percent ?? 100 - quota.gemini.used_percent);
        cards.push(quotaCard({
            icon: 'gemini',
            title: quota.gemini.model_name || 'Gemini',
            subtitle: fmt(_('Antigravity · %s% left'), left),
            bucket: quota.gemini,
            warningPercent,
        }));
    }
    if (hasQuota(quota.third_party_5h) && quota.third_party_5h.resets_at) {
        cards.push(quotaCard({
            icon: 'gemini',
            title: _('Third-party models · 5 hours'),
            subtitle: thirdPartyModelNames(quota.models_list),
            bucket: quota.third_party_5h,
            warningPercent,
        }));
    }
    if (hasQuota(quota.third_party_weekly) && quota.third_party_weekly.resets_at) {
        cards.push(quotaCard({
            icon: 'gemini',
            title: _('Third-party models · weekly'),
            subtitle: _('Shared weekly limit'),
            bucket: quota.third_party_weekly,
            warningPercent,
        }));
    }
    if (cards.length === 0) {
        cards.push(infoCard('gemini', _('Live quota unavailable'),
            _('Sign in to Antigravity to see model limits')));
    }

    const steps = ag.today?.steps || 0;
    const threshold = opts.stepThreshold ?? 0;
    const barPct = thresholdPercent(steps, threshold);
    cards.push({
        icon: null,
        title: _('Local Antigravity activity'),
        subtitle: fmt(_('Latest: %s'), ag.active_sessions?.[0]?.title || _('none')),
        value: fmt(_('%s steps'), steps),
        severity: barPct === null ? 'neutral' : severity(barPct, 100),
        percent: barPct,
        footer: barPct === null ? null : fmt(_('Daily alert at %s steps'), threshold),
        stats: [
            { label: _('Conversations today'), value: String(ag.today?.conversations || 0) },
            { label: _('Lifetime steps'), value: String(ag.lifetime?.steps || 0) },
        ],
        highlight: true,
    });
    return cards;
}

function pctText(bucket) {
    return hasQuota(bucket) ? `${Math.round(bucket.used_percent)}%` : '--%';
}

export function buildPanelState(data, opts = {}) {
    const mode = opts.mode || 'sessions';
    const warningPercent = opts.warningPercent ?? DEFAULT_WARNING_PERCENT;
    const tokenThreshold = opts.tokenThreshold ?? 0;
    const stepThreshold = opts.stepThreshold ?? 0;

    const claude = data?.claude || {};
    const ag = data?.antigravity || {};
    const showClaude = claude.status !== 'not_found';
    const showAg = ag.status !== 'not_found';
    const fiveH = claude.oauth_quota?.five_hour;
    const sevenD = claude.oauth_quota?.seven_day;
    const gemini = ag.oauth_quota?.gemini;
    const claudeTokens = claude.today?.total_tokens || 0;
    const agSteps = ag.today?.steps || 0;

    const quotaHot = [fiveH, sevenD, gemini].some(b => hasQuota(b) && b.used_percent >= warningPercent);
    const warning = quotaHot ||
        (showClaude && tokenThreshold > 0 && claudeTokens >= tokenThreshold) ||
        (showAg && stepThreshold > 0 && agSteps >= stepThreshold) ||
        ag.quota?.status === 'warning';

    const parts = [];
    if (mode === 'tokens') {
        if (showClaude) parts.push(fmt(_('%s tok'), formatTokens(claudeTokens)));
        if (showAg) parts.push(fmt(_('%s steps'), agSteps));
    } else if (mode === 'compact') {
        if (showClaude) parts.push(pctText(fiveH));
        if (showAg) parts.push(pctText(gemini));
    } else {
        if (showClaude) parts.push(`Claude ${pctText(fiveH)}`);
        if (showAg) parts.push(`AGY ${pctText(gemini)}`);
    }

    return {
        text: parts.length ? parts.join(' · ') : _('AI --'),
        warning,
        quotaWarning: quotaHot,
    };
}
