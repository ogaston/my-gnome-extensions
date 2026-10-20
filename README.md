# My GNOME Extensions

Collection of custom GNOME Shell extensions (GNOME 45–50).

## Extensions

### [`ai-consumption-extension`](./ai-consumption-extension)
Monitors real-time Claude Code and Google Antigravity / Gemini quota percentages, rolling 5-hour & 7-day usage windows, promotional credits, and local token/step telemetry directly from the GNOME top bar.

#### Features
- **Top Bar Indicator**: Displays live `Claude X% · AGY Y%` quota usage in the GNOME panel.
- **Claude & Gemini Tabs**: Detailed breakdown of 5-hour rolling session limits, 7-day weekly quotas, promotional/extra credits, 3P model buckets, and local CLI/SQLite telemetry.
- **GNOME Native & Blur Integration**: Automatically detects `blur-my-shell@aunetx` and applies compositor background blur (`Shell.BlurEffect`) with translucent Quick Settings cards.

#### Pack & Install
```bash
gnome-extensions pack ai-consumption-extension --force --extra-source=lib --extra-source=stylesheet-light.css -o ai-consumption-extension
gnome-extensions install --force ai-consumption-extension/ai-consumption-monitor@omarjayg.shell-extension.zip
gnome-extensions enable ai-consumption-monitor@omarjayg
```

#### Local Simulator & Tests
```bash
python3 -B -m unittest discover -s ai-consumption-extension/tests
cd ai-consumption-extension && gjs -m tests/test_viewmodel.js
gjs -m tests/run_topbar.js   # GTK simulator window
```
