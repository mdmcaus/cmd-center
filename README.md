### cmd-center

# cmd-center

A local web command center for your projects. It scans a repository root for every
directory that contains a `Makefile`, plus any extra project directories you list by
absolute path, shows them in one place, and gives you a real interactive terminal inside
any project so you can run `make` with any target (or any other command) without leaving
the browser.

This tool is meant to run only on your own machine. It intentionally opens a shell as
your user in the selected project directory, so it binds to loopback only and refuses
connections that do not originate from its own page.

## Features

- Sidebar list of all directories under the repo root that have a `Makefile`, plus any
  out-of-root projects listed in `config/extra-projects.json`.
- Auto-detected `make` targets (with optional `## description` comments) shown as
  quick-run buttons. A setting toggles the buttons on or off.
- A full interactive pseudo-terminal (xterm.js + node-pty) per project, cwd'd into that
  project. Type anything, use Ctrl-C, run interactive commands.
- Rescan button to pick up newly added projects.

## Requirements

- macOS (uses node-pty prebuilt binaries for darwin arm64/x64).
- Node.js 18 or newer (developed and tested on Node 22).

## Install

```bash
make install
```

This runs `npm install`. A `postinstall` step restores the execute bit on node-pty's
prebuilt `spawn-helper` binary, which npm does not preserve and which the PTY needs.

## Run

```bash
make start        # start in the background on http://127.0.0.1:3200
make open         # open the app in your browser
make status       # show whether it is running plus recent log lines
make stop         # stop the background server
make run          # or run in the foreground (Ctrl-C to stop)
```

Then open http://127.0.0.1:3200, pick a project on the left, and use the terminal.

`make start` launches the server detached (via `nohup`), so it keeps running after you
close the terminal. You do not need to wrap it in `nohup` yourself. It refuses to start
if the port is already held, and `make status` checks the port (not just the PID file),
so a stale PID file cannot make it report the wrong state. `make stop` also clears any
stray process still holding the port.

### `cmdc`: an interactive start/stop/restart menu

`cmdc.sh` provides a `cmdc` shell command with an arrow-key menu that adapts to whether
the server is running. Source it from your shell profile (bash or zsh):

```bash
echo 'source /Users/michael/repo/claude/cmd-center/cmdc.sh' >> ~/.bashrc
# then open a new shell, or: source ~/.bashrc
```

Run `cmdc`:

- if the server is not running, the menu offers only `start`
- if the server is running, the menu offers `stop` and `restart`

Move with the arrow keys (or `j`/`k`), press Enter to choose, `q` or Esc to cancel. It
runs the matching `make` target. Optional overrides: `CMDC_DIR` (project path) and
`CMDC_PORT` (default `3200`).

### Top targets (curated per project)

Projects with many make targets can be overwhelming. You can give a project a short,
curated list of its most-used targets in `config/top-targets.json`, keyed by project name:

```json
{
  "thepdfer-macos": ["run", "build", "test", "lint", "xcode", "install"]
}
```

When a project has an entry, the panel shows those targets first (in the order listed) with
a `Show all (N)` button to expand to the full alphabetical list, and `Show top only` to
collapse. Names that do not match a real target are ignored. Projects with no entry show
the full list as before. The config path can be overridden with the `TOP_TARGETS_FILE`
environment variable.

You do not have to edit the file by hand. Select a project and click `Edit` in the target
panel header to open the editor: move targets between "Shown at top" and "More", reorder the
top set with the up/down buttons (about 10 is a good number, but there is no hard limit), and
Save. The panel updates immediately and the choice is written back to `config/top-targets.json`,
so it persists across restarts and is the same in every browser.

### Projects outside the repo root

Discovery walks `REPO_ROOT` one level deep, so a repo that lives somewhere else is never
listed. To include one, add its absolute directory path to `config/extra-projects.json`:

```json
[
  "/Users/michael/repo/newonbrew"
]
```

Each entry still has to be a directory containing a `Makefile`. Anything else is skipped:
a missing directory, a directory with no `Makefile`, or a relative path (relative entries
are dropped rather than resolved, so the server's working directory can never decide what
they point at). The directory's base name becomes the project name, and a scanned project
always wins a name collision, so this config cannot redirect an existing project somewhere
else. The file is re-read on every scan, so `Rescan` picks up edits with no restart. The
path can be overridden with the `EXTRA_PROJECTS_FILE` environment variable.

### Autostart at login (recommended for always-on use)

To have cmd-center start at login and restart automatically if it crashes, install a
macOS LaunchAgent:

```bash
make install-agent     # start at login, keep alive, load it now
make agent-status      # show whether the agent is loaded
make uninstall-agent   # stop and remove it
```

Use the LaunchAgent or `make start`, not both at once, since they would compete for the
port. The agent runs `node server.js` with an absolute node path (launchd uses a minimal
PATH) and writes to `server.log`. The rendered plist lives at
`~/Library/LaunchAgents/com.mdmcaus.cmd-center.plist`; the template is in `launchd/`.

### Configuration

Set via environment variables (or `make VAR=value ...`):

- `PORT` (default `3200`): port to listen on.
- `HOST` (default `127.0.0.1`): bind address. Keep this on loopback.
- `REPO_ROOT` (default `/Users/michael/repo/claude`): directory scanned for projects.
- `EXTRA_PROJECTS_FILE` (default `config/extra-projects.json`): JSON array of absolute
  paths to projects that live outside `REPO_ROOT`.

## How it works

- `lib/projects.js` scans `REPO_ROOT` one level deep, keeps directories that contain a
  file named exactly `Makefile`, adds any directories listed in
  `config/extra-projects.json`, and parses their targets. This same list is the
  security allowlist for the terminal.
- `server.js` serves the static UI, exposes `GET /api/projects`, and upgrades
  `GET /pty?project=<name>` to a WebSocket backed by a node-pty shell in that project's
  directory.
- `public/` holds the frontend. xterm.js and its fit addon are vendored under
  `public/vendor/`, so nothing loads from a CDN.

## Security notes

- The HTTP server and WebSocket bind to `127.0.0.1` only.
- The WebSocket upgrade is accepted only when the `Origin` header matches the app's own
  origin, so a random web page you visit cannot open a shell on your machine through
  your browser.
- The `project` query parameter is validated against the freshly-scanned Makefile
  allowlist. The terminal's working directory is never built from raw client input, so
  path traversal cannot point it at an arbitrary directory.
- Out-of-root projects widen that allowlist only through a local config file you control.
  The client still sends nothing but a project name, which has to match an entry in the
  same freshly-scanned list, so the extra paths are not reachable any other way.
- A Content-Security-Policy restricts scripts, styles, and connections to same-origin.

Because the terminal runs commands as your user by design, treat this like any other
local shell: only run it on a machine you control.

## Testing

```bash
make test        # unit + security tests (no browser needed)
make test-ui     # Playwright UI tests (launches its own fixture server)
make test-all    # everything
make lint        # ESLint + security plugins (0 errors expected)
make audit       # npm dependency vulnerability check
```

- `test/unit.js` covers project discovery (in-root and out-of-root) and Makefile target
  parsing against temporary fixture directories.
- `test/security.js` boots a live server against a fixture root and asserts the Origin
  check, the project allowlist, a working PTY round-trip, and loopback binding.
- `test/ui.spec.js` drives the UI end to end with Playwright.

See `cmd-center_testplan.md` for a manual test plan and `EXTERNAL_TEST.md` for external
automated testing tooling.
