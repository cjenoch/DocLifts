/**
 * Supplies page data only. The auth GUARD is in src/hooks.server.ts `handle`,
 * not here: a form action executes before any `load`, so a guard in the
 * layout runs after every write has already happened. See hooks.server.ts.
 */
export function load({ locals }: { locals: App.Locals }) {
	return {
		user: locals.user ?? null
	};
}
