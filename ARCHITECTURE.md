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
| `server.js` | ~310 | Express routes, the WebSocket upgrade handler, PTY spawn |
| `config/*.json` | | Three small config files, described below |
| `Dockerfile`, `docker-compose.yml` | | The container build, described below |

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

The scan is exactly **one level deep**, which is a deliberate limit rather than
an oversight. A tree of vendored or tutorial repos (`~/repo/kia2e` holds 23
Makefiles across its chapters) stays invisible without needing an ignore entry,
because its top level has no Makefile of its own. Anything genuinely wanted from
deeper down is added by absolute path to `config/extra-projects.json`, which
keeps the allowlist a list of deliberate choices rather than whatever a recursive
walk happened to turn up.

Keep the ignore list free of names that no longer exist. An entry for a project
that is gone ignores nothing and only makes the real list harder to read.

`config/top-targets.json` lets a project surface a short curated list of its
most-used targets ahead of the full parsed list. Unlike the extras file it is
cached; extras are re-read on every scan so that list stays as live as the
directory scan itself.

## Request flow

```
GET /api/health          ->  {ok:true}, no filesystem work (container healthcheck)
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
step. xterm.js and its fit addon are vendored under `public/vendor/` and
committed to git, so the page loads nothing from a CDN and a fresh clone needs
no build step to render.

`scripts/postinstall.js` does something unrelated despite the name suggesting it
places those files: it restores the exec bit on node-pty's `spawn-helper`, which
npm does not reliably preserve when extracting prebuilt binaries. Without it
node-pty fails at runtime with `posix_spawnp failed`.

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

## Running in a container

`Dockerfile` and `docker-compose.yml` package this for OrbStack on macOS,
matching the pattern in `~/repo/jobhunt`. `docker-deploy.md` is the operator
guide; the decisions that are not obvious from the files:

**The repo roots are mounted at their real host paths.** `/Users/michael/repo`
is mounted at `/Users/michael/repo`, not at `/repos`. `config/extra-projects.json`
stores absolute host paths and `DEFAULT_REPO_ROOTS` is absolute, so an identical
path removes the whole translation problem and keeps the extras file working
untouched. Anything else would mean rewriting every one of those paths.

**node-pty compiles at build time.** Version 1.1.0 ships prebuilds for darwin
and win32 only. The build stage installs `python3 make g++` and compiles it; the
runtime stage copies only the resulting `node_modules`, so no compiler ships.

**The container runs as uid 1000 because that uid has a passwd entry.**
`os.userInfo()` throws `ERR_SYSTEM_ERROR` for a uid that does not, which is why
`shellEnv()` now guards it. Under OrbStack, bind-mounted macOS files are
presented as owned by whatever uid the container runs as, so matching the host's
501:20 buys nothing.

**Two of the three security properties at the top of this file are enforced
differently in the container, and one of them is why `ALLOWED_ORIGINS` exists.** The loopback bind
moves to the host side, because a loopback listener inside a container is
unreachable through a published port; compose publishes to `127.0.0.1` only. The
origin check had to gain `ALLOWED_ORIGINS`, because the browser's `Origin`
carries the published host port while the process listens on 3200, and a
mismatch made every WebSocket upgrade 403 while the page still loaded.
`ALLOWED_ORIGINS_ONLY=1`, which compose sets, drops the port-derived origins so
the container trusts only what it is published on. The allowlist itself is
unchanged. All of this is covered by `test/security.js`.

**What the container cannot do.** Its shell is Linux. 15 of the 18 discovered
projects have Makefiles calling `xcodebuild`, `swift`, `codesign`, `notarytool`,
`hdiutil`, `launchctl`, `open` or `magick`. Those fail there by design; the host
instance remains the way to drive macOS app builds.

## Related docs

`README.md`, `docker-deploy.md`, `PLAN-cmd-center-docker.md`,
`cmd-center_testplan.md`, `EXTERNAL_TEST.md`, `RELEASING.md`, `CHANGELOG.md`.

## Keeping this file true

Update it when the discovery rules change, when a route is added, or when a
decision recorded here is reversed. The three security properties at the top are
the load bearing part: if a change touches origin checking, the allowlist, or
how the PTY cwd is chosen, it changes this file too. The container section is
part of that: it records how two of those three properties are enforced
differently when this runs in Docker.
