/**
 * The app shell (0.5.5, SPEC 0.5.0 Part E): the bottom tabs, the account
 * button, page titles and the empty states. The only place their strings and
 * the tab list live; the layout and the pages read them from here, and tests
 * read the strings from here too.
 */

export type Tab = {
	href: string;
	label: string;
	/** Path prefixes that light this tab (a whole segment each). */
	match: readonly string[];
};

export const appShell = {
	appName: 'DocLifts',
	/** One line on the sign-in page. No sign-up link while sign-up is closed. */
	tagline: 'Log your lifts at the gym. Photograph each machine and log your sets on it.',
	tabs: [
		{
			href: '/',
			label: 'Workout',
			match: ['/', '/workout', '/sessions', '/programs', '/imported-history']
		},
		{ href: '/gyms', label: 'Gyms', match: ['/gyms', '/equipment', '/photos'] },
		{ href: '/history', label: 'History', match: ['/history'] },
		{ href: '/reports', label: 'Reports', match: ['/reports'] }
	] as const satisfies readonly Tab[],
	accountLabel: 'Account',
	/** Home for an account with no programs and no workouts. */
	firstRunSteps: ['Start a workout.', 'Photograph each machine.', 'Log your sets.'],
	empty: {
		gyms: 'No gyms yet. Name one below, or when you start a workout. The machines you add or photograph will be listed under it.',
		history: 'Your finished workouts will appear here, month by month.',
		reports:
			'Reports appear after your first finished workout: how often you train, how many sets you log, and your top exercises.'
	}
} as const;

/** Every page's title: "Page · DocLifts". */
export const pageTitle = (page: string): string => `${page} · ${appShell.appName}`;

/** The tab a path belongs to, or null. `/` matches only itself. */
export function activeTab(pathname: string): Tab | null {
	for (const tab of appShell.tabs)
		for (const prefix of tab.match)
			if (
				prefix === '/' ? pathname === '/' : pathname === prefix || pathname.startsWith(prefix + '/')
			)
				return tab;
	return null;
}

/** The account button's letter: the first character of the email, upper case. */
export const accountInitial = (email: string | null | undefined): string =>
	(email?.trim()[0] ?? '?').toUpperCase();
