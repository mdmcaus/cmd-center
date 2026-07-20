# cmd-center

A local web command center for your projects. It scans a repository root for every
directory that contains a `Makefile`, lists them in one place, and gives you a real
interactive terminal inside any project so you can run `make` with any target (or any
other command) without leaving the browser.

This tool is meant to run only on your own machine. It intentionally opens a shell as
your user in the selected project directory, so it binds to loopback only and refuses
connections that do not originate from its own page.

## Features

- Sidebar list of all directories under the repo root that have a `Makefile`.
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

### Configuration

Set via environment variables (or `make VAR=value ...`):

- `PORT` (default `3200`): port to listen on.
- `HOST` (default `127.0.0.1`): bind address. Keep this on loopback.
- `REPO_ROOT` (default `/Users/michael/repo/claude`): directory scanned for projects.

## How it works

- `lib/projects.js` scans `REPO_ROOT` one level deep, keeps directories that contain a
  file named exactly `Makefile`, and parses their targets. This same list is the
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

- `test/unit.js` covers project discovery and Makefile target parsing against a
  temporary fixture directory.
- `test/security.js` boots a live server against a fixture root and asserts the Origin
  check, the project allowlist, a working PTY round-trip, and loopback binding.
- `test/ui.spec.js` drives the UI end to end with Playwright.

See `cmd-center_testplan.md` for a manual test plan and `EXTERNAL_TEST.md` for external
automated testing tooling.
