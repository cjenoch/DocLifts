/**
 * Password policy: length only, from PASSWORD_MIN_LENGTH (spec §2 item 4).
 *
 * The parser is tested directly; the policy is tested where it bites, through
 * `createUser` on a real Better Auth instance, because that is the path the
 * account CLI uses and it reads the limit from the resolved auth context rather
 * than from this module.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { setupTestDb, resetTestDb, type TestDb } from './test-db';
import { createUser } from './users';
import {
	createAuth,
	passwordMinLength,
	PASSWORD_MIN_LENGTH_DEFAULT,
	PASSWORD_MIN_LENGTH_FLOOR
} from './auth-core';

describe('passwordMinLength', () => {
	it('defaults to 12 when unset or empty', () => {
		expect(passwordMinLength({})).toBe(12);
		expect(passwordMinLength({ PASSWORD_MIN_LENGTH: '' })).toBe(12);
		expect(PASSWORD_MIN_LENGTH_DEFAULT).toBe(12);
	});

	it('takes any whole number from the floor of 8 up to 128', () => {
		expect(PASSWORD_MIN_LENGTH_FLOOR).toBe(8);
		expect(passwordMinLength({ PASSWORD_MIN_LENGTH: '8' })).toBe(8);
		expect(passwordMinLength({ PASSWORD_MIN_LENGTH: '13' })).toBe(13);
		expect(passwordMinLength({ PASSWORD_MIN_LENGTH: '128' })).toBe(128);
	});

	it('refuses anything else, naming the variable, rather than running the default', () => {
		for (const bad of ['7', '0', '-12', '12.5', 'twelve', '129']) {
			expect(() => passwordMinLength({ PASSWORD_MIN_LENGTH: bad }), bad).toThrow(
				new RegExp(`PASSWORD_MIN_LENGTH="${bad.replace('.', '\\.')}"`)
			);
		}
	});

	it('has a docker-compose.yml passthrough whose default matches the code', () => {
		// Without the line the variable never reaches the container; with a
		// different default, production runs compose's number, not this one.
		const compose = readFileSync('docker-compose.yml', 'utf8');
		const match = compose.match(/PASSWORD_MIN_LENGTH: \$\{PASSWORD_MIN_LENGTH:-([^}]*)\}/);
		expect(match, 'no PASSWORD_MIN_LENGTH passthrough in docker-compose.yml').not.toBeNull();
		expect(Number(match![1])).toBe(PASSWORD_MIN_LENGTH_DEFAULT);
	});
});

describe('the configured minimum is what setting a password enforces', () => {
	let db: TestDb;
	let client: postgres.Sql;
	const saved = process.env.PASSWORD_MIN_LENGTH;

	beforeAll(async () => {
		({ db, client } = await setupTestDb());
		await resetTestDb(client);
	});

	afterAll(async () => {
		if (saved === undefined) delete process.env.PASSWORD_MIN_LENGTH;
		else process.env.PASSWORD_MIN_LENGTH = saved;
		await client.end();
	});

	/** A fresh auth instance built under a given PASSWORD_MIN_LENGTH. */
	const authWith = (min: string) => {
		process.env.PASSWORD_MIN_LENGTH = min;
		return createAuth(db, {
			secret: 'password-policy-test-secret-not-a-real-credential',
			baseURL: 'http://127.0.0.1:3000',
			openSignup: false,
			rateLimitStorage: 'memory'
		});
	};

	it('accepts exactly the minimum, letters only — there is no composition rule', async () => {
		const auth = authWith('10');
		// Ten lowercase letters: no digit, no symbol, no capital. Accepted.
		const user = await createUser(auth, db, {
			email: 'policy-ten@test.local',
			password: 'abcdefghij',
			name: 'Ten'
		});
		expect(user.email).toBe('policy-ten@test.local');
	});

	it('refuses one character under the minimum', async () => {
		const auth = authWith('10');
		await expect(
			createUser(auth, db, { email: 'policy-nine@test.local', password: 'abcdefghi', name: 'Nine' })
		).rejects.toThrow(/at least 10 characters/);
	});

	it('follows the setting, not a hard-coded 12', async () => {
		// The pre-0.2.4 code had `minPasswordLength: 12` literally. With the
		// setting at 9, a 9-character password must now be accepted.
		const auth = authWith('9');
		const user = await createUser(auth, db, {
			email: 'policy-nine-ok@test.local',
			password: 'abcdefghi',
			name: 'Nine'
		});
		expect(user.id).toBeTruthy();
	});
});
