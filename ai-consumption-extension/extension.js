import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { MetricsService } from './lib/metricsService.js';
import { IndicatorMenuManager } from './lib/indicatorMenu.js';

const AiConsumptionIndicator = GObject.registerClass(
class AiConsumptionIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('AI Consumption Monitor'));

        this._box = new St.BoxLayout({
            style_class: 'ai-consumption-panel-box',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this._label = new St.Label({
            text: 'Claude --% · AGY --%',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ai-consumption-panel-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);
    }

    setLabelText(text) {
        if (this._label) {
            this._label.text = text;
        }
    }

    setLabelVisible(visible) {
        if (this._label) {
            this._label.visible = visible;
        }
    }

    setWarning(hasWarning) {
        if (!this._label) return;
        if (hasWarning) {
            this._label.add_style_class_name('ai-consumption-warning-label');
        } else {
            this._label.remove_style_class_name('ai-consumption-warning-label');
        }
    }
});

export default class AiConsumptionExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._service = new MetricsService(this.path);

        // Apply settings to service
        this._applySettingsToService();

        // Build Indicator Button
        this._indicator = new AiConsumptionIndicator();
        this._menuManager = new IndicatorMenuManager(
            this._indicator,
            this._service,
            () => this.openPreferences()
        );

        // Connect to metrics updates
        this._metricsUpdatedId = this._service.connect('metrics-updated', (svc, jsonStr) => {
            try {
                const data = JSON.parse(jsonStr);
                this._updateIndicatorDisplay(data);
                this._menuManager.updateMenu(data);
            } catch (e) {
                console.error(`[AI Consumption Monitor] Failed to parse metrics in extension: ${e.message}`);
            }
        });

        // Connect settings signals
        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            this._applySettingsToService();
            const latest = this._service.getLatestData();
            if (latest) {
                this._updateIndicatorDisplay(latest);
            }
        });

        // Add to panel
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // Start polling
        this._service.start();
    }

    _applySettingsToService() {
        if (!this._service || !this._settings) return;
        const interval = this._settings.get_int('poll-interval-seconds');
        const claudePath = this._settings.get_string('claude-path-override');
        const agPath = this._settings.get_string('antigravity-path-override');
        this.updateServiceConfig(interval, claudePath, agPath);
    }

    updateServiceConfig(interval, claudePath, agPath) {
        this._service.configure(interval, claudePath, agPath);
        this._service.setInterval(interval);
    }

    _updateIndicatorDisplay(data) {
        if (!this._indicator || !data) return;

        this._indicator.setLabelVisible(true);

        const mode = this._settings.get_string('display-mode') || 'sessions';
        const claudeTokens = data.claude?.today?.total_tokens || 0;
        const agSteps = data.antigravity?.today?.steps || 0;

        // Check thresholds
        const tokenThreshold = this._settings.get_int('claude-token-daily-threshold');
        const stepThreshold = this._settings.get_int('antigravity-step-daily-threshold');
        const fiveHUsed = data.claude?.oauth_quota?.five_hour?.used_percent ?? 0;
        const sevenDUsed = data.claude?.oauth_quota?.seven_day?.used_percent ?? 0;
        const geminiUsed = data.antigravity?.oauth_quota?.gemini?.used_percent ?? 0;

        const hasWarning = (tokenThreshold > 0 && claudeTokens >= tokenThreshold) ||
                           (stepThreshold > 0 && agSteps >= stepThreshold) ||
                           (data.antigravity?.quota?.status === 'warning') ||
                           fiveHUsed >= 85 || sevenDUsed >= 85 || geminiUsed >= 85;

        this._indicator.setWarning(hasWarning);

        if (mode === 'tokens') {
            const formatted = this._formatTokens(claudeTokens);
            this._indicator.setLabelText(`${formatted} tok | ${agSteps} stp`);
        } else if (mode === 'compact') {
            this._indicator.setLabelText(`${Math.round(fiveHUsed)}% · ${Math.round(geminiUsed)}%`);
        } else {
            this._indicator.setLabelText(`Claude ${Math.round(fiveHUsed)}% · AGY ${Math.round(geminiUsed)}%`);
        }
    }

    _formatTokens(count) {
        if (!count || count <= 0) return '0';
        if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
        if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
        return count.toString();
    }

    disable() {
        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._service) {
            if (this._metricsUpdatedId) {
                this._service.disconnect(this._metricsUpdatedId);
                this._metricsUpdatedId = null;
            }
            this._service.stop();
            this._service = null;
        }

        if (this._menuManager) {
            this._menuManager.destroy?.();
            this._menuManager = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }
}
