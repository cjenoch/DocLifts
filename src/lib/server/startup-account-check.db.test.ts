/**
 * The startup warning must be right in both directions.
 *
 * A warning that fires when accounts DO exist sends an operator chasing a
 * phantom, and a warning that stays silent when none exist is the exact failure
 * it was written to catch. Both are asserted here, which is why the capture
 * helper is asserted as well as the return value.
 */
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, resetTestDb, type TestDb } from './test-db';
import { createUser } from './users';
import { auth } from './auth';
import { warnIfNoLoginCapableAccount } from './startup-account-check';
import { authUsers } from './db/auth-schema';
import { SENTINEL_EMAIL, SENTINEL_USER_ID } from './bootstrap';
import { eq } from 'drizzle-orm';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
const db = (): TestDb => harness.db;

beforeEach(async () => {
	harness ??= await setupTestDb();
	await resetTestDb(harness.client);
	vi.restoreAllMocks();
});

afterAll(async () => {
	await harness?.end();
});

/** Capture console output so the warning's actual text is asserted. */
function captureWarn() {
	const lines: string[] = [];
	vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
		lines.push(args.map(String).join(' '));
	});
	return lines;
}

describe('startup account warning', () => {
	it('warns, and says how to fix it, when the sentinel is unclaimed', async () => {
		const lines = captureWarn();
		await db().insert(authUsers).values({
			id: SENTINEL_USER_ID,
			name: 'Owner',
			email: 'owner@localhost',
			emailVerified: false
		});

		const warned = await warnIfNoLoginCapableAccount(db());

		expect(warned).toBe(true);
		expect(lines.join('\n')).toContain('NO LOGIN-CAPABLE ACCOUNT');
		// The actionable part. A warning that does not name the fix is a
		// decoration, not a diagnostic.
		// The production-facing command. `pnpm user:bootstrap` is the dev form;
		// an operator reading container logs needs the one that works on the VPS.
		expect(lines.join('\n')).toContain('user-prod.sh bootstrap');
		expect(lines.join('\n')).toContain('0011');
	});

	it('says "empty installation" when there is no sentinel either', async () => {
		const lines = captureWarn();
		const warned = await warnIfNoLoginCapableAccount(db());
		expect(warned).toBe(true);
		expect(lines.join('\n')).toContain('empty installation');
	});

	it('stays silent once a real account can sign in', async () => {
		await createUser(auth, db(), {
			email: 'chris@example.com',
			password: 'correct-horse-battery',
			name: 'Chris'
		});
		const lines = captureWarn();

		const warned = await warnIfNoLoginCapableAccount(db());

		expect(warned).toBe(false);
		expect(lines.join('\n')).not.toContain('NO LOGIN-CAPABLE ACCOUNT');
		expect(lines).toHaveLength(0);
	});

	it('warns when the only user has no credential row at all', async () => {
		// The trigger is the absence of a credential row, not the verified flag:
		// a user row with no credential cannot sign in, whatever its flag says.
		await db().insert(authUsers).values({
			id: '11111111-1111-4111-8111-111111111111',
			name: 'Credential-less',
			email: 'nocred@example.com',
			emailVerified: true
		});
		const lines = captureWarn();

		expect(await warnIfNoLoginCapableAccount(db())).toBe(true);
		expect(lines.join('\n')).toContain('NO LOGIN-CAPABLE ACCOUNT');
	});

	it("names a half-claimed sentinel as an interrupted bootstrap, not as 0011's placeholder", async () => {
		// Control first: the unclaimed sentinel gets the 0011 text.
		await db().insert(authUsers).values({
			id: SENTINEL_USER_ID,
			name: 'Owner',
			email: SENTINEL_EMAIL,
			emailVerified: false
		});
		let lines = captureWarn();
		expect(await warnIfNoLoginCapableAccount(db())).toBe(true);
		expect(lines.join('\n')).toContain('Migration 0011 created the sentinel');
		expect(lines.join('\n')).not.toContain('partly claimed');

		// The state a crash after the old bootstrap's first statement left.
		await db()
			.update(authUsers)
			.set({ email: 'half@doclifts.invalid', emailVerified: true })
			.where(eq(authUsers.id, SENTINEL_USER_ID));
		vi.restoreAllMocks();
		lines = captureWarn();

		expect(await warnIfNoLoginCapableAccount(db())).toBe(true);
		const text = lines.join('\n');
		expect(text).toContain('partly claimed');
		expect(text).toContain('user-prod.sh bootstrap');
		expect(text).not.toContain('Migration 0011 created the sentinel');
		// The operator's email is not written to the container log.
		expect(text).not.toContain('half@doclifts.invalid');
	});
});
