import { count, desc, sql } from 'drizzle-orm';
import { db, importedWorkouts } from '$lib/server/db';
import type { PageServerLoad } from './$types';

// L8: this page is a client-side searchable archive (text search spans the
// jsonb `lines`, plus an "all months" view), so it can't page by month
// server-side the way /history does. Bound the query instead: the most
// recent IMPORT_LIMIT workouts (undated last) plus the total, so the UI can
// disclose the cap instead of silently dropping records.
// (Not exported: +page.server.ts may only export load and SvelteKit's
// reserved names.)
const IMPORT_LIMIT = 500;

export const load: PageServerLoad = async () => {
	const [workouts, [{ total }]] = await Promise.all([
		db
			.select()
			.from(importedWorkouts)
			.orderBy(sql`${importedWorkouts.workoutDate} DESC NULLS LAST`, desc(importedWorkouts.sourceLine))
			.limit(IMPORT_LIMIT),
		db.select({ total: count() }).from(importedWorkouts)
	]);
	return { workouts, total, limit: IMPORT_LIMIT };
};
