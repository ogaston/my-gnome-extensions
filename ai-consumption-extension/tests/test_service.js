import GLib from 'gi://GLib';
import { MetricsService } from '../lib/metricsService.js';

const loop = new GLib.MainLoop(null, false);
const service = new MetricsService(GLib.get_current_dir());

let receivedUpdate = false;

service.connect('metrics-updated', (svc, jsonStr) => {
    const data = JSON.parse(jsonStr);
    console.log('Received metrics update successfully. Timestamp:', data.timestamp);
    receivedUpdate = true;
    service.stop();
    loop.quit();
});

service.connect('metrics-error', (svc, err) => {
    console.error('Error in service:', err);
    service.stop();
    loop.quit();
});

service.refreshNow();

// Set a timeout to avoid hanging if there is an error
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
    if (!receivedUpdate) {
        console.error('Timed out waiting for metrics-updated');
        loop.quit();
    }
    return GLib.SOURCE_REMOVE;
});

loop.run();

if (!receivedUpdate) {
    imports.system.exit(1);
} else {
    console.log('MetricsService verified successfully!');
}
