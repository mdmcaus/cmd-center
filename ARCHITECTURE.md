# ARCHITECTURE

Codebase map for cmd-center. Read this before searching the tree.

Purpose: orient a reader who has no prior context on this repo. What each file
owns, how a request moves through it, and where the security boundary is.

## What it is

A local web command center. It browses every project that has a Makefile, shows
that project's targets, and gives you a **real interactive terminal per project**
in the browser. Node.js, Express 5, `node-pty` for the PTY, `ws` for the
transport, xterm.js for the terminal in the page.

Runs on 127.0.0.1:3200. `~/repo/appmenu` controls it through `make start`,
`make stop`, `make restart` and `make status`.

## Read this part first

This app spawns a login shell as the current user and pipes it to a web page.
That is the entire point of it, and it is also why the security posture is not
decoration. From the header of `server.js`:

- **Binds to 127.0.0.1 only**, never a public interface.
- **WebSocket upgrades must carry a same-origin `Origin` header**, checked in
  `allowedOrigin()`. A page on another origin cannot open a terminal.
- **The PTY working directory is only ever a directory from the freshly scanned
  Makefile allowlist.** The client supplied project name is validated against
  that list and never used to build a path.

That last one is the important one, and it is why project discovery lives in a
library of its own rather than inline: the list of projects *is* the security
allowlist.

## Layout

| File | Lines | Owns |
| --- | --- | --- |
| `lib/projects.js` | ~349 | Project discovery, Makefile target parsing, the allowlist. Largest server file |
| `public/app.js` | ~569 | The whole front end: sidebar, target list, xterm.js wiring. No framework, no bundler |
| `server.js` | ~243 | Express routes, the WebSocket upgrade handler, PTY spawn |
| `config/*.json` | | Three small config files, described below |

## Project discovery

A "project" is:

- any immediate subdirectory of one of the `REPO_ROOTS` containing a file named
  exactly `Makefile`
- plus any directory listed in `config/extra-projects.json`, for repos outside
  every root, each of which still needs a Makefile
- minus any name listed in `config/ignored-projects.json`

Default roots, in precedence order: `~/repo/claude`, then `~/repo`. **An earlier
root wins a name collision**, so a project can never be shadowed by one further
down the list. `REPO_ROOTS` takes a colon separated list; `REPO_ROOT` is still
honored as the single root form.

Ignoring is **fail closed**: an ignored project is not merely hidden from the
sidebar, it is also refused a PTY. Hiding and forbidding are the same action
here, which is what keeps the allowlist honest.

`config/top-targets.json` lets a project surface a short curated list of its
most-used targets ahead of the full parsed list. Unlike the extras file it is
cached; extras are re-read on every scan so that list stays as live as the
directory scan itself.

## Request flow

```
GET /api/projects        ->  scan roots  ->  [{name, dir, targets}]
GET /api/projects/all    ->  same, including ignored, for the admin view

WS  /pty?project=<name>  ->  same-origin check   (403 if not)
                         ->  resolveProject()    (404 if not in allowlist)
                         ->  pty.spawn($SHELL -l, cwd)
                         ->  bytes both ways over the socket
```

## One detail that looks like paranoia and is not

`shellEnv()` rebuilds `USER`, `LOGNAME` and `HOME` from `os.userInfo()` rather
than inheriting them. The identity of whatever launched the server can leak
stale values into the environment (`USER=root` while the process actually runs
as a normal user, for instance). The shell prompt and plenty of tools read those
variables, so rebuilding them from the real account behind the effective uid is
what makes the browser terminal match a normal login shell.

## Front end

`public/app.js` is plain JavaScript against the DOM, no framework and no build
step. xterm.js and its fit addon are vendored under `public/vendor/` and copied
in by `scripts/postinstall.js` on `npm install`, so the page loads nothing from
a CDN.

Note the CSP in `server.js` explicitly allows the WebSocket connection, because
`'self'` alone is not reliably honored for `ws:` in Safari.

## Testing and linting

| Command | Does |
| --- | --- |
| `npm test` | `test/unit.js` then `test/security.js` |
| `npm run test:ui` | Playwright, `test/ui.spec.js` |
| `npm run lint` | ESLint |
| `npm run audit` | `npm audit --omit=dev` |

`test/security.js` is a suite of its own, not an afterthought: it is what keeps
the allowlist and origin checks from regressing. ESLint is configured in
`eslint.config.js` with `eslint-plugin-security` and
`eslint-plugin-no-unsanitized`, the latter aimed at the DOM writes in
`public/app.js`.

## Running as a service

`launchd/com.mdmcaus.cmd-center.plist.template` is the launchd job for running
this at login. It is a template: paths get substituted at install time.

## Related docs

`README.md`, `cmd-center_testplan.md`, `EXTERNAL_TEST.md`, `RELEASING.md`,
`CHANGELOG.md`.

## Keeping this file true

Update it when the discovery rules change, when a route is added, or when a
decision recorded here is reversed. The three security properties at the top are
the load bearing part: if a change touches origin checking, the allowlist, or
how the PTY cwd is chosen, it changes this file too.
