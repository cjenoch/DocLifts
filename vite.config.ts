import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';

// Point the app's `db` singleton at the test database for every vitest
// project, at config-load time — before any test module is imported.
//
// db/index.ts builds the client at MODULE IMPORT from DATABASE_URL. A test
// that imports `auth` therefore binds whatever DATABASE_URL is in the
// environment, and on the VPS that is the PRODUCTION database: auth tables
// get created and user rows written there by a test run. A project's `env`
// block does not reliably do this (the value is read when the config is
// resolved, and SvelteKit's env handling wins), so assign the process
// variable directly. It is the earliest point available.
//
// The fallback matches test-db.ts's own secretless default. The URL contains
// no credential — TEST_DATABASE_URL carries the password when one is needed.
process.env.DATABASE_URL ??=
	process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/doclifts_test';

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
