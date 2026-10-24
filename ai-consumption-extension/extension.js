// SPDX-License-Identifier: GPL-2.0-or-later
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
const SERVICE_KEYS = [
    'poll-interval-seconds', 'claude-path-override', 'antigravity-path-override',
    'show-claude', 'show-antigravity', 'allow-network',
];

const AiConsumptionIndicator = GObject.registerClass(
class AiConsumptionIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('AI Consumption Monitor'));

        this._box = new St.BoxLayout({ style_class: 'ai-consumption-panel-box' });

        this._label = new St.Label({
            text: _('AI --'),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ai-consumption-panel-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);
    }

    setLabelText(text) {
        this._label.text = text;
    }

    setWarning(hasWarning) {
        if (hasWarning)
            this._label.add_style_class_name('ai-consumption-warning-label');
        else
            this._label.remove_style_class_name('ai-consumption-warning-label');
    }
});

export default class AiConsumptionExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._service = new MetricsService(this.path);

        this._applySettingsToService();

        // The indicator must be in the panel before the menu actors are built.
        this._indicator = new AiConsumptionIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._menuManager = new IndicatorMenuManager(
            this._indicator,
            this._service,
            this._settings,
            () => this.openPreferences(),
            this.path
        );

        this._metricsUpdatedId = this._service.connect('metrics-updated', (_svc, data) => {
            this._updateIndicatorDisplay(data);
            this._menuManager.updateMenu(data);
        });

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (SERVICE_KEYS.includes(key)) {
                this._applySettingsToService();
                // Re-collect so a re-enabled provider fills in without waiting a full interval.
                if (key.startsWith('show-')) this._service.refreshNow();
                return;
            }
            const latest = this._service.getLatestData();
            if (latest) {
                this._updateIndicatorDisplay(latest);
                this._menuManager.updateMenu(latest);
            }
        });

        this._service.start();
    }

    _applySettingsToService() {
        this._service.configure({
            intervalSeconds: this._settings.get_int('poll-interval-seconds'),
            claudePath: this._settings.get_string('claude-path-override'),
            antigravityPath: this._settings.get_string('antigravity-path-override'),
            showClaude: this._settings.get_boolean('show-claude'),
            showAntigravity: this._settings.get_boolean('show-antigravity'),
            allowNetwork: this._settings.get_boolean('allow-network'),
        });
    }

    _updateIndicatorDisplay(data) {
        const state = buildPanelState(data, {
            mode: this._settings.get_string('display-mode'),
            warningPercent: this._settings.get_int('quota-warning-percent'),
            showClaude: this._settings.get_boolean('show-claude'),
            showAntigravity: this._settings.get_boolean('show-antigravity'),
        });
        this._indicator.setWarning(state.warning);
        this._indicator.setLabelText(state.text);
    }

    disable() {
        this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;

        this._menuManager.destroy();
        this._menuManager = null;

        this._service.disconnect(this._metricsUpdatedId);
        this._metricsUpdatedId = null;
        this._service.destroy();
        this._service = null;

        this._indicator.destroy();
        this._indicator = null;

        this._settings = null;
    }
}
