import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { MetricsService } from './lib/metricsService.js';
import { IndicatorMenuManager } from './lib/indicatorMenu.js';
import { buildPanelState } from './lib/viewModel.js';

// Keys that change what the collector does; everything else only affects rendering.
const SERVICE_KEYS = ['poll-interval-seconds', 'claude-path-override', 'antigravity-path-override'];

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
            text: _('AI --'),
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

        // Build Indicator Button and add to panel before building menu actors
        this._indicator = new AiConsumptionIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._menuManager = new IndicatorMenuManager(
            this._indicator,
            this._service,
            this._settings,
            () => this.openPreferences(),
            this.path
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
            if (SERVICE_KEYS.includes(key)) {
                this._applySettingsToService();
                return;
            }
            const latest = this._service.getLatestData();
            if (latest) {
                this._updateIndicatorDisplay(latest);
                this._menuManager.updateMenu(latest);
            }
        });

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

        const state = buildPanelState(data, {
            mode: this._settings.get_string('display-mode'),
            warningPercent: this._settings.get_int('quota-warning-percent'),
            tokenThreshold: this._settings.get_int('claude-token-daily-threshold'),
            stepThreshold: this._settings.get_int('antigravity-step-daily-threshold'),
        });
        this._indicator.setLabelVisible(true);
        this._indicator.setWarning(state.warning);
        this._indicator.setLabelText(state.text);
    }

    disable() {
        if (this._settingsChangedId && this._settings) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        if (this._menuManager) {
            this._menuManager.destroy();
            this._menuManager = null;
        }

        if (this._service) {
            if (this._metricsUpdatedId) {
                this._service.disconnect(this._metricsUpdatedId);
                this._metricsUpdatedId = null;
            }
            this._service.stop();
            this._service = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }
}
