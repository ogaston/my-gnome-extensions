import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

function formatTokens(count) {
    if (!count || count <= 0) return '0';
    if (count >= 1000000000) return (count / 1000000000).toFixed(2) + 'B';
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
}

function formatResetTime(isoStr) {
    if (!isoStr) return 'Live metrics';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return 'Live metrics';
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timePart = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (isToday) {
        return `Resets Today at ${timePart}`;
    }
    const dayName = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return `Resets ${dayName} at ${timePart}`;
}

function setVertical(box) {
    if ('orientation' in box) {
        box.orientation = Clutter.Orientation.VERTICAL;
    } else {
        box.vertical = true;
    }
}

export class IndicatorMenuManager {
    constructor(panelButton, metricsService, openPreferencesCallback) {
        this._button = panelButton;
        this._menu = panelButton.menu;
        this._service = metricsService;
        this._openPreferences = openPreferencesCallback;
        this._activeTab = 'claude';
        this._latestData = null;
        this._shellSettings = null;
        this._shellSettingsChangedId = null;

        this._buildMenuShell();
        this._initBlurDetection();
    }

    _isBlurExtensionEnabled() {
        try {
            const blurExt = Main.extensionManager?.lookup?.('blur-my-shell@aunetx');
            if (blurExt && blurExt.state === 1) {
                return true;
            }
        } catch (_e) {
            // Ignore if extensionManager is not ready yet
        }

        try {
            if (!this._shellSettings) {
                this._shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
            }
            const enabled = this._shellSettings.get_strv('enabled-extensions') || [];
            return enabled.some(uuid => uuid.toLowerCase().includes('blur'));
        } catch (_e) {
            return false;
        }
    }

    _initBlurDetection() {
        try {
            this._shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
            this._shellSettingsChangedId = this._shellSettings.connect(
                'changed::enabled-extensions',
                () => this._syncBlurState()
            );
        } catch (_e) {
            this._shellSettings = null;
        }
        this._syncBlurState();
    }

    _syncBlurState() {
        const blurEnabled = this._isBlurExtensionEnabled();
        const menuBox = this._menu?.box;

        if (this._rootBox) {
            if (blurEnabled) {
                this._rootBox.add_style_class_name('ai-usage-blur-active');
            } else {
                this._rootBox.remove_style_class_name('ai-usage-blur-active');
            }
        }

        if (!menuBox) return;
        menuBox.add_style_class_name('ai-usage-popup-menu');

        if (blurEnabled) {
            menuBox.add_style_class_name('ai-usage-blur-active');
            try {
                if (!menuBox.get_effect('ai-usage-bg-blur') && Shell.BlurEffect) {
                    const effect = new Shell.BlurEffect({
                        mode: Shell.BlurMode.BACKGROUND,
                    });
                    if ('radius' in effect) effect.radius = 36;
                    if ('sigma' in effect) effect.sigma = 36;
                    if ('brightness' in effect) effect.brightness = 0.68;
                    menuBox.add_effect_with_name('ai-usage-bg-blur', effect);
                }
            } catch (_e) {
                // CSS translucent fallback still applies
            }
        } else {
            menuBox.remove_style_class_name('ai-usage-blur-active');
            try {
                if (menuBox.get_effect('ai-usage-bg-blur')) {
                    menuBox.remove_effect_by_name('ai-usage-bg-blur');
                }
            } catch (_e) {
                // Ignore
            }
        }
    }

    _buildMenuShell() {
        this._menu.removeAll();

        this._rootBox = new St.BoxLayout({
            style_class: 'ai-usage-popup-container',
            x_expand: true,
        });
        setVertical(this._rootBox);

        // 1. Header Row: "AI Usage" + Status Dot + Refresh Button
        const headerRow = new St.BoxLayout({
            style_class: 'ai-usage-header-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const titleLabel = new St.Label({
            text: 'AI Usage',
            style_class: 'ai-usage-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(titleLabel);

        this._statusDot = new St.Label({
            text: '●',
            style_class: 'ai-usage-status-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(this._statusDot);

        headerRow.add_child(new St.Widget({ x_expand: true }));

        const refreshBtn = new St.Button({
            label: '↻',
            style_class: 'ai-usage-refresh-btn',
            reactive: true,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        refreshBtn.connect('clicked', () => {
            this._statusDot.style_class = 'ai-usage-status-dot ai-usage-status-dot-refresh';
            this._service.refreshNow();
        });
        headerRow.add_child(refreshBtn);

        this._rootBox.add_child(headerRow);

        // 2. Segmented Tab Bar: Claude | Gemini
        const tabBar = new St.BoxLayout({
            style_class: 'ai-usage-tab-bar',
            x_expand: true,
        });

        this._tabButtons = {};
        const tabs = [
            { id: 'claude', label: 'Claude' },
            { id: 'gemini', label: 'Gemini' },
        ];

        for (const t of tabs) {
            const btn = new St.Button({
                label: t.label,
                style_class: t.id === this._activeTab ? 'ai-usage-tab-btn ai-usage-tab-btn-active' : 'ai-usage-tab-btn',
                x_expand: true,
                reactive: true,
                can_focus: true,
            });
            btn.connect('clicked', () => {
                this._activeTab = t.id;
                this._updateTabStyles();
                this._renderCards();
            });
            this._tabButtons[t.id] = btn;
            tabBar.add_child(btn);
        }

        this._rootBox.add_child(tabBar);

        // 3. Cards Container
        this._cardsBox = new St.BoxLayout({
            style_class: 'ai-usage-cards-box',
            x_expand: true,
        });
        setVertical(this._cardsBox);
        this._rootBox.add_child(this._cardsBox);

        // 4. Footer Row: Settings & Close
        const footerRow = new St.BoxLayout({
            style_class: 'ai-usage-footer-row',
            x_expand: true,
        });

        const settingsBtn = new St.Button({
            label: '⚙  Settings',
            style_class: 'ai-usage-footer-btn',
            reactive: true,
            can_focus: true,
        });
        settingsBtn.connect('clicked', () => {
            this._menu.close();
            if (this._openPreferences) {
                this._openPreferences();
            }
        });
        footerRow.add_child(settingsBtn);

        footerRow.add_child(new St.Widget({ x_expand: true }));

        const quitBtn = new St.Button({
            label: '⏻  Close',
            style_class: 'ai-usage-quit-btn',
            reactive: true,
            can_focus: true,
        });
        quitBtn.connect('clicked', () => {
            this._menu.close();
        });
        footerRow.add_child(quitBtn);

        this._rootBox.add_child(footerRow);

        if (this._menu.box) {
            this._menu.box.add_child(this._rootBox);
        }

        this._renderCards();
    }

    _updateTabStyles() {
        for (const [id, btn] of Object.entries(this._tabButtons)) {
            if (id === this._activeTab) {
                btn.style_class = 'ai-usage-tab-btn ai-usage-tab-btn-active';
            } else {
                btn.style_class = 'ai-usage-tab-btn';
            }
        }
    }

    _createProgressBar(percentUsed, colorVariant = 'green') {
        const track = new St.BoxLayout({
            style_class: 'ai-usage-progress-track',
            x_expand: true,
        });
        const fill = new St.Widget({
            style_class: `ai-usage-progress-fill-${colorVariant}`,
        });
        track.add_child(fill);

        const clamped = Math.min(100, Math.max(2, percentUsed));
        const updateWidth = () => {
            const w = track.width > 0 ? track.width : 316;
            fill.width = Math.max(6, Math.round((w * clamped) / 100));
        };
        track.connect('notify::width', updateWidth);
        updateWidth();
        return track;
    }

    _createCard({
        iconType = null,
        title,
        subtitle,
        rightText,
        rightColor = 'green',
        percent = 0,
        barColor = 'green',
        bottomRightText = null,
        insetLeftTitle = null,
        insetLeftValue = null,
        insetRightTitle = null,
        insetRightValue = null,
        isGreenCard = false,
    }) {
        const card = new St.BoxLayout({
            style_class: isGreenCard ? 'ai-usage-card-green' : 'ai-usage-card',
            x_expand: true,
        });
        setVertical(card);

        const topRow = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (iconType === 'claude' || iconType === 'gemini') {
            const iconBadge = new St.Button({
                label: '✦',
                style_class: iconType === 'claude' ? 'ai-usage-icon-claude' : 'ai-usage-icon-gemini',
                reactive: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            topRow.add_child(iconBadge);
        }

        const titleCol = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        setVertical(titleCol);

        titleCol.add_child(new St.Label({
            text: title,
            style_class: 'ai-usage-card-title',
        }));
        titleCol.add_child(new St.Label({
            text: subtitle,
            style_class: 'ai-usage-card-subtitle',
        }));
        topRow.add_child(titleCol);

        const pctLabel = new St.Label({
            text: rightText,
            style_class: `ai-usage-pct-${rightColor}`,
            y_align: Clutter.ActorAlign.START,
        });
        topRow.add_child(pctLabel);

        card.add_child(topRow);
        card.add_child(this._createProgressBar(percent, barColor));

        if (bottomRightText) {
            const resetRow = new St.BoxLayout({ x_expand: true });
            resetRow.add_child(new St.Widget({ x_expand: true }));
            resetRow.add_child(new St.Label({
                text: bottomRightText,
                style_class: 'ai-usage-reset-text',
            }));
            card.add_child(resetRow);
        }

        if (insetLeftTitle && insetRightTitle) {
            const insetBox = new St.BoxLayout({
                style_class: isGreenCard ? '' : 'ai-usage-inset-box',
                x_expand: true,
            });

            const leftCol = new St.BoxLayout({ x_expand: true });
            setVertical(leftCol);
            leftCol.add_child(new St.Label({
                text: insetLeftTitle,
                style_class: 'ai-usage-stat-caption',
            }));
            leftCol.add_child(new St.Label({
                text: insetLeftValue,
                style_class: 'ai-usage-stat-big',
            }));
            insetBox.add_child(leftCol);

            const rightCol = new St.BoxLayout({ x_align: Clutter.ActorAlign.END });
            setVertical(rightCol);
            rightCol.add_child(new St.Label({
                text: insetRightTitle,
                style_class: 'ai-usage-stat-caption',
                x_align: Clutter.ActorAlign.END,
            }));
            rightCol.add_child(new St.Label({
                text: insetRightValue,
                style_class: 'ai-usage-stat-big',
                x_align: Clutter.ActorAlign.END,
            }));
            insetBox.add_child(rightCol);

            card.add_child(insetBox);
        }

        return card;
    }

    updateMenu(data) {
        this._latestData = data;
        if (!data) return;

        const claudeOAuth = data.claude?.oauth_quota || {};
        const fiveHUsed = claudeOAuth.five_hour?.used_percent ?? 0;
        const sevenDUsed = claudeOAuth.seven_day?.used_percent ?? 0;
        const geminiUsed = data.antigravity?.oauth_quota?.gemini?.used_percent ?? 0;

        if (fiveHUsed >= 85 || sevenDUsed >= 85 || geminiUsed >= 85) {
            this._statusDot.style_class = 'ai-usage-status-dot ai-usage-status-dot-warn';
        } else {
            this._statusDot.style_class = 'ai-usage-status-dot';
        }

        this._renderCards();
    }

    _renderCards() {
        this._cardsBox.destroy_all_children();
        const data = this._latestData || {};
        const claude = data.claude || {};
        const claudeOAuth = claude.oauth_quota || {};
        const ag = data.antigravity || {};
        const agOAuth = ag.oauth_quota || {};

        const fiveH = claudeOAuth.five_hour || { used_percent: 0, remaining_percent: 100, resets_at: '' };
        const sevenD = claudeOAuth.seven_day || { used_percent: 0, remaining_percent: 100, resets_at: '' };
        const extra = claudeOAuth.extra_usage || { used_percent: 0, used_dollars: 0, limit_dollars: 100 };
        const geminiQ = agOAuth.gemini || { model_name: 'Gemini 2.5 & 3.1 Pro', used_percent: 0, remaining_percent: 100, resets_at: '' };
        const ag3p5h = agOAuth.third_party_5h || { used_percent: 0, remaining_percent: 100, resets_at: '' };
        const ag3pWk = agOAuth.third_party_weekly || { used_percent: 0, remaining_percent: 100, resets_at: '' };

        const claudeTokensToday = formatTokens(claude.today?.total_tokens || 0);
        const agStepsToday = `${ag.today?.steps || 0} steps`;

        if (this._activeTab === 'claude') {
            const c5Pct = Math.round(fiveH.used_percent || 0);
            const c5Color = c5Pct >= 80 ? 'red' : (c5Pct >= 55 ? 'orange' : 'green');
            const c5Prefix = c5Pct >= 55 ? '⚠' : '✓';
            this._cardsBox.add_child(this._createCard({
                iconType: 'claude',
                title: `Claude ${claudeOAuth.plan_label || 'Pro'}`,
                subtitle: `5-hour rolling session · ${Math.round(fiveH.remaining_percent ?? 100)}% left`,
                rightText: `${c5Prefix} ${c5Pct}%`,
                rightColor: c5Color,
                percent: c5Pct,
                barColor: c5Color,
                bottomRightText: formatResetTime(fiveH.resets_at),
            }));

            const wPct = Math.round(sevenD.used_percent || 0);
            const wPrefix = wPct >= 50 ? '⚠' : '✓';
            this._cardsBox.add_child(this._createCard({
                iconType: 'claude',
                title: 'Claude Weekly Quota',
                subtitle: `7-day rolling window · ${Math.round(sevenD.remaining_percent ?? 100)}% left`,
                rightText: `${wPrefix} ${wPct}%`,
                rightColor: 'orange',
                percent: wPct,
                barColor: 'orange',
                bottomRightText: formatResetTime(sevenD.resets_at),
            }));

            const exPct = Math.round(extra.used_percent || 0);
            this._cardsBox.add_child(this._createCard({
                title: 'Promotional & Extra Credits',
                subtitle: 'Pay-as-you-go & promotional grant',
                rightText: `${exPct >= 90 ? '⚠' : '✓'} ${exPct}%`,
                rightColor: exPct >= 90 ? 'orange' : 'green',
                percent: exPct,
                barColor: 'orange',
                bottomRightText: `$${(extra.used_dollars || 0).toFixed(2)} / $${(extra.limit_dollars || 100).toFixed(2)} USD`,
            }));

            const inTok = formatTokens(claude.today?.input_tokens || 0);
            const outTok = formatTokens(claude.today?.output_tokens || 0);
            const cacheTok = formatTokens((claude.today?.cache_creation_tokens || 0) + (claude.today?.cache_read_tokens || 0));
            this._cardsBox.add_child(this._createCard({
                title: 'Local Claude CLI Telemetry',
                subtitle: `In: ${inTok} · Out: ${outTok} · Cache: ${cacheTok}`,
                rightText: `${claudeTokensToday} tok`,
                rightColor: 'green',
                percent: 35,
                barColor: 'green',
                insetLeftTitle: 'Today Messages',
                insetLeftValue: `${claude.today?.messages || 0} msgs`,
                insetRightTitle: 'Lifetime Tokens',
                insetRightValue: `${formatTokens(claude.lifetime?.total_tokens || 0)}`,
                isGreenCard: true,
            }));
        } else if (this._activeTab === 'gemini') {
            const gemPct = Math.round(geminiQ.used_percent || 0);
            this._cardsBox.add_child(this._createCard({
                iconType: 'gemini',
                title: 'Gemini 2.5 & 3.1 Pro',
                subtitle: `Google Antigravity daily · ${Math.round(geminiQ.remaining_percent ?? 100)}% left`,
                rightText: `✓ ${gemPct}%`,
                rightColor: 'green',
                percent: gemPct,
                barColor: 'blue',
                bottomRightText: formatResetTime(geminiQ.resets_at),
            }));

            const p5Pct = Math.round(ag3p5h.used_percent || 0);
            this._cardsBox.add_child(this._createCard({
                iconType: 'claude',
                title: 'Antigravity 3P (Claude/GPT) 5h',
                subtitle: 'Claude Opus 4.5, Sonnet 4.5, GPT-OSS',
                rightText: `✓ ${p5Pct}%`,
                rightColor: 'green',
                percent: p5Pct,
                barColor: 'green',
                bottomRightText: formatResetTime(ag3p5h.resets_at),
            }));

            const pWkPct = Math.round(ag3pWk.used_percent || 0);
            this._cardsBox.add_child(this._createCard({
                iconType: 'gemini',
                title: 'Antigravity 3P Weekly Window',
                subtitle: 'Shared weekly tier limit',
                rightText: `✓ ${pWkPct}%`,
                rightColor: 'green',
                percent: pWkPct,
                barColor: 'blue',
                bottomRightText: formatResetTime(ag3pWk.resets_at),
            }));

            this._cardsBox.add_child(this._createCard({
                title: 'Antigravity Local Activity',
                subtitle: `Latest: ${ag.active_sessions?.[0]?.title || 'None'}`,
                rightText: agStepsToday,
                rightColor: 'green',
                percent: Math.min(100, Math.round(((ag.today?.steps || 0) / 1000) * 100)),
                barColor: 'green',
                insetLeftTitle: 'Today Steps',
                insetLeftValue: agStepsToday,
                insetRightTitle: 'Lifetime Steps',
                insetRightValue: `${ag.lifetime?.steps || 0} steps`,
                isGreenCard: true,
            }));
        }
    }

    destroy() {
        if (this._shellSettings && this._shellSettingsChangedId) {
            this._shellSettings.disconnect(this._shellSettingsChangedId);
            this._shellSettingsChangedId = null;
        }
        this._shellSettings = null;
    }
}
