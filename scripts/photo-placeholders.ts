/**
 * pnpm photo:placeholders [--apply --expect <fingerprint>]
 *
 * One-time, operator-run cleanup (2026-11-08): archives the "Photo 2:32 PM"
 * placeholder machines `openPhotoBlock` made before c5bb02c, whose photo
 * carries no machine link, so the evidence rule in `photoPlaceholderOf` keeps
 * them forever once their block has left them. Archive only, never delete: an
 * archived machine leaves every chooser and comes back with Restore on the
 * gym page (`restoreMachine`). The rules are `legacyPhotoPlaceholders` and
 * `archiveLegacyPhotoPlaceholders` in src/lib/server/machine-admin.ts.
 *
 * Default is a dry run: per user (by id, never email) and machine, the gym,
 * the label and the evidence, then totals and a fingerprint of the candidate
 * ids. `--apply` lists again, refuses with nothing written when `--expect` is
 * given and the fingerprint differs, archives, and lists once more: a second
 * run must find 0.
 *
 * Built like scripts/catalog-import.ts: its own postgres() client from
 * DATABASE_URL, no app singleton, no $env, no auth secret.
 *
 * Exit status: 0 on success; 1 on a fingerprint mismatch (nothing written) or
 * when candidates remain after apply (skipped; rerun); 2 on usage errors.
 *
 * In production this runs through scripts/photo-placeholders-prod.sh.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { asc } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../src/lib/server/db/schema';
import {
	archiveLegacyPhotoPlaceholders,
	legacyPhotoPlaceholders,
	PHOTO_LABEL_WINDOW_MINUTES,
	placeholderFingerprint,
	type LegacyPhotoPlaceholder
} from '../src/lib/server/machine-admin';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const expectAt = args.indexOf('--expect');
const expected = expectAt >= 0 ? args[expectAt + 1] : undefined;
const known = new Set(['--apply', '--expect']);
const unknown = args.filter((a, i) => !known.has(a) && !(expectAt >= 0 && i === expectAt + 1));
if (
	unknown.length ||
	(expectAt >= 0 && !/^[0-9a-f]{64}$/.test(expected ?? '')) ||
	(expectAt >= 0 && !apply)
) {
	console.error(
		'Usage: pnpm photo:placeholders [--apply [--expect <fingerprint from the dry run>]]'
	);
	process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is required. Pass --env-file=.env or export it.');
	process.exit(2);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });
type Db = typeof db;

/** Every user who has a gym: only they can have a machine. */
async function usersWithGyms(db: Db): Promise<string[]> {
	const rows = await db
		.selectDistinct({ userId: schema.gyms.userId })
		.from(schema.gyms)
		.orderBy(asc(schema.gyms.userId));
	return rows.map((r) => r.userId);
}

async function listAll(db: Db): Promise<Map<string, LegacyPhotoPlaceholder[]>> {
	const byUser = new Map<string, LegacyPhotoPlaceholder[]>();
	for (const userId of await usersWithGyms(db)) {
		const found = await legacyPhotoPlaceholders(db, userId);
		if (found.length) byUser.set(userId, found);
	}
	return byUser;
}

function evidenceLine(p: LegacyPhotoPlaceholder): string {
	return p.evidence.kind === 'photo-time'
		? `strong: photo timing match (photo ${p.evidence.photoId} created ${p.evidence.photoCreatedAt.toISOString()}, 0-${PHOTO_LABEL_WINDOW_MINUTES} min after the label's minute)`
		: 'weak: label only (no unlinked photo of this user at this gym in the window)';
}

function report(byUser: Map<string, LegacyPhotoPlaceholder[]>): string[] {
	const all = [...byUser.values()].flat();
	for (const [userId, found] of byUser) {
		console.log(`user ${userId}`);
		for (const p of found) {
			console.log(`  machine ${p.machineId}`);
			console.log(`    gym:      ${JSON.stringify(p.gymName)} (${p.gymId})`);
			console.log(`    label:    ${JSON.stringify(p.label)}`);
			console.log('    created:  not recorded (gym_equipment has no created_at)');
			console.log(`    evidence: ${evidenceLine(p)}`);
		}
	}
	const strong = all.filter((p) => p.evidence.kind === 'photo-time').length;
	console.log(
		`totals: users ${byUser.size}, machines ${all.length} (strong ${strong}, weak ${all.length - strong})`
	);
	console.log(`fingerprint: ${placeholderFingerprint(all.map((p) => p.machineId))}`);
	return all.map((p) => p.machineId);
}

try {
	console.log(
		apply ? '==> apply: archiving legacy photo placeholders' : '==> dry run: nothing is written'
	);
	const byUser = await listAll(db);
	const ids = report(byUser);
	if (!apply) {
		console.log('Dry run only. Run with --apply to archive these.');
	} else if (expected && placeholderFingerprint(ids) !== expected) {
		console.error(
			'fingerprint differs from the dry run: the candidates changed. Nothing was written; run again.'
		);
		process.exitCode = 1;
	} else {
		let archived = 0;
		let skipped = 0;
		for (const [userId, found] of byUser) {
			const result = await archiveLegacyPhotoPlaceholders(
				db,
				userId,
				found.map((p) => p.machineId)
			);
			archived += result.archived.length;
			skipped += result.skipped.length;
			for (const id of result.archived) console.log(`archived ${id} (user ${userId})`);
			for (const s of result.skipped)
				console.log(`skipped  ${s.machineId} (user ${userId}): ${s.reason}`);
		}
		console.log(`apply totals: archived ${archived}, skipped ${skipped}`);
		const remaining = [...(await listAll(db)).values()].flat().length;
		console.log(`remaining after apply: ${remaining}`);
		if (remaining) {
			console.error(`${remaining} candidate(s) remain (skipped above); run again.`);
			process.exitCode = 1;
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Photo placeholder cleanup failed.');
	process.exitCode = 1;
} finally {
	await client.end();
}
