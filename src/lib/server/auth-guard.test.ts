/**
 * The auth guard: the allowlist, the open-redirect check, and the invariant
 * that no page under src/routes/ can ship unguarded.
 *
 * The enumeration test at the bottom is the point of this file. Everything
 * else is a unit test; that one reads the filesystem and would fail the moment
 * someone adds a page without deciding whether it is public.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { isPublicPath, isSafeNext, resolveAuthRedirect } from './request-user';

describe('isPublicPath', () => {
	it('allows the auth pages and the auth API', () => {
		expect(isPublicPath('/login')).toBe(true);
		expect(isPublicPath('/logout')).toBe(true);
		expect(isPublicPath('/signup')).toBe(true);
		expect(isPublicPath('/api/auth')).toBe(true);
		expect(isPublicPath('/api/auth/sign-in/email')).toBe(true);
	});

	it('allows SvelteKit and Vite asset paths', () => {
		expect(isPublicPath('/_app')).toBe(true);
		expect(isPublicPath('/_app/immutable/entry/start.js')).toBe(true);
		expect(isPublicPath('/favicon.svg')).toBe(true);
	});

	it('refuses every application page', () => {
		for (const p of [
			'/',
			'/history',
			'/reports',
			'/programs',
			'/gyms',
			'/gyms/x/machines/x/edit',
			'/equipment',
			'/equipment/1',
			'/equipment/1/edit',
			'/imported-history',
			'/sessions/1',
			'/account/password'
		]) {
			expect(isPublicPath(p), p).toBe(false);
		}
	});

	it('does not treat a lookalike prefix as public', () => {
		// `/loginXYZ` and `/api/authorisation` are not the allowlist entries.
		// A bare `startsWith(prefix)` would let both through.
		expect(isPublicPath('/loginXYZ')).toBe(false);
		expect(isPublicPath('/api/authorisation')).toBe(false);
		expect(isPublicPath('/login/../reports')).toBe(false);
	});
});

describe('isSafeNext', () => {
	it('accepts a same-origin relative path', () => {
		expect(isSafeNext('/history')).toBe(true);
		expect(isSafeNext('/')).toBe(true);
		expect(isSafeNext('/programs/3/edit?tab=2')).toBe(true);
	});

	it('rejects an absolute or protocol-relative URL', () => {
		expect(isSafeNext('https://evil.example')).toBe(false);
		expect(isSafeNext('http://evil.example/x')).toBe(false);
		expect(isSafeNext('//evil.example')).toBe(false);
		expect(isSafeNext('/\\evil.example')).toBe(false);
	});

	it('normalises traversal before deciding', () => {
		// `/login/../reports` is same-origin, so accepting it as a destination
		// is fine — the point is that it is DECIDED after normalisation, not
		// by a raw string prefix.
		expect(isSafeNext('/login/../reports')).toBe(true);
		// These genuinely leave the origin once a browser resolves them.
		expect(isSafeNext('/\\evil.example')).toBe(false);
		expect(isSafeNext('//evil.example')).toBe(false);
		// `/..//evil.example` normalises same-origin as a URL OBJECT, but its
		// resolved pathname is `//evil.example`, which a browser treats as
		// protocol-relative. Rejected. See next-redirect.test.ts, which proves
		// it on the Location header rather than on the classifier.
		expect(isSafeNext('/..//evil.example')).toBe(false);
		expect(isSafeNext('/../..//evil.example')).toBe(false);
	});

	it('rejects anything carrying a scheme, and non-paths', () => {
		expect(isSafeNext('javascript:alert(1)')).toBe(false);
		expect(isSafeNext('data:text/html,x')).toBe(false);
		expect(isSafeNext('history')).toBe(false);
		expect(isSafeNext('')).toBe(false);
		expect(isSafeNext(null)).toBe(false);
		expect(isSafeNext(undefined)).toBe(false);
	});
});

describe('resolveAuthRedirect', () => {
	it('falls back to /login for a hostile next', () => {
		expect(resolveAuthRedirect(new URL('http://app.local/history?next=https://evil.example'))).toBe(
			'/login'
		);
		expect(resolveAuthRedirect(new URL('http://app.local/history?next=//evil.example'))).toBe(
			'/login'
		);
	});

	it('keeps a legitimate next', () => {
		expect(resolveAuthRedirect(new URL('http://app.local/history?next=/history'))).toBe('/history');
	});
});

/**
 * The invariant: every route under src/routes/ is either on the allowlist or
 * guarded by the layout's default redirect. Reads the real directory, so a
 * page added in a later commit without a decision fails HERE rather than in
 * production.
 */
describe('route inventory', () => {
	it('every page route is either public by declaration or guarded by default', () => {
		const root = 'src/routes';
		expect(existsSync(root)).toBe(true);

		// Collect every directory that contains a +page.server.ts or +page.svelte.
		const pages: string[] = [];
		const walk = (dir: string, urlPath: string) => {
			for (const entry of readdirSync(dir)) {
				if (entry.startsWith('.')) continue;
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) {
					const seg = entry.startsWith('[') || entry.startsWith('(') ? 'x' : entry;
					walk(full, `${urlPath}/${seg}`);
				} else if (entry === '+page.server.ts' || entry === '+page.svelte') {
					pages.push(urlPath === '' ? '/' : urlPath);
				}
			}
		};
		walk(root, '');

		// At least the pages we know about, so an empty result from a broken
		// walk cannot pass this test.
		expect(pages).toContain('/');
		expect(pages).toContain('/login');
		expect(pages).toContain('/logout');

		const unguarded = pages.filter((p) => !isPublicPath(p));
		// These are the pages the layout guard covers by default. Listing them
		// is the record: adding a page here is fine (it IS guarded); removing
		// one is fine; forgetting to notice a new one is caught because the
		// inventory test fails only if a page is NEITHER public NOR here.
		// Generated from the real tree on 2026-09-29. `[id]` and layout-only
		// segments are walked as the placeholder `x`.
		const expectedGuarded = new Set([
			'/',
			'/account/password',
			'/equipment',
			'/equipment/x',
			'/equipment/x/edit',
			'/gyms',
			'/gyms/x/machines/x/edit',
			'/history',
			'/imported-history',
			'/programs/new',
			'/programs/x',
			'/programs/x/edit',
			'/reports',
			'/sessions/x'
		]);
		for (const p of unguarded) {
			expect(expectedGuarded.has(p), `route ${p} is not in the expected-guarded set`).toBe(true);
		}
	});
});
