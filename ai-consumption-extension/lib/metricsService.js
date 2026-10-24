// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

import { collectAntigravityMetrics } from './collect/antigravity.js';
import { defaultCachePath, loadCache, saveCache } from './collect/cache.js';
import { collectClaudeMetrics } from './collect/claude.js';
import { todayString } from './collect/dates.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const MIN_INTERVAL_SECONDS = 5;
const HTTP_TIMEOUT_SECONDS = 8;

export const MetricsService = GObject.registerClass({
    GTypeName: 'AiConsumptionMetricsService',
    Signals: {
        'metrics-updated': {
            param_types: [GObject.TYPE_JSOBJECT],
        },
        'metrics-error': {
            param_types: [GObject.TYPE_STRING],
        },
    },
}, class MetricsService extends GObject.Object {
    _init(extensionPath, cachePath = defaultCachePath()) {
        super._init();
        this._dbHelper = GLib.build_filenamev([extensionPath, 'lib', 'agy_db.py']);
        this._cachePath = cachePath;
        this._session = new Soup.Session({
            timeout: HTTP_TIMEOUT_SECONDS,
        });
        this._cancellable = new Gio.Cancellable();
        this._timerId = null;
        this._dbProc = null;
        this._refreshing = false;
        this._latestData = null;
        this._lastLoggedError = null;

        this._intervalSeconds = 30;
        this._claudeDir = '';
        this._antigravityDir = '';
        this._showClaude = true;
        this._showAntigravity = true;
        this._allowNetwork = true;
    }

    configure({
        intervalSeconds, claudePath = '', antigravityPath = '',
        showClaude = true, showAntigravity = true, allowNetwork = true,
    }) {
        const home = GLib.get_home_dir();
        this._claudeDir = claudePath || GLib.build_filenamev([home, '.claude']);
        this._antigravityDir = antigravityPath || GLib.build_filenamev([home, '.gemini', 'antigravity-cli']);
        this._showClaude = showClaude;
        this._showAntigravity = showAntigravity;
        this._allowNetwork = allowNetwork;

        const interval = Math.max(MIN_INTERVAL_SECONDS, intervalSeconds);
        if (interval !== this._intervalSeconds) {
            this._intervalSeconds = interval;
            if (this._timerId) this._startTimer();
        }
    }

    start() {
        this._startTimer();
        this.refreshNow();
    }

    _startTimer() {
        if (this._timerId) GLib.Source.remove(this._timerId);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this._intervalSeconds, () => {
            this.refreshNow();
            return GLib.SOURCE_CONTINUE;
        });
    }

    getLatestData() {
        return this._latestData;
    }

    refreshNow() {
        if (this._refreshing) return;
        this._refreshing = true;
        const cancellable = this._cancellable;
        this._collect(cancellable).then(data => {
            if (cancellable.is_cancelled()) return;
            this._latestData = data;
            this._lastLoggedError = null;
            this.emit('metrics-updated', data);
        }).catch(e => {
            if (!cancellable.is_cancelled()) this._reportError(e.message);
        }).finally(() => {
            this._refreshing = false;
        });
    }

    async _collect(cancellable) {
        const cache = await loadCache(this._cachePath, cancellable);
        const options = {
            cache,
            today: todayString(),
            session: this._allowNetwork ? this._session : null,
            cancellable,
        };
        const [claude, antigravity] = await Promise.all([
            collectClaudeMetrics(this._claudeDir, { ...options, disabled: !this._showClaude }),
            collectAntigravityMetrics(this._antigravityDir, {
                ...options,
                disabled: !this._showAntigravity,
                queryDb: path => this._queryDb(path, cancellable),
            }),
        ]);
        try {
            await saveCache(this._cachePath, cache, cancellable);
        } catch (e) {
            if (cancellable.is_cancelled()) throw e;
            this._reportError(`Could not save cache: ${e.message}`);
        }
        return { timestamp: new Date().toISOString(), claude, antigravity };
    }

    async _queryDb(dbPath, cancellable) {
        const proc = Gio.Subprocess.new(['python3', '-B', this._dbHelper, dbPath],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        this._dbProc = proc;
        try {
            const [stdout, stderr] = await proc.communicate_utf8_async(null, cancellable);
            if (!proc.get_successful()) throw new Error(stderr.trim() || 'agy_db.py failed');
            return JSON.parse(stdout);
        } finally {
            if (this._dbProc === proc) this._dbProc = null;
        }
    }

    // Repeated failures (e.g. while offline) are logged once until a refresh succeeds.
    _reportError(message) {
        if (message !== this._lastLoggedError) {
            console.error(`[AI Consumption Monitor] ${message}`);
            this._lastLoggedError = message;
        }
        this.emit('metrics-error', message);
    }

    destroy() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        this._cancellable.cancel();
        this._cancellable = null;
        this._dbProc?.force_exit();
        this._dbProc = null;
        this._session.abort();
        this._session = null;
        this._latestData = null;
    }
});
