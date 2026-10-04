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
		// csrfBoundary in hooks runs BEFORE auth and page actions. It preserves
		// same-origin forms, with one cookie-free native OAuth token exception.
		// The served-build MCP and auth tests exercise both sides of this boundary.
		csrf: { trustedOrigins: ['*'] },
		// Stale-build detection.
		//
		// The 0.2.1 lockout ended with a browser unable to sign in and no way to
		// tell why. SvelteKit's own answer is these two settings: `_app/version.json`
		// serves `version.name`, and a client whose value differs from what it
		// loaded detects a new deploy. AppUpdate shows a refresh prompt; polling
		// alone does not refresh an idle tab. The user chooses when to reload.
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
		}
		// Same-origin form protection uses runtime ORIGIN in csrfBoundary.
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
