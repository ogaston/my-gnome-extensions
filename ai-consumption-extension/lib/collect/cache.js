// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { readJson, writePrivateText } from './files.js';

// How long a live quota response is reused before the endpoint is asked again.
export const OAUTH_CACHE_TTL_SECONDS = 60;

export function defaultCachePath() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'ai-consumption-monitor', 'cache.json']);
}

export async function loadCache(path, cancellable = null) {
    try {
        const cache = await readJson(path, cancellable);
        return cache && typeof cache === 'object' && !Array.isArray(cache) ? cache : {};
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
        return {};
    }
}

export async function saveCache(path, cache, cancellable = null) {
    await writePrivateText(path, JSON.stringify(cache), cancellable);
}
