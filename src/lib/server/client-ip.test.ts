import { describe, expect, it } from 'vitest';
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
