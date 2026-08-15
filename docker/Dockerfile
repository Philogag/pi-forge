# syntax=docker/dockerfile:1.6
#
# Multi-stage Dockerfile for pi-forge.
#
#   builder  → install deps, compile server TS, build Vite client
#   runtime  → node:22-bookworm-slim with Python 3.12 + pip, production
#              dependencies installed with `npm ci` (NOT copied from the
#              builder), and the compiled output. The server runs as root
#              so the opt-in identity sandbox can drop tool processes to
#              the restricted pi-tools UID/GID.
#
# Why bookworm-slim and not alpine: the Node native-module ecosystem
# (node-pty, bcrypt, sharp, better-sqlite3, …) ships prebuilt binaries
# against glibc. On musl/alpine, prebuild-install can't find a matching
# binary and falls back to a source build, which both slows the image
# build and breaks any package without source-build support. The image
# is ~80 MB larger than alpine; in exchange we get faster builds, fewer
# native-module footguns, and a friendlier interactive shell for the
# integrated terminal (bash + readline + a real coreutils).

# ---------- shared Node + Python base ----------
FROM python:3.12-slim-bookworm AS python-base

FROM node:22-bookworm-slim AS node-python-base

# Keep the final image lineage on the official Node image — pi-forge is a
# Node app, so preserving Node/npm/corepack exactly as shipped is more
# important than preserving the Python image as the final base. Copy the
# official Python 3.12 runtime into /usr/local (Docker COPY merges into
# the existing Node-owned tree without deleting Node/npm/corepack) and
# install the Debian runtime libraries CPython extension modules commonly
# link against.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      libbz2-1.0 \
      libexpat1 \
      libffi8 \
      libgdbm-compat4 \
      liblzma5 \
      libncursesw6 \
      libreadline8 \
      libsqlite3-0 \
      libssl3 \
      libuuid1 \
      zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=python-base /usr/local/ /usr/local/
RUN ln -sf /usr/local/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/local/bin/python3 /usr/local/bin/py \
 && ldconfig \
 && node --version \
 && npm --version \
 && python3 --version \
 && pip3 --version

# ---------- builder ----------
FROM node-python-base AS builder

# Native deps for node-pty (Phase 11 will use it; the dep is already in
# server/package.json, so install needs the toolchain regardless). On
# bookworm-slim, node-pty's prebuilds usually cover the linux-x64 and
# linux-arm64 paths — but we keep the toolchain so a source build still
# works on platforms without a prebuild, and so any other native module
# pulled in transitively still installs cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfiles + workspace manifests first so dependency installs are
# cached on source-only changes.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# `npm ci --workspaces` honours the root lockfile across all packages.
RUN npm ci --workspaces --include-workspace-root

# Now bring in the source and build.
COPY . .

RUN npm run build

# ---------- runtime ----------
FROM node-python-base AS runtime

# `tini` for proper PID-1 signal handling (Ctrl-C → SIGTERM → graceful
# shutdown of pi-forge's onClose hook). Without it, dropped SIGTERMs
# leave SSE clients hanging on `docker compose down`.
#
# PUID/PGID build args let the legacy `pi` user match the host owner of
# mounted config/data directories. PTOOLS_UID/PTOOLS_GID create the
# restricted `pi-tools` identity used by AGENT_TOOL_SANDBOX_ENABLED.
# Override at build time when your host bind mounts require different
# ownership:
#   docker compose build --build-arg PUID=$(id -u) --build-arg PGID=$(id -g)
ARG PUID=1000
ARG PGID=1000
ARG PTOOLS_UID=1001
ARG PTOOLS_GID=1001

# Some upstream base images have shipped a pre-baked `node` user/group
# at UID/GID 1000 — the same default we want for `pi`. Drop it before
# creating `pi` if present; `|| true` keeps the build green on bases
# without that user.
#
# Runtime tools the agent + interactive terminal need:
#   - tini: PID-1 signal handling (see above)
#   - git: status / diff / commit / push / etc. — the GitPanel routes
#     and the agent's `bash` tool both expect git on PATH. Also used by
#     pi-forge's "clone repository" project-setup flow.
#   - ripgrep: pi's `grep` tool delegates to ripgrep when present.
#     Without it, code search inside the agent silently degrades.
#   - bash: replaces dash as the integrated terminal's interactive
#     shell. node-pty defaults to /bin/sh; we set SHELL=/bin/bash
#     below so xterm sessions land in bash with readline + history +
#     the prompt expansions users expect.
#   - curl, ca-certificates, less, procps: minimum interactive-terminal
#     hygiene. curl for fetching, ca-certificates so HTTPS works, less
#     so `git log` and similar pagers don't bomb, procps so `ps`/`top`
#     are present for users debugging long-running tool processes.
#   - python3/pip3: Python 3.12 package tooling from the official
#     Python image. `python` and `py` are aliases for `python3`.
#
# Not installed: `gh`, `tea`, and gnupg (GitHub CLI apt source/keyring
# and the pinned Gitea tea release), plus `vim` — an
# interactive-editing nicety at ~35 MB uncompressed. `make g++` are not
# in this apt RUN either: the runtime `npm ci` installs them
# transiently (node-pty compiles from source) and purges them in the
# same layer, so the toolchain is never part of the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini gosu git ripgrep bash curl ca-certificates less procps \
 && rm -rf /var/lib/apt/lists/* \
 && (userdel node 2>/dev/null || true) \
 && (groupdel node 2>/dev/null || true) \
 && groupadd -g $PGID pi \
 && useradd -m -u $PUID -g $PGID -s /bin/bash pi \
 && groupadd -g $PTOOLS_GID pi-tools \
 && useradd -m -d /home/pi-tools -u $PTOOLS_UID -g $PTOOLS_GID -s /usr/sbin/nologin pi-tools \
 && usermod -aG pi-tools pi

WORKDIR /app

# Production dependency install in the runtime image itself: only the
# lockfile + workspace manifests are needed, then `npm ci` builds a
# fresh, npm-owned node_modules. This replaces the builder's node_modules
# COPY; native modules are installed against this image's Node ABI, and
# `--omit=dev` keeps build-time-only packages (typescript, vite, eslint,
# …) out of the final image.
#
# Only the SERVER workspace is installed (`-w @pi-forge/server`): the
# client is a static Vite build served from packages/client/dist, so its
# dependencies (react, codemirror, katex, xterm, …) would be dead weight
# in the runtime image. npm hoists to /app/node_modules — module
# resolution walks up from packages/server/dist.
#
# node-pty has no prebuild for this image's Node ABI, so `npm ci`
# compiles it from source: make/g++ are installed transiently and
# purged again in the same RUN so the toolchain never lands in the
# layer (only libstdc++, already present for node, remains). The npm
# cache (already-gzipped tarballs, ~100 MB uncompressible) is deleted
# in the same RUN; the npm toolchain itself is kept (~30 MB) so
# in-container `npm install` keeps working (pi extension installs, the
# agent's bash tool, …). Note that native-module rebuilds also need
# `make g++` — add it back to the apt RUN if you rely on those.
#
# Cross-platform dead weight is pruned after install:
#   - node-pty/prebuilds (58 MB): darwin/win32 prebuilt binaries; this
#     glibc linux image uses the pty.node compiled by the npm ci above
#   - @napi-rs/canvas-linux-x64-musl (28 MB): musl variant of the
#     canvas binding pdf-parse pulls in; only the glibc build is used.
#     Note: canvas itself is REQUIRED at runtime — pdf-parse loads
#     pdfjs-dist's legacy build, which needs canvas's DOMMatrix
#     polyfill at module scope (pdf.mjs: `const SCALE_MATRIX = new
#     DOMMatrix()`); removing it crashes PDF text extraction.
COPY --chown=pi:pi package.json package-lock.json ./
COPY --chown=pi:pi packages/server/package.json packages/server/
COPY --chown=pi:pi packages/client/package.json packages/client/
RUN apt-get update \
 && apt-get install -y --no-install-recommends make g++ \
 && npm ci --workspace @pi-forge/server --include-workspace-root --omit=dev \
 && rm -rf /root/.npm \
 && apt-get purge -y --auto-remove make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /app/node_modules/node-pty/prebuilds \
 && rm -rf /app/node_modules/@napi-rs/canvas-linux-x64-musl \
 && if [ -d /app/node_modules/@earendil-works/pi-coding-agent ]; then \
      chmod -R a+rX,u+w,go-w /app/node_modules/@earendil-works/pi-coding-agent; \
    fi \
 && chown -R pi:pi /app/node_modules

# Compiled artifacts from the builder (no node_modules).
COPY --from=builder --chown=pi:pi /app/package.json ./package.json
COPY --from=builder --chown=pi:pi /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder --chown=pi:pi /app/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=pi:pi /app/packages/client/package.json ./packages/client/package.json
COPY --from=builder --chown=pi:pi /app/packages/client/dist ./packages/client/dist

# Workspace + pi config + pi-forge data dirs are mounted at runtime.
# Image-layer defaults preserve the historical non-sandbox posture:
# the server runs as `pi`, and pi-owned config/data dirs are writable by it.
# Sandbox deployments must explicitly permission their mounts; see
# docs/agent-tool-sandbox.md.
RUN mkdir -p /workspace /home/pi/.pi/agent /home/pi/.pi-forge /home/pi/.local /home/pi/.npm /home/pi/.pi/npm/node_global /home/pi-tools/.config \
 && chown -R pi:pi /workspace /home/pi/.pi/agent /home/pi/.pi-forge /home/pi/.local /home/pi/.npm /home/pi/.pi/npm \
 && chown -R pi-tools:pi-tools /home/pi-tools \
 && chown pi:pi /home/pi \
 && chown pi:pi-tools /home/pi/.pi \
 && chmod 0775 /workspace \
 && chmod 0755 /home/pi /home/pi/.pi \
 && chmod 0700 /home/pi/.pi/agent /home/pi/.pi-forge /home/pi/.local /home/pi/.npm /home/pi-tools \
 && printf 'prefix=/home/pi/.pi/npm/node_global\n' > /home/pi/.npmrc \
 && chown pi:pi /home/pi/.npmrc

RUN cat >/usr/local/bin/pi-forge-entrypoint <<'EOF'
#!/bin/sh
set -eu
case "$(printf '%s' "${AGENT_TOOL_SANDBOX_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    # Sandbox mode: keep the server as root so it can setuid/setgid
    # model/user tool children to AGENT_TOOL_UID:GID. Prepare the standard
    # writable mounts here, before Node imports config.ts and tries to create
    # server-private files such as /home/pi/.pi-forge/jwt-secret.
    if [ "$(id -u)" != "0" ]; then
      echo "AGENT_TOOL_SANDBOX_ENABLED=true requires the container to run as root" >&2
      exit 1
    fi
    tool_uid="${AGENT_TOOL_UID:?AGENT_TOOL_UID is required when sandbox is enabled}"
    tool_gid="${AGENT_TOOL_GID:?AGENT_TOOL_GID is required when sandbox is enabled}"
    workspace_path="${WORKSPACE_PATH:-/workspace}"
    forge_data_dir="${FORGE_DATA_DIR:-/home/pi/.pi-forge}"
    pi_config_dir="${PI_CONFIG_DIR:-/home/pi/.pi/agent}"
    tool_home="${AGENT_TOOL_HOME:-/home/pi-tools}"

    mkdir -p "$workspace_path" "$forge_data_dir" "$pi_config_dir" "$tool_home"

    chown root:root "$forge_data_dir"
    chmod u+rwx "$forge_data_dir"
    chown -R root:root "$forge_data_dir"
    chmod -R u+rwX,go-rwx "$forge_data_dir"

    chown root:0 "$workspace_path"
    chmod u+rwx,g+rwx "$workspace_path"
    chown -R root:0 "$workspace_path"
    chmod -R u+rwX,g+rwX,o-rwx "$workspace_path"
    chown -R "$tool_uid:0" "$workspace_path"

    chown root:"$tool_gid" "$pi_config_dir"
    chmod 0750 "$pi_config_dir"

    chown root:"$tool_gid" "$tool_home"
    chmod u+rwx "$tool_home"
    chown -R root:"$tool_gid" "$tool_home"
    chmod -R u+rwX,go-rwx "$tool_home"
    chown -R "$tool_uid:$tool_gid" "$tool_home"

    exec "$@"
    ;;
  *)
    # Legacy/default mode: run as whichever non-root user the runtime
    # selected. Compose starts as pi directly so regular mode does not
    # need SETUID/SETGID capabilities; the root fallback preserves
    # compatibility for `docker run` invocations without --user.
    # Sandbox startup chown paths are skipped here because sandbox is off.
    #
    # Root fallback also normalises pi-owned dirs before dropping to pi:
    # bind mounts (workspace, config/data dirs, home subdirs) keep host
    # ownership, which would break writes as pi — config.json/jwt-secret,
    # `pip install --user`, the npm cache, and `npm install -g` (global
    # prefix /home/pi/.pi/npm/node_global). Missing paths are recreated
    # and everything chowned to pi so mounted volumes behave like the
    # image-layer defaults.
    if [ "$(id -u)" = "0" ]; then
      for dir in "${WORKSPACE_PATH:-/workspace}" \
                 "${PI_CONFIG_DIR:-/home/pi/.pi/agent}" \
                 "${FORGE_DATA_DIR:-/home/pi/.pi-forge}" \
                 "${PYTHONUSERBASE:-/home/pi/.local}" \
                 /home/pi/.pi /home/pi/.npm /home/pi/.pi/npm/node_global; do
        mkdir -p "$dir"
        chown -R pi:pi "$dir"
      done
      exec gosu pi "$@"
    fi
    exec "$@"
    ;;
esac
EOF
RUN chmod 0755 /usr/local/bin/pi-forge-entrypoint

USER root

# SHELL=/bin/bash so node-pty spawns bash for the integrated terminal
# (pty-manager.ts uses `process.env.SHELL || '/bin/sh'`). TERM hint
# helps line-editing programs pick a sane terminfo entry inside xterm.
#
# PATH prepends /home/pi/.local/bin for scripts installed by
# `python3 -m pip install --user ...`, then the pi user's npm global
# prefix bin (/home/pi/.pi/npm/node_global — /home/pi/.npmrc sets the
# prefix, so `npm install -g` inside the container lands there), then
# /app/node_modules/.bin so the `pi` CLI shipped by
# @earendil-works/pi-coding-agent (already a server dep, so it survives
# `npm ci --omit=dev`) is on PATH for the running server and any process
# it spawns. The pi-subagents plugin shells out via
# `child_process.spawn("pi", ...)` with no fallback resolution on
# Linux — without this, the subagent tool fails with `spawn pi ENOENT`
# inside the container.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOME=/home/pi \
    USER=pi \
    LOGNAME=pi \
    PATH=/home/pi/.local/bin:/home/pi/.pi/npm/node_global/bin:/app/node_modules/.bin:$PATH \
    WORKSPACE_PATH=/workspace \
    PI_CONFIG_DIR=/home/pi/.pi/agent \
    FORGE_DATA_DIR=/home/pi/.pi-forge \
    PYTHONUSERBASE=/home/pi/.local \
    SHELL=/bin/bash \
    TERM=xterm-256color

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pi-forge-entrypoint"]
CMD ["node", "packages/server/dist/index.js"]
