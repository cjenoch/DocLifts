/**
 * The test-database name guard. Runs under vitest, so importing
 * db/index.ts executes the guard for real — the module is not stubbed, and
 * DATABASE_URL is the test database at that point (forced in vite.config.ts).
 *
 * The guard's job is to make a test run against a real database fail loudly
 * instead of quietly. The scenario that motivated it is concrete: a stale
 * DATABASE_URL exported in the shell for migration runs, pointing at whatever
 * answers on 127.0.0.1:5432. A `??=` default does nothing in that case; the
 * override does. Both layers are exercised below.
 */
import { describe, it, expect } from 'vitest';
import { assertTestDatabaseUrl, db } from './index';

describe('assertTestDatabaseUrl', () => {
	it('rejects a database whose name does not end in _test', () => {
		// The real mistake: a name that looks like production.
		expect(() => assertTestDatabaseUrl('postgresql://u:p@127.0.0.1:5432/doclifts')).toThrow(
			/Refusing to build a database client under vitest against "doclifts"/
		);
		// Not fooled by the user or the host; only the database name matters.
		expect(() =>
			assertTestDatabaseUrl('postgresql://doclifts_test@doclifts-test-db:5432/doclifts')
		).toThrow(/"doclifts"/);
		expect(() => assertTestDatabaseUrl('postgresql://u:p@h:5432/production')).toThrow(
			/"production"/
		);
		expect(() => assertTestDatabaseUrl('postgresql://u:p@h:5432/doclifts_scratch')).toThrow(
			/"doclifts_scratch"/
		);
	});

	it('accepts any _test-suffixed database and returns the name', () => {
		expect(assertTestDatabaseUrl('postgresql://u:p@h:5432/doclifts_test')).toBe('doclifts_test');
		expect(assertTestDatabaseUrl('postgresql://u:p@h:5432/integration_test')).toBe(
			'integration_test'
		);
	});

	it('the imported client was built against a _test database', () => {
		// Proof the guard did not merely exist but allowed this module to load:
		// reaching this line means the URL passed it.
		expect(db).toBeTruthy();
	});
});
