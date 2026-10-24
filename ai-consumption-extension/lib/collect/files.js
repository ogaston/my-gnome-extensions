// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');

const READ_CHUNK_BYTES = 1024 * 1024;
const decoder = new TextDecoder('utf-8');

export function buildPath(...parts) {
    return GLib.build_filenamev(parts);
}

export function isDirectory(path) {
    return GLib.file_test(path, GLib.FileTest.IS_DIR);
}

export async function readText(path, cancellable = null) {
    const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return decoder.decode(contents);
}

export async function readJson(path, cancellable = null) {
    return JSON.parse(await readText(path, cancellable));
}

// Replaces the file atomically (write to a temp file, then rename) and
// creates it 0600; a symlink at `path` is replaced rather than followed.
export async function writePrivateText(path, text, cancellable = null) {
    const file = Gio.File.new_for_path(path);
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    await file.replace_contents_bytes_async(
        new GLib.Bytes(new TextEncoder().encode(text)), null, false,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        cancellable);
}

// Returns [{name, isDir}] for the visible entries of a directory, or [] if it can't be read.
export async function listDir(path, cancellable = null) {
    const entries = [];
    try {
        const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name,standard::type,standard::is-hidden',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        for (;;) {
            const infos = await enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, cancellable);
            if (infos.length === 0) break;
            for (const info of infos) {
                if (info.get_is_hidden()) continue;
                entries.push({
                    name: info.get_name(),
                    isDir: info.get_file_type() === Gio.FileType.DIRECTORY,
                });
            }
        }
        enumerator.close(null);
    } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
    }
    return entries;
}

// Size in bytes and modification time in fractional seconds.
export async function statFile(path, cancellable = null) {
    const info = await Gio.File.new_for_path(path).query_info_async(
        'standard::size,time::modified,time::modified-usec',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    return {
        size: info.get_size(),
        mtime: info.get_attribute_uint64('time::modified') +
            info.get_attribute_uint32('time::modified-usec') / 1e6,
    };
}

function concatBytes(a, b) {
    if (a.length === 0) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

// Calls onLine for every complete line after byte `offset` and returns the
// offset just past the last newline, so a line still being written is read
// again on the next call. Reads in chunks so large files don't stall the shell.
export async function readLinesFrom(path, offset, onLine, cancellable = null) {
    const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT, cancellable);
    try {
        if (offset > 0) stream.seek(offset, GLib.SeekType.SET, cancellable);
        let consumed = offset;
        let pending = new Uint8Array(0);
        for (;;) {
            const bytes = await stream.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, cancellable);
            const chunk = bytes.toArray();
            if (chunk.length === 0) break;
            const buf = concatBytes(pending, chunk);
            let start = 0;
            for (let nl = buf.indexOf(10); nl !== -1; nl = buf.indexOf(10, start)) {
                onLine(decoder.decode(buf.subarray(start, nl)));
                start = nl + 1;
            }
            consumed += start;
            pending = buf.slice(start);
        }
        return consumed;
    } finally {
        stream.close(null);
    }
}
