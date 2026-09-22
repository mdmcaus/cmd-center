# Running cmd-center in Docker

How to run cmd-center as a container on macOS under OrbStack, and, just as
important, what it cannot do there.

This follows the same pattern as `~/repo/jobhunt`: multi-stage build, compose
file, published on loopback only, `.env` for the knobs.

## Read this before you start

cmd-center exists to run `make` in a project directory. Inside a container that
`make` runs against the **container's** Linux toolchain, not your Mac's.

A scan of the 18 projects cmd-center discovers found 15 whose Makefiles call
tooling that cannot exist on Linux:

    xcodebuild   swift   codesign   notarytool   hdiutil   launchctl   open   magick

Those targets fail in the container, by design. Verified example, `make build`
on scorebar inside the container:

    swift build
    make: swift: No such file or directory
    make: *** [Makefile:45: build] Error 127

The container is therefore the right tool for:

- the portable projects (`newonbrew`, `scoreline`, `shatui`)
- anything Node, Python, or Kubernetes shaped
- standardizing how every app in this account is packaged

and the wrong tool for driving your macOS app builds. Keep the host instance for
those. The two can run side by side on different ports.

## Quick start

1. Confirm OrbStack is the active Docker context.

       docker context ls

   The row marked `*` should be `orbstack`.

2. Optional. Copy the environment template and edit it if you want anything
   other than the defaults.

       cp .env.example .env

3. Build the image. The first build is slow (two to three minutes) because
   node-pty has no Linux prebuild and has to compile.

       make docker-build

4. Start it.

       make docker-up

5. Open it. The container publishes on **3201**, not 3200.

       open http://127.0.0.1:3201

6. Check on it.

       make docker-status
       make docker-logs

7. Stop it.

       make docker-down

## Running it alongside the host instance

**This is the default. No configuration needed.**

| Instance | Port | Started by | Can build macOS projects |
| --- | --- | --- | --- |
| Host | 3200 | `make start`, `cmdc.sh`, the LaunchAgent, `~/repo/appmenu` | Yes |
| Container | 3201 | `make docker-up` | No |

The container defaults to 3201 precisely so it can never take 3200 out from
under the host instance, which is the one that actually builds your macOS apps.
Compose feeds `HOST_PORT` into `ALLOWED_ORIGINS` automatically, so the origin
check follows the port with no further edits.

`make docker-up` also refuses to start if its port is already held by something
that is not the container itself, rather than failing cryptically or leaving you
driving the wrong instance without noticing.

To run the container *instead of* the host instance, stop the host one first and
set the port:

    make stop
    echo "HOST_PORT=3200" >> .env
    make docker-up

### Telling the two apart

Both instances render an identical page. The reliable tells are the URL
(`:3200` host, `:3201` container) and the terminal prompt: the container's is
`node@<container id>`, the host's is your own username.

## Make targets

| Target | Does |
| --- | --- |
| `make docker-build` | Build the image |
| `make docker-up` | Start the container detached |
| `make docker-down` | Stop and remove it |
| `make docker-restart` | Rebuild and restart |
| `make docker-logs` | Tail the container log |
| `make docker-status` | Container state, health, and URL |
| `make docker-shell` | A bash shell inside the container |
| `make docker-clean` | Remove the container and its image |

## Environment variables

Every one of these is read by compose, not by the app, and every one has a
working default. cmd-center takes no secrets and no API keys.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST_PORT` | `3201` | Port published on the Mac. 3200 is the host instance's |
| `BIND_ADDR` | `127.0.0.1` | Interface the port binds to. Loopback only |
| `REPO_MOUNT` | `/Users/michael/repo` | Host directory mounted into the container |
| `REPO_ROOTS` | `/Users/michael/repo/claude:/Users/michael/repo` | Roots scanned, in precedence order |
| `APP_UID` / `APP_GID` | `1000` / `1000` | Account the container runs as |
| `TZ` | `UTC` | Container timezone |

## Design notes

### The repos are mounted at their real host paths

`/Users/michael/repo` is mounted at `/Users/michael/repo` inside the container,
not at something like `/repos`.

`config/extra-projects.json` stores absolute host paths, and
`DEFAULT_REPO_ROOTS` in `lib/projects.js` is absolute. Mounting at the identical
path means no translation layer, the extras file keeps working untouched, and
the directory the UI shows matches what the Mac calls it. Verified: the
container and the host instance list the same 18 projects with the same paths.

### OrbStack makes the uid question go away

On OrbStack, a bind-mounted macOS directory is presented as owned by whatever
uid the container runs as. Verified at both 501:20 and 1000:1000, read and
write. So there is no chown dance and no need to match the host's uid.

The container therefore runs as the image's built-in `node` user (1000). That
uid matters for a different reason: it has a passwd entry. `os.userInfo()`
throws `ERR_SYSTEM_ERROR` for a uid that does not, which is why `APP_UID` is
best left alone. The app now survives that case anyway, but the shell would come
up with no username and no home directory.

### The app binds 0.0.0.0 inside, and that is not a loosening

A process listening on `127.0.0.1` inside a container is unreachable through a
published port, so `HOST=0.0.0.0` is mandatory. The loopback restriction moves
to the host side, where compose publishes to `127.0.0.1` only.

**Do not change `BIND_ADDR` to a LAN address.** This app hands out an
interactive shell and has no authentication in front of it.

### ALLOWED_ORIGINS, and why it had to be added

`allowedOrigin()` built its allow set from the port the process listens on. In
the container that is always 3200, but the browser's `Origin` carries the
*published* port. With `HOST_PORT=3201` the two disagree, and every WebSocket
upgrade would return 403: the page would load and no terminal would ever
connect.

`ALLOWED_ORIGINS` is a comma-separated list merged into the set. Entries are
matched exactly, and anything that is not a well-formed `http(s)` origin is
dropped rather than trusted (`not-a-url` and `http://host/path` are both
refused). Unset, the allow set is exactly what it has always been.

`ALLOWED_ORIGINS_ONLY=1`, which compose sets, additionally drops the
port-derived origins so the container trusts the explicit list and nothing else.

All of this is covered by `test/security.js`.

### node-pty compiles at build time

node-pty 1.1.0 publishes prebuilds for `darwin-arm64`, `darwin-x64`,
`win32-arm64` and `win32-x64`. There is no Linux prebuild, so the build stage
installs `python3 make g++` and compiles it. The runtime stage copies only the
resulting `node_modules`, so the compiler never ships.

This is why the first build is slow and later ones are fast.

### What is in the runtime image

`bash make git curl less procps lsof python3`, plus Node 22. Enough for the
portable projects and for the shell to feel like a shell.

## Things that will trip you up

1. **A project's `node_modules` is built for macOS.** The repos are bind-mounted,
   so `node_modules` inside them holds Darwin binaries. Running `npm test` in a
   project with native modules will fail inside the container. Run `npm ci`
   inside the container first if you need that, and know it will then be wrong
   for the host.

2. **cmd-center's own `make start` inside the container is not what you want.**
   It would start a second copy of the server inside the container. Use the
   docker targets from the host instead.

3. **`make install-agent` cannot work in the container.** It calls `launchctl`.

4. **The shell's home is `/home/node`, not your Mac's home.** Your `.gitconfig`,
   SSH keys and shell dotfiles are not there. That is deliberate: the container
   has no access to your credentials.

5. **Config edits are shared with the host instance.** `./config` is mounted, so
   ignoring a project in the container's UI also ignores it for the host
   instance. Usually what you want; worth knowing when it surprises you.

## Verification checklist

This was the sequence used to verify the setup, all of it passing:

| Check | Result |
| --- | --- |
| `npm test` on the host | 29 unit assertions, 21/21 security checks |
| `npx eslint .` | 0 errors |
| `make docker-build` | Image built |
| Container health | `healthy` |
| `GET /api/health` | `{"ok":true}` |
| Project list matches the host instance | 18 projects, identical paths |
| Terminal opens on a portable project | Linux, user `node`, GNU Make 4.3, git 2.39.5, node v22.23.2 |
| Terminal on a macOS project | Fails at `swift`, as documented |
| Foreign origin | Rejected 403 |
| Container's internal-port origin, strict mode | Rejected 403 |
| Config write-back through the mount | Works both directions |
