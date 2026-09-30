import { db } from '$lib/server/db';
import { importedWorkoutsForOwner } from '$lib/server/history';
import { requireUser } from '$lib/server/request-user';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// The query lives in importedWorkoutsForOwner, scoped through
	// import_id -> workout_log_imports.user_id. This route used to select from
	// imported_workouts with no owner predicate and returned every user's
	// archive.
	return importedWorkoutsForOwner(db, requireUser(locals).id);
};
