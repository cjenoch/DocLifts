/**
 * The one session row lock. Every mutation that must serialise with set
 * updates, quick-add and block changes takes it here, then reads the phase
 * with `sessionPhase()` and refuses in its own words (callers keep their
 * messages and statuses; route tests pin them).
 *
 * Imports nothing from `machines.ts`: `lockActive` there is built on this.
 */
import { and, eq } from 'drizzle-orm';
import { sessions } from './db/schema';
import type { Database } from './progression';

/**
 * Locks this user's session row `FOR UPDATE` and returns it, or null when no
 * such session belongs to the user. Any phase is returned; the caller decides.
 * Does not validate `sessionId`; callers that did so before (`lockActive`)
 * still do, so no caller gains or loses an error path.
 */
export async function lockSession(
	db: Database,
	userId: string,
	sessionId: string
): Promise<typeof sessions.$inferSelect | null> {
	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
		.for('update');
	return session ?? null;
}
