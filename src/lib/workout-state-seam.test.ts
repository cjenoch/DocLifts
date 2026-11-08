/**
 * Workout state has one vocabulary: `$lib/workout-state` (sessionPhase,
 * setStatus, workoutCapabilities) and `$lib/server/workout-state-sql`
 * (sessionIs, setIs, historyFilter).
 *
 * Made mechanical: no file under src/ outside the allowlist may spell a session
 * phase or a set's touched/completed state by hand, in Drizzle, in raw SQL, or
 * as a boolean read of `endedAt` / `deletedAt` in a component.
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

const ROOT = 'src';

const ALLOWLIST: Record<string, string> = {
	// The vocabulary itself.
	'src/lib/workout-state.ts': 'defines sessionPhase / setStatus',
	// The SQL spelling of the vocabulary.
	'src/lib/server/workout-state-sql.ts': 'defines sessionIs / setIs / historyFilter',
	// Column and CHECK definitions name the columns.
	'src/lib/server/db/schema.ts': 'table definitions and CHECK constraints',
	// This file quotes the patterns as test cases.
	'src/lib/workout-state-seam.test.ts': 'quotes the forbidden patterns',
	// Its own seam; listed so a future quoted example cannot trip this one.
	'src/lib/server/llm-seam.test.ts': 'another seam test',
	// Owner decision §5.3 pending: Strong CSV keeps `reps > 0`.
	'src/lib/server/exports/formats.ts': 'owner decision §5.3 pending',
	// Owner decision §5.1 pending: a notes-only set is not "saved" for templating.
	'src/lib/server/workout-to-program.ts': 'owner decision §5.1 pending',
	// Test fixtures write raw rows.
	'src/lib/server/exports/test-fixtures.ts': 'test fixtures write raw rows'
};

/** Tests legitimately write and assert raw rows. */
const ALLOWED_SUFFIX = /\.(test|db\.test|spec)\.ts$/;

/** Patterns forbidden in every scanned file. */
export const ANY_FILE_PATTERNS: RegExp[] = [
	// isNull(sessions.endedAt), isNotNull(s.deletedAt), ...
	// (`isNot?Null` would not match `isNull`: the `?` binds only to the `t`.)
	/is(Not)?Null\(\w+\.(endedAt|deletedAt)\)/,
	// `... ended_at IS NOT NULL ...` in raw SQL.
	/(ended_at|deleted_at)\s+IS\s+(NOT\s+)?NULL/,
	// Inline touched / completed chains.
	/executedLoad\s*!==?\s*null\s*(\|\||&&)/
];

/** Boolean reads of a session timestamp in a component. */
export const SVELTE_PATTERNS: RegExp[] = [
	/(\{#if\s+!?[^}]*\.(endedAt|deletedAt)\b|!\w+(\.\w+)*\.(endedAt|deletedAt)\b|\.(endedAt|deletedAt)\s*[!=]==?\s*null)/
];

function* sourceFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) yield* sourceFiles(path);
		else if (/\.(ts|js|mjs|cjs|svelte)$/.test(name)) yield path;
	}
}

function isAllowed(rel: string): boolean {
	return rel in ALLOWLIST || ALLOWED_SUFFIX.test(rel);
}

/**
 * Every `file:line` under `root` (outside the allowlist) that spells workout
 * state by hand. Paths are relative to `base` with forward slashes.
 */
export function workoutStateOffenders(root: string = ROOT, base: string = '.'): string[] {
	const offenders: string[] = [];
	for (const file of sourceFiles(root)) {
		const rel = relative(base, file).split(sep).join('/');
		if (isAllowed(rel)) continue;
		const patterns = file.endsWith('.svelte')
			? [...ANY_FILE_PATTERNS, ...SVELTE_PATTERNS]
			: ANY_FILE_PATTERNS;
		readFileSync(file, 'utf8')
			.split('\n')
			.forEach((line, i) => {
				if (patterns.some((p) => p.test(line))) offenders.push(`${rel}:${i + 1}`);
			});
	}
	return offenders;
}

describe('the workout-state seam', () => {
	it('recognises a raw state predicate when it sees one', () => {
		// Positive first: a pattern that matches nothing would pass the real check.
		const any = (s: string) => ANY_FILE_PATTERNS.some((p) => p.test(s));
		const svelte = (s: string) => SVELTE_PATTERNS.some((p) => p.test(s));
		expect(any('.where(isNull(sessions.endedAt))')).toBe(true);
		expect(any('isNotNull(s.deletedAt)')).toBe(true);
		expect(any('isNull(sess.deletedAt)')).toBe(true);
		expect(any('sql`and ended_at IS NOT NULL`')).toBe(true);
		expect(any("'WHERE deleted_at IS NULL'")).toBe(true);
		expect(any('set.executedLoad !== null || set.executedReps !== null')).toBe(true);
		expect(any('s.executedLoad != null && s.executedReps != null')).toBe(true);
		expect(svelte('{#if data.session.endedAt}')).toBe(true);
		expect(svelte('{#if !session.deletedAt}')).toBe(true);
		expect(svelte('disabled={!data.session.endedAt}')).toBe(true);
		expect(svelte('const open = session.endedAt === null;')).toBe(true);
		expect(svelte('session.deletedAt != null')).toBe(true);

		expect(any('.where(sessionIs.open())')).toBe(false);
		expect(any('isNull(sets.executedLoad)')).toBe(false);
		expect(svelte('{formatDate(session.endedAt)}')).toBe(false);
		expect(svelte('{#if data.capabilities.canFinish}')).toBe(false);
	});

	it('reports an offending .svelte and .ts file with line numbers', () => {
		const base = mkdtempSync(join(tmpdir(), 'workout-state-seam-'));
		const root = join(base, 'src');
		mkdirSync(join(root, 'routes'), { recursive: true });
		writeFileSync(
			join(root, 'routes', 'Page.svelte'),
			'<script lang="ts">\n\tlet { data } = $props();\n</script>\n\n{#if data.session.endedAt}\n\t<p>Done</p>\n{/if}\n'
		);
		writeFileSync(
			join(root, 'query.ts'),
			"import { isNull } from 'drizzle-orm';\n\nexport const w = isNull(sessions.endedAt);\n"
		);
		writeFileSync(join(root, 'clean.ts'), 'export const w = sessionIs.open();\n');

		expect(workoutStateOffenders(root, base).sort()).toEqual([
			'src/query.ts:3',
			'src/routes/Page.svelte:5'
		]);
	});

	it('finds no raw workout-state predicate anywhere else in src', () => {
		const offenders = workoutStateOffenders();
		expect(offenders, `offenders (${offenders.length}):\n${offenders.join('\n')}`).toEqual([]);
	});
});
