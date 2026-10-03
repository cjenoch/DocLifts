import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers } from '../test-db';
import { createAuth } from '../auth-core';
import { authenticateMcp, revokeConnection, connectionsForUser } from './access';
import { readMcpData } from './reads';
import { handleMcp } from './handler';
import { mcpResource } from './config';
import * as s from '../db/schema';
let h: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string, bob: string;
let registrationIp = 1;
let auth: ReturnType<typeof createAuth>;
const origin = 'https://doclifts-test.invalid';
beforeAll(async () => {
	h = await setupTestDb();
});
afterAll(async () => {
	await h?.end();
});
beforeEach(async () => {
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(h.db, h.client, 2, 'mcp');
	auth = createAuth(h.db, {
		secret: 'mcp-test-only-secret-never-production',
		baseURL: origin,
		openSignup: false,
		rateLimitStorage: 'memory'
	});
	await auth.$context;
});
async function grant(
	userId = alice,
	scopes = 'workouts:read programs:read equipment:read offline_access',
	exchangeOverride: Record<string, string> = {},
	expectedStatus = 200
) {
	const registration = await auth.handler(
		new Request(origin + '/api/auth/oauth2/register', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-forwarded-for': `192.0.2.${registrationIp++}`
			},
			body: JSON.stringify({
				client_name: 'Fixture agent',
				redirect_uris: ['https://client.invalid/callback'],
				token_endpoint_auth_method: 'none',
				scope: scopes
			})
		})
	);
	const client = await registration.json();
	expect(registration.status, JSON.stringify(client)).toBe(201);
	const session = await (await auth.$context).internalAdapter.createSession(userId);
	const cookieValue = await import('better-auth/crypto').then(
		async ({ makeSignature }) =>
			session.token +
			'.' +
			(await makeSignature(session.token, 'mcp-test-only-secret-never-production'))
	);
	const cookie = '__Secure-better-auth.session_token=' + encodeURIComponent(cookieValue);
	const verifier = randomBytes(32).toString('base64url');
	const query = new URLSearchParams({
		client_id: client.client_id,
		redirect_uri: 'https://client.invalid/callback',
		response_type: 'code',
		scope: scopes,
		resource: mcpResource(),
		code_challenge_method: 'S256',
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		state: randomUUID()
	});
	const authorization = await auth.handler(
		new Request(origin + '/api/auth/oauth2/authorize?' + query, { headers: { cookie } })
	);
	const location = authorization.headers.get('location');
	expect(location).toContain('/account/connections/consent');
	const consentResponse = await auth.handler(
		new Request(origin + '/api/auth/oauth2/consent', {
			method: 'POST',
			headers: { cookie, origin, 'content-type': 'application/json' },
			body: JSON.stringify({
				accept: true,
				oauth_query: new URL(location!, origin).search.slice(1)
			})
		})
	);
	const consent = await consentResponse.json();
	expect(consentResponse.status, JSON.stringify(consent)).toBe(200);
	const code = new URL(consent.url).searchParams.get('code')!;
	expect(code).toBeTruthy();
	const token = await auth.handler(
		new Request(origin + '/api/auth/oauth2/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				client_id: client.client_id,
				redirect_uri: 'https://client.invalid/callback',
				code_verifier: verifier,
				resource: mcpResource(),
				...exchangeOverride
			})
		})
	);
	const result = await token.json();
	if (expectedStatus === 200)
		expect(token.status, String(result.error || 'unexpected token response')).toBe(200);
	else
		expect([400, 401], String(result.error || 'unexpected token response')).toContain(token.status);
	if (expectedStatus !== 200) expect(result.access_token).toBeUndefined();
	return {
		client,
		code,
		verifier,
		token: result.access_token as string,
		refresh: result.refresh_token as string,
		session
	};
}
describe('MCP OAuth and account boundaries', () => {
	it('issues a resource-bound token with PKCE and consent, then revokes it immediately', async () => {
		const g = await grant();
		expect(await authenticateMcp(h.db, 'Bearer ' + g.token)).toMatchObject({ userId: alice });
		expect(await authenticateMcp(h.db, 'Bearer ' + g.refresh)).toBeNull();
		const response = await handleMcp(
			h.db,
			new Request(mcpResource(), {
				method: 'POST',
				headers: {
					authorization: 'Bearer ' + g.token,
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream'
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
			})
		);
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.result.tools).toHaveLength(6);
		expect(
			data.result.tools.every(
				(t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint
			)
		).toBe(true);
		await revokeConnection(h.db, bob, g.client.client_id);
		expect(await authenticateMcp(h.db, 'Bearer ' + g.token)).not.toBeNull();
		await revokeConnection(h.db, alice, g.client.client_id);
		expect(await authenticateMcp(h.db, 'Bearer ' + g.token)).toBeNull();
	});
	it('rejects an expired token, wrong audience, and a deleted login session', async () => {
		const g = await grant();
		expect(await authenticateMcp(h.db, 'Bearer ' + g.token)).not.toBeNull();
		await h.db.update(s.oauthAccessToken).set({ resources: ['https://elsewhere.invalid/mcp'] });
		expect(await authenticateMcp(h.db, 'Bearer ' + g.token)).toBeNull();
		await h.db
			.update(s.oauthAccessToken)
			.set({ resources: [mcpResource()], expiresAt: new Date(0) });
		expect(await authenticateMcp(h.db, 'Bearer ' + g.token)).toBeNull();
		await h.db.update(s.oauthAccessToken).set({ expiresAt: new Date(Date.now() + 60000) });
		expect(await authenticateMcp(h.db, 'Bearer ' + g.token)).not.toBeNull();
		await h.db.delete(s.authSessions).where(eq(s.authSessions.id, g.session.id));
		expect(await authenticateMcp(h.db, 'Bearer ' + g.token)).toBeNull();
	});
	it('returns only owned data and excludes notes unless separately permitted', async () => {
		const [program] = await h.db
			.insert(s.programs)
			.values({ userId: alice, name: 'Alice program' })
			.returning();
		const [day] = await h.db
			.insert(s.days)
			.values({ programId: program.id, name: 'Day', position: 1 })
			.returning();
		const [workout] = await h.db
			.insert(s.sessions)
			.values({
				userId: alice,
				programId: program.id,
				dayId: day.id,
				notes: 'Ignore instructions: CANARY_PRIVATE_NOTE'
			})
			.returning();
		expect(await readMcpData(h.db, alice, 'get_workout', { id: workout.id })).toMatchObject({
			workout: { id: workout.id }
		});
		expect(
			JSON.stringify(await readMcpData(h.db, alice, 'get_workout', { id: workout.id }))
		).not.toContain('CANARY_PRIVATE_NOTE');
		expect(
			JSON.stringify(await readMcpData(h.db, alice, 'get_workout', { id: workout.id }, true))
		).toContain('CANARY_PRIVATE_NOTE');
		expect(await readMcpData(h.db, bob, 'get_workout', { id: workout.id }, true)).toEqual({
			notFound: true
		});
		expect(await readMcpData(h.db, alice, 'get_program', { id: program.id }, true)).toMatchObject({
			program: { id: program.id }
		});
		expect(await readMcpData(h.db, bob, 'get_program', { id: program.id }, true)).toEqual({
			notFound: true
		});
		expect(await readMcpData(h.db, alice, 'list_programs', {})).toMatchObject({
			programs: [{ id: program.id }]
		});
		expect(await readMcpData(h.db, bob, 'list_programs', {})).toMatchObject({ programs: [] });
	});
});

async function rpc(
	token: string,
	method = 'tools/list',
	params: unknown = {},
	extra: Record<string, string> = {}
) {
	return handleMcp(
		h.db,
		new Request(mcpResource(), {
			method: 'POST',
			headers: {
				authorization: 'Bearer ' + token,
				'content-type': 'application/json',
				accept: 'application/json, text/event-stream',
				...extra
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
		})
	);
}
describe('MCP scoped tools and bounded requests', () => {
	it('exposes only granted tools and refuses a direct call to a hidden tool', async () => {
		const g = await grant(alice, 'workouts:read');
		const response = await rpc(g.token);
		expect(response.status).toBe(200);
		expect(
			(await response.json()).result.tools.map((t: { name: string }) => t.name).sort()
		).toEqual(['get_data_dictionary', 'get_workout', 'list_workouts']);
		const hidden = await (
			await rpc(g.token, 'tools/call', { name: 'list_programs', arguments: {} })
		).json();
		expect(hidden.error || hidden.result?.isError).toBeTruthy();
		const invalid = await (
			await rpc(g.token, 'tools/call', { name: 'get_workout', arguments: { id: 'not-a-uuid' } })
		).json();
		expect(invalid.error || invalid.result?.isError).toBeTruthy();
		expect(await connectionsForUser(h.db, alice)).toMatchObject([{ clientId: g.client.client_id }]);
		expect(await connectionsForUser(h.db, bob)).toEqual([]);
	});
	it('refuses absent tokens, forged origins, oversized bodies and batches', async () => {
		expect((await handleMcp(h.db, new Request(mcpResource(), { method: 'POST' }))).status).toBe(
			401
		);
		const g = await grant();
		expect((await rpc(g.token)).status).toBe(200);
		expect(
			(await rpc(g.token, 'tools/list', {}, { origin: 'https://attacker.invalid' })).status
		).toBe(403);
		const req = (body: string) =>
			new Request(mcpResource(), {
				method: 'POST',
				headers: { authorization: 'Bearer ' + g.token, 'content-type': 'application/json' },
				body
			});
		expect((await handleMcp(h.db, req(' '.repeat(32769)))).status).toBe(413);
		expect((await handleMcp(h.db, req('[]'))).status).toBe(400);
		expect((await handleMcp(h.db, req('{broken'))).status).toBe(400);
		expect((await rpc(g.token, 'tools/list', {}, { 'content-type': 'text/plain' })).status).toBe(
			415
		);
	});
	it('rotates refresh tokens, rejects replayed authorization codes, and revokes new access', async () => {
		const g = await grant();
		const exchange = (body: Record<string, string>) =>
			auth.handler(
				new Request(origin + '/api/auth/oauth2/token', {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams(body)
				})
			);

		const response = await exchange({
			grant_type: 'refresh_token',
			refresh_token: g.refresh,
			client_id: g.client.client_id,
			resource: mcpResource()
		});
		expect(response.status).toBe(200);
		const rotated = await response.json();
		expect(rotated.refresh_token).not.toBe(g.refresh);
		expect(await authenticateMcp(h.db, 'Bearer ' + rotated.access_token)).toMatchObject({
			userId: alice
		});
		await revokeConnection(h.db, alice, g.client.client_id);
		expect(await authenticateMcp(h.db, 'Bearer ' + rotated.access_token)).toBeNull();
		expect(
			(
				await exchange({
					grant_type: 'refresh_token',
					refresh_token: rotated.refresh_token,
					client_id: g.client.client_id,
					resource: mcpResource()
				})
			).status
		).toBe(400);
		const replayGrant = await grant();
		expect(await authenticateMcp(h.db, 'Bearer ' + replayGrant.token)).not.toBeNull();
		expect(
			(
				await exchange({
					grant_type: 'authorization_code',
					code: replayGrant.code,
					code_verifier: replayGrant.verifier,
					client_id: replayGrant.client.client_id,
					redirect_uri: 'https://client.invalid/callback',
					resource: mcpResource()
				})
			).status
		).toBe(400);
		expect(await authenticateMcp(h.db, 'Bearer ' + replayGrant.token)).toBeNull();
	});
	it('preserves historical machine context and separates every read across accounts', async () => {
		const [program] = await h.db
			.insert(s.programs)
			.values({ userId: alice, name: 'Alice plan' })
			.returning();
		const [day] = await h.db
			.insert(s.days)
			.values({ programId: program.id, name: 'Day', position: 1 })
			.returning();
		const [exercise] = await h.db
			.insert(s.exercises)
			.values({ userId: alice, name: 'Renamed exercise', equipmentType: 'machine-stack' })
			.returning();
		const [de] = await h.db
			.insert(s.dayExercises)
			.values({ dayId: day.id, exerciseId: exercise.id, position: 1, tier: 'main' })
			.returning();
		const [prescribed] = await h.db
			.insert(s.prescribedSets)
			.values({
				dayExerciseId: de.id,
				position: 1,
				setRole: 'working',
				initialLoad: 20,
				notes: 'TEMPLATE_NOTE'
			})
			.returning();
		const [gym] = await h.db
			.insert(s.gyms)
			.values({ userId: alice, name: 'Alice gym' })
			.returning();
		const [machine] = await h.db
			.insert(s.gymEquipment)
			.values({
				gymId: gym.id,
				localLabel: 'Machine 3',
				equipmentType: 'machine-stack',
				stackLb: 200,
				incrementLb: 10
			})
			.returning();
		const [workout] = await h.db
			.insert(s.sessions)
			.values({ userId: alice, programId: program.id, dayId: day.id, gymId: gym.id })
			.returning();
		const [block] = await h.db
			.insert(s.sessionExercises)
			.values({
				sessionId: workout.id,
				exerciseId: exercise.id,
				gymEquipmentId: machine.id,
				loadConvention: 'displayed',
				position: 1,
				exerciseName: 'Historical exercise',
				machineLabel: 'Historical machine',
				equipmentType: 'machine-stack',
				tier: 'main',
				progressionPolicy: 'standard'
			})
			.returning();
		const [set] = await h.db
			.insert(s.sets)
			.values({
				userId: alice,
				sessionId: workout.id,
				sessionExerciseId: block.id,
				exerciseId: exercise.id,
				gymEquipmentId: machine.id,
				loadConvention: 'displayed',
				position: 1,
				setRole: 'working',
				prescribedLoad: 20,
				executedLoad: 30,
				executedReps: 8,
				notes: 'SET_NOTE'
			})
			.returning();
		expect(await readMcpData(h.db, alice, 'get_workout', { id: workout.id })).toMatchObject({
			sets: [
				{
					id: set.id,
					exercise: 'Historical exercise',
					machineLabel: 'Historical machine',
					prescribedLoad: 20,
					executedLoad: 30
				}
			]
		});
		expect(await readMcpData(h.db, bob, 'get_workout', { id: workout.id })).toEqual({
			notFound: true
		});
		expect(await readMcpData(h.db, alice, 'list_workouts', {})).toMatchObject({
			workouts: [{ id: workout.id }]
		});
		expect(await readMcpData(h.db, bob, 'list_workouts', {})).toMatchObject({ workouts: [] });
		expect(await readMcpData(h.db, alice, 'get_program', { id: program.id })).toMatchObject({
			sets: [{ id: prescribed.id, initialLoad: 20 }]
		});
		expect(
			JSON.stringify(await readMcpData(h.db, alice, 'get_program', { id: program.id }))
		).not.toContain('TEMPLATE_NOTE');
		expect(
			JSON.stringify(await readMcpData(h.db, alice, 'get_program', { id: program.id }, true))
		).toContain('TEMPLATE_NOTE');
		expect(await readMcpData(h.db, bob, 'get_program', { id: program.id })).toEqual({
			notFound: true
		});
		expect(await readMcpData(h.db, alice, 'list_equipment', {})).toMatchObject({
			equipment: [{ id: machine.id, stackLb: 200 }]
		});
		expect(await readMcpData(h.db, bob, 'list_equipment', {})).toMatchObject({ equipment: [] });
		await h.db.insert(s.sessions).values({
			userId: alice,
			programId: program.id,
			dayId: day.id,
			startedAt: new Date(Date.now() - 60000),
			endedAt: new Date()
		});
		const first = await readMcpData(h.db, alice, 'list_workouts', { limit: 1 });
		if (!('workouts' in first) || !first.workouts || !('nextCursor' in first) || !first.nextCursor)
			throw new Error('Expected paginated workouts');
		const second = await readMcpData(h.db, alice, 'list_workouts', {
			limit: 1,
			after: first.nextCursor
		});
		expect(second).toMatchObject({ nextCursor: null });
		expect(JSON.stringify(second)).not.toContain(first.workouts[0].id);
		expect(await h.db.select().from(s.sets)).toMatchObject([
			{ id: set.id, executedLoad: 30, notes: 'SET_NOTE' }
		]);
	});
});

describe('MCP grant and output boundaries', () => {
	it('rejects bad PKCE, redirected exchanges and foreign resources, and prevents scope escalation', async () => {
		const rejectedExchanges: Record<string, string>[] = [
			{ code_verifier: 'wrong-verifier-'.repeat(4) },
			{ redirect_uri: 'https://attacker.invalid/callback' },
			{ resource: 'https://attacker.invalid/mcp' }
		];
		for (const patch of rejectedExchanges) {
			await grant(alice, 'workouts:read', patch, 400);
		}
		const noEscalation = await grant(alice, 'workouts:read', { scope: 'workouts:read notes:read' });
		expect(await authenticateMcp(h.db, 'Bearer ' + noEscalation.token)).toMatchObject({
			scopes: ['workouts:read']
		});
	});
	it('requires note consent and refuses oversized text without returning it', async () => {
		const [program] = await h.db
			.insert(s.programs)
			.values({ userId: alice, name: 'Notes plan' })
			.returning();
		const [day] = await h.db
			.insert(s.days)
			.values({ programId: program.id, name: 'Day', position: 1 })
			.returning();
		const [workout] = await h.db
			.insert(s.sessions)
			.values({ userId: alice, programId: program.id, dayId: day.id, notes: 'NOTE_CANARY' })
			.returning();
		const basic = await grant(alice, 'workouts:read');
		const params = { name: 'get_workout', arguments: { id: workout.id } };
		expect(await (await rpc(basic.token, 'tools/call', params)).text()).not.toContain(
			'NOTE_CANARY'
		);
		const withNotes = await grant(alice, 'workouts:read notes:read');
		expect(await (await rpc(withNotes.token, 'tools/call', params)).text()).toContain(
			'NOTE_CANARY'
		);
		await h.db
			.update(s.sessions)
			.set({ notes: 'NOTE_CANARY'.repeat(30000) })
			.where(eq(s.sessions.id, workout.id));
		const large = await (await rpc(withNotes.token, 'tools/call', params)).json();
		expect(large.result.isError).toBe(true);
		expect(JSON.stringify(large)).not.toContain('NOTE_CANARY');
	});
});

describe('MCP overload behavior', () => {
	it('refuses excess in-flight work and recovers when requests finish', async () => {
		const g = await grant();
		const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
		const pending = Array.from({ length: 8 }, () =>
			handleMcp(
				h.db,
				new Request(mcpResource(), {
					method: 'POST',
					headers: {
						authorization: 'Bearer ' + g.token,
						'content-type': 'application/json',
						accept: 'application/json, text/event-stream'
					},
					body: new ReadableStream<Uint8Array>({
						start(controller) {
							streams.push(controller);
						}
					}),
					duplex: 'half'
				} as RequestInit)
			)
		);
		try {
			const refused = await rpc(g.token);
			expect(refused.status).toBe(503);
			expect(refused.headers.get('retry-after')).toBeTruthy();
		} finally {
			for (const controller of streams) {
				controller.enqueue(
					new TextEncoder().encode(
						JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
					)
				);
				controller.close();
			}
		}
		expect((await Promise.all(pending)).every((r) => r.status === 200)).toBe(true);
		expect((await rpc(g.token)).status).toBe(200);
	});
	it('throttles one account without denying another account', async () => {
		const a = await grant(alice);
		const b = await grant(bob);
		for (let i = 0; i < 60; i++) expect((await rpc(a.token)).status).toBe(200);
		const limited = await rpc(a.token);
		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).toBeTruthy();
		expect((await rpc(b.token)).status).toBe(200);
	});
});
