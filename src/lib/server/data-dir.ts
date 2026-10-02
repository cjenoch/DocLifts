/**
 * The private data directory: a checkout of the owner's private data
 * repository (catalog snapshots and research, evals, the hard-photo
 * manifest), named by `DOCLIFTS_DATA_DIR`. See docs/private-data.md.
 *
 * Read only by scripts and private tests, never by the app at run time.
 * Unset (or empty) is the normal case, in public CI and on any machine
 * without the data: callers skip. Set but wrong (relative, missing, not a
 * directory) throws, so a typo can't pass as "no data here".
 */
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const DATA_DIR_ENV = 'DOCLIFTS_DATA_DIR';

export function dataDir(env: NodeJS.ProcessEnv = process.env): string | null {
	const dir = env[DATA_DIR_ENV];
	if (dir === undefined || dir === '') return null;
	if (!isAbsolute(dir)) throw new Error(`${DATA_DIR_ENV} must be an absolute path: ${dir}`);
	let isDir = false;
	try {
		isDir = statSync(dir).isDirectory();
	} catch {
		throw new Error(`${DATA_DIR_ENV} does not exist: ${dir}`);
	}
	if (!isDir) throw new Error(`${DATA_DIR_ENV} is not a directory: ${dir}`);
	return dir;
}
