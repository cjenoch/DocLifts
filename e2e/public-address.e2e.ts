import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetTestDb, setupTestDb } from '$lib/server/test-db';
import { seedTestUser, startTestServer, TEST_PASSWORD } from '$lib/server/test-auth-helpers';

const PUBLIC = 'https://doclifts.runthe.ai';
const EMAIL = 'public-address@test.local';
let harness: Awaited<ReturnType<typeof setupTestDb>>;
let server: Awaited<ReturnType<typeof startTestServer>>;

beforeAll(async () => {
	harness = await setupTestDb();
	await resetTestDb(harness.client);
	await seedTestUser(harness.db, EMAIL);
	server = await startTestServer({
		PUBLIC_ORIGIN: PUBLIC,
		ORIGIN: PUBLIC,
		CLIENT_IP_HEADER: 'cf-connecting-ip',
		LOGIN_MAX_FAILURES: '10',
		LOGIN_DELAY_BASE_MS: '5',
		LOGIN_DELAY_MAX_MS: '20'
	});
}, 60_000);

afterAll(async () => {
	await server?.stop();
	await harness?.end();
});

function login(ip: string, password = 'wrong-password', xff = '192.0.2.9') {
	return fetch(`${server.origin}/login`, {
		method: 'POST',
		headers: {
			origin: PUBLIC,
			'content-type': 'application/x-www-form-urlencoded',
			'cf-connecting-ip': ip,
			'x-forwarded-for': xff,
			'x-forwarded-host': 'attacker.invalid',
			'x-forwarded-proto': 'http'
		},
		body: new URLSearchParams({ email: EMAIL, password }),
		redirect: 'manual'
	});
}

describe('public-origin served build', () => {
	it('accepts same-origin login despite forged host/protocol and sets a host-only secure cookie', async () => {
		const res = await login('203.0.113.1', TEST_PASSWORD);
		expect((await res.json()).type).toBe('redirect');
		const cookie = res.headers.getSetCookie().find((value) => value.includes('session_token='));
		expect(cookie).toBeDefined();
		expect(cookie).toMatch(/; Secure/i);
		expect(cookie).toMatch(/; HttpOnly/i);
		expect(cookie).toMatch(/; SameSite=Lax/i);
		expect(cookie).not.toMatch(/; Domain=/i);
		const sessionCookie = cookie!.split(';')[0];
		for (const path of ['/login', '/history', '/api/auth/get-session', '/photos/missing/image']) {
			const page = await fetch(`${server.origin}${path}`, { headers: { cookie: sessionCookie } });
			expect(page.headers.get('cache-control'), path).toMatch(/private, no-store/);
			expect(page.headers.get('x-content-type-options'), path).toBe('nosniff');
			expect(page.headers.get('strict-transport-security'), path).toBe('max-age=86400');
			expect(page.headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
			if (path === '/history') {
				expect(page.status).toBe(200);
				expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
			}
		}
	});

	it('refuses other origins, including the former trusted tailnet origin', async () => {
		for (const origin of ['https://attacker.invalid', 'https://enochnvps.tail29bbdb.ts.net']) {
			const res = await fetch(`${server.origin}/login`, {
				method: 'POST',
				headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ email: EMAIL, password: TEST_PASSWORD })
			});
			expect(res.status, origin).toBe(403);
		}
	});

	it('keeps one IP bucket when XFF is forged or IPv6 changes inside a /64; logs the same key', async () => {
		for (let i = 1; i <= 10; i++) {
			const res = await login(`2001:db8:1234:5678::${i}`, 'wrong-password', `192.0.2.${i}`);
			expect((await res.json()).status).toBe(400);
		}
		const refused = await login('2001:db8:1234:5678:ffff::1', TEST_PASSWORD, '198.51.100.4');
		expect((await refused.json()).status).toBe(429);
		const lines = server
			.log()
			.split('\n')
			.filter((line) => line.includes('"event":"login_attempt"'));
		const event = JSON.parse(lines.at(-1)!.slice(lines.at(-1)!.indexOf('{')));
		expect(event.ipHash).toBe(
			createHash('sha256')
				.update('2001:0db8:1234:5678:0000:0000:0000:0000')
				.digest('hex')
				.slice(0, 8)
		);
		expect(event.keyType).toBe('ip');
	});

	it('never lets failures from ten other addresses lock out the account owner', async () => {
		for (let i = 1; i <= 10; i++) await login(`198.51.100.${i}`);
		const res = await login('203.0.113.99', TEST_PASSWORD);
		expect((await res.json()).type).toBe('redirect');
	});

	it('uses the trusted header in Better Auth direct requests too', async () => {
		let res: Response | undefined;
		for (let i = 0; i <= 60; i++) {
			res = await fetch(`${server.origin}/api/auth/sign-in/email`, {
				method: 'POST',
				headers: {
					origin: PUBLIC,
					'content-type': 'application/json',
					'cf-connecting-ip': `2001:db8:aaaa:bbbb::${i + 1}`,
					'x-forwarded-for': `192.0.2.${i + 1}`
				},
				body: JSON.stringify({ email: 'invalid-email', password: 'wrong-password' })
			});
			if (i < 60) expect(res.status).not.toBe(429);
		}
		expect(res!.status).toBe(429);
	});

	it('moves to a different origin with only a restart of the same build', async () => {
		const movedOrigin = 'https://moved.example.test';
		const moved = await startTestServer({ PUBLIC_ORIGIN: movedOrigin, ORIGIN: movedOrigin });
		try {
			for (const [origin, status] of [
				[PUBLIC, 403],
				[movedOrigin, 200]
			] as const) {
				const res = await fetch(`${moved.origin}/login`, {
					method: 'POST',
					headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ email: EMAIL, password: TEST_PASSWORD })
				});
				expect(res.status).toBe(status);
				if (status === 200) expect((await res.json()).type).toBe('redirect');
			}
		} finally {
			await moved.stop();
		}
	});
});
