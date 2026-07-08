# syntax=docker/dockerfile:1.7
# NanoClaw Host Container
# Runs the host process (channel listeners, admin-MCP webhook, agent
# orchestration). Agent containers are spawned as SIBLINGS through the
# host daemon: run this image with /var/run/docker.sock mounted.
#
# Runtime state is never baked in — mount it (see .dockerignore):
#   -v <install>/data:/app/data      sqlite, sessions, sockets
#   -v <install>/groups:/app/groups  registered group state
#   --env-file <install>/.env        channel + API credentials
#
# The image bakes what `pan instance up` builds on servers today: full
# dependency install (not --prod; parity with the proven server contract)
# plus `pnpm run build`.

FROM node:22-slim

# docker CLI only (no daemon) to drive the mounted socket; git for repo ops.
# bookworm matches node:22-slim's Debian base.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/*

# Pin pnpm to the repo's packageManager version via corepack.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Dependency layer first so source edits don't bust the install cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
