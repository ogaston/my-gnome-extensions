// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// Set per request rather than on the session: a session-level user agent
// overrides the request header, and some endpoints need their own.
const DEFAULT_USER_AGENT = 'ai-consumption-monitor';

// Sends a request on `session` and returns the parsed JSON body.
// Throws on network errors and non-2xx responses.
export async function fetchJson(session, { method = 'GET', url, headers = {}, body = null }, cancellable) {
    const message = Soup.Message.new(method, url);
    for (const [name, value] of Object.entries({ 'User-Agent': DEFAULT_USER_AGENT, ...headers })) {
        message.request_headers.replace(name, value);
    }
    if (body !== null) {
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body))));
    }
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    const status = message.get_status();
    if (status < 200 || status >= 300) throw new Error(`HTTP ${status} from ${url}`);
    return JSON.parse(new TextDecoder().decode(bytes.toArray()));
}
