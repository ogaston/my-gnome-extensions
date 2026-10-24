#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Builds the zip to upload to extensions.gnome.org.
#   scripts/pack.sh <extension-dir>  ->  dist/<uuid>.shell-extension.zip
#
# Only runtime files go in: metadata.json, top-level .js/.css, lib/, icons/,
# locale/, the schema XML and a license (the extension's own, else the repo's).
# Tests, caches and compiled schemas stay out; extensions.gnome.org compiles
# schemas itself.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
ext=$(cd "${1:?usage: scripts/pack.sh <extension-dir>}" && pwd)
uuid=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["uuid"])' "$ext/metadata.json")
out="$root/dist/$uuid.shell-extension.zip"

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

cd "$ext"
cp metadata.json "$stage/"
cp -- *.js "$stage/"
compgen -G '*.css' >/dev/null && cp -- *.css "$stage/"
for dir in lib icons locale; do
    [[ -d $dir ]] && rsync -a --exclude '__pycache__' --exclude '*.py[cod]' "$dir" "$stage/"
done
mkdir -p "$stage/schemas"
cp schemas/*.gschema.xml "$stage/schemas/"
if [[ -f LICENSE ]]; then cp LICENSE "$stage/"; else cp "$root/LICENSE" "$stage/"; fi

mkdir -p "$root/dist"
rm -f "$out"
(cd "$stage" && zip -qrX "$out" .)
echo "$out"
