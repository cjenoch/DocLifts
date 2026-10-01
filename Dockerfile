# DocLifts — multi-stage build (SvelteKit adapter-node)
# Builder: resolve deps + `vite build` -> emits ./build (immutable node artifact)
FROM node:24-alpine AS builder
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

# Runtime: slim node + adapter-node output + production deps.
# The adapter-node build does NOT vendor third-party imports (drizzle-orm,
# postgres) — the server resolves them from node_modules at runtime, so the
# runtime image must carry the production dependency graph, not just ./build.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

# Install ONLY production deps (frozen lockfile) for the runtime layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate \
    && pnpm install --prod --frozen-lockfile

# sharp (0.4.0 photos) is native. pnpm installs the prebuilt binary for the
# platform it runs on, so this alpine stage gets @img/sharp-linuxmusl-<arch>,
# not the glibc one a dev machine has. Prove it loads HERE, at build time: a
# missing or wrong-libc binary otherwise surfaces only on the first upload.
RUN node -e "const s = require('sharp'); console.log('sharp', s.versions.sharp, 'libvips', s.versions.vips)"

# Adapter-node output (build/) next to node_modules so imports resolve.
COPY --from=builder /app/build ./build
WORKDIR /app/build
EXPOSE 3000
CMD ["node", "."]