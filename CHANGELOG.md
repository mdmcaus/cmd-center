# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Initial project scaffold.
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

### Fixed
- Terminal now reflects the real login user. `USER`/`LOGNAME`/`HOME`/`SHELL` are
  rebuilt from `os.userInfo()` before spawning the PTY, so a stale `USER=root`
  leaked into the server environment no longer makes the prompt show `root@`.
