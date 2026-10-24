import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export class AiConsumptionPrefsPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(settings, _ = (s) => s) {
        super({
            title: _('AI Consumption'),
            icon_name: 'utilities-system-monitor-symbolic',
        });

        this._settings = settings;

        // Group 0: Providers
        const providersGroup = new Adw.PreferencesGroup({
            title: _('Providers'),
            description: _('Choose which AI tools appear in the top bar and popup'),
        });
        this.add(providersGroup);

        const providerRows = {};
        for (const [key, title] of [
            ['show-claude', _('Claude Code')],
            ['show-antigravity', _('Antigravity')],
        ]) {
            const row = new Adw.SwitchRow({ title });
            this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            providersGroup.add(row);
            providerRows[key] = row;
        }

        // Keep at least one provider on: the last active switch can't be turned off.
        const syncProviderLocks = () => {
            const active = Object.keys(providerRows).filter(k => this._settings.get_boolean(k));
            for (const [key, row] of Object.entries(providerRows)) {
                row.sensitive = !(active.length === 1 && active[0] === key);
            }
        };
        const lockIds = Object.keys(providerRows)
            .map(key => this._settings.connect(`changed::${key}`, syncProviderLocks));
        this.connect('destroy', () => lockIds.forEach(id => this._settings.disconnect(id)));
        syncProviderLocks();

        // Planned integrations, shown but not selectable yet.
        for (const title of [_('Kimi'), _('OpenCode')]) {
            providersGroup.add(new Adw.SwitchRow({
                title,
                subtitle: _('Coming soon'),
                active: false,
                sensitive: false,
            }));
        }

        // Group 1: General & Display
        const generalGroup = new Adw.PreferencesGroup({
            title: _('General Settings'),
            description: _('Configure monitoring frequency and top-panel display format'),
        });
        this.add(generalGroup);

        // Polling interval row
        const intervalRow = new Adw.SpinRow({
            title: _('Refresh Interval (seconds)'),
            subtitle: _('Minimum 5 seconds'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 3600,
                step_increment: 5,
                page_increment: 30,
            }),
        });
        this._settings.bind(
            'poll-interval-seconds',
            intervalRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(intervalRow);

        // Display mode combo row
        const modeModel = new Gtk.StringList();
        modeModel.append(_('Quota Percentages (Claude % · AGY %)'));
        modeModel.append(_("Today's Token & Step Totals"));
        modeModel.append(_('Compact Percentages (% · %)'));

        const modeMap = ['sessions', 'tokens', 'compact'];
        const currentMode = this._settings.get_string('display-mode');
        let selectedIndex = modeMap.indexOf(currentMode);
        if (selectedIndex === -1) selectedIndex = 0;

        const displayModeRow = new Adw.ComboRow({
            title: _('Panel Metric Display'),
            subtitle: _('Choose what summary metric appears on the top bar'),
            model: modeModel,
            selected: selectedIndex,
        });

        displayModeRow.connect('notify::selected', () => {
            const idx = displayModeRow.selected;
            if (idx >= 0 && idx < modeMap.length) {
                this._settings.set_string('display-mode', modeMap[idx]);
            }
        });
        generalGroup.add(displayModeRow);

        // Group 2: Warning Thresholds
        const thresholdGroup = new Adw.PreferencesGroup({
            title: _('Alert Thresholds'),
            description: _('When to highlight quota and daily usage (0 disables a daily threshold)'),
        });
        this.add(thresholdGroup);

        const quotaWarningRow = new Adw.SpinRow({
            title: _('Quota Warning (%)'),
            subtitle: _('Warn when a quota window reaches this usage'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 100,
                step_increment: 5,
                page_increment: 10,
            }),
        });
        this._settings.bind(
            'quota-warning-percent',
            quotaWarningRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        thresholdGroup.add(quotaWarningRow);

        const claudeThresholdRow = new Adw.SpinRow({
            title: _('Claude Daily Token Threshold'),
            subtitle: _('Alert when today total tokens exceed this limit'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 50000000,
                step_increment: 10000,
                page_increment: 100000,
            }),
        });
        this._settings.bind(
            'claude-token-daily-threshold',
            claudeThresholdRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        thresholdGroup.add(claudeThresholdRow);

        const agThresholdRow = new Adw.SpinRow({
            title: _('Antigravity Daily Step Threshold'),
            subtitle: _('Alert when today steps exceed this limit'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 10000,
                step_increment: 20,
                page_increment: 100,
            }),
        });
        this._settings.bind(
            'antigravity-step-daily-threshold',
            agThresholdRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        thresholdGroup.add(agThresholdRow);

        // Group 3: Custom Paths
        const pathsGroup = new Adw.PreferencesGroup({
            title: _('Custom Directory Overrides'),
            description: _('Leave blank to use standard default locations (~/.claude and ~/.gemini/antigravity-cli)'),
        });
        this.add(pathsGroup);

        const claudePathRow = new Adw.EntryRow({
            title: _('Claude Directory Path'),
            show_apply_button: true,
        });
        this._settings.bind(
            'claude-path-override',
            claudePathRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        pathsGroup.add(claudePathRow);

        const agPathRow = new Adw.EntryRow({
            title: _('Antigravity Directory Path'),
            show_apply_button: true,
        });
        this._settings.bind(
            'antigravity-path-override',
            agPathRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );
        pathsGroup.add(agPathRow);
    }
}

export default class AiConsumptionExtensionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const translate = (s) => {
            try {
                return this.gettext(s);
            } catch {
                return s;
            }
        };
        window.add(new AiConsumptionPrefsPage(settings, translate));
    }
}
