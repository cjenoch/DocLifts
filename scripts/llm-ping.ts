/**
 * pnpm llm:ping --email <account email>
 *
 * The smoke test for the LLM key: ONE real `complete()` call with
 * purpose 'ping', on behalf of the named account, through the same seam every
 * feature uses — so it is recorded in `llm_calls` and counted against that
 * account's hourly cap like any other call. It is the acceptance test for the
 * key and the passthrough lines, not for the module (the offline tests in
 * src/lib/server/llm/llm.db.test.ts are that).
 *
 * Built like src/lib/server/db/seed.ts: its own postgres() client from
 * process.env.DATABASE_URL, no app singleton, no $env — this runs under bare
 * tsx, outside SvelteKit. The LLM settings come from process.env as well
 * (OPENROUTER_API_KEY, LLM_MODEL, ...); the key is never printed.
 *
 * It costs a real (tiny) provider call, so nothing runs it automatically: not
 * CI, not a test. In production it runs once, by hand, in the builder image —
 * see docs/llm.md "Smoke test".
 *
 * Exit status: 0 on an `ok` row; 1 on any LlmError (the row id is printed, the
 * row exists); 2 on usage errors.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { z } from 'zod';
import * as schema from '../src/lib/server/db/schema';
import { authUsers } from '../src/lib/server/db/auth-schema';
import { complete, LlmError } from '../src/lib/server/llm';

const args = process.argv.slice(2);
const emailAt = args.indexOf('--email');
const email = emailAt >= 0 ? args[emailAt + 1]?.trim().toLowerCase() : undefined;
if (!email || args.length !== 2) {
	console.error('Usage: pnpm llm:ping --email <account email>');
	process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is required. Pass --env-file=.env or export it.');
	process.exit(2);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });
try {
	const [user] = await db
		.select({ id: authUsers.id })
		.from(authUsers)
		.where(eq(authUsers.email, email));
	if (!user) {
		console.error('No account with that email.');
		process.exitCode = 2;
	} else {
		const { output, callId } = await complete(db, user.id, {
			purpose: 'ping',
			system: 'You answer with a JSON object that matches the requested schema, and nothing else.',
			messages: [{ role: 'user', content: 'Reply with ok true and the model name you are.' }],
			schema: z.object({ ok: z.boolean(), model: z.string() })
		});
		const [row] = await db.select().from(schema.llmCalls).where(eq(schema.llmCalls.id, callId));
		console.log(
			JSON.stringify(
				{
					output,
					call_id: callId,
					model_sent: row.model,
					prompt_tokens: row.promptTokens,
					completion_tokens: row.completionTokens,
					latency_ms: row.latencyMs
				},
				null,
				2
			)
		);
	}
} catch (error) {
	if (error instanceof LlmError) {
		console.error(`${error.name}: ${error.message} (llm_calls row ${error.callId})`);
	} else {
		console.error(error instanceof Error ? error.message : 'llm:ping failed.');
	}
	process.exitCode = 1;
} finally {
	await client.end();
}
