import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GIRepository from 'gi://GIRepository';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

const repo = GIRepository.Repository.dup_default();
repo.prepend_search_path('/usr/lib64/gnome-shell/girepository-1.0');
repo.prepend_library_path('/usr/lib64/gnome-shell');

Gtk.init();
Adw.init();

const resource = Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
Gio.resources_register(resource);

const { default: AiConsumptionExtensionPreferences } = await import('../prefs.js');

const settingsSchemaSource = Gio.SettingsSchemaSource.new_from_directory(
    GLib.build_filenamev([GLib.get_current_dir(), 'schemas']),
    Gio.SettingsSchemaSource.get_default(),
    false
);

const schema = settingsSchemaSource.lookup('org.gnome.shell.extensions.ai-consumption-monitor', true);
const settings = new Gio.Settings({ settings_schema: schema });

const extDir = Gio.File.new_for_path(GLib.get_current_dir());
const prefs = new AiConsumptionExtensionPreferences({
    uuid: 'ai-consumption-monitor@omarjayg',
    dir: extDir,
    path: GLib.get_current_dir(),
    url: extDir.get_uri(),
    metadata: {
        uuid: 'ai-consumption-monitor@omarjayg',
        name: 'AI Consumption Monitor',
        'settings-schema': 'org.gnome.shell.extensions.ai-consumption-monitor',
    },
});
prefs.getSettings = () => settings;

const window = new Adw.PreferencesWindow();
prefs.fillPreferencesWindow(window);

console.log('Successfully instantiated AiConsumptionExtensionPreferences and populated Adw.PreferencesWindow!');
