# node-pty is a native module with no Linux prebuild. Version 1.1.0 publishes
# prebuilds for darwin-arm64, darwin-x64, win32-arm64 and win32-x64 only, so on
# linux it always compiles from source and always needs a toolchain. Build it in
# a stage that has one, then copy only the resulting node_modules into a clean
# runtime image so g++ never ships.
#
# Node 22, matching jobhunt: Node 20 reached end of life on 2026-04-30 and no
# longer receives security patches. 22 is in maintenance until 2027-04-30.
FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# scripts/ is copied before the install because package.json has a postinstall
# hook that lives there. It restores the exec bit on node-pty's spawn-helper,
# which npm does not reliably preserve; without the directory present npm ci
# fails outright rather than skipping the hook.
COPY package*.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev


FROM node:22-bookworm-slim AS runtime

# Two different reasons for this package list.
#
# Required by the app itself: ca-certificates, and tini via the compose "init"
# flag rather than installed here.
#
# Required by what the app is for: this image's whole purpose is to give a
# browser terminal that can run "make" in a project directory, so the toolchain
# a Makefile expects has to exist. bash because the PTY spawns a login shell,
# make and git because every discovered project needs them, python3, curl, less,
# procps and lsof because project Makefiles and interactive use reach for them.
#
# What is deliberately absent: Xcode, swift, codesign, notarytool, hdiutil,
# launchctl. Those cannot exist on linux, so the 15 of 18 discovered projects
# that build macOS apps will fail in this container by design. See
# docker-deploy.md.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates bash make git curl less procps lsof python3 \
 && rm -rf /var/lib/apt/lists/*

# HOST must stay 0.0.0.0 in the container: the app defaults to loopback, and a
# process listening on 127.0.0.1 inside a container cannot be reached through a
# published port. Exposure is constrained on the host side instead, where
# compose publishes to 127.0.0.1 only.
ENV NODE_ENV=production \
    PORT=3200 \
    HOST=0.0.0.0

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts
COPY config ./config

# config/ is baked in so the image runs standalone, but compose mounts the host
# copy over it. Without that mount, toggling a project in the manage screen would
# write into the container's own filesystem and vanish on the next rebuild.
RUN chown -R node:node /app

# uid 1000, the image's built-in account. It matters that this uid has a passwd
# entry: os.userInfo() throws ERR_SYSTEM_ERROR for one that does not, and the
# shell would have no name and no home. Under OrbStack the bind-mounted repos
# are remapped to whatever uid the container runs as, so this costs no access.
USER node

EXPOSE 3200

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
