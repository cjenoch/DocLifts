import { describe, expect, it } from 'vitest';
import { McpAuthGate } from './auth-gate';

const headers = (ip = '203.0.113.1', token = 'test-token-123456') =>
	new Headers({ 'x-forwarded-for': ip, authorization: `Bearer ${token}` });
describe('MCP pre-auth admission', () => {
	it('allows two concurrent lookups behind one NAT while reserving capacity for other IPs', () => {
		const gate = new McpAuthGate();
		const first = gate.enter(headers());
		const second = gate.enter(headers());
		expect(typeof first).toBe('object');
		expect(typeof second).toBe('object');
		expect(gate.enter(headers())).toBe('busy');
		expect(typeof gate.enter(headers('203.0.113.2'))).toBe('object');
		if (typeof first === 'object') {
			first.release();
			first.release();
		}
		expect(typeof gate.enter(headers())).toBe('object');
		expect(gate.enter(headers())).toBe('busy');
	});
	it('caches only denials, bounds their lifetime and evicts old entries', () => {
		let now = 0;
		const gate = new McpAuthGate(() => now);
		const deny = (token: string) => {
			const admission = gate.enter(headers(undefined, token));
			if (typeof admission !== 'object') throw new Error('expected admission');
			admission.denied(true);
			admission.release();
		};
		deny('first');
		expect(gate.enter(headers('203.0.113.2', 'first'))).toBe('invalid');
		for (let n = 0; n < 1000; n++) deny(`invalid-${n}`);
		expect(typeof gate.enter(headers(undefined, 'first'))).toBe('object');
		expect(gate.enter(headers(undefined, 'invalid-999'))).toBe('invalid');
		now = 5000;
		expect(typeof gate.enter(headers(undefined, 'invalid-999'))).toBe('object');
	});
	it('does not cache success, so each request must still authenticate against revocation state', () => {
		const gate = new McpAuthGate();
		const admission = gate.enter(headers());
		if (typeof admission !== 'object') throw new Error('expected admission');
		admission.denied(false);
		admission.release();
		expect(typeof gate.enter(headers())).toBe('object');
	});
});
