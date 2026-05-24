import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		// Single-user, Tailscale-only, no auth — explicit allowlist matches the
		// canonical HTTPS URL fronted by Tailscale Serve. Without this entry
		// adapter-node computes url.origin from the Host header (possibly
		// localhost behind the proxy) and POSTs 403 on mismatch. Add origins
		// here if the app moves; on adding auth, also wire PROTOCOL_HEADER /
		// HOST_HEADER so adapter-node trusts the proxy's forwarded values.
		csrf: { trustedOrigins: ['https://testdev01.tail29bbdb.ts.net'] }
	}
};

export default config;
