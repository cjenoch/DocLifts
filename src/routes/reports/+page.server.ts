import { db } from '$lib/server/db';
import { reportSnapshot } from '$lib/server/machine-reports';
import { requireUser } from '$lib/server/request-user';
import type { PageServerLoad } from './$types';

// Every query behind this page lives in reportSnapshot, owner-scoped. The
// route used to run six of them inline with no owner predicate at all, so the
// page counted the whole database.
export const load: PageServerLoad = async ({ locals }) => {
	return reportSnapshot(db, requireUser(locals).id);
};
