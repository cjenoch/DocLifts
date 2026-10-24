import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

describe.skipIf(process.platform !== 'linux')('Linux privacy journal broker', () => {
	it('enforces durability, retry, strict entries, complete recovery and safe output', () => {
		const result = spawnSync(
			'python3',
			['-m', 'unittest', 'discover', '-s', 'scripts/privacy-activation', '-p', 'test_*.py'],
			{
				encoding: 'utf8',
				env: { ...process.env, DOCLIFTS_TEST_RESTIC: '0' },
				timeout: 10000
			}
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain('OK');
	});
});
