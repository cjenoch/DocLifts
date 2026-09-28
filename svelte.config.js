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
		// CSRF: single-user, Tailscale-only, no auth. trustedOrigins allowlists
		// the canonical HTTPS URL fronted by Tailscale Serve — needed because
		// adapter-node would otherwise compute url.origin from the proxy's
		// Host header (possibly localhost) and 403 every POST.
		//
		// Side effect: strict enforcement means curl POSTs *without* an Origin
		// header also 403 (looser under the prior checkOrigin: false). When
		// scripting against the running service add:
		//   -H 'Origin: https://testdev01.tail29bbdb.ts.net'
		//
		// Extend this list if the app moves; on adding auth, also wire
		// PROTOCOL_HEADER / HOST_HEADER so adapter-node trusts forwarded values.
		// Tailnet-only on the VPS: allow the tailnet MagicDNS hostname and the
		// tailnet IP (the exact Origin a requesting browser will send). Both
		// hostnames resolve to the same tailnet node. Add any new tailnet host
		// here when the app moves again.
		csrf: {
			trustedOrigins: [
				'http://100.118.77.26:3000',
				'https://100.118.77.26:3000',
				'http://enochnvps.tail29bbdb.ts.net:3000',
				'https://enochnvps.tail29bbdb.ts.net:3000'
			]
		}
	}
};

export default config;
