/**
 * Every password field gets the reveal toggle (spec §2 item 2) — enforced, not
 * remembered. A raw `type="password"` anywhere outside PasswordInput.svelte is
 * a field without one, so this walks the real source tree and fails by file.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function svelteFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) return svelteFiles(full);
		return entry.endsWith('.svelte') ? [full] : [];
	});
}

describe('password fields', () => {
	it('are all PasswordInput: no raw type="password" anywhere else', () => {
		const files = svelteFiles('src');
		// A broken walk must not pass: these two are known to exist.
		expect(files.some((f) => f.endsWith(join('login', '+page.svelte')))).toBe(true);
		expect(files.some((f) => f.endsWith('PasswordInput.svelte'))).toBe(true);

		const raw = files.filter(
			(f) =>
				!f.endsWith('PasswordInput.svelte') &&
				/type\s*=\s*["']password["']/.test(readFileSync(f, 'utf8'))
		);
		expect(raw, `password fields without the reveal toggle: ${raw.join(', ')}`).toEqual([]);
	});
});
