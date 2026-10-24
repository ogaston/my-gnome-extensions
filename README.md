# My GNOME Extensions

Collection of custom GNOME Shell extensions (GNOME 45–50), published on
[extensions.gnome.org](https://extensions.gnome.org) (EGO).

## Extensions

### [`ai-consumption-extension`](./ai-consumption-extension)
Shows Claude Code and Google Antigravity quota and token usage in the GNOME top bar.

- **Top bar indicator**: live `Claude X% · AGY Y%` quota usage.
- **Claude & Antigravity tabs**: 5-hour and weekly quota windows, extra usage credits, Gemini and third-party model limits, and today's local token/step totals.
- **Blur my Shell integration**: when `blur-my-shell@aunetx` is active, the popup gets a matching background blur. Its state is only read.

**Privacy:** live quota is fetched from Anthropic's and Google's usage endpoints using the OAuth tokens Claude Code and Antigravity already saved locally (credentials file or keyring). Nothing is sent anywhere else. Turn off *Query Online Quota* in Preferences to only read local files.

**Requirements:** `python3` for the Antigravity conversation stats (`lib/agy_db.py` reads its SQLite database; GJS has no SQLite binding). Everything else is GJS.

## Repository layout

```
<extension-dir>/
  metadata.json         uuid: <name>@ogaston.github.io
  extension.js          entry point (shell process)
  prefs.js              preferences (GTK process; must not import St/Clutter/Shell/Meta)
  lib/                  modules loaded by extension.js
  icons/, *.css         runtime assets
  schemas/*.gschema.xml schema id/path under org.gnome.shell.extensions
  tests/                never packed
scripts/pack.sh         builds dist/<uuid>.shell-extension.zip
LICENSE                 GPL-2.0-or-later, packed into every zip
```

New extensions follow the same layout. Use the `@ogaston.github.io` UUID namespace, and add an SPDX header (`GPL-2.0-or-later`) to each source file.

## Development

```bash
npm ci && npm run lint                       # ESLint (GJS globals, flat config)

cd ai-consumption-extension
gjs -m tests/test_collect.js                 # collectors (temp fixtures, no network)
gjs -m tests/test_viewmodel.js
gjs -m tests/test_service.js                 # real local data, network off
gjs -m tests/test_prefs.js                   # needs GNOME Shell installed
python3 -B -m unittest discover -s tests     # agy_db.py helper
gjs -m tests/run_topbar.js                   # GTK simulator window
```

Don't test in a nested or headless `gnome-shell`; it has clobbered real dconf settings before. Use the unit tests and simulators, then a real install.

### Pack & install

```bash
scripts/pack.sh ai-consumption-extension
gnome-extensions install --force dist/ai-consumption-monitor@ogaston.github.io.shell-extension.zip
# log out and back in (Wayland), then:
gnome-extensions enable ai-consumption-monitor@ogaston.github.io
```

## Publishing checklist (extensions.gnome.org)

1. Lint and all tests pass; CI is green.
2. `scripts/pack.sh <ext>` then run [Shexli](https://pypi.org/project/shexli/) on the zip:
   `pip install shexli "tree-sitter<0.26" && shexli "$PWD"/dist/<uuid>.shell-extension.zip`
   (tree-sitter 0.26 makes shexli 0.2.1 segfault).
3. `shell-version` lists only releases you have actually tested.
4. No `version` key in `metadata.json`; EGO assigns it.
5. Description discloses network access, credentials used, clipboard use, and external dependencies.
6. Upload at <https://extensions.gnome.org/upload/> and add reviewer notes for anything unusual. For `ai-consumption-extension`:
   - why `lib/agy_db.py` exists (no SQLite binding in GJS; read-only; stdlib only);
   - Blur my Shell is only queried via `Main.extensionManager.lookup()`, never modified;
   - OAuth tokens are only sent to their own provider's endpoint;
   - Antigravity quota requests send the Antigravity CLI's User-Agent (`antigravity/1.4.6 linux/amd64`) because the backend returns 403 otherwise; they use the user's own token for their own quota;
   - the Claude and Antigravity logos only identify the monitored service. Reviewers may ask for permission from the trademark owners; swapping them for generic icons is a one-line change to `LOGO_FILES` in `lib/indicatorMenu.js`.
7. Review guidelines: <https://gjs.guide/extensions/review-guidelines/review-guidelines.html>
