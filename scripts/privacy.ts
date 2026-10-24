import { configureStorageLocks, closeStorageLocks } from '../src/lib/server/privacy/storage-lock';
/** Deliberately no timer or production wrapper: review activation separately. */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, gt, isNull } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import { fileLedger, readLedger } from '../src/lib/server/privacy/ledger';
import { reconcileDeletions, runDeletion } from '../src/lib/server/privacy/lifecycle';
import {
	RETENTION_DEFAULTS,
	sweepRetention,
	sweepExpiredHandshakes
} from '../src/lib/server/privacy/retention';
import { createPhotoStore } from '../src/lib/server/photos/store';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		mode: { type: 'string', default: 'retention' },
		apply: { type: 'boolean', default: false },
		all: { type: 'boolean', default: false },
		owner: { type: 'string' },
		after: { type: 'string' },
		limit: { type: 'string', default: '25' },
		ledger: { type: 'string' },
		'details-days': { type: 'string' },
		'records-days': { type: 'string' },
		'expired-auth-days': { type: 'string' },
		'discarded-days': { type: 'string' }
	},
	strict: true
});
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be supplied explicitly');
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
if (!['retention', 'deletions', 'reconcile'].includes(values.mode!))
	throw new Error('Unknown privacy mode');
if (!values.owner && !values.all) throw new Error('Choose --owner or --all explicitly');
if (values.owner && values.all) throw new Error('Choose exactly one scope');
const client = postgres(process.env.DATABASE_URL, { max: 3, onnotice: () => {} });
const db = drizzle(client, { schema });
configureStorageLocks(db, process.env.DATABASE_URL);
try {
	if (values.mode === 'reconcile') {
		if (!values.ledger || !values.all)
			throw new Error('Reconciliation requires --all --ledger newest-independent-journal');
		console.log(
			JSON.stringify(await reconcileDeletions(db, await readLedger(values.ledger), values.apply))
		);
	} else if (values.mode === 'deletions') {
		const jobs = await db
			.select()
			.from(schema.privacyDeletions)
			.where(
				and(
					isNull(schema.privacyDeletions.completedAt),
					values.owner ? eq(schema.privacyDeletions.ownerId, values.owner) : undefined
				)
			)
			.orderBy(schema.privacyDeletions.requestedAt)
			.limit(limit);
		if (!values.apply)
			console.log(JSON.stringify({ mode: 'dry-run', pendingJobs: jobs.length, limit }));
		else {
			const ledger = fileLedger(values.ledger);
			const store = createPhotoStore();
			const counts = { completed: 0, pending: 0, failed: 0, not_found: 0, removed: 0 };
			for (const job of jobs) {
				if (!job.ownerId) continue;
				const result = await runDeletion(db, job.ownerId, job.id, store, ledger, limit);
				counts[result.state]++;
				counts.removed += result.removed;
			}
			console.log(JSON.stringify(counts));
			if (counts.failed) process.exitCode = 1;
		}
	} else {
		const users = await db
			.select({ id: schema.authUsers.id })
			.from(schema.authUsers)
			.where(
				and(
					values.owner ? eq(schema.authUsers.id, values.owner) : undefined,
					values.after ? gt(schema.authUsers.id, values.after) : undefined
				)
			)
			.orderBy(schema.authUsers.id)
			.limit(limit);
		const policy = {
			detailsDays: Number(values['details-days'] ?? RETENTION_DEFAULTS.detailsDays),
			recordsDays: Number(values['records-days'] ?? RETENTION_DEFAULTS.recordsDays),
			expiredAuthDays: Number(values['expired-auth-days'] ?? RETENTION_DEFAULTS.expiredAuthDays),
			discardedDays: Number(values['discarded-days'] ?? RETENTION_DEFAULTS.discardedDays)
		};
		const results = [];
		const now = new Date();
		const store = values.apply ? createPhotoStore() : undefined;
		for (const user of users)
			results.push(
				await sweepRetention(db, user.id, { apply: values.apply, limit, policy, now, store })
			);
		const totals = results.reduce(
			(a, r) => {
				for (const key of Object.keys(r) as (keyof typeof r)[])
					if (typeof r[key] === 'number') a[key] = (a[key] ?? 0) + Number(r[key]);
				return a;
			},
			{} as Record<string, number>
		);
		const handshakes = values.all
			? await sweepExpiredHandshakes(db, {
					apply: values.apply,
					now,
					limit,
					graceDays: policy.expiredAuthDays
				})
			: null;
		console.log(
			JSON.stringify({
				handshakes,
				mode: values.apply ? 'apply' : 'dry-run',
				accounts: users.length,
				policy,
				totals,
				nextAfter: users.length === limit ? users.at(-1)?.id : null
			})
		);
		if (totals.failed) process.exitCode = 1;
	}
} catch {
	// Database/provider errors can embed identifiers, SQL values or signed URLs.
	console.error(
		JSON.stringify({
			mode: values.mode,
			error: 'Privacy operation failed; verify configuration and retry the same scope.'
		})
	);
	process.exitCode = 1;
} finally {
	await closeStorageLocks(db);
	await client.end({ timeout: 5 });
}
