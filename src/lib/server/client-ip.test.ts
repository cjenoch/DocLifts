import { describe, expect, it, vi } from 'vitest';
import { clientIpFrom, clientIpHeader, normalizeClientIp } from './client-ip';

describe('trusted client IP', () => {
	it.each([
		['203.0.113.17', '203.0.113.17'],
		['2001:DB8:1234:5678::1', '2001:0db8:1234:5678:0000:0000:0000:0000'],
		['2001:db8:1234:5678:abcd:0:ffff:4', '2001:0db8:1234:5678:0000:0000:0000:0000'],
		['::1', '0000:0000:0000:0000:0000:0000:0000:0000'],
		['::ffff:192.0.2.1', '192.0.2.1'],
		['0:0:0:0:0:ffff:c000:201', '192.0.2.1'],
		['garbage', null],
		['203.0.113.1, 203.0.113.2', null],
		['fe80::1%eth0', null],
		['192.0.2.1:443', null]
	])('normalizes %s', (input, expected) => {
		expect(normalizeClientIp(input)).toBe(expected);
	});

	it('uses only the configured header, including when missing or malformed', () => {
		const env = { CLIENT_IP_HEADER: 'CF-Connecting-IP' };
		const headers = new Headers({ 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '192.0.2.1' });
		expect(clientIpFrom(headers, env)).toBeNull();
		headers.set('cf-connecting-ip', 'bad');
		expect(clientIpFrom(headers, env)).toBeNull();
		headers.set('cf-connecting-ip', '203.0.113.7');
		expect(clientIpFrom(headers, env)).toBe('203.0.113.7');
	});

	it('keeps the legacy first-XFF behavior only when no header is configured', () => {
		const headers = new Headers({ 'x-forwarded-for': '192.0.2.1, 203.0.113.1' });
		expect(clientIpFrom(headers, {})).toBe('192.0.2.1');
		expect(clientIpFrom(headers, { CLIENT_IP_HEADER: 'x-forwarded-for' })).toBeNull();
		expect(() => clientIpHeader({ CLIENT_IP_HEADER: 'x-one,x-two' })).toThrow('CLIENT_IP_HEADER');
	});
});

/**
 * The declared edge and the configured header must agree, at boot.
 *
 * The accident this prevents: a public deployment (tunnel up, publicly
 * reachable) whose env file lost CLIENT_IP_HEADER. The app used to fall back to
 * the first X-Forwarded-For value — an address the client writes — so the
 * failure-only sign-in throttle counted failures against attacker-chosen keys.
 * Nothing in the response or the health check showed it.
 */
describe('DOCLIFTS_TRUSTED_EDGE', () => {
	it('cloudflare requires exactly cf-connecting-ip, missing or different both refuse', () => {
		expect(
			clientIpHeader({ DOCLIFTS_TRUSTED_EDGE: 'cloudflare', CLIENT_IP_HEADER: 'CF-Connecting-IP' })
		).toBe('cf-connecting-ip');
		for (const header of [undefined, '', 'x-forwarded-for', 'x-real-ip']) {
			expect(() =>
				clientIpHeader({ DOCLIFTS_TRUSTED_EDGE: 'cloudflare', CLIENT_IP_HEADER: header })
			).toThrow(/DOCLIFTS_TRUSTED_EDGE=cloudflare requires CLIENT_IP_HEADER=cf-connecting-ip/);
		}
	});

	it('none refuses a trusted header, because nothing would overwrite it', () => {
		expect(clientIpHeader({ DOCLIFTS_TRUSTED_EDGE: 'none' })).toBe('x-forwarded-for');
		expect(() =>
			clientIpHeader({ DOCLIFTS_TRUSTED_EDGE: 'none', CLIENT_IP_HEADER: 'cf-connecting-ip' })
		).toThrow(/DOCLIFTS_TRUSTED_EDGE=none refuses/);
	});

	it('an undeclared edge keeps existing behavior, and an unknown value stops the process', () => {
		// Undeclared is dev, tests, and every install that has not moved to a
		// single-header proxy. The pair check does not apply to it.
		expect(clientIpHeader({})).toBe('x-forwarded-for');
		expect(clientIpHeader({ CLIENT_IP_HEADER: 'cf-connecting-ip' })).toBe('cf-connecting-ip');
		// A typed-wrong declaration must not degrade to "undeclared".
		expect(() => clientIpHeader({ DOCLIFTS_TRUSTED_EDGE: 'cloudflare-tunnel' })).toThrow(
			/must be cloudflare or none, or unset/
		);
		expect(() => clientIpHeader({ DOCLIFTS_TRUSTED_EDGE: 'none ' })).not.toThrow();
	});

	it('refuses at IMPORT, not only at call time', async () => {
		// The bundled server defers the `createAuth` property read that calls
		// clientIpHeader(), so a mismatched pair otherwise ships as a 500 on every
		// request instead of a refused start. Importing this module is on every
		// boot path, so the check has to run when it is evaluated.
		vi.resetModules();
		vi.stubEnv('DOCLIFTS_TRUSTED_EDGE', 'cloudflare');
		vi.stubEnv('CLIENT_IP_HEADER', '');
		try {
			await expect(import('./client-ip')).rejects.toThrow(
				/requires CLIENT_IP_HEADER=cf-connecting-ip/
			);
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});
});
