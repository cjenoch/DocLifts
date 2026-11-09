/**
 * Retired program versions (owner decision, 2026-11-08).
 *
 * Editing a program deep-copies it and marks the source inactive
 * (`duplicateProgramForEditInTransaction`); the copy's `source_program_id`
 * points back at it. `is_active = false` on a user program therefore means
 * "this version was replaced". A retired version is read-only: its page shows
 * no Start or Edit, links to the current version, and `startSessionForDay`
 * refuses a new workout on it. A workout already open on it still resumes.
 *
 * How this is used on a phone: an old bookmark or History's "(archived)" link
 * lands on the retired page, which says it was replaced and offers one tap to
 * the current version.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { programs } from './db/schema';
import type { Database } from './progression';

export type ProgramVersion = { id: string; name: string };

/**
 * The user program's version state, or null when it is not this user's
 * program (another user's, a system program, or absent: D6).
 */
export async function programVersionState(
	db: Database,
	userId: string,
	programId: string
): Promise<{ isActive: boolean } | null> {
	if (!z.string().uuid().safeParse(programId).success) return null;
	const [row] = await db
		.select({ isActive: programs.isActive })
		.from(programs)
		.where(
			and(eq(programs.id, programId), eq(programs.userId, userId), isNull(programs.systemKind))
		);
	return row ?? null;
}

/**
 * The newest active version descended from `programId`, walking the lineage
 * forward through `source_program_id` (v1 → v2 → v3 gives v3). Every step is
 * owner-scoped, so another user's program (or a chain that crosses into one)
 * yields null. Null also when no active successor exists: a successor was
 * deleted (the FK is ON DELETE SET NULL, which breaks the chain) or the
 * lineage ends in another retired version. `UNION` (not `UNION ALL`) makes the
 * walk terminate even on a malformed cycle.
 */
export async function currentProgramVersion(
	db: Database,
	userId: string,
	programId: string
): Promise<ProgramVersion | null> {
	if (!z.string().uuid().safeParse(programId).success) return null;
	const result = await db.execute<{ id: string; name: string }>(sql`
		with recursive lineage(id) as (
			select p.id from programs p
			where p.id = ${programId}::uuid and p.user_id = ${userId} and p.system_kind is null
			union
			select child.id from programs child
			join lineage on child.source_program_id = lineage.id
			where child.user_id = ${userId} and child.system_kind is null
		)
		select p.id, p.name from programs p
		join lineage on lineage.id = p.id
		where p.id <> ${programId}::uuid and p.is_active
		order by p.created_at desc, p.id desc
		limit 1
	`);
	const [row] = [...result];
	return row ? { id: row.id, name: row.name } : null;
}
