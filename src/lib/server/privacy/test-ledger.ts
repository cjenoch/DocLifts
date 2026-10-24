/** Fictional test transport only. It does not claim real off-host durability. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileLedger, ledgerEntry, type LedgerEntry } from './ledger';

export async function startTestLedger(
	dir: string,
	append?: (entry: LedgerEntry) => Promise<unknown>
) {
	const socketPath =
		process.platform === 'win32'
			? '\\\\.\\pipe\\doclifts-ledger-' + randomUUID()
			: join(dir, 'ledger.sock');
	const local = fileLedger(join(dir, 'ledger.jsonl'));
	const server = createServer(async (request, response) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const entry = ledgerEntry.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			const result = append
				? await append(entry)
				: (await local.append(entry), { durable: true, entry, snapshot: 'a'.repeat(64) });
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify(result));
		} catch {
			response.writeHead(503);
			response.end('{}');
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, resolve);
	});
	return {
		socketPath,
		stop: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			})
	};
}
