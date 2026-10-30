# DocLifts — multi-stage build (SvelteKit adapter-node)
# Builder: resolve deps + `vite build` -> emits ./build (immutable node artifact)
FROM node:24.22.2-alpine AS builder
WORKDIR /app

# pnpm corepack (project pins pnpm@11.3.0 via package.json packageManager)
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

# Deps layer first for caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# adapter-node reads the lockfile generation; install with frozen lockfile
RUN pnpm install --frozen-lockfile

# Source
COPY . .

ENV NODE_ENV=production
# SvelteKit's build analyses/imports route modules; db/index.ts throws at import
# if DATABASE_URL is unset. The postgres client is lazy (no connect at this
# point) so a placeholder suffices; the real URL is injected at runtime via
# compose environment. Override with --build-arg if you build standalone.
ARG DATABASE_URL=postgresql://doclifts:***@localhost:5432/doclifts
ENV DATABASE_URL=$DATABASE_URL

# The commit sha, baked into kit.version.name so /_app/version.json identifies
# this build and a client can detect a newer deploy.
#
# It MUST be supplied. The build context is copied without .git, so the
# git-rev-parse fallback in svelte.config.js has nothing to read here and every
# image would report the framework's default 'dev' — a constant, which makes
# stale-build detection silently useless. CI was caught by exactly that: the
# non-vacuous version.json e2e passed locally (a checkout has .git) and failed
# in CI (it does not).
#
# EARNED BY A RED BUILD — do not make this optional.
ARG DOCLIFTS_BUILD_SHA=unknown
ENV DOCLIFTS_BUILD_SHA=$DOCLIFTS_BUILD_SHA
RUN test -n "$DOCLIFTS_BUILD_SHA" || test "$DOCLIFTS_BUILD_SHA" = "unknown" \
  || (echo "DOCLIFTS_BUILD_SHA must be a real sha" >&2; exit 1)
RUN pnpm build

# The privacy scheduler invokes tsx directly; it does not need Corepack's
# root-owned package-manager cache. Keep the builder intact for migration and
# operator scripts that invoke pnpm, and use this stage for scheduled jobs.
FROM builder AS privacy-worker
RUN rm -rf /root/.cache/node/corepack /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

# Runtime: slim node + adapter-node output + production deps.
# The adapter-node build does NOT vendor third-party imports (drizzle-orm,
# postgres) — the server resolves them from node_modules at runtime, so the
# runtime image must carry the production dependency graph, not just ./build.
FROM node:24.22.2-alpine AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

# Install ONLY production deps (frozen lockfile) for the runtime layer.
#
# --chown=node:node on the COPYs into this stage, not only the USER below: the
# runtime user must be able to READ these files. A build context whose umask is
# restrictive (0600) otherwise produces an image only root can read, and the app
# exits before opening its listener with:
#   Error: Cannot read package config /app/package.json: permission denied
# Found by building from a checkout created under `umask 077` and running it as
# `node`; the file mode comes from the build context, not from this Dockerfile.
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate \
    && pnpm install --prod --frozen-lockfile \
    && rm -rf /root/.cache/node/corepack /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx

# sharp (0.4.0 photos) is native. pnpm installs the prebuilt binary for the
# platform it runs on, so this alpine stage gets @img/sharp-linuxmusl-<arch>,
# not the glibc one a dev machine has. Prove it loads HERE, at build time: a
# missing or wrong-libc binary otherwise surfaces only on the first upload.
RUN node -e "const s = require('sharp'); console.log('sharp', s.versions.sharp, 'libvips', s.versions.vips)"

# Adapter-node output (build/) next to node_modules so imports resolve.
COPY --chown=node:node --from=builder /app/build ./build
WORKDIR /app/build

# M3 (2026-10-23): run as the unprivileged `node` user that the base image
# already provides (uid 1000), not as root. Everything above was created by
# root; the files are world-readable (0644/0755) and nothing at runtime writes
# under /app — the server reads ./build and node_modules, and its only writable
# path is the /tmp tmpfs Compose mounts. Verified by running an isolated build
# of this image against a throwaway test database (see the ops-hardening
# handoff: non-root uid, read-only rootfs, cap_drop ALL, no-new-privileges,
# /health 200 and 503, sharp resize under /tmp). The builder/migrator stage
# stays root: it only builds an image.
#
# A new runtime write outside /tmp is a decision to make here (chown a path, or
# mount something writable), not a reason to remove this line.
USER node

EXPOSE 3000
CMD ["node", "."]
