// SPDX-License-Identifier: GPL-2.0-or-later
// Run with: gjs -m tests/test_service.js  (from the extension directory)
// Collects real local data with the network off, then checks that destroy()
// removes the timer and kills a running helper process.
import GLib from 'gi://GLib';
import System from 'system';

import { MetricsService } from '../lib/metricsService.js';

const tmp = GLib.dir_make_tmp('ai-consumption-service-XXXXXX');
const newService = () => {
    const service = new MetricsService(GLib.get_current_dir(), `${tmp}/cache.json`);
    service.configure({ intervalSeconds: 30, allowNetwork: false });
    return service;
};

function fail(message) {
    console.error(message);
    System.exit(1);
}

const timeout = new Promise((_, reject) =>
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 20, () => {
        reject(new Error('Timed out waiting for metrics-updated'));
        return GLib.SOURCE_REMOVE;
    }));

const service = newService();
const data = await Promise.race([timeout, new Promise((resolve, reject) => {
    service.connect('metrics-updated', (_svc, d) => resolve(d));
    service.connect('metrics-error', (_svc, message) => reject(new Error(message)));
    service.start();
})]).catch(e => fail(e.message));

if (typeof data !== 'object' || !data.timestamp || !data.claude || !data.antigravity)
    fail(`Unexpected payload: ${JSON.stringify(data)}`);
console.log(`ok - metrics-updated delivered an object (claude: ${data.claude.status}, antigravity: ${data.antigravity.status})`);

const timerId = service._timerId;
service.destroy();
if (service._timerId !== null || GLib.MainContext.default().find_source_by_id(timerId))
    fail('Timer still installed after destroy()');
console.log('ok - destroy() removed the poll timer');

// A helper that is still running when the service is destroyed must be killed.
const slow = newService();
const pending = slow._queryDb('/dev/null', slow._cancellable).catch(() => null);
const proc = slow._dbProc;
slow.destroy();
await pending;
proc.wait(null);
if (!proc.get_if_signaled())
    fail('Helper exited on its own instead of being killed');
console.log('ok - destroy() killed the running helper');

GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(tmp)}`);
console.log('MetricsService verified successfully!');
