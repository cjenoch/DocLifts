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

# Adapter-node output (build/) next to node_modules so imports resolve.
COPY --from=builder /app/build ./build
WORKDIR /app/build
EXPOSE 3000
CMD ["node", "."]