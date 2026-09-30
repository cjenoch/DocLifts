import adapter from '@sveltejs/adapter-node';
import { execSync } from 'node:child_process';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		// Stale-build detection.
		//
		// The 0.2.1 lockout ended with a browser unable to sign in and no way to
		// tell why. SvelteKit's own answer is these two settings: `_app/version.json`
		// serves `version.name`, and a client whose value differs from what it
		// loaded detects a new deploy and forces a full reload instead of running
		// stale client code against a new server.
		//
		// Built from git so the value changes exactly when the deployed code
		// does. Falls back to 'dev' outside a checkout; that is still a valid,
		// stable value, it simply never differs between builds.
		version: {
			pollInterval: 60_000,
			name: process.env.DOCLIFTS_BUILD_SHA || gitSha()
		},
		// L13: strict Content-Security-Policy. mode 'nonce' makes SvelteKit
		// add per-request nonces to its own inline hydration scripts/styles,
		// so script-src/style-src stay locked to 'self' with no
		// 'unsafe-inline'. No external scripts, styles, fonts, or images
		// exist anywhere in the app, and app.html carries no inline
		// style/script attributes, so nothing else needs allowlisting.
		csp: {
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self'],
				'img-src': ['self'],
				'font-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none']
			}
		},
		// CSRF. trustedOrigins exists because adapter-node computes
		// url.origin from the request it receives, and behind Tailscale Serve
		// that is the PROXY's view — a forwarded request whose Host is
		// localhost, or whose scheme has been rewritten http->https. Without an
		// allowlist every POST 403s.
		//
		// THE CANONICAL ORIGIN IS THE ts.net HTTPS URL. Since auth (T2) the app
		// is served over HTTPS, so `Secure` cookies are set, and a non-https
		// origin is no longer a supported way in. The http:// and :3000 entries
		// are kept only so a pre-T6 rollback still works; a release with auth
		// live should remove them.
		//
		// Side effect: strict enforcement means curl POSTs *without* an Origin
		// header also 403. When scripting against the running service add:
		//   -H 'Origin: https://enochnvps.tail29bbdb.ts.net'
		csrf: {
			trustedOrigins: [
				// Canonical: Tailscale Serve's own HTTPS name.
				'https://enochnvps.tail29bbdb.ts.net',
				// Same node, port-explicit, for a pre-T6 rollback.
				'https://enochnvps.tail29bbdb.ts.net:3000',
				'http://enochnvps.tail29bbdb.ts.net:3000',
				// Raw tailnet IP, still reachable and still used by the
				// local acceptance harness.
				'https://100.118.77.26:3000',
				'http://100.118.77.26:3000'
			]
		}
	}
};

/**
 * The git sha at build time, or a stable placeholder.
 *
 * `DOCLIFTS_BUILD_SHA` is the explicit override the release runbook sets, so a
 * source-less runtime image does not need a .git directory to be identifiable.
 */
function gitSha() {
	try {
		return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return 'dev';
	}
}

export default config;
