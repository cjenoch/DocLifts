import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { isAbsolute, dirname } from 'node:path';
import { z } from 'zod';

export const subjectHash = (kind: 'account' | 'photo', id: string) =>
	createHash('sha256').update(`doclifts-deletion-v1:${kind}:${id}`).digest('hex');
export const ledgerEntry = z
	.object({
		version: z.literal(1),
		kind: z.enum(['account', 'photo']),
		subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
		requestedAt: z.iso.datetime()
	})
	.strict();
export type LedgerEntry = z.infer<typeof ledgerEntry>;
export type Ledger = { append(entry: LedgerEntry): Promise<void> };

/** Deployment must preserve this journal independently of restored snapshots.
 * The file contains random-ID hashes, never email, object keys, or workout data.
 * Each line is one append write and fsync. A broken/torn line fails reconciliation.
 */
export function fileLedger(path = process.env.DELETION_LEDGER_PATH): Ledger {
	if (!path || !isAbsolute(path)) throw new Error('Deletion ledger requires an absolute path');
	return {
		async append(entry) {
			const handle = await open(path, 'a', 0o600);
			try {
				await handle.writeFile(JSON.stringify(ledgerEntry.parse(entry)) + '\n');
				await handle.sync();
			} finally {
				await handle.close();
			}
			if (process.platform === 'win32') return; // FlushFileBuffers above; Windows cannot open directories this way.
			const directory = await open(dirname(path), 'r');
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		}
	};
}
export async function readLedger(path: string): Promise<LedgerEntry[]> {
	const content = await readFile(path, 'utf8');
	return content
		.split('\n')
		.filter(Boolean)
		.map((line) => ledgerEntry.parse(JSON.parse(line)));
}
export function deletionEnabled() {
	return process.env.PRIVACY_DELETION_ENABLED === '1';
}
