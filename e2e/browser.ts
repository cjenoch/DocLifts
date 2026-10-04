import { existsSync } from 'node:fs';
import { describe } from 'vitest';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { BUILD_ENTRY } from '$lib/server/test-auth-helpers';

/** One prerequisite policy for every browser suite; CI must never silently skip. */
export function browserSuite() {
	const candidate = process.env.PW_EXECUTABLE_PATH ?? chromium.executablePath();
	const executablePath = existsSync(candidate) ? candidate : undefined;
	const missing = [
		...(existsSync(BUILD_ENTRY) ? [] : [BUILD_ENTRY + ' (run pnpm build)']),
		...(executablePath ? [] : ['a Chromium for Playwright'])
	];
	if (missing.length && process.env.CI) {
		throw new Error('e2e prerequisites missing in CI: ' + missing.join('; '));
	}
	if (missing.length) console.warn('[e2e] skipped — missing ' + missing.join('; '));
	return { run: missing.length ? describe.skip : describe, executablePath };
}

declare global {
	interface Window {
		__cspViolations: string[];
	}
}

/** Install before navigation, including on logged-out pages. */
export async function watchCsp(page: Page) {
	await page.addInitScript(() => {
		window.__cspViolations = [];
		document.addEventListener('securitypolicyviolation', (event) => {
			window.__cspViolations.push(
				(
					event.violatedDirective +
					' blocked ' +
					(event.blockedURI || 'inline') +
					': ' +
					(event.sample || '')
				).trim()
			);
		});
	});
}

/** Fresh browser context per page; closing the page also closes its context. */
export async function authenticatedPage(
	browser: Browser,
	cookie: string,
	options: BrowserContextOptions = {}
): Promise<Page> {
	const page = await browser.newPage(options);
	try {
		// Split once: the encoded signature can itself contain '='.
		const at = cookie.indexOf('=');
		if (at <= 0) throw new Error('Missing test session cookie');
		await page.context().addCookies([
			{
				name: cookie.slice(0, at),
				value: decodeURIComponent(cookie.slice(at + 1)),
				domain: '127.0.0.1',
				path: '/'
			}
		]);
		await watchCsp(page);
		return page;
	} catch (error) {
		await page.close();
		throw error;
	}
}

/**
 * The framework announcer is the sole tolerated inline-style artifact.
 * Pair event filtering with DOM inspection so app style attributes still fail.
 */
export async function auditCsp(page: Page) {
	const { raw, styled } = await page.evaluate(() => ({
		raw: window.__cspViolations,
		styled: [...document.querySelectorAll('[style]')].map((el) => el.id || el.tagName.toLowerCase())
	}));
	if (!Array.isArray(raw)) throw new Error('CSP observer was not installed before navigation');
	return {
		violations: raw.filter((value) => !value.startsWith('style-src-attr ')),
		appStyledElements: styled.filter((id) => id !== 'svelte-announcer')
	};
}

export async function violations(page: Page) {
	const result = await auditCsp(page);
	return [
		...result.violations,
		...result.appStyledElements.map((id) => 'app style attribute: ' + id)
	];
}
