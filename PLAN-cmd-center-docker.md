# PLAN-cmd-center-docker

Plan for running cmd-center in Docker on macOS under OrbStack, following the
same pattern already used by `~/repo/jobhunt`.

Status: agreed 2026-09-22. Direction A (full container), goal: standardize every
app on the same Docker and OrbStack pattern.

## Why this app is not jobhunt

jobhunt is Node plus SQLite plus outbound HTTPS. Nothing it does cares what
operating system it sits on, so containerizing it changes nothing about its
behaviour.

cmd-center spawns a login shell and pipes it to the browser
(`server.js:190`). Inside a container that shell is Debian, not macOS, so `make`
runs against the container toolchain. A scan of the 18 projects cmd-center
discovers found 15 whose Makefiles call macOS-only tooling (`xcodebuild`,
`swift build`, `codesign`, `notarytool`, `hdiutil`, `launchctl`, `open`,
`magick`). Those targets cannot work in a Linux container and are out of scope
for the container build.

This is accepted, not solved. The container is the standardized packaging and a
working terminal for the portable projects. The host instance stays the way to
drive the macOS app projects.

## Verified facts this plan rests on

| Question | Answer | How it was checked |
| --- | --- | --- |
| Does node-pty 1.1.0 ship a Linux prebuild? | No. Only `darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64` | `ls node_modules/node-pty/prebuilds` |
| Does it compile in `node:22-bookworm-slim`? | Yes, with `python3 make g++`. Produces `build/Release/pty.node` and spawns a working PTY | Throwaway container build, printed `PTY_OK` |
| Who owns bind-mounted files under OrbStack? | Whatever uid the container runs as. Verified read and write at uid 501:20 and 1000:1000 | `docker run -u ... -v ... alpine` |
| Does `os.userInfo()` work in the container? | At uid 1000 (`node`) yes. At an unmapped uid it **throws** `ERR_SYSTEM_ERROR ENOENT` | `docker run -u 501:20 node:22-bookworm-slim node -e ...` |
| Is OrbStack the active docker context? | Yes, server 29.4.0 | `docker context ls` |

## Design decisions

### 1. Bind-mount the repo roots at identical host paths

`/Users/michael/repo` is mounted at `/Users/michael/repo` inside the container,
not at `/repos`.

Reason: `config/extra-projects.json` stores absolute host paths, and
`DEFAULT_REPO_ROOTS` in `lib/projects.js` is absolute. Identical paths mean no
config translation, the extras file keeps working untouched, and the directory
shown in the UI matches what the Mac calls it. OrbStack handles the ownership
remap, so nothing else is needed.

### 2. Run as the image's built-in `node` user (1000:1000)

`os.userInfo()` resolves cleanly at uid 1000 and gives the shell a real home at
`/home/node`. OrbStack makes file ownership a non-issue, so there is no reason
to reach for the host's 501:20.

`APP_UID` and `APP_GID` stay overridable in `.env` for consistency with
jobhunt, with a warning that an unmapped uid has no passwd entry.

### 3. HOST=0.0.0.0 inside, published to 127.0.0.1 outside

Same reasoning as jobhunt: a process on loopback inside a container is
unreachable through a published port. Exposure is constrained on the host side
by publishing to `127.0.0.1` only.

### 4. New: ALLOWED_ORIGINS environment variable

`allowedOrigin()` builds its allow set from `HOST` and `PORT`
(`server.js:34-42`). In the container `PORT` is 3200, so if the published host
port differs (`HOST_PORT=3201`) the browser sends `Origin:
http://localhost:3201`, which is not in the set, and **every WebSocket upgrade
returns 403**. The terminal would silently never connect.

Fix: an optional comma-separated `ALLOWED_ORIGINS` merged into the existing set.
Unset, behaviour is byte-for-byte what it is today. Compose sets it from
`HOST_PORT` so a remapped port works out of the box.

### 5. New: harden shellEnv() against a uid with no passwd entry

`shellEnv()` calls `os.userInfo()` unguarded (`server.js:171`). That throws for
an unmapped uid, which would crash the handler on every terminal open. Wrap it
and fall back to the environment. This is a real robustness fix, not
container-only decoration.

### 6. New: GET /api/health

The compose healthcheck needs a cheap endpoint. Hitting `/api/projects` would
trigger a full filesystem scan of every repo root every 30 seconds. A flat
health route avoids that and matches jobhunt, which already has one.

### 7. Toolchain in the runtime image

Beyond Node: `bash make git curl ca-certificates procps lsof less python3`.
Enough for the portable projects and for the shell to feel like a shell. The
build toolchain (`g++`) stays in the build stage and ships nothing.

### 8. Makefile docker targets

A deliberate deviation from jobhunt, which drives compose from the docs only.
cmd-center is operated through its own Makefile inside its own UI, so
`docker-build`, `docker-up`, `docker-down`, `docker-logs`, `docker-status`,
`docker-shell` belong there.

## Files

| File | New or changed | Holds |
| --- | --- | --- |
| `Dockerfile` | new | Multi-stage build, node-pty compiled for Linux |
| `docker-compose.yml` | new | Mounts, ports, env, healthcheck, logging |
| `.dockerignore` | new | Keeps the build context small and secrets out |
| `.env.example` | new | Every compose variable, documented |
| `docker-deploy.md` | new | How to run it, and what does not work in a container |
| `server.js` | changed | `ALLOWED_ORIGINS`, `shellEnv()` guard, `/api/health` |
| `test/security.js` | changed | Origin allowlist still closed with the new variable |
| `test/unit.js` | changed | Health route, shellEnv fallback |
| `Makefile` | changed | docker targets |
| `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md` | changed | Documented, plus the gollum copies |

`ARCHITECTURE.md` also carries a stale claim to fix: it says the xterm vendor
files are "copied in by scripts/postinstall.js on npm install". They are
committed to git, and postinstall only restores the exec bit on node-pty's
spawn-helper.

## Out of scope

- Making macOS app targets work in the container. That is direction B (SSH back
  to the host) and was not chosen.
- Mounting the Docker socket so container shells can drive other containers.
- Replacing the host instance or the LaunchAgent. Both stay.

## Verification

1. `npm test` passes on the host, unchanged behaviour with `ALLOWED_ORIGINS` unset.
2. `make docker-build` completes.
3. `make docker-up`, then the page loads at `http://127.0.0.1:3200`.
4. The sidebar lists the same projects as the host instance.
5. A terminal opens on a portable project and `make` runs.
6. A terminal on a macOS app project opens and fails at `xcodebuild`, as documented.
7. Healthcheck reports healthy.
8. `make docker-down` stops it cleanly.
