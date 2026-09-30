import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
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

export default config;
