/**
 * Fails the e2e run if any server it spawned is still alive at the end.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every run used to leave `node build/index.js` processes behind: five per run,
 * measured 2026-10-01, from four files that stopped their server with SIGTERM,
 * which adapter-node never finishes acting on (see `stopChild` in
 * test-auth-helpers.ts). The suite was green throughout. A leaked server holds
 * a Postgres connection, and on a reused host it accumulates run after run.
 * Nothing in a test file can see this: the leak outlives the worker that
 * caused it.
 *
 * HOW
 * ---
 * `startTestServer` appends `{ pid, file }` to a registry file whose path this
 * setup provides. The teardown runs in the main process after every file has
 * finished, reads the registry, and checks each pid. Any survivor is SIGKILLed,
 * so a failing run leaves nothing behind either, and then the run fails naming
 * the file that started it.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

type Spawned = { pid: number; file: string };

/**
 * Whether `pid` is still one of OUR servers.
 *
 * On Linux, which is where CI runs, /proc says exactly that: the pid is
 * alive, it is not a zombie waiting for a reaper (the CI-mirror container's
 * PID 1 is `sleep infinity`, which never reaps), and it is still running the
 * build. A pid the kernel has since handed to something else does not match.
 * Elsewhere the best available check is signal 0.
 */
function isOurServer(pid: number): boolean {
	if (process.platform === 'linux') {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
			if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
			return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('build/index.js');
		} catch {
			return false;
		}
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export default function setup(project: TestProject) {
	const dir = mkdtempSync(join(tmpdir(), 'doclifts-e2e-'));
	const registry = join(dir, 'servers.jsonl');
	writeFileSync(registry, '');
	project.provide('e2eServerRegistry', registry);

	return () => {
		const spawned: Spawned[] = readFileSync(registry, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		rmSync(dir, { recursive: true, force: true });

		const survivors = spawned.filter((s) => isOurServer(s.pid));
		for (const { pid } of survivors) {
			try {
				process.kill(pid, 'SIGKILL');
			} catch {
				/* exited between the check and the kill */
			}
		}
		if (survivors.length === 0) return;

		// LOAD-BEARING. Vitest 4.1.5 prints a teardown error as "error during
		// close" and still exits 0: measured with this line removed, the run
		// named the leaked pid and passed. The throw is for the message; this
		// is what fails CI.
		process.exitCode = 1;
		throw new Error(
			`${survivors.length} of ${spawned.length} e2e servers were still running after the suite ` +
				`(now SIGKILLed). Stop every server with the \`stop\` that startTestServer returns:\n` +
				survivors.map((s) => `  pid ${s.pid} from ${s.file}`).join('\n')
		);
	};
}
