/**
 * CLAUDE.md: no provider SDK is called anywhere except through `complete()`.
 *
 * Made mechanical: no file outside src/lib/server/llm/ may import `ai`, an
 * `ai/*` subpath, an `@ai-sdk/*` package, or `@openrouter/*`. A new feature
 * that wants a model calls `complete()`; it does not get its own client.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['src', 'scripts', 'e2e'];
const SEAM = join('src', 'lib', 'server', 'llm') + '/';
// This file quotes SDK import lines as test cases; it imports nothing from them.
const SELF = join('src', 'lib', 'server', 'llm-seam.test.ts');
const SDK_IMPORT =
	/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](?:ai|ai\/[^'"]*|@ai-sdk\/[^'"]*|@openrouter\/[^'"]*)['"]/;

function* sourceFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* sourceFiles(path);
		else if (/\.(ts|js|mjs|cjs|svelte)$/.test(name)) yield path;
	}
}

function sdkImportersOutsideSeam(roots: string[] = ROOTS): string[] {
	const offenders: string[] = [];
	for (const root of roots) {
		for (const file of sourceFiles(root)) {
			const rel = relative('.', file);
			if (rel.startsWith(SEAM) || rel === SELF) continue;
			if (SDK_IMPORT.test(readFileSync(file, 'utf8'))) offenders.push(rel);
		}
	}
	return offenders;
}

describe('the LLM seam', () => {
	it('recognises an SDK import when it sees one', () => {
		// Positive first: a pattern that matches nothing would pass the real check.
		expect(SDK_IMPORT.test(`import { generateText } from 'ai';`)).toBe(true);
		expect(SDK_IMPORT.test(`import { MockLanguageModelV4 } from 'ai/test';`)).toBe(true);
		expect(SDK_IMPORT.test(`const m = await import("@openrouter/ai-sdk-provider")`)).toBe(true);
		expect(SDK_IMPORT.test(`import x from '@ai-sdk/anthropic';`)).toBe(true);
		expect(SDK_IMPORT.test(`import { complete } from '$lib/server/llm';`)).toBe(false);
		expect(SDK_IMPORT.test(`import { aim } from 'aim';`)).toBe(false);
	});

	it('finds the SDK imported inside src/lib/server/llm/', () => {
		const inside = [...sourceFiles(SEAM)].filter((f) => SDK_IMPORT.test(readFileSync(f, 'utf8')));
		expect(inside.length).toBeGreaterThan(0);
	});

	it('finds no SDK import anywhere else in src, scripts or e2e', () => {
		expect(sdkImportersOutsideSeam()).toEqual([]);
	});
});
