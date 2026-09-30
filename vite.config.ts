import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';

// Point the app's `db` singleton at the test database for every vitest
// project, at config-load time — before any test module is imported.
//
// db/index.ts builds the client at MODULE IMPORT from DATABASE_URL, so a test
// that imports `auth` binds whatever DATABASE_URL is in the environment. This
// is an OVERRIDE, not a default: on this host a stale DATABASE_URL exported in
// the shell for migration runs has pointed at a real Postgres on
// 127.0.0.1:5432, and a default would do nothing about it. A project's `env`
// block did not apply reliably (SvelteKit's env handling wins), so assign the
// process variable directly — the earliest point available.
//
// VITEST is set by vitest before the config is loaded. Guard on it so a normal
// `vite dev` / `vite build` still gets a real DATABASE_URL.
//
// VITE loads `.env` into `import.meta.env` / SvelteKit's private env module,
// NOT into `process.env`, and it does that AFTER this config is evaluated. So
// `process.env.TEST_DATABASE_URL` is empty here unless the shell exported it,
// and the bare fallback would silently drop the credential. `loadEnv` reads the
// same file Vite will, with the same mode rules, and is the supported way to
// read a .env value at config time. If it finds nothing, the secretless default
// applies, which then fails loudly with a Postgres auth error rather than
// connecting to the wrong database.
if (process.env.VITEST) {
	const fromFile = loadEnv(
		process.env.NODE_ENV === 'production' ? 'production' : 'development',
		process.cwd(),
		''
	);
	const testUrl =
		process.env.TEST_DATABASE_URL ??
		fromFile.TEST_DATABASE_URL ??
		'postgresql://localhost/doclifts_test';
	// BOTH variables. test-db.ts reads TEST_DATABASE_URL directly and
	// post-process.env, not Vite's env module — so setting only DATABASE_URL
	// leaves the migrator connecting with no credential at all, which
	// postgres-js answers by guessing the OS user and failing with
	// 'password authentication failed for user "<you>"'.
	process.env.TEST_DATABASE_URL = testUrl;
	process.env.DATABASE_URL = testUrl;
} else {
	process.env.DATABASE_URL ??=
		process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/doclifts_test';
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		// Allow Tailscale MagicDNS + Serve hostnames (and any other tailnet
		// hostname under .ts.net) to hit the dev server.
		allowedHosts: ['.ts.net', 'testdev01']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						api: process.env.PW_TEST_PORT
							? { host: '127.0.0.1', port: Number(process.env.PW_TEST_PORT) }
							: undefined,
						// Point at a system Chrome/Chromium when Playwright's bundled build
						// is unavailable (e.g. Ubuntu 26.04). Opt-in via PW_EXECUTABLE_PATH
						// so the repo stays portable across dev hosts.
						provider: process.env.PW_EXECUTABLE_PATH
							? playwright({ launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } })
							: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					// DB integration tests share a single doclifts_test database, so
					// test files must run one-at-a-time. Pure-function files would be
					// safe to parallelize, but the cost of running everything serial
					// is small and avoids per-file partitioning gymnastics.
					fileParallelism: false
				}
			},

			{
				// The demo seed must have DATABASE_URL and TEST_DATABASE_URL both
				// pointing at doclifts_demo_test, because `createUser` writes
				// through the `auth` singleton and the demo rows go to the
				// handle the caller passes. Keying that off the base config is
				// not possible: vitest 4 does not pass the project name to the
				// config function, so the rewrite cannot be conditional on it.
				// A sibling config file sets the variable before importing this
				// one, which is the earliest point it can take effect. See the
				// file's own comment.
				extends: './vite.demo.config.ts',
				test: {
					name: 'demo',
					environment: 'node',
					include: ['src/lib/server/demo.db.test.ts'],
					fileParallelism: false,
					hookTimeout: 120_000,
					testTimeout: 60_000
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'e2e',
					environment: 'node',
					include: ['e2e/**/*.e2e.ts'],
					// Serves a production build and drives it with Playwright; one
					// server + one test database, so strictly serial.
					fileParallelism: false,
					testTimeout: 60_000,
					hookTimeout: 60_000
				}
			}
		]
	}
});
