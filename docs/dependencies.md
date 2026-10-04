# Dependency inventory and security updates

Measured October 4, 2026 for 0.18.3 Alpha. This is a lockfile snapshot, not a
promise that future advisories will remain absent. Node is 24.21.0, pnpm 11.3.0.

The full and production-filtered pnpm audits went from 16 findings (3 critical,
5 high, 6 moderate, 2 low) to one moderate finding. No audit entries are ignored.
The existing audit remains report-only; this release does not change that policy.

## Direct dependencies

Versions are installed resolutions, not the ranges in package.json.

| Package                        | Before   | After    | Use               |
| ------------------------------ | -------- | -------- | ----------------- |
| `@aws-sdk/client-s3`           | 3.1138.0 | 3.1138.0 | Application       |
| `@better-auth/oauth-provider`  | 1.7.7    | 1.7.7    | Application       |
| `@modelcontextprotocol/sdk`    | 1.32.0   | 1.32.0   | Application       |
| `@openrouter/ai-sdk-provider`  | 3.1.0    | 3.1.0    | Application       |
| `ai`                           | 7.0.123  | 7.0.123  | Application       |
| `better-auth`                  | 1.7.7    | 1.7.7    | Application       |
| `drizzle-orm`                  | 0.45.2   | 0.45.2   | Application       |
| `postgres`                     | 3.4.9    | 3.4.9    | Application       |
| `sharp`                        | 0.35.5   | 0.35.5   | Application       |
| `zod`                          | 4.6.5    | 4.6.5    | Application       |
| `@sveltejs/adapter-node`       | 5.5.4    | 5.5.4    | Development/build |
| `@sveltejs/kit`                | 2.70.3   | 2.70.3   | Development/build |
| `@sveltejs/vite-plugin-svelte` | 7.1.1    | 7.1.1    | Development/build |
| `@tailwindcss/vite`            | 4.2.4    | 4.2.4    | Development/build |
| `@types/node`                  | 25.6.0   | 25.6.0   | Development/build |
| `@vitest/browser-playwright`   | 4.1.5    | 4.1.11   | Development/build |
| `dotenv`                       | 17.4.2   | 17.4.2   | Development/build |
| `drizzle-kit`                  | 0.31.10  | 0.31.10  | Development/build |
| `node`                         | 24.21.0  | 24.21.0  | Development/build |
| `playwright`                   | 1.59.1   | 1.59.1   | Development/build |
| `prettier`                     | 3.8.3    | 3.8.3    | Development/build |
| `prettier-plugin-svelte`       | 3.5.1    | 3.5.1    | Development/build |
| `prettier-plugin-tailwindcss`  | 0.7.4    | 0.7.4    | Development/build |
| `svelte`                       | 5.55.10  | 5.55.10  | Development/build |
| `svelte-check`                 | 4.4.8    | 4.4.8    | Development/build |
| `tailwindcss`                  | 4.2.4    | 4.2.4    | Development/build |
| `tsx`                          | 4.21.0   | 4.23.15  | Development/build |
| `typescript`                   | 6.0.3    | 6.0.3    | Development/build |
| `vite`                         | 8.0.10   | 8.0.16   | Development/build |
| `vitest`                       | 4.1.5    | 4.1.11   | Development/build |
| `vitest-browser-svelte`        | 2.1.1    | 2.1.1    | Development/build |

## Security batch

Vitest and its Playwright provider move from 4.1.5 to 4.1.11 together. Vite
moves from 8.0.10 to the patched 8.0.16 maintenance release. Updating tsx from
4.21.0 to 4.23.15 replaces its affected esbuild. The lockfile also resolves
patched ws, PostCSS and Nano ID dependencies. Playwright stays at 1.59.1,
matching the CI browser image. Framework/compiler major migrations are separate.

Kit 2.70.3 still requests cookie 0.6.x. A scoped pnpm override selects cookie
0.7.2 only for that exact Kit version. Its stricter serialization refuses an
injected cookie path; normal encoded values and Secure/HttpOnly/SameSite options
retain their behavior. Remove the override when the supported Kit version itself
requests a patched cookie. The full auth/browser gate checks actual app behavior.

## Remaining moderate advisory

[GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99)
affects esbuild's development HTTP server. The remaining 0.18.20 installation
comes through drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils.
This loader uses esbuild to transform code; DocLifts does not start its serve API.
The application starts adapter-node and the database CLI is operator-only.
This is a reachability assessment, not a fix or a claim that the package is safe
for arbitrary use. Do not expose an esbuild serve process or Drizzle Studio.

The newer drizzle-kit 0.31.11 still declares the deprecated loader. Forcing
esbuild across its 0.x compatibility boundary just to remove this entry is
outside this batch. Revisit when Drizzle removes/replaces the loader or before
changing how database tools are run. Better Auth's optional peers mean this path
can appear in the production graph too; do not classify solely by package name.

## Validation

Frozen installation, the full local gate (1,102 passing tests and two expected
private-data skips), exact-head CI and Docker/native-image checks passed. The
live d76b226 container was inspected for the patched versions. Public automation
checks passed, including login, saved workout data, MCP's authentication challenge
and rejection of a session cookie after logout. Owner phone/agent acceptance is
separate; see docs/release-0.2.0.md.
