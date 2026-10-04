import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Event = {
	before?: string;
	after?: string;
	pull_request?: { base: { sha: string }; head: { sha: string } };
};

/** Unknown events, missing history and non-document changes always take the full gate. */
export function docsOnly(eventName: string, event: Event, cwd = process.cwd()): boolean {
	const pr = eventName === 'pull_request' ? event.pull_request : undefined;
	const base = pr?.base.sha ?? (eventName === 'push' ? event.before : undefined);
	const head = pr?.head.sha ?? (eventName === 'push' ? event.after : undefined);
	const sha = /^[a-f0-9]{40}$/;
	if (!base || !head || !sha.test(base) || !sha.test(head) || /^0+$/.test(base)) return false;
	try {
		// PR: the complete branch diff, not just its last commit. Push: the entire push.
		// Disable rename detection so a code file renamed to Markdown still counts as code.
		const raw = execFileSync(
			'git',
			[
				'diff',
				'--raw',
				'--no-abbrev',
				'--no-renames',
				'-z',
				base + (pr ? '...' : '..') + head,
				'--'
			],
			{ cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }
		);
		const records = raw.split('\0');
		if (records.pop() !== '' || records.length === 0 || records.length % 2 !== 0) return false;
		for (let i = 0; i < records.length; i += 2) {
			const header = records[i].split(' ');
			const file = records[i + 1];
			if (header.length !== 5 || !['A', 'M', 'D'].includes(header[4])) return false;
			// A symlink named README.md is not documentation.
			if (
				![header[0].slice(1), header[1]].every((mode) =>
					['000000', '100644', '100755'].includes(mode)
				)
			)
				return false;
			if (!(file.endsWith('.md') && (!file.includes('/') || file.startsWith('docs/'))))
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	let onlyDocs = false;
	try {
		onlyDocs = docsOnly(
			process.env.GITHUB_EVENT_NAME ?? '',
			JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'))
		);
	} catch {
		// Malformed/unavailable event data must never bypass tests.
	}
	const result = 'docs_only=' + onlyDocs + '\n';
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, result);
	console.log(result.trim());
}
