# Dependency inventory and security updates

Measured October 4, 2026 for 0.18.3 Alpha. This is a lockfile snapshot, not a
promise that future advisories will remain absent. The current Node pin is 24.22.1
(updated October 24, 2026); pnpm remains 11.3.0.

The full and production-filtered pnpm audits went from 16 findings (3 critical,
5 high, 6 moderate, 2 low) to one moderate finding. No audit entries are ignored.
The existing audit remains report-only; this release does not change that policy.

## Node security patch

Node 24.22.1 includes the Brotli decoder fix for CVE-2026-111497, described in the
[Node release notes](https://nodejs.org/en/blog/release/v24.22.1) and
[October security advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
The project-managed development runtime, CI pin and both Alpine Docker stages
use that exact patch release. The lockfile records pnpm-generated runtime URLs
and integrity metadata. Application package resolutions are unchanged by this
runtime patch; the earlier audit counts below have not been remeasured here.

## Cloudflare Tunnel certificate update

The connector image is pinned to cloudflared **2026.10.4** and its multi-platform
manifest digest (October 26, 2026), replacing 2026.9.3. This exceeds the
2026.10.2 minimum in Cloudflare's
[eMudhra certificate compromise advisory](https://blog.cloudflare.com/emudhra-certificate-compromise/).
Cloudflare reported no identified active exploitation on its services at the
time of that advisory. The [2026.10.4 release](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.4)
also restricts debug endpoints on the metrics server.

Pull and recreate every connector using the patched image; restarting an old
container does not install the fix. Check other hosts and disconnected replicas
before bringing them back online. See the [rolling upgrade procedure](public-address.md#connector-security-updates).
This connector update does not change the application release or the package
audit counts below.

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
| `node`                         | 24.21.0  | 24.22.1  | Development/build |
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

## SvelteKit advisory review — October 26, 2026

GitHub reports two low-severity advisories against the locked Kit 2.70.3;
both list 3.0.0 as the first patched version. This review adds an upstream
workaround without changing the framework major or the owner's report-only
dependency-audit policy. The dependency alerts remain open until an upgrade
removes the affected version; mitigation is not a package-level patch.

- [GHSA-pfhg-q3qv-9q6r](https://github.com/sveltejs/kit/security/advisories/GHSA-pfhg-q3qv-9q6r):
  enhanced forms can navigate off-origin when an action route accepts a pathname
  beginning with `//`. DocLifts uses enhanced forms but has no rest/catch-all
  routes. As defense in depth, `actionPathBoundary` rejects those parsed paths
  with HTTP 400 before Better Auth, the session guard, or page actions. This is
  the maintainer's documented workaround. The served-build regression checks
  GET and action POST refusals, absence of a redirect, no-store headers, and an
  ordinary login page that still succeeds. No exploit against production was
  attempted and no exploitable DocLifts route was established.
- [GHSA-27mw-82g8-phjj](https://github.com/sveltejs/kit/security/advisories/GHSA-27mw-82g8-phjj):
  untrusted `cache-control` values passed to `setHeaders` can inject HTML into
  prerendered pages. Current application routes do not enable prerendering,
  and their cache policies are fixed literals. Neither prerequisite exists in
  the reviewed source, so this lead is not applicable to the current route set.
  Reassess before adding prerendering or forwarding upstream/user-supplied cache
  headers. This conclusion does not make Kit 2.x generally unaffected.

The review covers the current `src/routes`, `src/hooks.server.ts`,
`svelte.config.js`, and frozen dependency lockfile. A future Kit 3 migration
requires its own compatibility review and full local/branch gates.

## Validation

Frozen installation, the full local gate (1,102 passing tests and two expected
private-data skips), exact-head CI and Docker/native-image checks passed. The
live d76b226 container was inspected for the patched versions. Public automation
checks passed, including login, saved workout data, MCP's authentication challenge
and rejection of a session cookie after logout. Owner phone/agent acceptance is
separate; see docs/release-0.2.0.md.
