# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Removed
- `riptide` dropped from `config/ignored-projects.json`. It was a third-party
  checkout whose source is no longer in `~/repo`, so the entry ignored nothing.
  The installed binary at `~/go/bin/riptide` is untouched.

### Fixed
- `shellEnv()` no longer crashes when the effective uid has no passwd entry.
  `os.userInfo()` throws `ERR_SYSTEM_ERROR` in that case, and the unguarded call
  would have taken down every terminal the user tried to open. It now falls back
  to the environment.
- `make stop` no longer kills whatever process happens to hold `PORT`. It kills
  the holder only when that holder is a node process, and otherwise reports what
  is there and leaves it alone. Found when a process this Makefile did not start
  was holding the port and `make stop` would have signalled it.

### Security
- GitHub Actions in the workflows are pinned to full commit SHAs instead of tags such as `@v4`. A tag can be moved to different code by whoever controls the Action, and the release workflow can publish releases. Bump the SHA and its `# vN` comment together (`gh api repos/OWNER/ACTION/commits/vN --jq .sha`).
- `npm audit fix` resolved a moderate advisory in `qs` (a transitive dependency
  of Express). Lockfile only, no direct dependency changed. `npm audit
  --omit=dev` now reports 0 vulnerabilities.

### Changed
- The project now lives at `~/repo/cmd-center` as a standalone repository, extracted from
  the `claude` monorepo with `git subtree split` so its history is intact. This puts it
  alongside every other top-level repo in `~/repo`. Update your shell profile to source
  `~/repo/cmd-center/cmdc.sh` from the new location.
- Project discovery now scans **multiple** roots. `REPO_ROOTS` is a colon-separated list,
  defaulting to `/Users/michael/repo/claude:/Users/michael/repo`, so projects in both trees
  are listed together. Roots are scanned in order and the first to claim a project name
  keeps it, so precedence is predictable and the PTY allowlist can never be redirected by a
  later root. `REPO_ROOT` still works as the single-root form and replaces the whole list.
  Because `~/repo` is now scanned directly, the `config/extra-projects.json` entries for
  `newonbrew` and `scorebar` are redundant; they are deduplicated against the scan rather
  than listed twice, and the file is left in place.

### Fixed
- The top-targets config is now held in a `Map` rather than a plain object. Project
  names come from directory names, so a project called `__proto__` previously hit the
  prototype setter on save and its curated set was silently dropped from the file;
  a name matching an inherited property such as `constructor` was only saved from
  being misread by the existing `Array.isArray` guard. Both are now inert data.

### Added
- `make security-audit` from the shared security kit: security tests, Gitleaks, Semgrep project rules and platform scan, dependencies, pinned GitHub Actions and, for macOS apps, entitlements, the signed bundle and the DMG. Settings in `security-audit.conf`; explained in `security-audit.md`.
- **Manage projects** screen, opened from the new `Manage` button in the sidebar header.
  Lists every discovered project in a Shown/Ignored pair of columns with its parent
  directory, so the two roots are easy to tell apart; `✕` ignores one, `+` brings it back.
  Ignoring is enforced server-side rather than being a display filter: the project list is
  the PTY allowlist, so an ignored project is also refused a terminal. Saved as a list of
  names in `config/ignored-projects.json` (overridable with `IGNORED_PROJECTS_FILE`),
  re-read on every scan. A name stays ignored even when no such project is currently
  found, so ignoring survives a repo being temporarily missing.
- `Show target descriptions` toggle in the sidebar, next to the existing quick-run toggle.
  Descriptions come from `## text` comments on Makefile target lines, which only `jobhunt`
  and `newonbrew` currently use; 18 documented targets made the panel tall enough to
  scroll, so the inline text is now off by default. The description is still available as
  the button's hover tooltip either way, and the choice persists in `localStorage` under
  `cmdcenter.showDescs`.
- Site favicon generated from `Command-Center-Icon.png`. The small sizes (16, 32, and the
  `.ico`) use a crop of the central terminal emblem with a rounded-square mask, because the
  full artwork's wordmark and sub-icons are illegible below about 48px; the 180, 192, and
  512 pixel assets keep the complete artwork. Served from `public/` as
  `cmd-center-favicon.ico` and `cmd-center-favicon-{16,32,180,192,512}.png`, with a
  `site.webmanifest` and a `theme-color` matching the app background.
- Support for projects that live outside `REPO_ROOT`: list their absolute directory paths
  in `config/extra-projects.json` (path overridable with `EXTRA_PROJECTS_FILE`) and they
  are listed alongside the scanned projects, with the same target parsing, curated top
  targets, and PTY allowlisting. Entries still need a `Makefile`; missing directories,
  directories without one, and relative paths are skipped, and a scanned project always
  wins a name collision so the config cannot redirect an existing project elsewhere. The
  file is re-read on every scan, so `Rescan` picks up edits without a restart.
- `newonbrew` (`/Users/michael/repo/newonbrew`) added as the first out-of-root project,
  with curated top targets `new-file`, `commit`, and `brewupd`.
- In-UI editor for per-project top targets: click `Edit` in the target panel header to
  pick which targets appear at the top, reorder them (up/down), and Save. Saves to
  `config/top-targets.json` via a same-origin `PUT /api/projects/:name/top-targets`
  endpoint, so it persists across restarts and browsers. Soft guidance of ~10, no hard cap.
- Curated "top targets" per project via `config/top-targets.json` (keyed by project name,
  path overridable with `TOP_TARGETS_FILE`). The panel shows the curated targets first with
  a `Show all (N)` / `Show top only` toggle; projects without an entry are unchanged.
  Curated sets configured for all 16 projects with a Makefile.
- `cmdc.sh`: a sourceable `cmdc` shell command with an arrow-key menu that offers
  `start` when the server is stopped and `stop`/`restart` when it is running, then
  runs the matching make target.
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
- Page now renders in Safari. The Content-Security-Policy no longer includes
  `upgrade-insecure-requests` (a helmet default), which made Safari try to load
  `styles.css`, `app.js`, and the xterm assets over https on a plain-http localhost
  server, leaving the page unstyled with no scripts. `connect-src` also lists the
  `ws://` origins explicitly so Safari allows the terminal WebSocket. UI tests now
  run under WebKit as well as Chromium to catch Safari regressions.
- `make start` now launches detached via `nohup`, refuses to start when the port is
  already in use (previously it wrote a dead PID after `EADDRINUSE`), and verifies the
  server actually came up before recording the PID.
- `make status` checks the listening port rather than only the PID file, so a stale PID
  file no longer reports the wrong state.
- `make stop` clears any stray process still holding the port, preventing orphans.
- Terminal now reflects the real login user. `USER`/`LOGNAME`/`HOME`/`SHELL` are
  rebuilt from `os.userInfo()` before spawning the PTY, so a stale `USER=root`
  leaked into the server environment no longer makes the prompt show `root@`.
