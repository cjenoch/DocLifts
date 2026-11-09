import { eq } from 'drizzle-orm';
import { db, privacyDeletions } from '$lib/server/db';
import { deletionEnabled } from '$lib/server/privacy/ledger';
import { deletionJobState } from '$lib/server/privacy/lifecycle';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ cookies }) => {
	const id = cookies.get('doclifts.deletion');
	const [receipt] =
		id && /^[0-9a-f-]{36}$/i.test(id)
			? await db
					.select({
						completedAt: privacyDeletions.completedAt,
						lastError: privacyDeletions.lastError
					})
					.from(privacyDeletions)
					.where(eq(privacyDeletions.id, id))
			: [];
	return {
		deletionEnabled: deletionEnabled(),
		deletionState: receipt ? deletionJobState(receipt) : null
	};
};
