/**
 * T5 bootstrap: turn the 0011 sentinel into Chris's real account.
 *
 * THE SENTINEL AND WHY IT EXISTS
 * ------------------------------
 * 0011 backfilled every pre-existing row to one placeholder owner,
 * `00000000-0000-4000-8000-000000000001` / `owner@localhost`, with
 * `email_verified false` and deliberately NO row in `auth.account` — nothing to
 * sign in with. Before this, T3's owner-scoped reads were live but every one of
 * Chris's 435 sets was invisible to him: his app came up empty.
 *
 * Bootstrap makes that placeholder signable. It does not migrate the data — the
 * data is already stamped with the sentinel id, which is exactly why claiming
 * the sentinel itself (rather than creating a new user and re-stamping) is the
 * only cheap way to hand 435 sets back to Chris.
 *
 * WHY NOT rename-and-reuse someone else's id
 * ------------------------------------------
 * Because the id is the foreign key on eight tables. Updating `auth.user`'s
 * primary key would cascade, or not, depending on constraint setup — and
 * getting it wrong silently orphans 435 sets. Keeping the id and changing the
 * login details is the safe direction.
 *
 * THE REFUSAL
 * -----------
 * If any user other than the sentinel exists, bootstrap refuses. It is the
 * FIRST-RUN step, and its whole job is claiming a virgin database's data. If it
 * finds real accounts it is being run in the wrong place, and "adopt the
 * sentinel" would be a surprising thing to do to a live instance. Refusing
 * loudly is the correct behaviour; `pnpm user:create` is the operator's tool
 * for adding accounts to a live database.
 *
 * It also refuses when the sentinel already has a credential row: the claim
 * has happened, and `pnpm user:set-password` changes the password. A claim
 * that failed part-way leaves nothing behind (it is one transaction — see
 * `claimSentinel`), so re-running bootstrap after a failure is always safe.
 * A sentinel that carries a real email but no credential row (left by the
 * pre-2026-11-08 three-statement claim if it crashed mid-way) is still
 * claimable, and a re-run completes it.
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Auth } from './auth-core';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { authTables, authUsers } from './db/auth-schema';
import { exercises } from './db/schema';
import { createUser } from './users';
import { STARTER_EXERCISES } from './starter-exercises';
import type { Database } from './progression';

/** The fixed id written by migration 0011. Not configurable: it is a FK target. */
export const SENTINEL_USER_ID = '00000000-0000-4000-8000-000000000001';
export const SENTINEL_EMAIL = 'owner@localhost';

export type BootstrapResult =
	| { kind: 'claimed-sentinel'; userId: string; email: string; starterExercises: number }
	| { kind: 'created-fresh'; userId: string; email: string; starterExercises: number };

const inputSchema = z.object({
	email: z
		.string()
		.trim()
		.email()
		.max(320)
		.transform((v) => v.toLowerCase()),
	password: z.string().min(1, 'Password is required'),
	name: z.string().trim().min(1).max(120)
});

/**
 * Claim the sentinel, or create a fresh account on a genuinely empty database.
 *
 * Neither path hand-writes the credential row: the fresh path uses
 * `createUser` (Better Auth's internalAdapter), and the claim uses Better
 * Auth's own drizzle adapter bound to the claim's transaction. A change to
 * Better Auth's account shape therefore breaks this CLI's sign-in test rather
 * than producing a user that cannot sign in.
 */
export async function bootstrap(
	auth: Auth,
	db: Database,
	raw: { email: string; password: string; name: string }
): Promise<BootstrapResult> {
	const input = inputSchema.parse(raw);

	const [sentinel] = await db
		.select({ id: authUsers.id })
		.from(authUsers)
		.where(eq(authUsers.id, SENTINEL_USER_ID));

	if (!sentinel) {
		// No sentinel: either a brand-new install, or a database that predates
		// 0011. Creating fresh is correct in both cases.
		const others = await otherUserCount(db);
		if (others > 0) {
			throw new Error(
				`Refusing to bootstrap: ${others} user(s) exist and there is no 0011 sentinel to claim. ` +
					`This database was not migrated to 0011, or it already has real accounts. Use pnpm user:create instead.`
			);
		}
		const created = await createUser(auth, db, input);
		return {
			kind: 'created-fresh',
			userId: created.id,
			email: created.email,
			starterExercises: await starterCount(db, created.id)
		};
	}

	await claimSentinel(auth, db, input);

	return {
		kind: 'claimed-sentinel',
		userId: SENTINEL_USER_ID,
		email: input.email,
		starterExercises: await starterCount(db, SENTINEL_USER_ID)
	};
}

/**
 * Claim the sentinel in place: same primary key, new login details, a
 * credential row and the starter list — ONE transaction, all or nothing.
 *
 * WHY ONE TRANSACTION
 * -------------------
 * The first version ran three statements on the pool: UPDATE the user, then
 * Better Auth's `linkAccount`, then the starter insert. A failure after the
 * UPDATE left a sentinel that carried the operator's email but had no
 * credential row — a state no message named: `user:set-password` said "no
 * credential account" and the startup warning still described an unclaimed
 * 0011 sentinel. Now a failure anywhere rolls the whole claim back, and the
 * database is exactly as 0011 left it.
 *
 * WHY THE CREDENTIAL ROW IS NOT `linkAccount`
 * -------------------------------------------
 * `ctx.internalAdapter.linkAccount` writes through the adapter Better Auth was
 * built with, which is bound to the pool, not to this transaction (the drizzle
 * adapter's `transaction` option is off, and the CLI's pool has ONE
 * connection, so a pool write inside this transaction would wait for itself
 * forever). So the row is written by the SAME public adapter factory
 * (`better-auth/adapters/drizzle`), with the same options and Better Auth's
 * resolved config (`ctx.options`: id generation, field names), bound to `tx`.
 * The payload is exactly what `linkAccount` sends
 * (better-auth 1.7.7 dist/db/internal-adapter.mjs:594): createdAt, updatedAt,
 * userId, providerId 'credential', accountId === userId, password hash.
 *
 * What that skips is `linkAccount`'s `databaseHooks.account.create` hooks.
 * None exist (auth-core.ts registers only `user.create.after`; oauth-provider
 * only `session.delete`). A configured account hook is refused below rather
 * than silently skipped. A plugin's hooks are not visible on the context, so
 * a new plugin with an account hook must be checked here by hand.
 *
 * WHY "ALREADY HAS A CREDENTIAL" IS A REFUSAL, NOT A NO-OP
 * --------------------------------------------------------
 * `auth.account` has no unique constraint on (provider_id, account_id), so a
 * second claim used to insert a SECOND credential row for the sentinel. And a
 * re-run carries a password: treating it as "already provisioned, nothing to
 * do" would silently ignore it. `pnpm user:set-password` is the tool for that.
 *
 * The sentinel row is locked FOR UPDATE first, so two concurrent runs
 * serialise: the second sees the first one's credential row and refuses.
 */
async function claimSentinel(
	auth: Auth,
	db: Database,
	input: { email: string; password: string; name: string }
): Promise<void> {
	const ctx = await auth.$context;
	const hooks = ctx.options.databaseHooks as { account?: { create?: unknown } } | undefined;
	if (hooks?.account?.create) {
		throw new Error(
			'Refusing to bootstrap: an auth.account create hook is configured, and the transactional ' +
				'claim writes the credential row without running it. Teach bootstrap.ts about the hook first.'
		);
	}
	// Hash before the transaction: scrypt is slow and needs no lock.
	const hash = await ctx.password.hash(input.password);

	await db.transaction(async (tx) => {
		const locked = await tx.execute<{ email: string }>(
			sql`select email from auth.user where id = ${SENTINEL_USER_ID} for update`
		);
		if (locked.length === 0) {
			throw new Error('Refusing to bootstrap: the 0011 sentinel disappeared while claiming it.');
		}

		const others = await otherUserCount(tx);
		if (others > 0) {
			throw new Error(
				`Refusing to bootstrap: found the 0011 sentinel AND ${others} other user(s). ` +
					`Bootstrap claims the sentinel, which is a first-run step; this database is already in use. ` +
					`Use pnpm user:create, or pnpm user:set-password, to add or fix an account.`
			);
		}

		const [credential] = await tx.execute<{ n: number }>(
			sql`select count(*)::int as n from auth.account
			    where user_id = ${SENTINEL_USER_ID} and provider_id = 'credential'`
		);
		if (Number(credential?.n ?? 0) > 0) {
			throw new Error(
				`Refusing to bootstrap: the 0011 sentinel is already claimed as ${locked[0].email} ` +
					`and has a password. Bootstrap is a first-run step and does not change passwords. ` +
					`Use pnpm user:set-password --email ${locked[0].email} instead.`
			);
		}

		// 0011 deliberately left email_verified false and NO credential row, so
		// both are set here — an operator-created account with no email flow is
		// verified, exactly as createUser creates them.
		await tx
			.update(authUsers)
			.set({ email: input.email, name: input.name, emailVerified: true, updatedAt: new Date() })
			.where(eq(authUsers.id, SENTINEL_USER_ID));

		const txAdapter = drizzleAdapter(tx, {
			provider: 'pg',
			schemaName: 'auth',
			schema: authTables
		})(ctx.options);
		await txAdapter.create({
			model: 'account',
			data: {
				createdAt: new Date(),
				updatedAt: new Date(),
				userId: SENTINEL_USER_ID,
				providerId: 'credential',
				accountId: SENTINEL_USER_ID,
				password: hash
			}
		});

		// The starter list. The sentinel predates the hook, so it never received
		// one. onConflictDoNothing keeps a name the user already has.
		await tx
			.insert(exercises)
			.values(
				STARTER_EXERCISES.map((e) => ({
					userId: SENTINEL_USER_ID,
					name: e.name,
					equipmentType: e.equipmentType,
					isLowerBody: e.isLowerBody ?? false,
					bodyRegion: e.bodyRegion
				}))
			)
			.onConflictDoNothing({ target: [exercises.userId, exercises.name] });
	});
}

type Executor = Pick<Database, 'execute'>;

async function otherUserCount(db: Executor): Promise<number> {
	const [row] = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from auth.user where id <> ${SENTINEL_USER_ID}`
	);
	return Number(row?.n ?? 0);
}

/** How many exercises this user can see. Reported so the operator knows it worked. */
async function starterCount(db: Database, userId: string): Promise<number> {
	const [row] = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from exercises where user_id = ${userId}`
	);
	return Number(row?.n ?? 0);
}

export { setPassword } from './users';
