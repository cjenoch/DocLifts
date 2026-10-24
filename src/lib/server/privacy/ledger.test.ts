import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableLedger, type LedgerEntry } from './ledger';
import { startTestLedger } from './test-ledger';

const entry: LedgerEntry = {
	version: 1,
	kind: 'account',
	subjectHash: 'b'.repeat(64),
	requestedAt: '2026-01-01T00:00:00.000Z'
};
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function broker(append: (entry: LedgerEntry) => Promise<unknown>) {
	const dir = await mkdtemp(join(tmpdir(), 'journal-client-'));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const transport = await startTestLedger(dir, append);
	cleanups.push(transport.stop);
	return durableLedger(transport.socketPath);
}

describe('off-host journal acknowledgment', () => {
	it('does not resolve until the exact entry has been durably acknowledged', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let received!: () => void;
		const arrived = new Promise<void>((resolve) => (received = resolve));
		const ledger = await broker(async (record) => {
			received();
			await held;
			return { durable: true, entry: record, snapshot: 'a'.repeat(64) };
		});
		let finished = false;
		const pending = ledger.append(entry).then(() => (finished = true));
		await arrived;
		expect(finished).toBe(false);
		release();
		await pending;
		expect(finished).toBe(true);
	});

	it('fails closed on outage, a different entry, and a non-durable response', async () => {
		for (const answer of [
			async () => {
				throw new Error('synthetic outage');
			},
			async () => ({
				durable: true,
				entry: { ...entry, subjectHash: 'c'.repeat(64) },
				snapshot: 'a'.repeat(64)
			}),
			async () => ({ durable: false, entry, snapshot: 'a'.repeat(64) })
		]) {
			await expect((await broker(answer)).append(entry)).rejects.toThrow(/durability/);
		}
		expect(() => durableLedger('relative.sock')).toThrow(/absolute/);
	});
});
