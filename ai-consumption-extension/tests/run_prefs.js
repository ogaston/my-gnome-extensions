import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GIRepository from 'gi://GIRepository';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

// Register GNOME Shell typelib and GResource so resource:///org/gnome/Shell/Extensions/... resolves
const repo = GIRepository.Repository.dup_default();
repo.prepend_search_path('/usr/lib64/gnome-shell/girepository-1.0');
repo.prepend_library_path('/usr/lib64/gnome-shell');

const resource = Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
Gio.resources_register(resource);

const { AiConsumptionPrefsPage } = await import('../prefs.js');
const { MetricsService } = await import('../lib/metricsService.js');

function formatTokens(count) {
    if (!count || count <= 0) return '0';
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
}

const app = new Adw.Application({
    application_id: 'org.gnome.shell.extensions.ai-consumption-monitor.DevPreview',
});

app.connect('activate', () => {
    const settingsSchemaSource = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([GLib.get_current_dir(), 'schemas']),
        Gio.SettingsSchemaSource.get_default(),
        false
    );

    const schema = settingsSchemaSource.lookup('org.gnome.shell.extensions.ai-consumption-monitor', true);
    if (!schema) {
        console.error('Schema not found in ./schemas');
        return;
    }

    const settings = new Gio.Settings({ settings_schema: schema });
    const service = new MetricsService(GLib.get_current_dir());

    const window = new Adw.PreferencesWindow({
        application: app,
        title: 'AI Consumption Monitor — Dev Preview & Preferences',
        default_width: 680,
        default_height: 640,
    });

    // --- Page 1: Live Indicator & Menu Preview ---
    const previewPage = new Adw.PreferencesPage({
        title: 'Live Preview',
        icon_name: 'view-reveal-symbolic',
    });

    // Top Bar Simulation Group
    const topBarGroup = new Adw.PreferencesGroup({
        title: 'Simulated Top Panel Indicator',
        description: 'Live preview of how the indicator appears in the GNOME top bar',
    });
    previewPage.add(topBarGroup);

    const panelPreviewRow = new Adw.ActionRow({
        title: 'Top Bar Status Indicator',
        subtitle: 'Loading metrics...',
    });
    const statusIcon = new Gtk.Image({
        icon_name: 'utilities-system-monitor-symbolic',
        pixel_size: 20,
    });
    panelPreviewRow.add_prefix(statusIcon);

    const refreshBtn = new Gtk.Button({
        label: 'Refresh Now',
        valign: Gtk.Align.CENTER,
    });
    refreshBtn.connect('clicked', () => {
        panelPreviewRow.subtitle = 'Refreshing...';
        service.refreshNow();
    });
    panelPreviewRow.add_suffix(refreshBtn);
    topBarGroup.add(panelPreviewRow);

    // Claude Code Live Metrics Group
    const claudeGroup = new Adw.PreferencesGroup({
        title: 'Claude Code — Popup Menu Section',
    });
    previewPage.add(claudeGroup);

    const claudeTodayRow = new Adw.ActionRow({
        title: 'Today Token Consumption',
        subtitle: '0 tokens (0 messages)',
    });
    claudeGroup.add(claudeTodayRow);

    const claudeBreakdownRow = new Adw.ActionRow({
        title: 'Token Breakdown',
        subtitle: 'In: 0 | Out: 0 | Cache: 0',
    });
    claudeGroup.add(claudeBreakdownRow);

    const claudeSessionsRow = new Adw.ActionRow({
        title: 'Active CLI Sessions',
        subtitle: 'None',
    });
    claudeGroup.add(claudeSessionsRow);

    // Antigravity Live Metrics Group
    const agGroup = new Adw.PreferencesGroup({
        title: 'Google Antigravity — Popup Menu Section',
    });
    previewPage.add(agGroup);

    const agTodayRow = new Adw.ActionRow({
        title: 'Today Activity',
        subtitle: '0 steps (0 conversations)',
    });
    agGroup.add(agTodayRow);

    const agQuotaRow = new Adw.ActionRow({
        title: 'Quota Health',
        subtitle: 'Checking...',
    });
    agGroup.add(agQuotaRow);

    const agRecentRow = new Adw.ActionRow({
        title: 'Latest Conversation',
        subtitle: 'None',
    });
    agGroup.add(agRecentRow);

    const updatePreview = (data) => {
        if (!data) return;
        const mode = settings.get_string('display-mode') || 'sessions';
        const claudeTokens = data.claude?.today?.total_tokens || 0;
        const agSteps = data.antigravity?.today?.steps || 0;
        const fiveHUsed = data.claude?.oauth_quota?.five_hour?.used_percent ?? 0;
        const geminiUsed = data.antigravity?.oauth_quota?.gemini?.used_percent ?? 0;

        const tokenThreshold = settings.get_int('claude-token-daily-threshold');
        const stepThreshold = settings.get_int('antigravity-step-daily-threshold');
        const hasWarning = (tokenThreshold > 0 && claudeTokens >= tokenThreshold) ||
                           (stepThreshold > 0 && agSteps >= stepThreshold) ||
                           (data.antigravity?.quota?.status === 'warning') ||
                           fiveHUsed >= 85 || geminiUsed >= 85;

        let badgeText = '';
        if (mode === 'compact') {
            badgeText = `${Math.round(fiveHUsed)}% · ${Math.round(geminiUsed)}%`;
        } else if (mode === 'tokens') {
            badgeText = `${formatTokens(claudeTokens)} tok | ${agSteps} stp`;
        } else {
            badgeText = `Claude ${Math.round(fiveHUsed)}% · AGY ${Math.round(geminiUsed)}%`;
        }

        const warnTag = hasWarning ? ' ⚠️ [THRESHOLD WARNING]' : '';
        const timeStr = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : 'Just now';
        panelPreviewRow.title = `Panel Label:  ${badgeText}${warnTag}`;
        panelPreviewRow.subtitle = `Last updated: ${timeStr}`;

        // Claude section
        const claude = data.claude || {};
        const claudeToday = claude.today || {};
        claudeGroup.title = `Claude Code (${claude.active_count || 0} active)`;
        claudeTodayRow.subtitle = `${formatTokens(claudeToday.total_tokens || 0)} tokens (${claudeToday.messages || 0} messages) — Lifetime: ${formatTokens(claude.lifetime?.total_tokens || 0)}`;
        const inTok = formatTokens(claudeToday.input_tokens || 0);
        const outTok = formatTokens(claudeToday.output_tokens || 0);
        const cacheTok = formatTokens((claudeToday.cache_creation_tokens || 0) + (claudeToday.cache_read_tokens || 0));
        claudeBreakdownRow.subtitle = `In: ${inTok}  |  Out: ${outTok}  |  Cache: ${cacheTok}`;

        if (claude.active_sessions && claude.active_sessions.length > 0) {
            claudeSessionsRow.subtitle = claude.active_sessions.map(s => `${s.name} (PID ${s.pid})`).join(', ');
        } else {
            claudeSessionsRow.subtitle = 'No active CLI sessions';
        }

        // Antigravity section
        const ag = data.antigravity || {};
        const agToday = ag.today || {};
        agGroup.title = `Google Antigravity (${ag.active_count || 0} active)`;
        agTodayRow.subtitle = `${agToday.steps || 0} steps today (${agToday.conversations || 0} conversations) — Lifetime: ${ag.lifetime?.steps || 0} steps`;
        agQuotaRow.subtitle = `${ag.quota?.status === 'warning' ? '⚠️ Warning' : '✅ Healthy'} — ${ag.quota?.details || 'OK'}`;

        if (ag.active_sessions && ag.active_sessions.length > 0) {
            const first = ag.active_sessions[0];
            agRecentRow.subtitle = `${first.title} (${first.step_count} steps in ${first.workspace || 'workspace'})`;
        } else {
            agRecentRow.subtitle = 'No recent conversations';
        }
    };

    service.connect('metrics-updated', (svc, jsonStr) => {
        try {
            updatePreview(JSON.parse(jsonStr));
        } catch (e) {
            console.error(e);
        }
    });

    settings.connect('changed', () => {
        service.configure(
            settings.get_int('poll-interval-seconds'),
            settings.get_string('claude-path-override'),
            settings.get_string('antigravity-path-override')
        );
        const latest = service.getLatestData();
        if (latest) updatePreview(latest);
    });

    window.add(previewPage);

    // --- Page 2: Preferences UI ---
    window.add(new AiConsumptionPrefsPage(settings));

    window.connect('close-request', () => {
        service.stop();
        return false;
    });

    service.configure(
        settings.get_int('poll-interval-seconds'),
        settings.get_string('claude-path-override'),
        settings.get_string('antigravity-path-override')
    );
    service.start();

    window.present();
});

app.run([]);
