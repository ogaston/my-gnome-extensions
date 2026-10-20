import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionState } from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    buildClaudeCards,
    buildGeminiCards,
    formatUpdatedAgo,
    setGettext,
} from './viewModel.js';

const BLUR_UUID = 'blur-my-shell@aunetx';

function setVertical(box) {
    if ('orientation' in box) {
        box.orientation = Clutter.Orientation.VERTICAL;
    } else {
        box.vertical = true;
    }
}

export class IndicatorMenuManager {
    constructor(panelButton, metricsService, settings, openPreferencesCallback) {
        setGettext(_);
        this._button = panelButton;
        this._menu = panelButton.menu;
        this._service = metricsService;
        this._settings = settings;
        this._openPreferences = openPreferencesCallback;
        this._activeTab = 'claude';
        this._latestData = null;
        this._lastError = null;

        this._buildMenuShell();

        this._menuOpenId = this._menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._render();
        });
        this._errorId = this._service.connect('metrics-error', (_svc, message) => {
            this._lastError = message;
            this._syncStatus();
        });

        this._extensionStateId = Main.extensionManager.connect('extension-state-changed', (_mgr, ext) => {
            if (ext?.uuid === BLUR_UUID) this._syncBlurState();
        });
        this._syncBlurState();
    }

    _isBlurExtensionEnabled() {
        return Main.extensionManager.lookup(BLUR_UUID)?.state === ExtensionState.ACTIVE;
    }

    _syncBlurState() {
        const blurEnabled = this._isBlurExtensionEnabled();
        const menuBox = this._menu?.box;
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
            if (menuBox.get_effect('ai-usage-bg-blur')) {
                menuBox.remove_effect_by_name('ai-usage-bg-blur');
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

        headerRow.add_child(new St.Label({
            text: _('AI Usage'),
            style_class: 'ai-usage-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        this._statusDot = new St.Widget({
            style_class: 'ai-usage-status-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(this._statusDot);

        headerRow.add_child(new St.Widget({ x_expand: true }));

        const refreshBtn = new St.Button({
            child: new St.Icon({ icon_name: 'view-refresh-symbolic', style_class: 'popup-menu-icon' }),
            style_class: 'ai-usage-refresh-btn',
            accessible_name: _('Refresh'),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        refreshBtn.connect('clicked', () => {
            this._setStatus('refresh', _('Refreshing'));
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
            { id: 'claude', label: _('Claude') },
            { id: 'gemini', label: _('Gemini') },
        ];

        for (const t of tabs) {
            const btn = new St.Button({
                label: t.label,
                style_class: 'ai-usage-tab-btn',
                x_expand: true,
                can_focus: true,
            });
            btn.connect('clicked', () => {
                this._activeTab = t.id;
                this._render();
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

        // 4. Footer Row: Settings + last update time
        const footerRow = new St.BoxLayout({
            style_class: 'ai-usage-footer-row',
            x_expand: true,
        });

        const settingsContent = new St.BoxLayout({ style_class: 'ai-usage-footer-btn-box' });
        settingsContent.add_child(new St.Icon({ icon_name: 'emblem-system-symbolic', style_class: 'popup-menu-icon' }));
        settingsContent.add_child(new St.Label({ text: _('Settings'), y_align: Clutter.ActorAlign.CENTER }));
        const settingsBtn = new St.Button({
            child: settingsContent,
            style_class: 'ai-usage-footer-btn',
            can_focus: true,
        });
        settingsBtn.connect('clicked', () => {
            this._menu.close();
            this._openPreferences?.();
        });
        footerRow.add_child(settingsBtn);

        footerRow.add_child(new St.Widget({ x_expand: true }));

        this._updatedLabel = new St.Label({
            text: '',
            style_class: 'ai-usage-updated-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        footerRow.add_child(this._updatedLabel);

        this._rootBox.add_child(footerRow);

        this._menu.box?.add_child(this._rootBox);

        this._syncStatus();
    }

    _cardOptions() {
        return {
            warningPercent: this._settings.get_int('quota-warning-percent'),
            tokenThreshold: this._settings.get_int('claude-token-daily-threshold'),
            stepThreshold: this._settings.get_int('antigravity-step-daily-threshold'),
        };
    }

    _setStatus(kind, description) {
        this._statusDot.style_class = `ai-usage-status-dot ai-usage-status-dot-${kind}`;
        this._statusDot.accessible_name = description;
    }

    _syncStatus() {
        if (this._lastError) {
            this._setStatus('error', _('Last refresh failed'));
            this._updatedLabel.text = _('Refresh failed');
            return;
        }
        if (!this._latestData) {
            this._setStatus('refresh', _('Waiting for data'));
            this._updatedLabel.text = '';
            return;
        }
        const { warningPercent } = this._cardOptions();
        const data = this._latestData;
        const hot = [
            data.claude?.oauth_quota?.five_hour,
            data.claude?.oauth_quota?.seven_day,
            data.antigravity?.oauth_quota?.gemini,
        ].some(b => typeof b?.used_percent === 'number' && b.used_percent >= warningPercent);
        this._setStatus(hot ? 'warn' : 'ok', hot ? _('Quota warning') : _('All quotas healthy'));
        this._updatedLabel.text = formatUpdatedAgo(data.timestamp);
    }

    _createProgressBar(percent, colorVariant) {
        const clamped = Math.min(100, Math.max(0, percent));
        const track = new St.BoxLayout({
            style_class: 'ai-usage-progress-track',
            x_expand: true,
        });
        const fill = new St.Widget({
            style_class: `ai-usage-progress-fill ai-usage-progress-fill-${colorVariant}`,
            visible: clamped > 0,
            width: clamped > 0 ? Math.max(6, Math.round((318 * clamped) / 100)) : 0,
        });
        track.add_child(fill);
        return track;
    }

    _createCard(card) {
        const box = new St.BoxLayout({
            style_class: card.highlight ? 'ai-usage-card ai-usage-card-highlight' : 'ai-usage-card',
            x_expand: true,
        });
        setVertical(box);

        const topRow = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        if (card.icon) {
            topRow.add_child(new St.Bin({
                style_class: `ai-usage-icon ai-usage-icon-${card.icon}`,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({ icon_name: 'starred-symbolic', icon_size: 16 }),
            }));
        }

        const titleCol = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        setVertical(titleCol);
        titleCol.add_child(new St.Label({ text: card.title, style_class: 'ai-usage-card-title' }));
        titleCol.add_child(new St.Label({ text: card.subtitle, style_class: 'ai-usage-card-subtitle' }));
        topRow.add_child(titleCol);

        const valueBox = new St.BoxLayout({
            style_class: `ai-usage-value ai-usage-pct-${card.severity}`,
            y_align: Clutter.ActorAlign.START,
        });
        if (card.severity === 'orange' || card.severity === 'red') {
            valueBox.add_child(new St.Icon({
                icon_name: 'dialog-warning-symbolic',
                style_class: 'ai-usage-value-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        valueBox.add_child(new St.Label({ text: card.value, y_align: Clutter.ActorAlign.CENTER }));
        topRow.add_child(valueBox);

        box.add_child(topRow);

        if (card.percent !== null && card.percent !== undefined) {
            box.add_child(this._createProgressBar(card.percent, card.severity));
        }

        if (card.footer) {
            const footerRow = new St.BoxLayout({ x_expand: true });
            footerRow.add_child(new St.Widget({ x_expand: true }));
            footerRow.add_child(new St.Label({ text: card.footer, style_class: 'ai-usage-reset-text' }));
            box.add_child(footerRow);
        }

        if (card.stats?.length === 2) {
            const insetBox = new St.BoxLayout({ style_class: 'ai-usage-inset-box', x_expand: true });
            card.stats.forEach((stat, i) => {
                const align = i === 0 ? Clutter.ActorAlign.START : Clutter.ActorAlign.END;
                const col = new St.BoxLayout({ x_expand: i === 0, x_align: align });
                setVertical(col);
                col.add_child(new St.Label({ text: stat.label, style_class: 'ai-usage-stat-caption', x_align: align }));
                col.add_child(new St.Label({ text: stat.value, style_class: 'ai-usage-stat-big', x_align: align }));
                insetBox.add_child(col);
            });
            box.add_child(insetBox);
        }

        return box;
    }

    updateMenu(data) {
        if (!data) return;
        this._latestData = data;
        this._lastError = null;
        this._syncStatus();
        // Cards are only rebuilt while visible; opening the menu renders the latest data.
        if (this._menu.isOpen) this._render();
    }

    _render() {
        for (const [id, btn] of Object.entries(this._tabButtons)) {
            if (id === this._activeTab) {
                btn.add_style_class_name('ai-usage-tab-btn-active');
            } else {
                btn.remove_style_class_name('ai-usage-tab-btn-active');
            }
        }
        this._syncStatus();

        this._cardsBox.destroy_all_children();
        const opts = this._cardOptions();
        const cards = this._activeTab === 'gemini'
            ? buildGeminiCards(this._latestData, opts)
            : buildClaudeCards(this._latestData, opts);
        for (const card of cards) {
            this._cardsBox.add_child(this._createCard(card));
        }
    }

    destroy() {
        if (this._extensionStateId) {
            Main.extensionManager.disconnect(this._extensionStateId);
            this._extensionStateId = null;
        }
        if (this._errorId) {
            this._service.disconnect(this._errorId);
            this._errorId = null;
        }
        if (this._menuOpenId) {
            this._menu.disconnect(this._menuOpenId);
            this._menuOpenId = null;
        }
    }
}
