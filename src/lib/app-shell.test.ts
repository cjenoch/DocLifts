import { describe, expect, it } from 'vitest';
import { accountInitial, activeTab, appShell, pageTitle } from './app-shell';

describe('app shell', () => {
	it('has the owner’s four tabs, in order', () => {
		expect(appShell.tabs.map((t) => t.label)).toEqual(['Workout', 'Gyms', 'History', 'Reports']);
	});

	it('lights the tab a page belongs to; equipment and photos sit under Gyms', () => {
		const tab = (p: string) => activeTab(p)?.label ?? null;
		expect(tab('/')).toBe('Workout');
		expect(tab('/sessions/abc')).toBe('Workout');
		expect(tab('/workout/start')).toBe('Workout');
		expect(tab('/programs/x/edit')).toBe('Workout');
		expect(tab('/gyms')).toBe('Gyms');
		expect(tab('/gyms/g/equipment/photo')).toBe('Gyms');
		expect(tab('/equipment/m')).toBe('Gyms');
		expect(tab('/photos/p/review')).toBe('Gyms');
		expect(tab('/history')).toBe('History');
		expect(tab('/reports')).toBe('Reports');
		expect(tab('/account')).toBeNull();
		// A whole segment, not a string prefix.
		expect(tab('/gymsx')).toBeNull();
		expect(tab('/historyx')).toBeNull();
	});

	it('titles every page "Page · DocLifts"', () => {
		expect(pageTitle('History')).toBe('History · DocLifts');
	});

	it('the account letter is the email’s first character, upper case', () => {
		expect(accountInitial('chris@example.com')).toBe('C');
		expect(accountInitial('  x@y')).toBe('X');
		expect(accountInitial('')).toBe('?');
		expect(accountInitial(null)).toBe('?');
	});
});
