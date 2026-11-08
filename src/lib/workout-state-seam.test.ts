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

/**
 * Structural exemptions only: the vocabulary modules, the schema, the seam
 * tests and fixtures. A file is never exempted for one predicate it keeps;
 * that is the line marker's job (`ALLOW_MARKER`), so the rest of the file
 * stays scanned.
 */
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
	// Test fixtures write raw rows.
	'src/lib/server/exports/test-fixtures.ts': 'test fixtures write raw rows'
};

/**
 * `// workout-state-seam: allow — <reason>` on the line immediately above a
 * match exempts that match only (its start line must be the next line). The
 * reason is required: a marker with nothing after the dash is not honoured.
 * Inside a SQL template the same marker is a SQL comment, `-- workout-state-seam: ...`.
 */
export const ALLOW_MARKER = /^\s*(\/\/|--)\s*workout-state-seam:\s*allow\s*—\s*\S/;

/** Tests legitimately write and assert raw rows. */
const ALLOWED_SUFFIX = /\.(test|db\.test|spec)\.ts$/;

/** Patterns forbidden in every scanned file. SQL keywords match in any case. */
export const ANY_FILE_PATTERNS: RegExp[] = [
	// isNull(sessions.endedAt), isNotNull(s.deletedAt), isNull(\n\tsessions.endedAt\n)...
	// (`isNot?Null` would not match `isNull`: the `?` binds only to the `t`.)
	/is(Not)?Null\(\s*\w+\.(endedAt|deletedAt)\s*\)/,
	// The same through a namespace import: isNull(s.sessions.deletedAt).
	/is(Not)?Null\(\s*\w+(\.\w+)+\.(endedAt|deletedAt)\s*\)/,
	// Set side in Drizzle: isNotNull(sets.executedLoad), isNull(s.sets.executedReps).
	/is(Not)?Null\(\s*\w+(\.\w+)*\.executed(Load|Reps)\s*\)/,
	// `... ended_at IS NOT NULL ...` / `deleted_at is null` in raw SQL.
	/(ended_at|deleted_at)\s+is\s+(not\s+)?null/i,
	// The same with an interpolated column: sql`${sessions.endedAt} is not null`.
	/\$\{\s*\w+(\.\w+)*\.(endedAt|deletedAt)\s*\}\s+is\s+(not\s+)?null/i,
	// Set side in raw SQL: `executed_load is not null and executed_reps is not null`.
	/executed_(load|reps)\s+is\s+(not\s+)?null/i,
	// Set side with an interpolated column: sql`${sets.executedLoad} is not null`.
	/\$\{\s*\w+(\.\w+)*\.executed(Load|Reps)\s*\}\s+is\s+(not\s+)?null/i,
	// Inline touched / completed chains, either column first, any operator.
	/executed(Load|Reps)\s*[!=]==?\s*null\s*(\|\||&&)/
];

/**
 * Boolean reads of a session timestamp, in `.ts` and `.svelte` alike. Passing
 * the column as a value (a select projection, a date to format, a method call
 * on it) is not a read of the phase and must not match.
 */
export const STATE_READ_PATTERNS: RegExp[] = [
	// Negated: !session.endedAt, ! s.deletedAt.
	/!\s*\w+(\.\w+)*\.(endedAt|deletedAt)\b/,
	// Ternary on the column: s.endedAt ? a : b (not `?.` or `??`).
	/\.(endedAt|deletedAt)\s*\?(?![.?])/,
	// Truthy operand: if (s.endedAt), a && s.deletedAt, x || s.endedAt ? ...
	/(\|\||&&|if\s*\(|\?\s*)\s*\w+(\.\w+)*\.(endedAt|deletedAt)\s*(\)|&&|\|\||\?|:)/,
	// Compared with null: session.endedAt === null, s.deletedAt != null.
	/\.(endedAt|deletedAt)\s*[!=]==?\s*null/
];

/** Svelte-only: a template block branching on the column. */
export const SVELTE_PATTERNS: RegExp[] = [/\{#if\s+!?[^}]*\.(endedAt|deletedAt)\b/];

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
 * 1-based line numbers of every match of `patterns` in `content`, scanned as
 * a whole so a predicate split across lines is still one match, reported at
 * the line it starts on. A match whose previous line is an `ALLOW_MARKER`
 * with a reason is skipped.
 */
export function offendingLines(content: string, patterns: RegExp[]): number[] {
	const lines = content.split('\n');
	const found = new Set<number>();
	for (const pattern of patterns) {
		const global = new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g');
		for (const match of content.matchAll(global)) {
			const line = content.slice(0, match.index).split('\n').length;
			if (line > 1 && ALLOW_MARKER.test(lines[line - 2])) continue;
			found.add(line);
		}
	}
	return [...found].sort((a, b) => a - b);
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
			? [...ANY_FILE_PATTERNS, ...STATE_READ_PATTERNS, ...SVELTE_PATTERNS]
			: [...ANY_FILE_PATTERNS, ...STATE_READ_PATTERNS];
		for (const line of offendingLines(readFileSync(file, 'utf8'), patterns)) {
			offenders.push(`${rel}:${line}`);
		}
	}
	return offenders;
}

describe('the workout-state seam', () => {
	it('recognises a raw state predicate when it sees one', () => {
		// Positive first: a pattern that matches nothing would pass the real check.
		const any = (s: string) => ANY_FILE_PATTERNS.some((p) => p.test(s));
		const read = (s: string) => STATE_READ_PATTERNS.some((p) => p.test(s));
		const svelte = (s: string) => read(s) || SVELTE_PATTERNS.some((p) => p.test(s));
		expect(any('.where(isNull(sessions.endedAt))')).toBe(true);
		expect(any('isNotNull(s.deletedAt)')).toBe(true);
		expect(any('isNull(sess.deletedAt)')).toBe(true);
		expect(any('sql`and ended_at IS NOT NULL`')).toBe(true);
		expect(any("'WHERE deleted_at IS NULL'")).toBe(true);
		expect(any('sql`${sessions.endedAt} IS NOT NULL`')).toBe(true);
		expect(any('count(sql`CASE WHEN ${sessions.endedAt} IS NULL THEN 1 END`)')).toBe(true);
		expect(any('isNull(s.sessions.deletedAt)')).toBe(true);
		expect(any('set.executedLoad !== null || set.executedReps !== null')).toBe(true);
		expect(any('s.executedLoad != null && s.executedReps != null')).toBe(true);
		expect(svelte('{#if data.session.endedAt}')).toBe(true);
		expect(svelte('{#if !session.deletedAt}')).toBe(true);
		expect(svelte('disabled={!data.session.endedAt}')).toBe(true);
		expect(svelte('const open = session.endedAt === null;')).toBe(true);
		expect(svelte('session.deletedAt != null')).toBe(true);
		// Lowercase / mixed-case SQL, both sides.
		expect(any('sql`and ended_at is not null`')).toBe(true);
		expect(any("'where deleted_at Is Null'")).toBe(true);
		expect(any('sql`${sessions.endedAt} is null`')).toBe(true);
		expect(any('sql`${s.sessions.deletedAt} Is Not Null`')).toBe(true);
		expect(
			any('count(*) filter (where executed_load is not null and executed_reps is not null)')
		).toBe(true);
		expect(any('sql`${sets.executedLoad} is not null`')).toBe(true);
		// Inline chains: `== null ||`, executedReps first.
		expect(any('s.executedLoad == null || s.executedReps == null')).toBe(true);
		expect(any('s.executedReps !== null && s.executedLoad !== null')).toBe(true);
		// Truthy / ternary reads in a .ts file.
		expect(read('if (s.endedAt) return;')).toBe(true);
		expect(read("const label = row.deletedAt ? 'trashed' : 'live';")).toBe(true);
		expect(read('return !session.endedAt;')).toBe(true);
		expect(read('ok && s.deletedAt && x')).toBe(true);
		// Split across lines (review of PR #61): matched against the whole text.
		expect(any('isNull(\n\tsessions.endedAt\n)')).toBe(true);
		expect(any('r.executedLoad != null\n\t|| r.executedReps != null')).toBe(true);
		expect(any('r.executedLoad\n\t!= null ||\n\tr.executedReps != null')).toBe(true);
		expect(any('sql`${\n\tsessions.deletedAt\n} IS NULL`')).toBe(true);
		// Set side in Drizzle, which had no pattern at all.
		expect(any('and(isNotNull(sets.executedLoad), isNotNull(sets.executedReps))')).toBe(true);
		expect(any('isNull(s.sets.executedReps)')).toBe(true);
		// Single-line control for the split cases above.
		expect(any('.where(isNull(sessions.endedAt))')).toBe(true);

		expect(any('.where(sessionIs.open())')).toBe(false);
		expect(any('isNull(sets.executedLoadUnit)')).toBe(false);
		expect(any('isNull(sets.notes)')).toBe(false);
		expect(any('sql`CASE WHEN ${sessionIs.ended()} THEN 1 END`')).toBe(false);
		expect(any('isNull(s.programs.systemKind)')).toBe(false);
		expect(svelte('{formatDate(session.endedAt)}')).toBe(false);
		expect(svelte('{#if data.capabilities.canFinish}')).toBe(false);
		// Passing the column as a value is not a state read.
		expect(read('.select({ id: sessions.id, endedAt: sessions.endedAt })')).toBe(false);
		expect(svelte('<td>{row.endedAt}</td>')).toBe(false);
		expect(read('const iso = s.endedAt.toISOString();')).toBe(false);
	});

	it('reports a split predicate at the line it starts on', () => {
		const content = [
			"import { and, isNotNull, isNull } from 'drizzle-orm';", // 1
			'export const a = isNull(', // 2
			'\tsessions.endedAt', // 3
			');', // 4
			'export const b = (r: Row) =>', // 5
			'\tr.executedLoad != null', // 6
			'\t|| r.executedReps != null;', // 7
			'export const c = and(isNotNull(sets.executedLoad), isNotNull(sets.executedReps));', // 8
			'export const d = sessionIs.open();' // 9
		].join('\n');
		expect(offendingLines(content, ANY_FILE_PATTERNS)).toEqual([2, 6, 8]);
	});

	it('honours a line marker with a reason, for the next line only', () => {
		// Positive first: unmarked, both predicates are found.
		const bare = ['const x = isNull(sessions.endedAt);', 'const y = isNull(sessions.deletedAt);'];
		expect(offendingLines(bare.join('\n'), ANY_FILE_PATTERNS)).toEqual([1, 2]);

		const marked = [
			'// workout-state-seam: allow \u2014 plan \u00a75.1 pending', // 1
			'const x = isNull(sessions.endedAt);', // 2: exempt
			'const y = isNull(sessions.deletedAt);' // 3: not exempt, two lines below
		].join('\n');
		expect(offendingLines(marked, ANY_FILE_PATTERNS)).toEqual([3]);

		// No reason after the dash: not honoured.
		for (const marker of [
			'// workout-state-seam: allow \u2014',
			'// workout-state-seam: allow \u2014   ',
			'// workout-state-seam: allow'
		]) {
			const content = [marker, 'const x = isNull(sessions.endedAt);'].join('\n');
			expect(offendingLines(content, ANY_FILE_PATTERNS), marker).toEqual([2]);
		}

		// Inside a SQL template the marker is a SQL comment.
		const inSql = [
			'\t\t-- workout-state-seam: allow \u2014 plan \u00a75.2 pending',
			'\t\tAND sets.executed_load IS NOT NULL'
		].join('\n');
		expect(offendingLines(inSql, ANY_FILE_PATTERNS)).toEqual([]);

		// A marker covers a split predicate that starts on the next line.
		const split = [
			'// workout-state-seam: allow \u2014 plan \u00a75.1 pending',
			'const s = (r: Row) => r.executedLoad != null',
			'\t|| r.executedReps != null;'
		].join('\n');
		expect(offendingLines(split, ANY_FILE_PATTERNS)).toEqual([]);
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
