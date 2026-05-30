# TypeScript Migration Task List (DocLifts)

Date: 2026-05-30
Owner: DocLifts
Status: Ready for execution

## Scope

Incrementally move remaining non-generated JavaScript/config surfaces to TypeScript while keeping CI green at every step.

Out of scope:
- `.svelte-kit/**` generated artifacts
- third-party tool internals

## Current baseline

- TypeScript strict mode is enabled (`tsconfig.json` -> `strict: true`)
- App/runtime code is already TypeScript-first (`.ts` + `.svelte`)
- Remaining first-party JS file: `svelte.config.js`

## Plan (small, shippable steps)

### 1) Convert `svelte.config.js` to `svelte.config.ts`
- [ ] Rename file to `svelte.config.ts`
- [ ] Keep existing adapter/csrf/alias config behavior unchanged
- [ ] Ensure exported config is typed (`import type { Config } from '@sveltejs/kit'`)
- [ ] Run `npm run check`, `npm run test`, `npm run build`
- [ ] Commit

### 2) Add explicit typing pass for server helpers (tightening only)
Files:
- `src/lib/server/sessions.ts`
- `src/lib/server/progression.ts`
- `src/lib/server/plates.ts`

- [ ] Add/confirm explicit return types on public exported functions
- [ ] Remove any implicit `any` surfaces
- [ ] Preserve runtime behavior (no logic changes)
- [ ] Run `npm run check`, `npm run test`
- [ ] Commit

### 3) Type boundary hardening for route actions/loaders
Files:
- `src/routes/+page.server.ts`
- `src/routes/programs/[id]/+page.server.ts`
- `src/routes/sessions/[id]/+page.server.ts`

- [ ] Ensure all action payload parsing paths are strongly typed
- [ ] Ensure all `fail(...)` payloads remain serializable and typed
- [ ] Ensure loader/action return contracts are explicit and stable
- [ ] Run `npm run check`, `npm run test`
- [ ] Commit

### 4) Cleanup + guardrails
- [ ] Add short "TS posture" section to README (strict mode, migration policy)
- [ ] Keep generated paths out of manual migration effort (`.svelte-kit/**`)
- [ ] Final verification: `npm run check && npm run test && npm run build`
- [ ] Commit

## Acceptance criteria

- No first-party `.js` config/runtime files remain unless intentionally documented
- CI stays green through each step
- No behavior regressions in session lifecycle or progression flows

## Suggested branch strategy

- Use one PR with 3-4 commits, one per task above
- If any step destabilizes CI, revert only that step and continue from the prior green commit
