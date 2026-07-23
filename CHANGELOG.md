# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Initial project scaffold.
- ESLint with `eslint-plugin-security` and `eslint-plugin-no-unsanitized`
  (`eslint.config.js`), plus `make lint` and `make audit` targets.
- `EXTERNAL_TEST.md` rewritten as a step-by-step runbook: each tool has install,
  an exact verified command, and what a passing result looks like. Covers the
  bundled checks, curl-based WebSocket authorization probes, Semgrep, OWASP ZAP,
  and Nikto, with a verified baseline table.
- Project discovery: scans `/Users/michael/repo/claude` for directories containing
  a `Makefile` and lists them in a sidebar.
- Makefile target parsing with optional `## description` comments, surfaced as
  quick-run buttons.
- Full interactive PTY per project: xterm.js in the browser wired to `node-pty`
  over a WebSocket, cwd'd into the selected project directory.
- UI setting (persisted in `localStorage`) to toggle the quick-run target buttons.
- Security guardrails: server binds to `127.0.0.1` only, WebSocket requires a
  same-origin `Origin` header, and the PTY cwd is restricted to the scanned
  Makefile allowlist (no path traversal).
- `postinstall` hook that restores the execute bit on node-pty's prebuilt
  `spawn-helper` (npm strips it, which otherwise breaks the PTY).
- Unit tests (discovery + parser), black-box security tests, and Playwright UI
  tests. Makefile with `install`/`start`/`stop`/`status`/`test`/`test-all`/`clean`.

### Added (background service)
- macOS LaunchAgent for autostart: `make install-agent` / `uninstall-agent` /
  `agent-status`, backed by a plist template in `launchd/` that is rendered with
  absolute paths (launchd runs with a minimal PATH).

### Changed
- Quick-run make target buttons moved from a top bar to a scrollable vertical panel
  on the right side of the terminal, so long target lists are easy to navigate. The
  terminal reflows when the panel is toggled on or off.
- Target buttons in the panel are now sorted alphabetically (case-insensitive),
  matching the project list, instead of following Makefile order.

### Fixed
- `make start` now launches detached via `nohup`, refuses to start when the port is
  already in use (previously it wrote a dead PID after `EADDRINUSE`), and verifies the
  server actually came up before recording the PID.
- `make status` checks the listening port rather than only the PID file, so a stale PID
  file no longer reports the wrong state.
- `make stop` clears any stray process still holding the port, preventing orphans.
- Terminal now reflects the real login user. `USER`/`LOGNAME`/`HOME`/`SHELL` are
  rebuilt from `os.userInfo()` before spawning the PTY, so a stale `USER=root`
  leaked into the server environment no longer makes the prompt show `root@`.
