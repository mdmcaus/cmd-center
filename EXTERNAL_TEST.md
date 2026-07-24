# External Testing Runbook

A step by step guide to running external automated tests against cmd-center. Every
command below was verified against this app. Each recipe has three parts: how to install
the tool, the exact command to run, and what a passing result looks like.

Free and open source tools are prioritized. Research current as of 2026.

## What we are testing

cmd-center is a local Node.js/Express web app that exposes a WebSocket backed
pseudo-terminal. The highest value targets are:

1. WebSocket authorization: the Origin check and the project allowlist.
2. The HTTP surface and security headers.
3. Dependency and source code security.

## Prerequisites

- macOS with the app already installed (`make install`).
- Node.js 18+ and npm (bundled tools: ESLint, Playwright, npm audit).
- Docker Desktop, for Semgrep, OWASP ZAP, and Nikto. Check with `docker --version`.
- The other tools install via Homebrew or Docker; each recipe says which.

Note on Docker and loopback: the server binds to `127.0.0.1`. On Docker Desktop a
container still reaches it using the special host name `host.docker.internal`, so the
containerized scanners below work without exposing the app on the network. This was
verified: a container GET to `http://host.docker.internal:3200/api/projects` returns 200.

## Quick start: the bundled checks

These need no extra installs and are the fastest signal. Run them first.

```bash
make lint        # ESLint + security plugins   -> expect 0 errors
make audit       # npm dependency audit         -> expect 0 vulnerabilities
make test        # unit + black-box security    -> expect all pass
make test-ui     # Playwright UI                 -> expect 14 passed (7 x 2 browsers)
```

Everything after this point is optional depth: DAST scanners, deeper SAST, and manual
protocol level probes.

---

## 1. Functionality and smoke tests

### 1a. Playwright (bundled)

- Install: already a dev dependency. First run only: `npx playwright install chromium webkit`
  (the suite runs under both Chromium and WebKit/Safari).
- Run:
  ```bash
  make test-ui
  ```
- Pass looks like: `14 passed` (7 tests across Chromium and WebKit). The suite loads the page, lists projects, opens a
  terminal, runs a target, and toggles the target buttons. On failure a screenshot is
  written under `test-results/`.

### 1b. HTTP API smoke (curl, jq)

- Install: `curl` ships with macOS; `brew install jq`.
- Run (server must be up: `make start`):
  ```bash
  curl -s http://127.0.0.1:3200/api/projects | jq '.projects | length'
  ```
- Pass looks like: a number matching how many sibling directories have a Makefile
  (18 at time of writing).

---

## 2. WebSocket authorization (curl)

This is the single most important external check: proving a shell cannot be opened from a
foreign page or steered outside the allowlist. A WebSocket handshake is just an HTTP GET
with upgrade headers, so `curl` can drive it and read the status code the server returns
before any upgrade happens. No extra tool is needed.

- Install: none (`curl` is built in).
- Run (server up on port 3200):

  ```bash
  WSK="dGhlIHNhbXBsZSBub25jZQ=="   # any base64 16 byte value
  probe() {
    # $1 = project, $2 = Origin (omit to send no Origin)
    curl -s -o /dev/null -w "%{http_code}\n" --max-time 2 \
      -H "Connection: Upgrade" -H "Upgrade: websocket" \
      -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $WSK" \
      ${2:+-H "Origin: $2"} \
      "http://127.0.0.1:3200/pty?project=$1"
  }

  probe cmd-center http://evil.example.com   # foreign Origin
  probe cmd-center                           # no Origin
  probe nope       http://127.0.0.1:3200     # unknown project
  probe ../../etc  http://127.0.0.1:3200     # path traversal
  probe cmd-center http://127.0.0.1:3200     # valid: allowed
  ```

- Pass looks like exactly these codes:

  | Probe                         | Expected |
  |-------------------------------|----------|
  | foreign Origin, valid project | `403`    |
  | no Origin, valid project      | `403`    |
  | good Origin, unknown project  | `404`    |
  | good Origin, path traversal   | `404`    |
  | good Origin, valid project    | `101`    |

  The `101` case completes the upgrade and holds the socket open, which is why the
  `--max-time 2` guard is there; without it curl waits on the live connection.

---

## 3. White-box (static) security

### 3a. npm audit (bundled)

- Install: none.
- Run:
  ```bash
  make audit          # runtime deps only
  npm audit           # include dev deps too
  ```
- Pass looks like: `found 0 vulnerabilities`. In CI, fail the build on high or critical.

### 3b. ESLint with security plugins (bundled)

- Install: `eslint`, `eslint-plugin-security`, and `eslint-plugin-no-unsanitized` are dev
  dependencies; config is in `eslint.config.js`.
- Run:
  ```bash
  make lint
  ```
- Pass looks like: `0 errors`. You will see a handful of `security/detect-non-literal-fs-filename`
  warnings in `lib/projects.js`, `scripts/`, and the tests. Those are expected and safe:
  the file paths there are built from the validated project allowlist and from test
  fixtures, not from untrusted input. The browser rules (`no-unsanitized`) report nothing,
  confirming the frontend builds DOM nodes with `textContent` rather than `innerHTML`.

### 3c. Semgrep (Docker)

- Install: nothing to install; the recipe pulls the image on first run. Alternative:
  `pipx install semgrep`.
- Run (from the project root):
  ```bash
  docker run --rm -v "$PWD:/src" -w /src semgrep/semgrep \
    semgrep --config p/javascript --config p/nodejs \
    --exclude node_modules --exclude public/vendor --exclude test-results \
    server.js lib public/app.js scripts
  ```
- Pass looks like: `Findings: 0 (0 blocking)`. This was verified: 68 rules over 4 files,
  0 findings. The rulesets to watch for this app are command injection and path traversal
  around the PTY spawn (`server.js`) and the project resolver (`lib/projects.js`); both are
  designed to be safe and Semgrep confirms no regressions.

---

## 4. Black-box (dynamic) security

These run a real scanner against the running server. Start it first with `make start`.
Both use `host.docker.internal` to reach the host from inside the container.

### 4a. OWASP ZAP baseline scan (Docker)

- What it does: passive DAST that crawls the app and flags missing security headers,
  cookie issues, and common web weaknesses.
- Install: none; the image pulls on first run (it is large, roughly 1.5 GB).
- Run:
  ```bash
  docker run --rm -t ghcr.io/zaproxy/zaproxy:stable \
    zap-baseline.py -t http://host.docker.internal:3200
  ```
- Pass looks like: `PASS` on the header and content checks. The app sets a
  Content-Security-Policy plus `X-Content-Type-Options`, `X-Frame-Options`, and
  `Referrer-Policy` (verified via `curl -sD - http://127.0.0.1:3200/`), so those rules
  should pass. ZAP reports informational and low warnings for a minimal app; review them,
  but a clean baseline means no medium or high alerts. Add `-I` to make the run exit 0 on
  warnings if you wire it into CI.

### 4b. Nikto (Docker)

- What it does: scans a web server for dangerous files, outdated components, and
  misconfigurations.
- Install: none; image pulls on first run.
- Run:
  ```bash
  docker run --rm sullo/nikto -h http://host.docker.internal:3200
  ```
- Pass looks like: no dangerous files or unexpected endpoints reported. Because the app
  serves only static assets and two endpoints (`/api/projects` and the `/pty` upgrade),
  the output should be short. Any reported path outside `public/` or those endpoints is
  worth investigating.

---

## 5. Optional: CodeQL (free for public repositories)

If this repo is pushed to GitHub, enable the CodeQL JavaScript workflow (Security tab,
Code scanning, or `github/codeql-action` in a workflow). It performs taint tracking to
verify no client controlled value reaches the PTY working directory or a shell command.
Expected result: none can, because the project name is validated against the allowlist and
is never interpolated into a path or a command.

## 6. Suggested CI pipeline

Ordered fastest to slowest so failures surface early:

1. `npm ci` then `make audit` (fail on high or critical).
2. `make lint` (static, white-box).
3. Semgrep (recipe 3c).
4. `make test` then `make test-ui`.
5. `make start`, then the ZAP baseline (recipe 4a), then `make stop`.
6. Optional: CodeQL on a schedule.

All steps run locally or on a standard GitHub Actions runner. None require paid tooling.

## Verified baseline (as of this writing)

| Check                    | Result                          |
|--------------------------|---------------------------------|
| `make lint`              | 0 errors (10 fs warnings)       |
| `make audit`             | 0 vulnerabilities               |
| `make test`              | 10 unit + 7 security pass        |
| `make test-ui`           | 14 passed (Chromium + WebKit)   |
| Semgrep (js + nodejs)    | 0 findings over 68 rules        |
| WebSocket auth probes    | 403 / 403 / 404 / 404 / 101     |
| Security headers on `/`  | CSP + nosniff + frame + referrer|
