import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

export const MetricsService = GObject.registerClass({
    GTypeName: 'AiConsumptionMetricsService',
    Signals: {
        'metrics-updated': {
            param_types: [GObject.TYPE_STRING],
        },
        'metrics-error': {
            param_types: [GObject.TYPE_STRING],
        },
    },
}, class MetricsService extends GObject.Object {
    _init(extensionPath) {
        super._init();
        this._extensionPath = extensionPath;
        this._collectorScript = GLib.build_filenamev([this._extensionPath, 'lib', 'collector.py']);
        this._timerId = null;
        this._isRunning = false;
        this._intervalSeconds = 30;
        this._claudePath = '';
        this._antigravityPath = '';
        this._showClaude = true;
        this._showAntigravity = true;
        this._cancellable = null;
        this._latestData = null;
    }

    configure(intervalSeconds, claudePath = '', antigravityPath = '', showClaude = true, showAntigravity = true) {
        this._intervalSeconds = Math.max(5, intervalSeconds);
        this._claudePath = claudePath || '';
        this._antigravityPath = antigravityPath || '';
        this._showClaude = showClaude;
        this._showAntigravity = showAntigravity;
    }

    start() {
        this.stop();
        this.refreshNow();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._intervalSeconds,
            () => {
                this.refreshNow();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    stop() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._isRunning = false;
    }

    setInterval(seconds) {
        this._intervalSeconds = Math.max(5, seconds);
        if (this._timerId) {
            this.start();
        }
    }

    setCustomPaths(claudePath, antigravityPath) {
        this._claudePath = claudePath || '';
        this._antigravityPath = antigravityPath || '';
    }

    getLatestData() {
        return this._latestData;
    }

    refreshNow() {
        if (this._isRunning) {
            return;
        }
        this._isRunning = true;

        const cmd = ['python3', '-B', this._collectorScript];
        if (this._claudePath) {
            cmd.push('--claude-dir', this._claudePath);
        }
        if (this._antigravityPath) {
            cmd.push('--antigravity-dir', this._antigravityPath);
        }
        if (!this._showClaude) {
            cmd.push('--skip-claude');
        }
        if (!this._showAntigravity) {
            cmd.push('--skip-antigravity');
        }

        try {
            this._cancellable = new Gio.Cancellable();
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            });

            const proc = launcher.spawnv(cmd);
            proc.communicate_utf8_async(null, this._cancellable, (subprocess, result) => {
                this._isRunning = false;
                try {
                    const [, stdout, stderr] = subprocess.communicate_utf8_finish(result);
                    if (!subprocess.get_successful()) {
                        const errMsg = stderr ? stderr.trim() : 'Collector subprocess failed';
                        console.error(`[AI Consumption Monitor] ${errMsg}`);
                        this.emit('metrics-error', errMsg);
                        return;
                    }

                    if (stdout) {
                        try {
                            const parsed = JSON.parse(stdout);
                            this._latestData = parsed;
                            this.emit('metrics-updated', JSON.stringify(parsed));
                        } catch (parseErr) {
                            console.error(`[AI Consumption Monitor] JSON parse error: ${parseErr.message}`);
                            this.emit('metrics-error', parseErr.message);
                        }
                    }
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        console.error(`[AI Consumption Monitor] Subprocess error: ${e.message}`);
                        this.emit('metrics-error', e.message);
                    }
                }
            });
        } catch (e) {
            this._isRunning = false;
            console.error(`[AI Consumption Monitor] Failed to spawn collector: ${e.message}`);
            this.emit('metrics-error', e.message);
        }
    }
});
