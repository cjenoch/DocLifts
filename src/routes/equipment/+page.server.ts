import { db } from '$lib/server/db';
import { browseFacets, browseModels, parseBrowseParams } from '$lib/server/catalog';
import { requireUser } from '$lib/server/request-user';
import type { PageServerLoad } from './$types';

// Read-only, GET-form filters. Global catalog rows plus this user's own.
export const load: PageServerLoad = async ({ url, locals }) => {
	const userId = requireUser(locals).id;
	const filters = parseBrowseParams(url.searchParams);
	const [result, facets] = await Promise.all([
		browseModels(db, userId, filters),
		browseFacets(db, userId, filters.manufacturer)
	]);
	return { ...result, facets, filters, userId };
};
