import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { chromium, type Browser } from 'playwright';
import {
	freshTestDb,
	seedTestUser,
	startTestServer,
	TEST_PASSWORD
} from '$lib/server/test-auth-helpers';
import { oauthFixture, RESOURCE } from './mcp-fixture';
import * as s from '$lib/server/db/schema';
let h: Awaited<ReturnType<typeof freshTestDb>>,
	browser: Browser,
	origin: string,
	stop = async () => {};
let email: string, workoutId: string;
beforeAll(async () => {
	h = await freshTestDb();
	const owner = await seedTestUser(h.db);
	email = owner.email;
	const [program] = await h.db
		.insert(s.programs)
		.values({ userId: owner.id, name: 'MCP fixture program' })
		.returning();
	const [day] = await h.db
		.insert(s.days)
		.values({ programId: program.id, name: 'Day', position: 1 })
		.returning();
	const [session] = await h.db
		.insert(s.sessions)
		.values({
			userId: owner.id,
			programId: program.id,
			dayId: day.id,
			notes: 'PRIVATE_HEALTH_NOTE'
		})
		.returning();
	workoutId = session.id;
	const importId = randomUUID();
	await h.db.insert(s.workoutLogImports).values({
		id: importId,
		userId: owner.id,
		sourceSha256: randomUUID(),
		sourceName: 'Private notebook',
		sourceText: 'PRIVATE_ARCHIVE_DOCUMENT'
	});
	await h.db.insert(s.importedWorkouts).values({
		id: randomUUID(),
		importId,
		sourceLine: 1,
		title: 'Archive fixture',
		workoutDate: '2024-05-01',
		dateNote: 'PRIVATE_DATE_NOTE',
		lines: [
			{
				sourceLine: 2,
				text: 'PRIVATE_ARCHIVE_LINE',
				loadConvention: 'total_plates',
				interpretationNote: null,
				sets: [{ load: 137, reps: 7, evidence: 'explicit' }]
			}
		]
	});
	const app = await startTestServer();
	origin = app.origin;
	stop = app.stop;
	browser = await chromium.launch({ executablePath: process.env.PW_EXECUTABLE_PATH });
});
afterAll(async () => {
	await browser?.close();
	await stop();
	await h?.end();
});
async function rpc(token: string, method: string, params: unknown = {}) {
	return fetch(origin + '/mcp', {
		method: 'POST',
		headers: {
			authorization: 'Bearer ' + token,
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream'
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	});
}
describe('real MCP connection controls', () => {
	it('keeps form CSRF protection everywhere except cookie-free native token exchange', async () => {
		const endpoints = [
			'/login',
			'/gyms?/createGym',
			'/account/connections/consent',
			'/api/auth/sign-in/email',
			'/api/auth/oauth2/token',
			'/api/auth/oauth2/token/',
			'/api/auth/oauth2/token/other'
		];
		for (const path of endpoints) {
			for (const headers of [
				{ origin: 'https://attacker.invalid' },
				{ cookie: 'unrelated=present' }
			]) {
				const response = await fetch(origin + path, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
					body: 'grant_type=authorization_code',
					redirect: 'manual'
				});
				expect(response.status, path).toBe(403);
			}
		}
		const native = await fetch(origin + '/api/auth/oauth2/token', {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'grant_type=authorization_code',
			redirect: 'manual'
		});
		expect(native.status).toBe(400); // Reaches OAuth validation, never authenticates a malformed grant.
		const metadata = await fetch(origin + '/.well-known/oauth-authorization-server/api/auth');
		expect(metadata.status).toBe(200);
		expect((await metadata.json()).token_endpoint).toBe(origin + '/api/auth/oauth2/token');
		const resource = await fetch(origin + '/.well-known/oauth-protected-resource/mcp');
		expect(resource.status).toBe(200);
		expect((await resource.json()).resource).toBe(RESOURCE);
	});
	it.each([true, false])(
		'signs in, reads, refreshes and revokes (explicit resource: %s)',
		async (includeResource) => {
			const flow = await oauthFixture(origin, undefined, undefined, includeResource);
			const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
			await page.route('https://client.invalid/**', (r) =>
				r.fulfill({ status: 200, contentType: 'text/html', body: 'Connected' })
			);
			await page.goto(flow.authorize);
			await page.waitForURL('**/login?**');
			await page.getByRole('button', { name: 'Show password', exact: true }).waitFor();
			await page.waitForLoadState('networkidle');
			await page.locator('input[name=email]').fill(email);
			await page.locator('#password').fill(TEST_PASSWORD);
			await page.locator('form:has(#password) button[type=submit]').click();
			await page.waitForURL('**/account/connections/consent?**');
			await page.getByRole('heading', { name: 'Connect Test agent?' }).waitFor();
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
				390
			);
			await page.waitForLoadState('networkidle');
			const approval = page.waitForResponse(
				(r) => r.request().method() === 'POST' && r.url().includes('/consent'),
				{ timeout: 5000 }
			);
			await page.getByRole('button', { name: 'Allow read access', exact: true }).click();
			const approvalResponse = await approval;
			expect(approvalResponse.status()).toBe(200);
			await page
				.waitForURL('https://client.invalid/callback?**', { timeout: 5000 })
				.catch(async () => {
					throw new Error('Consent did not redirect: ' + (await page.locator('main').innerText()));
				});
			const code = new URL(page.url()).searchParams.get('code')!;
			const exchange = await fetch(origin + '/api/auth/oauth2/token', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'authorization_code',
					code,
					client_id: flow.client.client_id,
					redirect_uri: 'https://client.invalid/callback',
					code_verifier: flow.verifier,
					...(includeResource ? { resource: RESOURCE } : {})
				})
			});
			expect(exchange.status).toBe(200);
			let tokens = await exchange.json();
			const rotated = await fetch(origin + '/api/auth/oauth2/token', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: tokens.refresh_token,
					client_id: flow.client.client_id,
					...(includeResource ? { resource: RESOURCE } : {})
				})
			});
			expect(rotated.status).toBe(200);
			tokens = await rotated.json();
			const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
			const { StreamableHTTPClientTransport } =
				await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
			const client = new Client({ name: 'DocLifts acceptance test', version: '1' });
			await client.connect(
				new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
					requestInit: { headers: { authorization: 'Bearer ' + tokens.access_token } }
				})
			);
			expect((await client.listTools()).tools).toHaveLength(7);
			const read = await client.callTool({ name: 'get_workout', arguments: { id: workoutId } });
			expect(JSON.stringify(read)).toContain(workoutId);
			expect(JSON.stringify(read)).not.toContain('PRIVATE_HEALTH_NOTE');
			const imported = await client.callTool({
				name: 'list_imported_workouts',
				arguments: { limit: 50 }
			});
			expect(imported.isError).not.toBe(true);
			expect(imported.structuredContent).toMatchObject({
				source: 'imported_notebook',
				workouts: [
					{
						title: 'Archive fixture',
						workoutDate: '2024-05-01',
						lines: [{ sets: [{ load: 137, reps: 7, evidence: 'explicit' }] }]
					}
				]
			});
			expect(JSON.stringify(imported)).not.toMatch(/PRIVATE_ARCHIVE|PRIVATE_DATE_NOTE/);
			expect((await rpc(tokens.refresh_token, 'tools/list')).status).toBe(401);
			await page.goto(origin + '/account');
			await page.getByRole('link', { name: 'Connected agents', exact: true }).click();
			await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
			await page.getByRole('status').waitFor();
			expect((await rpc(tokens.access_token, 'tools/list')).status).toBe(401);
			const refresh = await fetch(origin + '/api/auth/oauth2/token', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: tokens.refresh_token,
					client_id: flow.client.client_id,
					...(includeResource ? { resource: RESOURCE } : {})
				})
			});
			expect(refresh.status).toBe(400);
			await client.close();
			await page.close();
		}
	);
	it('does not replace an explicitly wrong resource with the default', async () => {
		const flow = await oauthFixture(origin);
		for (const resource of ['https://attacker.invalid/mcp', 'https://doclifts-mcp.runthe.ai']) {
			const url = new URL(flow.authorize);
			url.searchParams.set('resource', resource);
			const response = await fetch(url, { redirect: 'manual' });
			const result = await response.json();
			const callback = new URL(result.url);
			expect(callback.origin).toBe('https://client.invalid');
			expect(callback.searchParams.get('error')).toBe('invalid_target');
			expect(callback.searchParams.has('code')).toBe(false);
		}
	});
	it('denies consent without issuing a code and rejects tampering', async () => {
		const flow = await oauthFixture(origin);
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		await page.route('https://client.invalid/**', (r) =>
			r.fulfill({ status: 200, body: 'Denied' })
		);
		await page.goto(flow.authorize);
		await page.getByRole('button', { name: 'Show password', exact: true }).waitFor();
		await page.waitForLoadState('networkidle');
		await page.locator('input[name=email]').fill(email);
		await page.locator('#password').fill(TEST_PASSWORD);
		await page.locator('form:has(#password) button[type=submit]').click();
		await page.waitForURL('**/account/connections/consent?**');
		const valid = page.url(),
			tampered = new URL(valid);
		const missingResource = new URL(valid);
		missingResource.searchParams.delete('resource');
		expect((await page.request.get(missingResource.href)).status()).toBe(400);
		tampered.searchParams.set('scope', 'notes:read');
		expect((await page.request.get(tampered.href)).status()).toBe(400);
		await page.waitForLoadState('networkidle');
		const denial = page.waitForResponse(
			(r) => r.request().method() === 'POST' && r.url().includes('/consent'),
			{ timeout: 5000 }
		);
		await page.getByRole('button', { name: 'Deny', exact: true }).click();
		const denialResponse = await denial;
		expect(denialResponse.status()).toBe(200);
		await page
			.waitForURL('https://client.invalid/callback?**', { timeout: 5000 })
			.catch(async () => {
				throw new Error('Consent did not redirect: ' + (await page.locator('main').innerText()));
			});
		expect(new URL(page.url()).searchParams.get('code')).toBeNull();
		expect(new URL(page.url()).searchParams.get('error')).toBe('access_denied');
		await page.close();
	});
});
