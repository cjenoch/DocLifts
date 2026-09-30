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
 */
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Auth } from './auth-core';
import { authUsers } from './db/auth-schema';
import { exercises } from './db/schema';
import { createUser } from './users';
import { STARTER_EXERCISES } from './starter-exercises';
import type { Database } from './progression';

/** The fixed id written by migration 0011. Not configurable: it is a FK target. */
export const SENTINEL_USER_ID = '00000000-0000-4000-8000-000000000001';
export const SENTINEL_EMAIL = 'owner@localhost';

export type BootstrapResult =
	| { kind: 'claimed-sentinel'; userId: string; email: string; starterExercises: number }
	| { kind: 'created-fresh'; userId: string; email: string; starterExercises: number }
	| { kind: 'already-provisioned'; userId: string; email: string; starterExercises: number };

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
 * Both paths go through `createUser`'s primitives deliberately: the credential
 * row is created by Better Auth's own internalAdapter, not hand-written, so a
 * change to Better Auth's account shape breaks this CLI and the e2e together
 * rather than producing a user that cannot sign in.
 */
export async function bootstrap(
	auth: Auth,
	db: Database,
	raw: { email: string; password: string; name: string }
): Promise<BootstrapResult> {
	const input = inputSchema.parse(raw);

	const [sentinel] = await db
		.select({ id: authUsers.id, email: authUsers.email, name: authUsers.name })
		.from(authUsers)
		.where(eq(authUsers.id, SENTINEL_USER_ID));
	const [others] = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from auth.user where id <> ${SENTINEL_USER_ID}`
	);

	if (!sentinel) {
		// No sentinel: either a brand-new install, or a database that predates
		// 0011. Creating fresh is correct in both cases.
		if (Number(others?.n ?? 0) > 0) {
			throw new Error(
				`Refusing to bootstrap: ${others?.n} user(s) exist and there is no 0011 sentinel to claim. ` +
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

	if (Number(others?.n ?? 0) > 0) {
		throw new Error(
			`Refusing to bootstrap: found the 0011 sentinel AND ${others?.n} other user(s). ` +
				`Bootstrap claims the sentinel, which is a first-run step; this database is already in use. ` +
				`Use pnpm user:create, or pnpm user:set-password, to add or fix an account.`
		);
	}

	// The sentinel exists and is alone. Claim it in place: same primary key,
	// new login details. 0011 deliberately left email_verified false and NO
	// credential row, so both are set here — an operator-created account with no
	// email flow is verified, exactly as createUser creates them.
	await db
		.update(authUsers)
		.set({ email: input.email, name: input.name, emailVerified: true })
		.where(eq(authUsers.id, SENTINEL_USER_ID));

	// The credential row cannot be created by `createUser`, which inserts a new
	// auth.user row. Link it directly against the sentinel id — same call, same
	// (userId, 'credential', accountId === userId) shape sign-up uses.
	const ctx = await auth.$context;
	await ctx.internalAdapter.linkAccount({
		userId: SENTINEL_USER_ID,
		providerId: 'credential',
		accountId: SENTINEL_USER_ID,
		password: await ctx.password.hash(input.password)
	});

	// The starter list. The sentinel predates the hook, so it never received
	// one. onConflictDoNothing keeps this safe if bootstrap is re-run.
	await db
		.insert(exercises)
		.values(
			STARTER_EXERCISES.map((e) => ({
				userId: SENTINEL_USER_ID,
				name: e.name,
				equipmentType: e.equipmentType,
				isLowerBody: e.isLowerBody ?? false
			}))
		)
		.onConflictDoNothing({ target: [exercises.userId, exercises.name] });

	return {
		kind: 'claimed-sentinel',
		userId: SENTINEL_USER_ID,
		email: input.email,
		starterExercises: await starterCount(db, SENTINEL_USER_ID)
	};
}

/** How many exercises this user can see. Reported so the operator knows it worked. */
async function starterCount(db: Database, userId: string): Promise<number> {
	const [row] = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from exercises where user_id = ${userId}`
	);
	return Number(row?.n ?? 0);
}

/** Is there any account anyone can actually sign in as? Drives the startup warning. */
export async function hasLoginCapableAccount(db: Database): Promise<boolean> {
	const [row] = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from auth.account where "providerId" = 'credential'`
	);
	return Number(row?.n ?? 0) > 0;
}

export { setPassword } from './users';
