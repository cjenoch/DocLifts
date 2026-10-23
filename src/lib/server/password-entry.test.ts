import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginThrottle, DEFAULT_THROTTLE_CONFIG } from './login-throttle';
import { loginWaitFor, passwordEntryHandler } from './password-entry';

const request = (
	ip = '203.0.113.1',
	email = 'scratch-test@doclifts.invalid',
	path = '/api/auth/sign-in/email'
) =>
	new Request(`http://localhost${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
		body: JSON.stringify({ email, password: 'test-only' })
	});
const throttle = () =>
	new LoginThrottle({
		...DEFAULT_THROTTLE_CONFIG,
		maxFailures: 2,
		delayAfterFailures: 2,
		delayBaseMs: 10,
		delayMaxMs: 10
	});
afterEach(() => vi.useRealTimers());

describe('shared password entry', () => {
	it('bounds active clients globally without a queue and releases capacity', async () => {
		let finish!: () => void;
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const handle = passwordEntryHandler(async () => {
			await blocked;
			return new Response('ok');
		}, throttle());
		const active = Array.from({ length: 32 }, (_, n) => handle(request(`203.0.113.${n + 1}`)));
		expect((await handle(request('203.0.113.100'))).status).toBe(503);
		finish();
		expect((await Promise.all(active)).every((r) => r.ok)).toBe(true);
		expect((await handle(request('203.0.113.100'))).status).toBe(200);
	});

	it('rejects oversized bodies without verification and frees its lane', async () => {
		const backend = vi.fn(async () => new Response('ok'));
		const handle = passwordEntryHandler(backend, throttle());
		const oversized = new Request('http://localhost/api/auth/sign-in/email', {
			method: 'POST',
			headers: { 'x-forwarded-for': '203.0.113.1' },
			body: 'x'.repeat(32769)
		});
		expect((await handle(oversized)).status).toBe(413);
		expect(backend).not.toHaveBeenCalled();
		expect((await handle(request())).status).toBe(200);
	});

	it('times out a stalled body and frees capacity without checking a password', async () => {
		vi.useFakeTimers();
		const backend = vi.fn(async () => new Response('ok'));
		const handle = passwordEntryHandler(backend, throttle());
		const stalled = new Request('http://localhost/api/auth/sign-in/email', {
			method: 'POST',
			headers: { 'x-forwarded-for': '203.0.113.1' },
			body: new ReadableStream<Uint8Array>(),
			duplex: 'half'
		} as RequestInit);
		const pending = handle(stalled);
		await vi.advanceTimersByTimeAsync(10_000);
		expect((await pending).status).toBe(408);
		expect(backend).not.toHaveBeenCalled();
		expect((await handle(request())).status).toBe(200);
	});

	it('passes cookies and successful responses unchanged and clears failures', async () => {
		const limit = throttle();
		const success = new Response('ok', { headers: { 'set-cookie': 'session=test; HttpOnly' } });
		const backend = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValue(success);
		const handle = passwordEntryHandler(backend, limit);
		await handle(request());
		expect(await handle(request())).toBe(success);
		expect(success.headers.get('set-cookie')).toContain('session=test');
		expect(limit.check([{ type: 'ip', value: '203.0.113.1' }])).toEqual({ kind: 'allow' });
	});

	it('counts JSON endpoint failures and refuses normalized aliases before checking credentials', async () => {
		const backend = vi.fn(async () => new Response(null, { status: 401 }));
		const handle = passwordEntryHandler(backend, throttle());
		expect((await handle(request())).status).toBe(401);
		expect((await handle(request())).status).toBe(401);
		for (const path of [
			'/api/auth/sign-in/email',
			'/api/auth/sign-in/email/',
			'/api/auth/sign-in/%65mail'
		]) {
			const result = await handle(request('203.0.113.1', undefined, path));
			expect(result.status).toBe(429);
			expect(Number(result.headers.get('retry-after'))).toBeGreaterThan(0);
			expect(loginWaitFor(result).keyType).toBe('ip');
		}
		expect(backend).toHaveBeenCalledTimes(2);
	});

	it('only counts credential refusals, never origin, validation, backstop or service errors', async () => {
		const limit = throttle();
		for (const status of [400, 403, 429, 500, 503]) {
			const handle = passwordEntryHandler(async () => new Response(null, { status }), limit);
			expect((await handle(request())).status).toBe(status);
		}
		expect(limit.check([{ type: 'ip', value: '203.0.113.1' }])).toEqual({ kind: 'allow' });
	});

	it('does not queue parallel attempts from an IP, releases the lane on exceptions', async () => {
		let finish!: () => void;
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const backend = vi.fn(async () => {
			await blocked;
			throw new Error('unavailable');
		});
		const handle = passwordEntryHandler(backend, throttle());
		const first = handle(request());
		const failure = expect(first).rejects.toThrow('unavailable');
		expect((await handle(request())).status).toBe(429);
		finish();
		await failure;
		await expect(handle(request())).rejects.toThrow('unavailable');
		expect(backend).toHaveBeenCalledTimes(2);
	});

	it('another address can sign in to the same email while a lane is occupied', async () => {
		let finish!: () => void;
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const backend = vi.fn(async (r: Request) => {
			if (r.headers.get('x-forwarded-for') === '203.0.113.1') await blocked;
			return new Response('ok');
		});
		const handle = passwordEntryHandler(backend, throttle());
		const first = handle(request());
		expect((await handle(request('203.0.113.2'))).status).toBe(200);
		finish();
		await first;
		expect(backend).toHaveBeenCalledTimes(2);
	});

	it('holds the IP lane during progressive delay, but email only delays a different IP', async () => {
		vi.useFakeTimers();
		const limit = throttle();
		const keys = [{ type: 'email' as const, value: 'scratch-test@doclifts.invalid' }];
		limit.recordFailure(keys);
		limit.recordFailure(keys);
		const backend = vi.fn(async () => new Response('ok'));
		const handle = passwordEntryHandler(backend, limit);
		const first = handle(request());
		expect((await handle(request())).status).toBe(429);
		await vi.waitUntil(() => backend.mock.calls.length === 1);
		await vi.runAllTimersAsync();
		const response = await first;
		expect(response.status).toBe(200);
		expect(loginWaitFor(response).heldMs).toBe(10);
		expect(backend).toHaveBeenCalledTimes(1);
	});

	it('leaves OAuth, logout and password change handling intact', async () => {
		const backend = vi.fn(async () => new Response('ok'));
		const handle = passwordEntryHandler(backend, throttle());
		for (const path of [
			'/api/auth/sign-out',
			'/api/auth/change-password',
			'/api/auth/oauth2/token'
		]) {
			expect((await handle(request(undefined, undefined, path))).status).toBe(200);
		}
		expect(backend).toHaveBeenCalledTimes(3);
	});
});
