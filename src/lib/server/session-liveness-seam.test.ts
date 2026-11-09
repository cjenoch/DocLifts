/**
 * Login-session liveness has one spelling: `sessionIsLive()` in
 * `src/lib/server/session-liveness.ts`.
 *
 * Made mechanical: no file under src/ or scripts/ outside the allowlist may
 * name `authSessions.expiresAt` (a comparison, in Drizzle or interpolated into
 * SQL), or compare `auth.session`'s `expires_at` in raw SQL. MCP access and
 * refresh, the export and the deletion request all decide "is this session
 * live" through the helper; a second spelling is how they drift apart.
 */
import { describe, expect, it } from 'vitest';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

const ROOTS = ['src', 'scripts'];

/** Structural exemptions only. A single expression is exempted by `ALLOW_MARKER`. */
const ALLOWLIST: Record<string, string> = {
	'src/lib/server/session-liveness.ts': 'defines sessionIsLive',
	'src/lib/server/db/schema.ts': 'table definitions',
	'src/lib/server/db/auth-schema.ts': 'table definitions'
};

/**
 * `// session-liveness-seam: allow — <reason>` (or `-- …` inside SQL) on the line
 * immediately above a match exempts that match only. A marker with no reason
 * after the dash is not honoured.
 */
export const ALLOW_MARKER = /^\s*(\/\/|--)\s*session-liveness-seam:\s*allow\s*—\s*\S/;

/** Tests set up and assert raw rows. */
const ALLOWED_SUFFIX = /\.(test|db\.test|spec)\.ts$/;

export const PATTERNS: RegExp[] = [
	// gt(authSessions.expiresAt, now), lte(s.authSessions.expiresAt, …), sql`${authSessions.expiresAt} > now()`.
	/\bauthSessions\s*\.\s*expiresAt\b/,
	// Raw SQL on the table: `FROM auth.session WHERE … expires_at > now()`, within one statement.
	/\bauth\.["]?session["]?(?![\w.])[^`;]{0,300}?\bexpires_at\b/i
];

function* sourceFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* sourceFiles(path);
		else if (/\.(ts|js|mjs|cjs|svelte)$/.test(name)) yield path;
	}
}

/** 1-based start lines of every match, scanning the file whole; a marked match is skipped. */
export function offendingLines(content: string): number[] {
	const lines = content.split('\n');
	const found = new Set<number>();
	for (const pattern of PATTERNS) {
		const global = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
		for (const match of content.matchAll(global)) {
			const line = content.slice(0, match.index).split('\n').length;
			if (line > 1 && ALLOW_MARKER.test(lines[line - 2])) continue;
			found.add(line);
		}
	}
	return [...found].sort((a, b) => a - b);
}

export function livenessOffenders(roots: string[] = ROOTS, base: string = '.'): string[] {
	const offenders: string[] = [];
	for (const root of roots) {
		for (const file of sourceFiles(root)) {
			const rel = relative(base, file).split(sep).join('/');
			if (rel in ALLOWLIST || ALLOWED_SUFFIX.test(rel)) continue;
			for (const line of offendingLines(readFileSync(file, 'utf8')))
				offenders.push(`${rel}:${line}`);
		}
	}
	return offenders;
}

describe('the session-liveness seam', () => {
	it('recognises a raw session-expiry check when it sees one', () => {
		// Positive first: a pattern that matches nothing would pass the real check.
		expect(offendingLines('gt(s.authSessions.expiresAt, now)')).toEqual([1]);
		expect(offendingLines('and(\n\tgt(\n\t\tauthSessions\n\t\t\t.expiresAt, now))')).toEqual([3]);
		expect(offendingLines('sql`${authSessions.expiresAt} > now()`')).toEqual([1]);
		expect(
			offendingLines('sql`SELECT 1 FROM auth.session a\n WHERE a.expires_at > now()`')
		).toEqual([1]);
		expect(offendingLines('sql`select 1 from auth."session" where expires_at > now()`')).toEqual([
			1
		]);
		// Not a session expiry: other tables, the helper itself.
		expect(offendingLines('gt(oauthAccessToken.expiresAt, now)')).toEqual([]);
		expect(offendingLines('sessionIsLive(now)')).toEqual([]);
		expect(offendingLines('sql`FROM auth.session_token WHERE expires_at > now()`')).toEqual([]);
		expect(
			offendingLines('sql`DELETE FROM auth.session WHERE user_id = $1`; sql`expires_at`')
		).toEqual([]);
	});

	it('honours a line marker with a reason, for the next line only', () => {
		const marked =
			'// session-liveness-seam: allow — fixture\nconst a = authSessions.expiresAt;\nconst b = authSessions.expiresAt;';
		expect(offendingLines(marked)).toEqual([3]);
		const noReason = '// session-liveness-seam: allow —\nconst a = authSessions.expiresAt;';
		expect(offendingLines(noReason)).toEqual([2]);
	});

	it('reports a planted violation by file and line, and skips the helper and tests', () => {
		const base = mkdtempSync(join(tmpdir(), 'session-liveness-seam-'));
		const root = join(base, 'src', 'lib', 'server');
		mkdirSync(root, { recursive: true });
		writeFileSync(
			join(root, 'planted.ts'),
			"import { gt } from 'drizzle-orm';\nexport const live = gt(authSessions.expiresAt, new Date());\n"
		);
		writeFileSync(join(root, 'session-liveness.ts'), 'gt(authSessions.expiresAt, now);\n');
		writeFileSync(join(root, 'planted.test.ts'), 'gt(authSessions.expiresAt, now);\n');
		expect(livenessOffenders([join(base, 'src')], base)).toEqual(['src/lib/server/planted.ts:2']);
	});

	it('finds the helper spelling it in session-liveness.ts', () => {
		expect(offendingLines(readFileSync('src/lib/server/session-liveness.ts', 'utf8'))).not.toEqual(
			[]
		);
	});

	it('finds no session-expiry check anywhere else in src or scripts', () => {
		expect(livenessOffenders()).toEqual([]);
	});
});
