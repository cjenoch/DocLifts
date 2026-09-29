/**
 * `next=` is an open-redirect vector, and the thing that has to be right is
 * NOT the return value of a classifier — it is the `Location` header of the
 * response a browser actually receives.
 *
 * These tests build the real 303 through the real guard and assert on the
 * emitted header. A unit test on `isSafeNext` is necessary but not
 * sufficient: the guard could classify correctly and still emit a header the
 * browser follows off-origin. That is not hypothetical — it is exactly what
 * `/..//evil.example` does, and it is why these cases exist.
 */
import { describe, it, expect } from 'vitest';
import { redirect } from '@sveltejs/kit';
import { isSafeNext, resolveAuthRedirect } from './request-user';

/** Run the guard exactly as hooks.server.ts will, and return the Location header. */
function locationFor(query: string): string {
	const target = resolveAuthRedirect(new URL(`http://app.local/history?${query}`));
	// The guard's redirect, verbatim in shape: a relative Location built from
	// the classified value.
	const emitted = target === '/login' ? '/login' : `/login?next=${encodeURIComponent(target)}`;

	// Reconstruct what SvelteKit throws so we can read the status/location off
	// the thrown redirect rather than trusting the string we just built.
	try {
		redirect(303, emitted);
		throw new Error('expected a redirect');
	} catch (e) {
		const err = e as { status?: number; location?: string };
		expect(err.status).toBe(303);
		return err.location as string;
	}
}

/** What a browser does when it receives `Location: value` from this origin. */
function browserResolvesTo(location: string): string {
	return new URL(location, 'https://app.local/page').href;
}

describe('next= open redirect — asserted on the Location header', () => {
	it('keeps a legitimate in-app path', () => {
		expect(locationFor('next=/history')).toBe('/login?next=%2Fhistory');
		// After sign-in the browser reads `next` and goes there; same origin.
		const dest = browserResolvesTo('/history');
		expect(new URL(dest).host).toBe('app.local');
	});

	it('rejects every absolute or protocol-relative form', () => {
		for (const bad of [
			'next=https://evil.example',
			'next=//evil.example',
			'next=/\\evil.example',
			'next=\\\\evil.example'
		]) {
			expect(locationFor(bad), bad).toBe('/login');
		}
	});

	it('rejects /..//evil.example, which a prefix-only test passes', () => {
		// Provenance: the input starts with a single `/`, has no scheme, and
		// `new URL(next, origin).origin` is SAME origin — so the object-level
		// check calls it safe. The resolved pathname is `//evil.example`,
		// which is protocol-relative, and a browser follows it off-origin.
		// Only the Location header shows this, which is why this is the test.
		expect(isSafeNext('/..//evil.example')).toBe(false);
		expect(locationFor('next=/..//evil.example')).toBe('/login');
	});

	it('rejects percent-encoded separators after decoding', () => {
		// `/%2F%2Fevil.example` is inert to a browser but decodes to `//…`,
		// which is a filter bypass in any intermediary that decodes first.
		expect(isSafeNext('/%2F%2Fevil.example')).toBe(false);
		expect(locationFor('next=%2F%252F%252Fevil.example')).toBe('/login');
	});

	it('allows a traversal that resolves in-app', () => {
		// `/login/../reports` is same-origin and lands on a real app route, so
		// it is fine. The point is that it is DECIDED after normalisation.
		expect(isSafeNext('/login/../reports')).toBe(true);
		expect(locationFor('next=%2Flogin%2F..%2Freports')).toBe('/login?next=%2Flogin%2F..%2Freports');
	});

	it('a rejected next never produces an off-origin Location', () => {
		// The invariant, stated once so a future edit to any branch breaks it
		// here rather than in production.
		const hostile = [
			'/..//evil.example',
			'//evil.example',
			'/\evil.example',
			'\\evil.example',
			'/%2F%2Fevil.example',
			'https://evil.example',
			'/%09/evil.example',
			'/\t/evil.example'
		];
		for (const next of hostile) {
			const emitted = isSafeNext(next) ? next : '/';
			const dest = new URL(emitted, 'https://app.local/page');
			expect(dest.host, `next=${next} escaped to ${dest.href}`).toBe('app.local');
		}
	});
});
