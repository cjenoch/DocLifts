/**
 * GET /health: the two statuses the healthcheck distinguishes, and the body it
 * must never carry.
 *
 * The database is faked here on purpose. The real pool cannot be pointed at an
 * unreachable server in-process (the module builds it at import), and the
 * property under test belongs to the ROUTE: a 503 from a failing probe must not
 * describe the failure, because the route is publicly reachable. The real probe
 * against real databases is covered in src/lib/server/health.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('$lib/server/db', () => ({ db: { transaction } }));

const { GET } = await import('./+server');

describe('GET /health', () => {
	afterEach(() => {
		transaction.mockReset();
	});

	it('answers 200 with a single ok field when the probe returns', async () => {
		transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) =>
			run({ execute: async () => [] })
		);

		const response = await GET({} as never);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'ok' });
	});

	it('answers 503 with no database detail when the probe fails', async () => {
		transaction.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

		const response = await GET({} as never);

		expect(response.status).toBe(503);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({ status: 'unavailable' });
		// No host, no port, no driver message, no stack: an unauthenticated
		// caller learns the status and nothing about the deployment.
		expect(body).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|5432|database|postgres/i);
	});
});
