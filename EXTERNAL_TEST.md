# External Automated Testing

This document lists external tooling for automated testing of cmd-center, covering
black-box security, white-box security, functionality, and smoke tests. Free and open
source tools are prioritized. Research current as of 2026.

cmd-center is a local Node.js/Express web app that exposes a WebSocket-backed
pseudo-terminal, so the highest-value external testing targets are: the WebSocket
authorization checks (Origin and project allowlist), the HTTP surface and headers, and
dependency/code security.

## Functionality and smoke tests

### Playwright (FOSS) — already integrated
- What it does: drives a real Chromium browser against the app; asserts UI behavior end
  to end.
- Use here: `make test-ui` runs `test/ui.spec.js` against a self-contained fixture
  server. Extend with cross-browser projects (Firefox, WebKit) and a trace on failure.
- Smoke test: a single spec that loads `/`, selects a project, and asserts the terminal
  renders output. Wire into CI as the go/no-go gate.

### curl / websocat (FOSS) — protocol-level smoke
- `curl -s http://127.0.0.1:3200/api/projects` should return the project list.
- `websocat` (https://github.com/vi/websocat) can open the `/pty` WebSocket from the
  command line to smoke-test the terminal channel and, importantly, to test it with a
  forged or missing Origin header for the security cases below.

## Black-box security

### OWASP ZAP (FOSS) — baseline scan
- What it does: passive and active DAST scanning of a running web app; flags missing
  security headers, cookie issues, and common web weaknesses.
- Use here: run the ZAP baseline scan against `http://127.0.0.1:3200`. Confirm the
  Content-Security-Policy and other helmet headers are present and that no unexpected
  endpoints are exposed. Runnable via the `zaproxy/zap-baseline` Docker image in CI.

### Nikto (FOSS) — server misconfiguration
- What it does: scans a web server for dangerous files, outdated components, and
  misconfigurations.
- Use here: quick pass against the running server to confirm nothing beyond the intended
  static assets and two endpoints is reachable.

### WebSocket authorization tests (websocat / custom script)
- Origin enforcement: open `/pty` with `Origin: http://evil.example.com` and with no
  Origin header. Both must be refused (HTTP 403). This mirrors `test/security.js` but as
  an external, black-box check.
- Project allowlist: open `/pty?project=../../etc` and `/pty?project=nonexistent` with a
  valid Origin. Both must be refused (HTTP 404). Confirms no shell can be opened outside
  the scanned Makefile directories.
- Port binding: from another host on the LAN, attempt to reach the port. It must be
  unreachable because the server binds to `127.0.0.1`.

## White-box security

### npm audit (FOSS) — dependency vulnerabilities
- What it does: checks installed dependencies against the advisory database.
- Use here: `npm audit` in CI; fail on high/critical. Current baseline reports 0
  vulnerabilities.

### Semgrep (FOSS) — static analysis
- What it does: pattern-based SAST for JavaScript/Node.
- Use here: run with the `p/javascript`, `p/nodejs`, and `p/owasp-top-ten` rulesets over
  `server.js`, `lib/`, and `public/`. Pay attention to command-injection and
  path-traversal findings around the PTY spawn and the project resolver (both are
  designed to be safe; Semgrep confirms no regressions creep in).

### ESLint with security plugins (FOSS)
- What it does: lint plus `eslint-plugin-security` and `eslint-plugin-no-unsanitized`
  catch unsafe patterns (dynamic child_process, unsanitized DOM sinks).
- Use here: lint `server.js`, `lib/`, and `public/app.js`. The frontend builds DOM nodes
  via `textContent` (not `innerHTML` with data), which these rules verify.

### CodeQL (free for public repos)
- What it does: deep semantic code analysis with taint tracking.
- Use here: a JavaScript CodeQL workflow to trace whether any client-controlled value can
  reach the PTY cwd or a shell command. Expected result: it cannot, because the project
  name is validated against the allowlist and never interpolated into a path or command.

## Suggested CI pipeline

1. `npm ci` then `npm audit` (fail on high/critical).
2. Semgrep and ESLint (static, white-box).
3. `make test` (unit + security) then `make test-ui` (Playwright).
4. Start the server; run the ZAP baseline scan; stop the server.
5. Optional: CodeQL on a schedule.

All steps run locally or in a standard GitHub Actions runner; none require paid tooling.
