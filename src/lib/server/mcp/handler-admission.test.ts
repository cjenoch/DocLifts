import { beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '../progression';
const authenticate = vi.hoisted(() => vi.fn());
vi.mock('./access', () => ({ authenticateMcp: authenticate }));
import { handleMcp } from './handler';
const db = {} as Database;
const request = (ip: string, token = 'test-only-invalid-token') =>
	new Request('https://doclifts-mcp.runthe.ai/mcp', {
		method: 'POST',
		headers: { 'x-forwarded-for': ip, authorization: `Bearer ${token}` }
	});
beforeEach(() => authenticate.mockReset());

it('keeps the Bearer challenge while repeated denied tokens skip authentication work', async () => {
	authenticate.mockResolvedValue(null);
	const first = await handleMcp(db, request('203.0.113.101', 'repeat-invalid-token'));
	expect(first.status).toBe(401);
	expect(first.headers.get('www-authenticate')).toContain('resource_metadata=');
	expect((await handleMcp(db, request('203.0.113.102', 'repeat-invalid-token'))).status).toBe(401);
	expect(authenticate).toHaveBeenCalledTimes(1);
});

it('limits one IP to two pending token lookups while another IP can authenticate', async () => {
	let finish!: () => void;
	const pending = new Promise<null>((resolve) => {
		finish = () => resolve(null);
	});
	authenticate.mockReturnValueOnce(pending).mockReturnValueOnce(pending).mockResolvedValue(null);
	const first = handleMcp(db, request('203.0.113.103', 'parallel-invalid-a'));
	const second = handleMcp(db, request('203.0.113.103', 'parallel-invalid-b'));
	expect((await handleMcp(db, request('203.0.113.103', 'parallel-invalid-c'))).status).toBe(429);
	expect((await handleMcp(db, request('203.0.113.104', 'parallel-invalid-d'))).status).toBe(401);
	finish();
	expect((await Promise.all([first, second])).map((r) => r.status)).toEqual([401, 401]);
	expect(authenticate).toHaveBeenCalledTimes(3);
});

it('retains the global eight-request pre-auth bound', async () => {
	let finish!: () => void;
	const pending = new Promise<null>((resolve) => {
		finish = () => resolve(null);
	});
	authenticate.mockReturnValue(pending);
	const active = Array.from({ length: 8 }, (_, n) =>
		handleMcp(db, request(`203.0.113.${110 + n}`, `global-invalid-${n}`))
	);
	expect((await handleMcp(db, request('203.0.113.120', 'global-excess'))).status).toBe(503);
	finish();
	expect((await Promise.all(active)).every((r) => r.status === 401)).toBe(true);
	expect(authenticate).toHaveBeenCalledTimes(8);
});
