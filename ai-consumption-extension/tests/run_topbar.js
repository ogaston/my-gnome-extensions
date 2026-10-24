import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GIRepository from 'gi://GIRepository';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

const repo = GIRepository.Repository.dup_default();
repo.prepend_search_path('/usr/lib64/gnome-shell/girepository-1.0');
repo.prepend_library_path('/usr/lib64/gnome-shell');

const resource = Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
Gio.resources_register(resource);

const { MetricsService } = await import('../lib/metricsService.js');
const { AiConsumptionPrefsPage } = await import('../prefs.js');
const { buildClaudeCards, buildGeminiCards, buildPanelState } = await import('../lib/viewModel.js');

function detectBlurExtension() {
    try {
        const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
        const enabled = shellSettings.get_strv('enabled-extensions') || [];
        const matched = enabled.find(uuid => uuid.toLowerCase().includes('blur'));
        return { enabled: Boolean(matched), uuid: matched || null, shellSettings };
    } catch (_e) {
        return { enabled: false, uuid: null, shellSettings: null };
    }
}

function getDesktopWallpaperPath() {
    try {
        const bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        const uri = bgSettings.get_string('picture-uri-dark') || bgSettings.get_string('picture-uri');
        if (uri && uri.startsWith('file://')) {
            const path = GLib.filename_from_uri(uri)[0];
            if (path && GLib.file_test(path, GLib.FileTest.EXISTS)) {
                return path;
            }
        }
    } catch (_e) {
        // Fallback to gradient background
    }
    return null;
}

const css = `
.desktop-fallback-bg {
    background: linear-gradient(135deg, #1a1c2e 0%, #0f2027 50%, #203a43 100%);
}

.gnome-top-panel {
    background-color: #131314;
    color: #ffffff;
    min-height: 36px;
    padding: 0 12px;
}

.gnome-top-panel-blur {
    background-color: rgba(20, 20, 24, 0.48);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.panel-clock {
    font-weight: 700;
    font-size: 10.5pt;
    color: #f6f5f4;
}

.panel-indicator-btn {
    background: transparent;
    color: #ffffff;
    border-radius: 99px;
    padding: 2px 12px;
    font-weight: 700;
    font-size: 10pt;
    border: none;
}

.panel-indicator-btn:hover, .panel-indicator-btn-active {
    background-color: rgba(255, 255, 255, 0.15);
}

.panel-warning {
    color: #f59e0b;
}

/* GNOME Shell Popup Menu Container */
.ai-usage-popup-card {
    min-width: 348px;
    max-width: 348px;
    padding: 16px;
    border-radius: 26px;
    background-color: #303034;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
}

.ai-usage-popup-card.ai-usage-blur-active {
    background-color: rgba(32, 32, 36, 0.58);
    border: 1px solid rgba(255, 255, 255, 0.16);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
}

.ai-usage-popup-blur-underlay {
    border-radius: 26px;
    filter: blur(28px) brightness(0.68);
}

.ai-usage-title {
    font-size: 13.5pt;
    font-weight: 800;
    color: #ffffff;
}

/* Status Dot (only dot, no text) */
.ai-usage-status-dot {
    color: #34d399;
    font-size: 11pt;
    padding: 0 4px;
}

.ai-usage-status-dot-warn {
    color: #fbbf24;
}

.ai-usage-status-dot-refresh {
    color: #60a5fa;
}

.ai-usage-refresh-btn {
    background: rgba(255, 255, 255, 0.1);
    color: #f6f5f4;
    border-radius: 99px;
    min-width: 32px;
    min-height: 32px;
    padding: 0;
    font-size: 11.5pt;
    font-weight: bold;
    border: none;
}

.ai-usage-refresh-btn:hover {
    background: rgba(255, 255, 255, 0.18);
    color: #ffffff;
}

/* GNOME Segmented Pill Tab Bar (Claude | Gemini) */
.ai-usage-tab-bar {
    background-color: rgba(0, 0, 0, 0.26);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 99px;
    padding: 3px;
}

.ai-usage-tab-btn {
    background: transparent;
    border: none;
    border-radius: 99px;
    padding: 6px 14px;
    font-size: 9.5pt;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.65);
    box-shadow: none;
}

.ai-usage-tab-btn:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.06);
}

.ai-usage-tab-btn-active {
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
    font-weight: 800;
}

/* Usage Cards (GNOME Quick Settings style) */
.ai-usage-card {
    background-color: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 16px;
    padding: 12px 14px;
}

.ai-usage-blur-active .ai-usage-card {
    background-color: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
}

.ai-usage-card-green {
    background-color: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(52, 211, 153, 0.25);
    border-radius: 16px;
    padding: 12px 14px;
}

.ai-usage-icon-claude {
    background-color: rgba(224, 122, 95, 0.2);
    color: #f48c6c;
    border-radius: 12px;
    min-width: 34px;
    min-height: 34px;
    font-size: 13pt;
    font-weight: bold;
}

.ai-usage-icon-gemini {
    background-color: rgba(59, 130, 246, 0.22);
    color: #60a5fa;
    border-radius: 12px;
    min-width: 34px;
    min-height: 34px;
    font-size: 13pt;
    font-weight: bold;
}

.ai-usage-card-title {
    font-size: 10.5pt;
    font-weight: 700;
    color: #ffffff;
}

.ai-usage-card-subtitle {
    font-size: 8.8pt;
    color: rgba(255, 255, 255, 0.6);
}

.ai-usage-pct-green {
    font-size: 10.5pt;
    font-weight: 800;
    color: #34d399;
}

.ai-usage-pct-orange {
    font-size: 10.5pt;
    font-weight: 800;
    color: #fbbf24;
}

.ai-usage-pct-red {
    font-size: 10.5pt;
    font-weight: 800;
    color: #f87171;
}

.ai-usage-progress-track {
    min-height: 6px;
    border-radius: 3px;
    background-color: rgba(255, 255, 255, 0.13);
}

.ai-usage-progress-fill-green {
    min-height: 6px;
    border-radius: 3px;
    background-color: #34d399;
}

.ai-usage-progress-fill-blue {
    min-height: 6px;
    border-radius: 3px;
    background-color: #60a5fa;
}

.ai-usage-progress-fill-orange {
    min-height: 6px;
    border-radius: 3px;
    background-color: #fbbf24;
}

.ai-usage-progress-fill-red {
    min-height: 6px;
    border-radius: 3px;
    background-color: #f87171;
}

.ai-usage-reset-text {
    font-size: 8.5pt;
    color: rgba(255, 255, 255, 0.55);
}

.ai-usage-inset-box {
    background-color: rgba(0, 0, 0, 0.22);
    border-radius: 12px;
    padding: 8px 12px;
}

.ai-usage-stat-caption {
    font-size: 8.5pt;
    color: rgba(255, 255, 255, 0.58);
}

.ai-usage-stat-big {
    font-size: 10.5pt;
    font-weight: 800;
    color: #ffffff;
}

.ai-usage-footer-btn {
    background: rgba(255, 255, 255, 0.07);
    border: none;
    padding: 6px 14px;
    border-radius: 99px;
    font-size: 9.5pt;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.88);
}

.ai-usage-footer-btn:hover {
    background-color: rgba(255, 255, 255, 0.15);
    color: #ffffff;
}

.ai-usage-quit-btn {
    background: rgba(239, 68, 68, 0.12);
    border: none;
    padding: 6px 14px;
    border-radius: 99px;
    font-size: 9.5pt;
    font-weight: 600;
    color: #fca5a5;
}

.ai-usage-quit-btn:hover {
    background-color: rgba(239, 68, 68, 0.22);
}

.blur-badge {
    background-color: rgba(20, 20, 24, 0.65);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 99px;
    padding: 6px 14px;
    color: rgba(255, 255, 255, 0.85);
    font-size: 9pt;
    font-weight: 600;
}
`;

function createProgressBar(percentUsed, colorVariant = 'green') {
    const track = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        css_classes: ['ai-usage-progress-track'],
        hexpand: true,
        overflow: Gtk.Overflow.HIDDEN,
    });
    const clamped = Math.min(100, Math.max(2, percentUsed || 0));
    const fillWidth = Math.max(8, Math.round((316 * clamped) / 100));
    const fill = new Gtk.Box({
        css_classes: [`ai-usage-progress-fill-${colorVariant}`],
        width_request: fillWidth,
        halign: Gtk.Align.START,
    });
    track.append(fill);
    return track;
}

function createCard(desc) {
    const {
        icon: iconType = null,
        title,
        subtitle,
        value: rightText,
        severity = 'green',
        percent = null,
        footer: bottomRightText = null,
        highlight: isGreenCard = false,
    } = desc;
    const rightColor = severity === 'neutral' ? 'green' : severity;
    const barColor = severity === 'neutral' ? 'blue' : severity;
    const [insetLeft, insetRight] = desc.stats || [];
    const insetLeftTitle = insetLeft?.label, insetLeftValue = insetLeft?.value;
    const insetRightTitle = insetRight?.label, insetRightValue = insetRight?.value;
    const card = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        css_classes: [isGreenCard ? 'ai-usage-card-green' : 'ai-usage-card'],
        hexpand: true,
    });

    const topRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        valign: Gtk.Align.CENTER,
        hexpand: true,
    });

    if (iconType === 'claude' || iconType === 'gemini') {
        const iconBadge = new Gtk.Label({
            label: '✦',
            css_classes: [iconType === 'claude' ? 'ai-usage-icon-claude' : 'ai-usage-icon-gemini'],
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });
        topRow.append(iconBadge);
    }

    const titleCol = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 2,
        hexpand: true,
        valign: Gtk.Align.CENTER,
    });
    titleCol.append(new Gtk.Label({
        label: title,
        xalign: 0,
        css_classes: ['ai-usage-card-title'],
    }));
    titleCol.append(new Gtk.Label({
        label: subtitle,
        xalign: 0,
        css_classes: ['ai-usage-card-subtitle'],
    }));
    topRow.append(titleCol);

    const pctLabel = new Gtk.Label({
        label: rightText,
        valign: Gtk.Align.START,
        css_classes: [`ai-usage-pct-${rightColor}`],
    });
    topRow.append(pctLabel);

    card.append(topRow);
    if (percent !== null) card.append(createProgressBar(percent, barColor));

    if (bottomRightText) {
        const resetRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
        });
        resetRow.append(new Gtk.Box({ hexpand: true }));
        resetRow.append(new Gtk.Label({
            label: bottomRightText,
            xalign: 1,
            css_classes: ['ai-usage-reset-text'],
        }));
        card.append(resetRow);
    }

    if (insetLeftTitle && insetRightTitle) {
        const insetBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            css_classes: isGreenCard ? [] : ['ai-usage-inset-box'],
            margin_top: 2,
        });

        const leftCol = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            hexpand: true,
        });
        leftCol.append(new Gtk.Label({
            label: insetLeftTitle,
            xalign: 0,
            css_classes: ['ai-usage-stat-caption'],
        }));
        leftCol.append(new Gtk.Label({
            label: insetLeftValue,
            xalign: 0,
            css_classes: ['ai-usage-stat-big'],
        }));
        insetBox.append(leftCol);

        const rightCol = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            halign: Gtk.Align.END,
        });
        rightCol.append(new Gtk.Label({
            label: insetRightTitle,
            xalign: 1,
            css_classes: ['ai-usage-stat-caption'],
        }));
        rightCol.append(new Gtk.Label({
            label: insetRightValue,
            xalign: 1,
            css_classes: ['ai-usage-stat-big'],
        }));
        insetBox.append(rightCol);

        card.append(insetBox);
    }

    return card;
}

const app = new Adw.Application({
    application_id: 'org.gnome.shell.extensions.ai-consumption-monitor.TopBarSimulator',
});

app.connect('activate', () => {
    const provider = new Gtk.CssProvider();
    provider.load_from_string(css);
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    );

    const settingsSchemaSource = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([GLib.get_current_dir(), 'schemas']),
        Gio.SettingsSchemaSource.get_default(),
        false
    );
    const schema = settingsSchemaSource.lookup('org.gnome.shell.extensions.ai-consumption-monitor', true);
    const settings = new Gio.Settings({ settings_schema: schema });
    const service = new MetricsService(GLib.get_current_dir());
    const blurInfo = detectBlurExtension();
    const wallpaperPath = getDesktopWallpaperPath();

    const win = new Gtk.ApplicationWindow({
        application: app,
        title: 'GNOME Top Panel — AI Usage Indicator Simulator',
        default_width: 960,
        default_height: 760,
    });

    const mainOverlay = new Gtk.Overlay({
        hexpand: true,
        vexpand: true,
    });

    if (wallpaperPath) {
        const bgPic = Gtk.Picture.new_for_filename(wallpaperPath);
        bgPic.content_fit = Gtk.ContentFit.COVER;
        bgPic.hexpand = true;
        bgPic.vexpand = true;
        mainOverlay.set_child(bgPic);
    } else {
        const fallbackBg = new Gtk.Box({
            css_classes: ['desktop-fallback-bg'],
            hexpand: true,
            vexpand: true,
        });
        mainOverlay.set_child(fallbackBg);
    }

    const foregroundBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        hexpand: true,
        vexpand: true,
    });

    // 1. Simulated GNOME Shell Top Bar
    const topBar = new Gtk.CenterBox({
        css_classes: blurInfo.enabled
            ? ['gnome-top-panel', 'gnome-top-panel-blur']
            : ['gnome-top-panel'],
    });

    const activitiesLabel = new Gtk.Label({
        label: '●  Activities',
        css_classes: ['panel-clock'],
        margin_start: 6,
    });
    topBar.set_start_widget(activitiesLabel);

    const clockLabel = new Gtk.Label({
        label: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        css_classes: ['panel-clock'],
    });
    topBar.set_center_widget(clockLabel);

    const rightBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
    });

    // Top Bar Indicator Button (NO icon at the beginning, only Claude % · AGY %)
    const btnLabel = new Gtk.Label({
        label: 'Claude --% · AGY --%',
    });
    const indicatorBtn = new Gtk.Button({
        css_classes: ['panel-indicator-btn', 'panel-indicator-btn-active'],
        child: btnLabel,
    });

    rightBox.append(indicatorBtn);
    const sysIcons = new Gtk.Label({
        label: '🔊  🔋',
        margin_end: 6,
    });
    rightBox.append(sysIcons);
    topBar.set_end_widget(rightBox);

    foregroundBox.append(topBar);

    // 2. Popup Menu Overlay Container aligned top-right below panel
    const menuArea = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        halign: Gtk.Align.END,
        valign: Gtk.Align.START,
        margin_top: 8,
        margin_end: 16,
    });

    const popupContainer = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 12,
        css_classes: blurInfo.enabled
            ? ['ai-usage-popup-card', 'ai-usage-blur-active']
            : ['ai-usage-popup-card'],
    });

    indicatorBtn.connect('clicked', () => {
        popupContainer.visible = !popupContainer.visible;
        if (popupContainer.visible) {
            indicatorBtn.add_css_class('panel-indicator-btn-active');
        } else {
            indicatorBtn.remove_css_class('panel-indicator-btn-active');
        }
    });

    // Header Row: "AI Usage" + Status Dot (no text) + Circular Refresh Button
    const headerRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        valign: Gtk.Align.CENTER,
    });

    const titleLbl = new Gtk.Label({
        label: 'AI Usage',
        css_classes: ['ai-usage-title'],
    });
    headerRow.append(titleLbl);

    const statusDot = new Gtk.Label({
        label: '●',
        css_classes: ['ai-usage-status-dot'],
        valign: Gtk.Align.CENTER,
    });
    headerRow.append(statusDot);

    headerRow.append(new Gtk.Box({ hexpand: true }));

    const refreshBtn = new Gtk.Button({
        label: '↻',
        css_classes: ['ai-usage-refresh-btn'],
        valign: Gtk.Align.CENTER,
    });
    refreshBtn.connect('clicked', () => {
        statusDot.set_css_classes(['ai-usage-status-dot', 'ai-usage-status-dot-refresh']);
        service.refreshNow();
    });
    headerRow.append(refreshBtn);

    popupContainer.append(headerRow);

    // Segmented Tab Bar: Claude | Gemini (Overview & Weekly removed)
    const tabBar = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 4,
        css_classes: ['ai-usage-tab-bar'],
        homogeneous: true,
    });

    let activeTab = 'claude';
    let latestData = null;
    const tabButtons = {};

    const cardsBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 10,
    });

    const renderCards = () => {
        let child = cardsBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            cardsBox.remove(child);
            child = next;
        }

        const opts = {
            warningPercent: settings.get_int('quota-warning-percent'),
            tokenThreshold: settings.get_int('claude-token-daily-threshold'),
            stepThreshold: settings.get_int('antigravity-step-daily-threshold'),
        };
        const cards = activeTab === 'gemini'
            ? buildGeminiCards(latestData, opts)
            : buildClaudeCards(latestData, opts);
        for (const desc of cards) cardsBox.append(createCard(desc));
    };

    const tabs = [
        { id: 'claude', label: 'Claude' },
        { id: 'gemini', label: 'Gemini' },
    ];

    const updateTabClasses = () => {
        for (const [id, b] of Object.entries(tabButtons)) {
            if (id === activeTab) {
                b.set_css_classes(['ai-usage-tab-btn', 'ai-usage-tab-btn-active']);
            } else {
                b.set_css_classes(['ai-usage-tab-btn']);
            }
        }
    };

    for (const t of tabs) {
        const btn = new Gtk.Button({
            label: t.label,
            css_classes: t.id === activeTab
                ? ['ai-usage-tab-btn', 'ai-usage-tab-btn-active']
                : ['ai-usage-tab-btn'],
        });
        btn.connect('clicked', () => {
            activeTab = t.id;
            updateTabClasses();
            renderCards();
        });
        tabButtons[t.id] = btn;
        tabBar.append(btn);
    }

    popupContainer.append(tabBar);
    popupContainer.append(cardsBox);

    // Footer Row: Settings
    const footerRow = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        hexpand: true,
        margin_top: 2,
    });

    const prefsBtn = new Gtk.Button({
        label: '⚙  Settings',
        css_classes: ['ai-usage-footer-btn'],
    });
    prefsBtn.connect('clicked', () => {
        const prefsWin = new Adw.PreferencesWindow({
            transient_for: win,
            title: 'AI Consumption Monitor Preferences',
            default_width: 620,
            default_height: 520,
        });
        prefsWin.add(new AiConsumptionPrefsPage(settings));
        prefsWin.present();
    });
    footerRow.append(prefsBtn);

    footerRow.append(new Gtk.Box({ hexpand: true }));

    popupContainer.append(footerRow);

    menuArea.append(popupContainer);
    foregroundBox.append(menuArea);

    // Bottom status badge showing GNOME Blur detection state
    const bottomSpacer = new Gtk.Box({ vexpand: true });
    foregroundBox.append(bottomSpacer);

    const blurStatusRow = new Gtk.Box({
        halign: Gtk.Align.START,
        margin_start: 16,
        margin_bottom: 14,
    });
    const blurBadge = new Gtk.Label({
        label: blurInfo.enabled
            ? `✦ GNOME Blur Detected (${blurInfo.uuid}) — Translucent Shell Mode Active`
            : 'GNOME Solid Shell Mode (No blur extension detected)',
        css_classes: ['blur-badge'],
    });
    blurStatusRow.append(blurBadge);
    foregroundBox.append(blurStatusRow);

    mainOverlay.add_overlay(foregroundBox);
    win.set_child(mainOverlay);

    const updateUI = (data) => {
        if (!data) return;
        latestData = data;

        const state = buildPanelState(data, {
            mode: settings.get_string('display-mode'),
            warningPercent: settings.get_int('quota-warning-percent'),
            showClaude: settings.get_boolean('show-claude'),
            showAntigravity: settings.get_boolean('show-antigravity'),
        });
        statusDot.set_css_classes(state.warning
            ? ['ai-usage-status-dot', 'ai-usage-status-dot-warn']
            : ['ai-usage-status-dot']);
        if (state.warning) btnLabel.add_css_class('panel-warning');
        else btnLabel.remove_css_class('panel-warning');
        btnLabel.label = state.text;

        renderCards();
    };

    renderCards();

    service.connect('metrics-updated', (_svc, data) => updateUI(data));

    const configureService = () => service.configure({
        intervalSeconds: settings.get_int('poll-interval-seconds'),
        claudePath: settings.get_string('claude-path-override'),
        antigravityPath: settings.get_string('antigravity-path-override'),
        showClaude: settings.get_boolean('show-claude'),
        showAntigravity: settings.get_boolean('show-antigravity'),
        allowNetwork: settings.get_boolean('allow-network'),
    });

    settings.connect('changed', () => {
        configureService();
        const latest = service.getLatestData();
        if (latest) updateUI(latest);
    });

    win.connect('close-request', () => {
        service.destroy();
        return false;
    });

    configureService();
    service.start();

    win.present();
});

app.run([]);
